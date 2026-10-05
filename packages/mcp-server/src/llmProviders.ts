/**
 * LLM provider implementations for MCP server
 *
 * Supports OpenAI, Anthropic, and Ollama APIs.
 * Uses dynamic imports to avoid requiring all SDKs at once —
 * only the selected provider's dependency is loaded.
 */

import { ILLMProvider, ILLMModel, ILLMMessage, Logger, PROVIDER_DEFAULT_MODELS } from "@ragnarok/core";
import { McpConfig } from "./config";
import { MCP_DEFAULTS } from "./defaults";

/** How long a hosted provider's availability probe result is reused. */
const REMOTE_AVAILABILITY_TTL_MS = 10_000;
/** Ollama runs on this machine, so its probe is cheap and repeated sooner. */
const LOCAL_AVAILABILITY_TTL_MS = 3_000;

// The SDKs are loaded with `await import(...)`, which resolves their ESM typings; name the same ones here.
type OpenAIClient = InstanceType<typeof import("openai", { with: { "resolution-mode": "import" } }).default>;
type AnthropicClient = InstanceType<
  typeof import("@anthropic-ai/sdk", { with: { "resolution-mode": "import" } }).default
>;

function deadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) {
    onAbort();
  }
  const timer = setTimeout(() => controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Open a provider stream under a deadline and yield only its text. The
 * deadline is disposed exactly once: when opening fails, or when iteration ends.
 * `textOf` returns undefined for chunks that carry no text; any other string
 * (including the empty string) is yielded.
 */
async function streamText<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>> | AsyncIterable<T>,
  textOf: (chunk: T) => string | undefined,
): Promise<AsyncIterable<string>> {
  const deadline = deadlineSignal(signal, timeoutMs);
  let stream: AsyncIterable<T>;
  try {
    stream = await open(deadline.signal);
  } catch (error) {
    deadline.dispose();
    throw error;
  }
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          const text = textOf(chunk);
          if (text !== undefined) {
            yield text;
          }
        }
      } finally {
        deadline.dispose();
      }
    },
  };
}

/** Run `probe` under a deadline. */
async function withDeadline(timeoutMs: number, probe: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const deadline = deadlineSignal(undefined, timeoutMs);
  try {
    await probe(deadline.signal);
  } finally {
    deadline.dispose();
  }
}

/** Remembers an availability probe's verdict for `ttlMs`. */
class AvailabilityCache {
  private cached?: { value: boolean; expiresAt: number };

  constructor(private ttlMs: number) {}

  async check(probe: () => Promise<void>): Promise<boolean> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    let value: boolean;
    try {
      await probe();
      value = true;
    } catch {
      value = false;
    }
    this.cached = { value, expiresAt: Date.now() + this.ttlMs };
    return value;
  }
}

/** The part of an OpenAI-style streaming chunk that carries text. */
interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
}

/** Text of one OpenAI-style streaming chunk; `label` names the provider in the error. */
const openAiChunkText =
  (label: string) =>
  (chunk: OpenAIStreamChunk): string | undefined => {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content !== undefined && content !== null && typeof content !== "string") {
      throw new Error(`${label} streaming response contained non-text content`);
    }
    // Empty content carries no text; it is not yielded.
    return typeof content === "string" && content ? content : undefined;
  };

/** The part of an Anthropic stream event that carries text. */
interface AnthropicStreamEvent {
  type?: string;
  delta?: unknown;
}

