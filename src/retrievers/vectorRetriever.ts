/**
 * VectorRetriever - Pure vector similarity search with score normalization
 *
 * Wraps a LangChain VectorStore and normalizes L2 distances to [0,1] similarity scores.
 * Used as a building block by HybridRetriever and EnsembleRetriever.
 */

import { VectorStore } from '@langchain/core/vectorstores';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { Logger } from '../utils/logger';

export interface VectorSearchResult {
  document: LangChainDocument;
  score: number;
}

/**
 * Vector retriever for pure semantic similarity search
 */
export class VectorRetriever {
  private logger: Logger;
  private vectorStore: VectorStore;

  constructor(vectorStore: VectorStore) {
    this.logger = new Logger('VectorRetriever');
    this.vectorStore = vectorStore;
  }

  /**
   * Perform vector similarity search with normalized scores
   */
  public async search(query: string, k: number = 5): Promise<VectorSearchResult[]> {
    this.logger.debug('Starting vector search', {
      query: query.substring(0, 100),
      k,
    });

    const results = await this.vectorStore.similaritySearchWithScore(query, k);

    return results.map(([doc, distance]) => ({
      document: doc,
      score: this.normalizeDistance(distance, doc),
    }));
  }

  /**
   * Perform vector similarity search returning documents only (no scores).
   * Useful for rank-based fusion (e.g. RRF) where only ordering matters.
   */
  public async getDocuments(query: string, k: number = 5): Promise<LangChainDocument[]> {
    return this.vectorStore.similaritySearch(query, k);
  }

  /**
   * Update the underlying vector store
   */
  public setVectorStore(vectorStore: VectorStore): void {
    this.vectorStore = vectorStore;
    this.logger.debug('Vector store updated');
  }

  /**
   * Normalize LanceDB L2 distance to a similarity score in [0, 1].
   *
   * LanceDB returns L2 (Euclidean) distance by default. For unit-normalized
   * embeddings (e.g., all-MiniLM-L6-v2), L2 distance falls in [0, 2]:
   *   0 = identical vectors, 2 = opposite vectors.
   *
   * Formula: similarity = 1 - (distance / 2), clamped to [0, 1].
   */
  private normalizeDistance(
    distance: number | undefined,
    doc: LangChainDocument
  ): number {
    let d: number | undefined = distance;
    if (d === undefined || isNaN(d)) {
      d = doc.metadata?._distance;
    }

    if (d === undefined || isNaN(d) || !isFinite(d)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, 1 - d / 2));
  }
}
