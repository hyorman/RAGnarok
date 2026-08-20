/**
 * VectorRetriever - Pure vector similarity search with score normalization
 *
 * Wraps a LangChain VectorStore and normalizes LanceDB squared-L2 distances
 * to [0,1] similarity scores.
 * Used as a building block by HybridRetriever.
 */

import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../logger";
import { lanceDistanceToSimilarity } from "../utils/vectorMath";

export interface VectorSearchResult {
  document: LangChainDocument;
  score: number;
  scoreKind: "vector_similarity";
  componentScores: { vector: number };
}

/**
 * Vector retriever for pure semantic similarity search
 */
export class VectorRetriever {
  private logger: Logger;
  private vectorStore: VectorStore;

  constructor(vectorStore: VectorStore) {
    this.logger = new Logger("VectorRetriever");
    this.vectorStore = vectorStore;
  }

  /**
   * Perform vector similarity search with normalized scores
   */
  public async search(query: string, k: number): Promise<VectorSearchResult[]> {
    this.logger.debug("Starting vector search", {
      query: query.substring(0, 100),
      k,
    });

    const results = await this.vectorStore.similaritySearchWithScore(query, k);

    return results.map(([doc, distance]) => {
      const score = this.normalizeDistance(distance, doc);
      return {
        document: doc,
        score,
        scoreKind: "vector_similarity" as const,
        componentScores: { vector: score },
      };
    });
  }

  /**
   * Perform vector similarity search returning documents only (no scores).
   * Useful for rank-based fusion (e.g. RRF) where only ordering matters.
   */
  public async getDocuments(query: string, k: number): Promise<LangChainDocument[]> {
    return this.vectorStore.similaritySearch(query, k);
  }

  /**
   * Update the underlying vector store
   */
  public setVectorStore(vectorStore: VectorStore): void {
    this.vectorStore = vectorStore;
    this.logger.debug("Vector store updated");
  }

  /**
   * Normalize LanceDB squared-L2 distance to a similarity score in [0, 1].
   *
   * For unit-normalized embeddings (e.g., all-MiniLM-L6-v2), LanceDB's
   * squared-L2 distance falls in [0, 4]:
   *   0 = identical vectors, 2 = orthogonal vectors, 4 = opposite vectors.
   *
   * Formula: similarity = 1 - (distance / 2), clamped to [0, 1].
   */
  private normalizeDistance(distance: number | undefined, doc: LangChainDocument): number {
    let d: number | undefined = distance;
    if (d === undefined || !Number.isFinite(d)) {
      const metadataDistance = doc.metadata?._distance;
      d = typeof metadataDistance === "number" ? metadataDistance : undefined;
    }

    return lanceDistanceToSimilarity(d);
  }
}
