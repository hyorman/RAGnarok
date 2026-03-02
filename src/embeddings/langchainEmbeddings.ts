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
import { Logger } from "../utils/logger";

/**
 * LangChain Embeddings implementation backed by EmbeddingService.
 * Works with any backend (HuggingFace Transformers.js or VS Code LM).
 */
export class TransformersEmbeddings extends Embeddings {
  private embeddingService: EmbeddingService;
  private modelName?: string;
  private logger: Logger;

  constructor(fields?: EmbeddingsParams & { modelName?: string }) {
    super(fields ?? {});
    this.embeddingService = EmbeddingService.getInstance();
    this.modelName = fields?.modelName;
    this.logger = new Logger("TransformersEmbeddings");
  }

  /**
   * Embed a list of documents (batch operation)
   */
  async embedDocuments(documents: string[]): Promise<number[][]> {
    // Ensure the embedding service is initialized with the configured model
    await this.embeddingService.initialize(this.modelName);

    // Use the batch embedding method for efficiency
    return await this.embeddingService.embedBatch(documents);
  }

  /**
   * Embed a single query text
   */
  async embedQuery(query: string): Promise<number[]> {
    // Ensure the embedding service is initialized with the configured model
    await this.embeddingService.initialize(this.modelName);

    this.logger.debug("Embedding query", {
      model: this.modelName || "default",
      queryPreview: query.substring(0, 50) + (query.length > 50 ? "..." : "")
    });

    return await this.embeddingService.embed(query);
  }
}
