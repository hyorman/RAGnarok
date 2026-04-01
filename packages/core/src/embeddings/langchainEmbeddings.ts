/**
 * LangChain-compatible wrapper for EmbeddingService
 *
 * This allows us to use our pluggable embedding backends (HuggingFace or
 * VS Code LM) with LangChain's vector stores and other components.
 *
 * The wrapper is backend-agnostic — it delegates to EmbeddingService which
 * internally routes to the configured backend (see embeddingBackend.ts).
 */

import { Embeddings, EmbeddingsParams } from "@langchain/core/embeddings";
import { EmbeddingService } from "./embeddingService";
import { Logger } from "../logger";

/**
 * LangChain Embeddings implementation backed by EmbeddingService.
 * Works with any backend (HuggingFace Transformers.js or VS Code LM).
 */
export class TransformersEmbeddings extends Embeddings {
  private embeddingService: EmbeddingService;
  private modelName?: string;
  /** When set, queries use this specific backend instead of the global active one. */
  private backendType?: string;
  private logger: Logger;
  private initialized = false;

  constructor(fields?: EmbeddingsParams & { modelName?: string; backendType?: string; embeddingService?: EmbeddingService }) {
    super(fields ?? {});
    if (!fields?.embeddingService) {
      throw new Error("EmbeddingService must be provided");
    }
    this.embeddingService = fields.embeddingService;
    this.modelName = fields?.modelName;
    this.backendType = fields?.backendType;
    this.logger = new Logger("TransformersEmbeddings");
  }

  /**
   * Embed a list of documents (batch operation)
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      if (this.backendType) {
        // Scoped init: ensure the specific backend is ready
        await this.embeddingService.initializeForBackend(this.backendType, this.modelName);
      } else {
        await this.embeddingService.initialize(this.modelName);
      }
      this.initialized = true;
    }
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    await this.ensureInitialized();

    if (this.backendType) {
      return await this.embeddingService.embedBatchWithBackend(this.backendType, documents);
    }
    return await this.embeddingService.embedBatch(documents);
  }

  /**
   * Embed a single query text
   */
  async embedQuery(query: string): Promise<number[]> {
    await this.ensureInitialized();

    this.logger.debug("Embedding query", {
      model: this.modelName || "default",
      backend: this.backendType || "active",
      queryPreview: query.substring(0, 50) + (query.length > 50 ? "..." : ""),
    });

    if (this.backendType) {
      return await this.embeddingService.embedWithBackend(this.backendType, query);
    }
    return await this.embeddingService.embed(query);
  }
}