/** Text of one Anthropic stream event, or undefined for events that carry none. */
function anthropicEventText(event: AnthropicStreamEvent): string | undefined {
  if (event.type !== "content_block_delta" || typeof event.delta !== "object" || event.delta === null) {
    return undefined;
  }
  const delta = event.delta as { type?: unknown; text?: unknown };
  if (delta.type !== "text_delta") {
    return undefined;
  }
  if (typeof delta.text !== "string") {
    throw new Error("Anthropic stream contained invalid text");
  }
  return delta.text;
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

// ────────────────────────────────────────────────────────────
// Shared provider skeleton
// ────────────────────────────────────────────────────────────

/**
 * What the SDK-backed providers have in common: a client built on first use, an
 * availability verdict cached for a TTL, and a `selectModel` that reports a
 * failure as `null` instead of throwing. A subclass supplies only what differs
 * between SDKs: how to build the client, which model wraps it, and the cheapest
 * request that proves the backend answers.
 */
abstract class SdkLLMProvider<Client> implements ILLMProvider {
  private readonly logger: Logger;
  private readonly availability: AvailabilityCache;
  private client: Client | null = null;

  protected constructor(
    private readonly label: string,
    protected readonly defaultModel: string,
    protected readonly requestTimeoutMs: number,
    availabilityTtlMs: number,
  ) {
    this.logger = new Logger(`${label}LLMProvider`);
    this.availability = new AvailabilityCache(availabilityTtlMs);
  }

  /** Build the SDK client. Runs once, on first use, so only the selected provider's SDK is ever loaded. */
  protected abstract createClient(): Promise<Client>;

  /** The chat model that sends requests for `modelName` through `client`. */
  protected abstract createModel(client: Client, modelName: string): ILLMModel;

  /** The cheapest request that proves the backend answers; it rejects when the backend does not. */
  protected abstract probe(client: Client, signal: AbortSignal): Promise<unknown>;

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      return this.createModel(client, options?.family ?? this.defaultModel);
    } catch (error) {
      this.logger.error(`Failed to create ${this.label} model`, error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.availability.check(async () => {
      const client = await this.getClient();
      await withDeadline(this.requestTimeoutMs, (signal) => this.probe(client, signal));
    });
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.client = await this.createClient();
    }
    return this.client;
  }
}

// ────────────────────────────────────────────────────────────
// OpenAI provider
// ────────────────────────────────────────────────────────────

/** Chat model on an OpenAI-compatible API; Ollama is driven through the OpenAI SDK. */
class OpenAICompatibleModel implements ILLMModel {
  readonly id: string;

  constructor(
    private client: OpenAIClient,
    private modelName: string,
    private requestTimeoutMs: number,
    private label: string,
    public readonly family: string,
  ) {
    this.id = modelName;
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return streamText(
      signal,
      this.requestTimeoutMs,
      (deadline) =>
        this.client.chat.completions.create(
          {
            model: this.modelName,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
          },
          { signal: deadline },
        ),
      openAiChunkText(this.label),
    );
  }
}

export class OpenAILLMProvider extends SdkLLMProvider<OpenAIClient> {
  constructor(
    private apiKey: string,
    defaultModel: string,
    private baseUrl?: string,
    requestTimeoutMs: number = MCP_DEFAULTS.LLM_REQUEST_TIMEOUT_MS,
  ) {
    super("OpenAI", defaultModel, requestTimeoutMs, REMOTE_AVAILABILITY_TTL_MS);
  }

  protected async createClient(): Promise<OpenAIClient> {
    const { default: OpenAI } = await import("openai");
    return new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
    });
  }

  protected createModel(client: OpenAIClient, modelName: string): ILLMModel {
    return new OpenAICompatibleModel(
      client,
      modelName,
      this.requestTimeoutMs,
      "OpenAI",
      modelName.split("-")[0], // e.g. "gpt" from "gpt-4o-mini"
    );
  }

  protected probe(client: OpenAIClient, signal: AbortSignal): Promise<unknown> {
    return client.models.list({ signal });
  }
}

// ────────────────────────────────────────────────────────────
// Anthropic provider
// ────────────────────────────────────────────────────────────

class AnthropicModel implements ILLMModel {
  readonly id: string;
  readonly family: string;

  constructor(
    private client: AnthropicClient,
    private modelName: string,
    private requestTimeoutMs: number,
  ) {
    this.id = modelName;
    this.family = modelName.split("-")[0]; // e.g. "claude" from "claude-sonnet-4-20250514"
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Anthropic uses a system parameter instead of a system message
    const systemPrompts: string[] = [];
    const chatMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const m of messages) {
      if (m.role === "system") {
        systemPrompts.push(m.content);
      } else {
        chatMessages.push({ role: m.role, content: m.content });
      }
    }

    return streamText(
      signal,
      this.requestTimeoutMs,
      (deadline) =>
        this.client.messages.stream(
          {
            model: this.modelName,
            max_tokens: 4096,
            ...(systemPrompts.length ? { system: systemPrompts.join("\n\n") } : {}),
            messages: chatMessages,
          },
          { signal: deadline },
        ),
      anthropicEventText,
    );
  }
}

export class AnthropicLLMProvider extends SdkLLMProvider<AnthropicClient> {
  constructor(
    private apiKey: string,
    defaultModel: string,
    private baseUrl?: string,
    requestTimeoutMs: number = MCP_DEFAULTS.LLM_REQUEST_TIMEOUT_MS,
  ) {
    super("Anthropic", defaultModel, requestTimeoutMs, REMOTE_AVAILABILITY_TTL_MS);
  }

