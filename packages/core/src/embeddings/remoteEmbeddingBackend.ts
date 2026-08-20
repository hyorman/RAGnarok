/**
 * Remote embedding backend
 *
 * Calls external embedding APIs over HTTP. Supports OpenAI-compatible
 * and Ollama embedding endpoints.
 */

import { EmbeddingBackend } from "./embeddingBackend";
import { Logger } from "../logger";
import { createHash } from "crypto";

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
  private switchSnapshot: { modelName: string | null; dimension: number | null } | null = null;
  private logger: Logger;

  constructor(options: { baseUrl: string; apiKey?: string; format: RemoteEmbeddingFormat; modelName?: string }) {
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
    const candidateModel = modelName ?? this.modelName;
    if (!candidateModel) {
      throw new Error("Remote embedding backend requires a model name — set it via constructor or initialize()");
    }

    // Publish only after all synchronous validation succeeds. A rejected
    // switch must not overwrite the last usable model identifier.
    this.modelName = candidateModel;
    this.logger.info(`Using remote model "${candidateModel}"`);
  }

  beginSwitchTransaction(): void {
    this.switchSnapshot = { modelName: this.modelName, dimension: this.dimension };
  }

  commitSwitchTransaction(): void {
    this.switchSnapshot = null;
  }

  rollbackSwitchTransaction(): void {
    if (this.switchSnapshot) {
      this.modelName = this.switchSnapshot.modelName;
      this.dimension = this.switchSnapshot.dimension;
      this.switchSnapshot = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) {
      return false;
    }
    try {
      const url = this.format === "openai" ? `${this.baseUrl}/models` : `${this.baseUrl}/api/tags`;
      const response = await this.fetchWithTimeout(url, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.callEmbedEndpoint([text || " "], signal);
    return results[0];
  }

  async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    if (texts.length === 0) {
      progressCallback?.(1);
      return [];
    }
    const sanitized = texts.map((t) => t || " ");
    if (sanitized.length <= BATCH_SIZE) {
      const result = await this.callEmbedEndpoint(sanitized, signal);
      progressCallback?.(1);
      return result;
    }

    // Split into sub-batches for large inputs
    const results: number[][] = [];
    for (let i = 0; i < sanitized.length; i += BATCH_SIZE) {
      const batch = sanitized.slice(i, i + BATCH_SIZE);
      signal?.throwIfAborted();
      const batchResults = await this.callEmbedEndpoint(batch, signal);
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

  getFingerprintInfo(): { providerFormat: string; revision: string; endpointHash: string } {
    return {
      providerFormat: this.format,
      revision: "remote",
      endpointHash: createHash("sha256").update(this.baseUrl.toLowerCase()).digest("hex"),
    };
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

  private async callEmbedEndpoint(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.modelName) {
      throw new Error("Model not configured — call initialize() first");
    }

    if (this.format === "openai") {
      return this.embedOpenAI(texts, signal);
    }
    return this.embedOllama(texts, signal);
  }

  private async embedOpenAI(texts: string[], signal?: AbortSignal): Promise<number[][]> {
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
      signal,
    });

    await this.ensureOk(response, "OpenAI embeddings");

    const json: any = await response.json();
    if (!Array.isArray(json?.data)) {
      throw new Error("OpenAI embeddings response is missing the data array");
    }
    if (json.data.length !== texts.length) {
      throw new Error(`OpenAI embeddings returned ${json.data.length} result(s); expected ${texts.length}`);
    }
    const indices = new Set<number>();
    for (const item of json.data) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= texts.length || indices.has(item.index)) {
        throw new Error("OpenAI embeddings response contains invalid or duplicate indices");
      }
      indices.add(item.index);
    }
    const sorted = [...(json.data as Array<{ embedding: number[]; index: number }>)].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);
    this.validateEmbeddings(embeddings, texts.length, "OpenAI");
    this.cacheDimension(embeddings);
    return embeddings;
  }

  private async embedOllama(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const body = {
      model: this.modelName,
      input: texts.length === 1 ? texts[0] : texts,
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    await this.ensureOk(response, "Ollama embeddings");

    const json: any = await response.json();
    const embeddings: number[][] = json?.embeddings;
    this.validateEmbeddings(embeddings, texts.length, "Ollama");
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

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetch(url, { ...init, signal });
    } catch (error: unknown) {
      if (init.signal?.aborted) {
        throw init.signal.reason ?? error;
      }
      if (timeoutSignal.aborted) {
        throw new Error(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(`Network error connecting to ${url}: ${error instanceof Error ? error.message : String(error)}`);
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
      throw new Error(`${context} request failed (HTTP ${response.status}): ${detail}`.trim());
    }
  }

  private cacheDimension(embeddings: number[][]): void {
    if (this.dimension === null && embeddings.length > 0 && embeddings[0].length > 0) {
      this.dimension = embeddings[0].length;
      this.logger.debug(`Cached embedding dimension: ${this.dimension}`);
    }
  }

  private validateEmbeddings(value: unknown, expectedCount: number, provider: string): asserts value is number[][] {
    if (!Array.isArray(value) || value.length !== expectedCount) {
      throw new Error(
        `${provider} embeddings returned ${Array.isArray(value) ? value.length : "an invalid payload"}; expected ${expectedCount}`,
      );
    }
    let dimension: number | null = null;
    value.forEach((vector, index) => {
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`${provider} embedding at index ${index} is empty or invalid`);
      }
      if (!vector.every((component) => typeof component === "number" && Number.isFinite(component))) {
        throw new Error(`${provider} embedding at index ${index} contains a non-finite value`);
      }
      dimension ??= vector.length;
      if (vector.length !== dimension) {
        throw new Error(
          `${provider} embeddings have inconsistent dimensions: expected ${dimension}, got ${vector.length} at index ${index}`,
        );
      }
    });
    if (this.dimension !== null && dimension !== null && dimension !== this.dimension) {
      throw new Error(`${provider} embedding dimension changed from ${this.dimension} to ${dimension}`);
    }
  }
}
