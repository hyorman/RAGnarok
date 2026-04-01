/**
 * Remote embedding backend
 *
 * Calls external embedding APIs over HTTP. Supports OpenAI-compatible
 * and Ollama embedding endpoints.
 */

import { EmbeddingBackend } from "./embeddingBackend";
import { Logger } from "../logger";

export type RemoteEmbeddingFormat = "openai" | "ollama";

const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Remote HTTP-based backend implementing {@link EmbeddingBackend}.
 *
 * Sends embedding requests to an external API server (OpenAI or Ollama format).
 */
export class RemoteEmbeddingBackend implements EmbeddingBackend {
  readonly name = "remote" as const;

  private baseUrl: string;
  private apiKey: string | undefined;
  private format: RemoteEmbeddingFormat;
  private modelName: string | null;
  private dimension: number | null = null;
  private logger: Logger;

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    format: RemoteEmbeddingFormat;
    modelName?: string;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.format = options.format;
    this.modelName = options.modelName ?? null;
    this.logger = new Logger("RemoteEmbeddingBackend");
  }

  // ---------------------------------------------------------------------------
  // EmbeddingBackend interface
  // ---------------------------------------------------------------------------

  async initialize(modelName?: string): Promise<void> {
    if (modelName) {
      this.modelName = modelName;
    }

    if (!this.modelName) {
      throw new Error("Remote embedding backend requires a model name — set it via constructor or initialize()");
    }

    this.logger.info(`Using remote model "${this.modelName}"`);
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) {
      return false;
    }
    try {
      const url =
        this.format === "openai"
          ? `${this.baseUrl}/models`
          : `${this.baseUrl}/api/tags`;
      const response = await this.fetchWithTimeout(url, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.callEmbedEndpoint([text || ' ']);
    return results[0];
  }

  async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void,
  ): Promise<number[][]> {
    const sanitized = texts.map((t) => t || ' ');
    if (sanitized.length <= BATCH_SIZE) {
      const result = await this.callEmbedEndpoint(sanitized);
      progressCallback?.(1);
      return result;
    }

    // Split into sub-batches for large inputs
    const results: number[][] = [];
    for (let i = 0; i < sanitized.length; i += BATCH_SIZE) {
      const batch = sanitized.slice(i, i + BATCH_SIZE);
      const batchResults = await this.callEmbedEndpoint(batch);
      results.push(...batchResults);
      progressCallback?.(Math.min((i + batch.length) / sanitized.length, 1));
    }
    return results;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  getModelId(): string | null {
    return this.modelName;
  }

  dispose(): void {
    // Stateless HTTP client — nothing to release
  }

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch available models from the remote server.
   */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    if (this.format === "openai") {
      return this.listModelsOpenAI();
    }
    return this.listModelsOllama();
  }

  // ---------------------------------------------------------------------------
  // Private – API calls
  // ---------------------------------------------------------------------------

  private async callEmbedEndpoint(texts: string[]): Promise<number[][]> {
    if (!this.modelName) {
      throw new Error("Model not configured — call initialize() first");
    }

    if (this.format === "openai") {
      return this.embedOpenAI(texts);
    }
    return this.embedOllama(texts);
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const body = {
      input: texts.length === 1 ? texts[0] : texts,
      model: this.modelName,
      encoding_format: "float",
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    await this.ensureOk(response, "OpenAI embeddings");

    const json: any = await response.json();
    const sorted = (json.data as Array<{ embedding: number[]; index: number }>)
      .sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);
    this.cacheDimension(embeddings);
    return embeddings;
  }

  private async embedOllama(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const body = {
      model: this.modelName,
      input: texts.length === 1 ? texts[0] : texts,
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await this.ensureOk(response, "Ollama embeddings");

    const json: any = await response.json();
    const embeddings: number[][] = json.embeddings;
    this.cacheDimension(embeddings);
    return embeddings;
  }

  private async listModelsOpenAI(): Promise<Array<{ id: string; name: string }>> {
    const url = `${this.baseUrl}/models`;
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.buildHeaders(),
    });

    await this.ensureOk(response, "OpenAI list models");

    const json: any = await response.json();
    return (json.data as Array<{ id: string }>).map((m) => ({
      id: m.id,
      name: m.id,
    }));
  }

  private async listModelsOllama(): Promise<Array<{ id: string; name: string }>> {
    const url = `${this.baseUrl}/api/tags`;
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
    });

    await this.ensureOk(response, "Ollama list models");

    const json: any = await response.json();
    return (json.models as Array<{ name: string; model: string }>).map((m) => ({
      id: m.model ?? m.name,
      name: m.name,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private – utilities
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(
        `Network error connecting to ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureOk(response: Response, context: string): Promise<void> {
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore read errors
      }
      throw new Error(
        `${context} request failed (HTTP ${response.status}): ${detail}`.trim(),
      );
    }
  }

  private cacheDimension(embeddings: number[][]): void {
    if (this.dimension === null && embeddings.length > 0 && embeddings[0].length > 0) {
      this.dimension = embeddings[0].length;
      this.logger.debug(`Cached embedding dimension: ${this.dimension}`);
    }
  }
}