  protected async createClient(): Promise<AnthropicClient> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
    });
  }

  protected createModel(client: AnthropicClient, modelName: string): ILLMModel {
    return new AnthropicModel(client, modelName, this.requestTimeoutMs);
  }

  protected async probe(client: AnthropicClient, signal: AbortSignal): Promise<void> {
    if (client.models?.list) {
      await client.models.list({ limit: 1 }, { signal });
    }
  }
}

// ────────────────────────────────────────────────────────────
// Ollama provider (OpenAI-compatible API)
// ────────────────────────────────────────────────────────────

export class OllamaLLMProvider extends SdkLLMProvider<OpenAIClient> {
  constructor(
    private baseUrl: string,
    defaultModel: string,
    requestTimeoutMs: number = MCP_DEFAULTS.LLM_REQUEST_TIMEOUT_MS,
  ) {
    super("Ollama", defaultModel, requestTimeoutMs, LOCAL_AVAILABILITY_TTL_MS);
  }

  protected async createClient(): Promise<OpenAIClient> {
    const { default: OpenAI } = await import("openai");
    return new OpenAI({
      baseURL: normalizeOllamaBaseUrl(this.baseUrl),
      apiKey: "ollama", // Ollama doesn't require a real key
    });
  }

  protected createModel(client: OpenAIClient, modelName: string): ILLMModel {
    return new OpenAICompatibleModel(client, modelName, this.requestTimeoutMs, "Ollama", "ollama");
  }

  protected probe(client: OpenAIClient, signal: AbortSignal): Promise<unknown> {
    return client.models.list({ signal });
  }
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/**
 * Create an LLM provider based on configuration.
 * Returns a null provider when provider is "none" or API key is missing.
 */
export function createLLMProvider(config: McpConfig): ILLMProvider {
  const logger = new Logger("LLMProviderFactory");

  switch (config.llmProvider) {
    case "openai": {
      if (!config.llmApiKey) {
        logger.warn("OpenAI selected but RAGNAROK_LLM_API_KEY not set — LLM features disabled");
        return new NullProvider();
      }
      const openaiModel = config.llmModel || PROVIDER_DEFAULT_MODELS.openai;
      logger.info(
        `Using OpenAI provider (model: ${openaiModel}${config.llmBaseUrl ? `, baseUrl: ${config.llmBaseUrl}` : ""})`,
      );
      return new OpenAILLMProvider(
        config.llmApiKey,
        openaiModel,
        config.llmBaseUrl || undefined,
        config.llmRequestTimeoutMs,
      );
    }

    case "anthropic": {
      if (!config.llmApiKey) {
        logger.warn("Anthropic selected but RAGNAROK_LLM_API_KEY not set — LLM features disabled");
        return new NullProvider();
      }
      const anthropicModel = config.llmModel || PROVIDER_DEFAULT_MODELS.anthropic;
      logger.info(
        `Using Anthropic provider (model: ${anthropicModel}${config.llmBaseUrl ? `, baseUrl: ${config.llmBaseUrl}` : ""})`,
      );
      return new AnthropicLLMProvider(
        config.llmApiKey,
        anthropicModel,
        config.llmBaseUrl || undefined,
        config.llmRequestTimeoutMs,
      );
    }

    case "ollama": {
      const ollamaModel = config.llmModel || PROVIDER_DEFAULT_MODELS.ollama;
      const ollamaUrl = config.llmBaseUrl || "http://localhost:11434";
      logger.info(`Using Ollama provider (model: ${ollamaModel}, url: ${ollamaUrl})`);
      return new OllamaLLMProvider(ollamaUrl, ollamaModel, config.llmRequestTimeoutMs);
    }

    case "none":
    default:
      logger.info("No LLM provider configured — agentic features disabled");
      return new NullProvider();
  }
}

/**
 * True when the configured provider can actually do work.
 *
 * `createLLMProvider` never returns null: for `provider: "none"` — and for a
 * misconfiguration such as OpenAI without an API key — it substitutes a
 * NullProvider, which is a truthy object that can never answer. Consumers that
 * merely call `isAvailable()` are fine with that no-op; consumers that decide
 * something *synchronously* from the provider's presence (MemoryStore builds
 * its entity extractor in its constructor) must not be handed one, or they
 * report a capability that can never work.
 */
export function isUsableLLMProvider(provider: ILLMProvider): boolean {
  return !(provider instanceof NullProvider);
}

/** Inline null provider to avoid circular imports with adapters.ts */
class NullProvider implements ILLMProvider {
  async selectModel(): Promise<ILLMModel | null> {
    return null;
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}
