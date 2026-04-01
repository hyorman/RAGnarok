/**
 * LLM provider implementations for MCP server
 *
 * Supports OpenAI, Anthropic, and Ollama APIs.
 * Uses dynamic imports to avoid requiring all SDKs at once —
 * only the selected provider's dependency is loaded.
 */

import { ILLMProvider, ILLMModel, ILLMMessage, Logger } from "@ragnarok/core";
import { McpConfig } from "./config";

// ────────────────────────────────────────────────────────────
// OpenAI provider
// ────────────────────────────────────────────────────────────

class OpenAIModel implements ILLMModel {
  id: string;
  family: string;

  constructor(
    private client: any, // OpenAI instance
    private modelName: string,
  ) {
    this.id = modelName;
    this.family = modelName.split("-")[0]; // e.g. "gpt" from "gpt-4o-mini"
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelName,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      },
      { signal },
    );

    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of stream) {
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        }
      },
    };
  }
}

export class OpenAILLMProvider implements ILLMProvider {
  private logger = new Logger("OpenAILLMProvider");
  private client: any = null;

  constructor(
    private apiKey: string,
    private defaultModel: string,
    private baseUrl?: string,
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
      return new OpenAIModel(client, modelName);
    } catch (error) {
      this.logger.error("Failed to create OpenAI model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.models.list();
      return true;
    } catch {
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
  ) {
    this.id = modelName;
    this.family = modelName.split("-")[0]; // e.g. "claude" from "claude-sonnet-4-20250514"
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Anthropic uses a system parameter instead of a system message
    let systemPrompt: string | undefined;
    const chatMessages: Array<{ role: string; content: string }> = [];

    for (const m of messages) {
      if (m.role === "system") {
        systemPrompt = m.content;
      } else {
        chatMessages.push({ role: m.role, content: m.content });
      }
    }

    const stream = this.client.messages.stream(
      {
        model: this.modelName,
        max_tokens: 4096,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: chatMessages,
      },
      ...(signal ? [{ signal }] : []),
    );

    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            yield event.delta.text;
          }
        }
      },
    };
  }
}

export class AnthropicLLMProvider implements ILLMProvider {
  private logger = new Logger("AnthropicLLMProvider");
  private client: any = null;

  constructor(
    private apiKey: string,
    private defaultModel: string,
  ) {}

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      const modelName = options?.family ?? this.defaultModel;
      return new AnthropicModel(client, modelName);
    } catch (error) {
      this.logger.error("Failed to create Anthropic model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getClient();
      return true;
    } catch {
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
  ) {
    this.id = modelName;
    this.family = "ollama";
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelName,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      },
      { signal },
    );

    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of stream) {
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        }
      },
    };
  }
}

export class OllamaLLMProvider implements ILLMProvider {
  private logger = new Logger("OllamaLLMProvider");
  private client: any = null;

  constructor(
    private baseUrl: string,
    private defaultModel: string,
  ) {}

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: OpenAI } = await import("openai");
      this.client = new OpenAI({
        baseURL: `${this.baseUrl}/v1`,
        apiKey: "ollama", // Ollama doesn't require a real key
      });
    }
    return this.client;
  }

  async selectModel(options?: { family?: string }): Promise<ILLMModel | null> {
    try {
      const client = await this.getClient();
      const modelName = options?.family ?? this.defaultModel;
      return new OllamaModel(client, modelName);
    } catch (error) {
      this.logger.error("Failed to create Ollama model", error);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.models.list();
      return true;
    } catch {
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
      const openaiModel = config.llmModel || "gpt-4o-mini";
      logger.info(`Using OpenAI provider (model: ${openaiModel}${config.llmBaseUrl ? `, baseUrl: ${config.llmBaseUrl}` : ""})`);
      return new OpenAILLMProvider(config.llmApiKey, openaiModel, config.llmBaseUrl || undefined);
    }

    case "anthropic": {
      if (!config.llmApiKey) {
        logger.warn("Anthropic selected but RAGNAROK_LLM_API_KEY not set — LLM features disabled");
        return new NullProvider();
      }
      const anthropicModel = config.llmModel || "claude-sonnet-4-20250514";
      logger.info(`Using Anthropic provider (model: ${anthropicModel})`);
      return new AnthropicLLMProvider(config.llmApiKey, anthropicModel);
    }

    case "ollama": {
      const ollamaModel = config.llmModel || "llama3";
      logger.info(`Using Ollama provider (model: ${ollamaModel}, url: ${config.llmBaseUrl})`);
      return new OllamaLLMProvider(config.llmBaseUrl, ollamaModel);
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
