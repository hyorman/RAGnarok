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

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

// ────────────────────────────────────────────────────────────
// OpenAI provider
// ────────────────────────────────────────────────────────────

class OpenAIModel implements ILLMModel {
  id: string;
  family: string;

  constructor(
    private client: any, // OpenAI instance
    private modelName: string,
    private requestTimeoutMs: number,
  ) {
    this.id = modelName;
    this.family = modelName.split("-")[0]; // e.g. "gpt" from "gpt-4o-mini"
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const deadline = deadlineSignal(signal, this.requestTimeoutMs);
    let stream: any;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.modelName,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        },
        { signal: deadline.signal },
      );
    } catch (error) {
      deadline.dispose();
      throw error;
    }

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (content !== undefined && content !== null && typeof content !== "string") {
              throw new Error("OpenAI streaming response contained non-text content");
            }
            if (content) {
              yield content;
            }
          }
        } finally {
          deadline.dispose();
        }
      },
    };
  }
}

export class OpenAILLMProvider implements ILLMProvider {
  private logger = new Logger("OpenAILLMProvider");
  private client: any = null;
  private availability?: { value: boolean; expiresAt: number };

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
      return new OpenAIModel(client, modelName, this.requestTimeoutMs);
    } catch (error) {
      this.logger.error("Failed to create OpenAI model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability && this.availability.expiresAt > Date.now()) {
      return this.availability.value;
    }
    try {
      const client = await this.getClient();
      const deadline = deadlineSignal(undefined, this.requestTimeoutMs);
      try {
        await client.models.list({}, { signal: deadline.signal });
      } finally {
        deadline.dispose();
      }
      this.availability = { value: true, expiresAt: Date.now() + 10_000 };
      return true;
    } catch {
      this.availability = { value: false, expiresAt: Date.now() + 10_000 };
      return false;
    }
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

    const deadline = deadlineSignal(signal, this.requestTimeoutMs);
    let stream: any;
    try {
      stream = this.client.messages.stream(
        {
          model: this.modelName,
          max_tokens: 4096,
          ...(systemPrompts.length ? { system: systemPrompts.join("\n\n") } : {}),
          messages: chatMessages,
        },
        { signal: deadline.signal },
      );
    } catch (error) {
      deadline.dispose();
      throw error;
    }

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              if (typeof event.delta.text !== "string") {
                throw new Error("Anthropic stream contained invalid text");
              }
              yield event.delta.text;
            }
          }
        } finally {
          deadline.dispose();
        }
      },
    };
  }
}

export class AnthropicLLMProvider implements ILLMProvider {
  private logger = new Logger("AnthropicLLMProvider");
  private client: any = null;
  private availability?: { value: boolean; expiresAt: number };

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
    if (this.availability && this.availability.expiresAt > Date.now()) {
      return this.availability.value;
    }
    try {
      const client = await this.getClient();
      if (client.models?.list) {
        const deadline = deadlineSignal(undefined, this.requestTimeoutMs);
        try {
          await client.models.list({ limit: 1 }, { signal: deadline.signal });
        } finally {
          deadline.dispose();
        }
      }
      this.availability = { value: true, expiresAt: Date.now() + 10_000 };
      return true;
    } catch {
      this.availability = { value: false, expiresAt: Date.now() + 10_000 };
      return false;
    }
  }
}

// ────────────────────────────────────────────────────────────
// Ollama provider (OpenAI-compatible API)
// ────────────────────────────────────────────────────────────

class OllamaModel implements ILLMModel {
  id: string;
  family: string;

  constructor(
    private client: any, // OpenAI-compatible client
    private modelName: string,
    private requestTimeoutMs: number,
  ) {
    this.id = modelName;
    this.family = "ollama";
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const deadline = deadlineSignal(signal, this.requestTimeoutMs);
    let stream: any;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.modelName,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        },
        { signal: deadline.signal },
      );
    } catch (error) {
      deadline.dispose();
      throw error;
    }

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (content !== undefined && content !== null && typeof content !== "string") {
              throw new Error("Ollama streaming response contained non-text content");
            }
            if (content) {
              yield content;
            }
          }
        } finally {
          deadline.dispose();
        }
      },
    };
  }
}

export class OllamaLLMProvider implements ILLMProvider {
  private logger = new Logger("OllamaLLMProvider");
  private client: any = null;
  private availability?: { value: boolean; expiresAt: number };

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
      return new OllamaModel(client, modelName, this.requestTimeoutMs);
    } catch (error) {
      this.logger.error("Failed to create Ollama model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability && this.availability.expiresAt > Date.now()) {
      return this.availability.value;
    }
    try {
      const client = await this.getClient();
      const deadline = deadlineSignal(undefined, this.requestTimeoutMs);
      try {
        await client.models.list({}, { signal: deadline.signal });
      } finally {
        deadline.dispose();
      }
      this.availability = { value: true, expiresAt: Date.now() + 3_000 };
      return true;
    } catch {
      this.availability = { value: false, expiresAt: Date.now() + 3_000 };
      return false;
    }
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

/** Inline null provider to avoid circular imports with adapters.ts */
class NullProvider implements ILLMProvider {
  async selectModel(): Promise<ILLMModel | null> {
    return null;
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}
