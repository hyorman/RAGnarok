/**
 * Ensemble Retriever - Composite retriever using Reciprocal Rank Fusion
 *
 * Delegates retrieval to VectorRetriever and KeywordRetriever, then applies
 * RRF rank fusion to produce a single ranked list. Unlike HybridRetriever
 * which uses weighted score fusion, EnsembleRetriever fuses by rank position.
 */

import { createHash } from 'crypto';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { VectorRetriever } from './vectorRetriever';
import { KeywordRetriever } from './keywordRetriever';
import { Logger } from '../utils/logger';

export interface EnsembleSearchOptions {
  /** Number of results to return */
  k?: number;

  /** Weight for vector retriever (0-1, default 0.7) */
  vectorWeight?: number;

  /** Weight for BM25 retriever (0-1, default 0.3) */
  bm25Weight?: number;
}

export interface EnsembleSearchResult {
  document: LangChainDocument;
  score?: number; // Note: EnsembleRetriever doesn't return scores
}

/**
 * Ensemble retriever using RRF to combine vector and keyword search
 */
export class EnsembleRetrieverWrapper {
  private logger: Logger;
  private vectorRetriever: VectorRetriever;
  private keywordRetriever: KeywordRetriever;

  private readonly DEFAULT_K = 5;
  private readonly DEFAULT_VECTOR_WEIGHT = 0.7;
  private readonly DEFAULT_BM25_WEIGHT = 0.3;
  private readonly RRF_CONSTANT = 60; // Standard RRF constant

  constructor(vectorRetriever: VectorRetriever, keywordRetriever: KeywordRetriever) {
    this.logger = new Logger('EnsembleRetriever');
    this.vectorRetriever = vectorRetriever;
    this.keywordRetriever = keywordRetriever;
    this.logger.info('EnsembleRetriever initialized');
  }

  /**
   * Perform ensemble search using manual RRF
   */
  public async search(
    query: string,
    options: EnsembleSearchOptions = {}
  ): Promise<EnsembleSearchResult[]> {
    if (!this.keywordRetriever.isInitialized()) {
      throw new Error('EnsembleRetriever not initialized. KeywordRetriever must be initialized first.');
    }

    const startTime = Date.now();
    const k = options.k || this.DEFAULT_K;
    let vectorWeight = options.vectorWeight ?? this.DEFAULT_VECTOR_WEIGHT;
    let bm25Weight = options.bm25Weight ?? this.DEFAULT_BM25_WEIGHT;

    if (vectorWeight < 0 || bm25Weight < 0) {
      throw new Error('Weights must be non-negative');
    }
    // Normalize if they don't sum to ~1.0
    const totalWeight = vectorWeight + bm25Weight;
    if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 0.01) {
      vectorWeight = vectorWeight / totalWeight;
      bm25Weight = bm25Weight / totalWeight;
    }

    this.logger.info('Starting ensemble search with manual RRF', {
      query: query.substring(0, 100),
      k,
      vectorWeight,
      bm25Weight,
    });

    try {
      // Fetch extra documents for re-ranking
      const fetchCount = k * 3;

      // Get results from both retrievers in parallel
      const [vectorResults, bm25Results] = await Promise.all([
        this.vectorRetriever.getDocuments(query, fetchCount),
        this.keywordRetriever.search(query, fetchCount),
      ]);

      // Apply Reciprocal Rank Fusion (RRF)
      const fusedResults = this.reciprocalRankFusion(
        vectorResults,
        bm25Results.map(r => r.document),
        vectorWeight,
        bm25Weight
      );

      // Limit to k results
      const limitedResults = fusedResults.slice(0, k);

      const searchTime = Date.now() - startTime;

      this.logger.info('Ensemble search complete', {
        resultCount: limitedResults.length,
        searchTime,
      });

      // Convert to our result format
      return limitedResults.map((doc: LangChainDocument) => ({
        document: doc,
        // Note: RRF doesn't provide meaningful scores
      }));
    } catch (error) {
      this.logger.error('Ensemble search failed', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  // ==================== Private Methods ====================

  /**
   * Reciprocal Rank Fusion algorithm
   * Combines rankings from multiple retrievers
   */
  private reciprocalRankFusion(
    vectorResults: LangChainDocument[],
    bm25Results: LangChainDocument[],
    vectorWeight: number,
    bm25Weight: number
  ): LangChainDocument[] {
    // Create a map of document ID -> RRF score
    const scoreMap = new Map<string, { doc: LangChainDocument; score: number }>();

    // Add vector results with their ranks
    vectorResults.forEach((doc, index) => {
      const docId = this.getDocumentId(doc);
      const rrf = vectorWeight / (this.RRF_CONSTANT + index + 1);

      if (scoreMap.has(docId)) {
        scoreMap.get(docId)!.score += rrf;
      } else {
        scoreMap.set(docId, { doc, score: rrf });
      }
    });

    // Add BM25 results with their ranks
    bm25Results.forEach((doc, index) => {
      const docId = this.getDocumentId(doc);
      const rrf = bm25Weight / (this.RRF_CONSTANT + index + 1);

      if (scoreMap.has(docId)) {
        scoreMap.get(docId)!.score += rrf;
      } else {
        scoreMap.set(docId, { doc, score: rrf });
      }
    });

    // Sort by RRF score (descending)
    const rankedResults = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map((item) => item.doc);

    return rankedResults;
  }

  /**
   * Get a unique ID for a document
   */
  private getDocumentId(doc: LangChainDocument): string {
    if (doc.metadata?.chunkId) return String(doc.metadata.chunkId);
    const hash = createHash('sha256');
    hash.update(doc.pageContent);
    hash.update(JSON.stringify(doc.metadata || {}));
    return hash.digest('hex');
  }

  /**
   * Check if the retriever is ready (keyword retriever initialized)
   */
  public isInitialized(): boolean {
    return this.keywordRetriever.isInitialized();
  }

  /**
   * Get document count from keyword retriever
   */
  public getDocumentCount(): number {
    return this.keywordRetriever.getDocumentCount();
  }
}
