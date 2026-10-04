/**
 * LLM provider implementations for MCP server
 *
 * Supports OpenAI, Anthropic, and Ollama APIs.
 * Uses dynamic imports to avoid requiring all SDKs at once —
 * only the selected provider's dependency is loaded.
 */

import { ILLMProvider, ILLMModel, ILLMMessage, Logger, PROVIDER_DEFAULT_MODELS } from "@ragnarok/core";
import { McpConfig } from "./config";

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
  delta?: { type?: string; text?: unknown };
}

/** Text of one Anthropic stream event, or undefined for events that carry none. */
function anthropicEventText(event: AnthropicStreamEvent): string | undefined {
  if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") {
    return undefined;
  }
  if (typeof event.delta.text !== "string") {
    throw new Error("Anthropic stream contained invalid text");
  }
  return event.delta.text;
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

// ────────────────────────────────────────────────────────────
// OpenAI provider
// ────────────────────────────────────────────────────────────

/** Chat model on an OpenAI-compatible API; Ollama is driven through the OpenAI SDK. */
class OpenAICompatibleModel implements ILLMModel {
  id: string;

  constructor(
    private client: any, // OpenAI instance
    private modelName: string,
    private requestTimeoutMs: number,
    private label: string,
    public family: string,
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

export class OpenAILLMProvider implements ILLMProvider {
  private logger = new Logger("OpenAILLMProvider");
  private client: any = null;
  private availability = new AvailabilityCache(10_000);

  constructor(
    private apiKey: string,
    private defaultModel: string,
    private baseUrl?: string,
    private requestTimeoutMs = 30_000,
  ) {}

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: OpenAI } = await import("openai");
      this.client = new OpenAI({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    }
    return this.client;
  }

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      const modelName = options?.family ?? this.defaultModel;
      return new OpenAICompatibleModel(
        client,
        modelName,
        this.requestTimeoutMs,
        "OpenAI",
        modelName.split("-")[0], // e.g. "gpt" from "gpt-4o-mini"
      );
    } catch (error) {
      this.logger.error("Failed to create OpenAI model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.availability.check(async () => {
      const client = await this.getClient();
      await withDeadline(this.requestTimeoutMs, (signal) => client.models.list({}, { signal }));
    });
  }
}

// ────────────────────────────────────────────────────────────
// Anthropic provider
// ────────────────────────────────────────────────────────────

class AnthropicModel implements ILLMModel {
  id: string;
  family: string;

  constructor(
    private client: any, // Anthropic instance
    private modelName: string,
    private requestTimeoutMs: number,
  ) {
    this.id = modelName;
    this.family = modelName.split("-")[0]; // e.g. "claude" from "claude-sonnet-4-20250514"
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Anthropic uses a system parameter instead of a system message
    const systemPrompts: string[] = [];
    const chatMessages: Array<{ role: string; content: string }> = [];

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

export class AnthropicLLMProvider implements ILLMProvider {
  private logger = new Logger("AnthropicLLMProvider");
  private client: any = null;
  private availability = new AvailabilityCache(10_000);

  constructor(
    private apiKey: string,
    private defaultModel: string,
    private baseUrl?: string,
    private requestTimeoutMs = 30_000,
  ) {}

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    }
    return this.client;
  }

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      const modelName = options?.family ?? this.defaultModel;
      return new AnthropicModel(client, modelName, this.requestTimeoutMs);
    } catch (error) {
      this.logger.error("Failed to create Anthropic model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.availability.check(async () => {
      const client = await this.getClient();
      if (client.models?.list) {
        await withDeadline(this.requestTimeoutMs, (signal) => client.models.list({ limit: 1 }, { signal }));
      }
    });
  }
}

// ────────────────────────────────────────────────────────────
// Ollama provider (OpenAI-compatible API)
// ────────────────────────────────────────────────────────────

export class OllamaLLMProvider implements ILLMProvider {
  private logger = new Logger("OllamaLLMProvider");
  private client: any = null;
  private availability = new AvailabilityCache(3_000);

  constructor(
    private baseUrl: string,
    private defaultModel: string,
    private requestTimeoutMs = 30_000,
  ) {}

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: OpenAI } = await import("openai");
      this.client = new OpenAI({
        baseURL: normalizeOllamaBaseUrl(this.baseUrl),
        apiKey: "ollama", // Ollama doesn't require a real key
      });
    }
    return this.client;
  }

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      const modelName = options?.family ?? this.defaultModel;
      return new OpenAICompatibleModel(client, modelName, this.requestTimeoutMs, "Ollama", "ollama");
    } catch (error) {
      this.logger.error("Failed to create Ollama model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.availability.check(async () => {
      const client = await this.getClient();
      await withDeadline(this.requestTimeoutMs, (signal) => client.models.list({}, { signal }));
    });
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
