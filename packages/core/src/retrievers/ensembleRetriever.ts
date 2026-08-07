/**
 * Ensemble Retriever - Composite retriever using Reciprocal Rank Fusion
 *
 * Delegates retrieval to VectorRetriever and KeywordRetriever,
 * then applies RRF rank fusion across both arms to produce a single ranked list.
 * Unlike HybridRetriever which uses weighted score fusion, EnsembleRetriever fuses
 * by rank position.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { VectorRetriever } from "./vectorRetriever";
import { KeywordRetriever } from "./keywordRetriever";
import { Logger } from "../logger";
import { extractKeywords } from "../utils/keywords";
import { getDocumentIdentity } from "../utils/retrievalIdentity";

export interface EnsembleSearchOptions {
  /** Number of results to return */
  k: number;
  /** Weight for vector retriever (0-1) */
  vectorWeight: number;
  /** Weight for BM25 retriever (0-1) */
  bm25Weight: number;
  /** RRF constant (default 60). Lower values (20-30) may work better for small corpora */
  rrfK?: number;
}

/** Default ensemble search options (weights) */
export const DEFAULT_ENSEMBLE_OPTIONS = {
  vectorWeight: 0.5,
  bm25Weight: 0.5,
} as const;

export interface EnsembleSearchResult {
  document: LangChainDocument;
  /** Weighted reciprocal-rank-fusion score. */
  score: number;
  scoreKind: "rrf";
  /** Per-arm RRF contributions; these sum exactly to score. */
  componentScores: { vector: number; keyword: number };
}

/**
 * Ensemble retriever using RRF to combine vector and keyword search
 */
export class EnsembleRetrieverWrapper {
  private logger: Logger;
  private vectorRetriever: VectorRetriever;
  private keywordRetriever: KeywordRetriever;

  private readonly RRF_CONSTANT: number;

  constructor(vectorRetriever: VectorRetriever, keywordRetriever: KeywordRetriever, rrfK = 60) {
    if (!Number.isFinite(rrfK) || rrfK <= 0) {
      throw new Error("RRF constant must be a finite positive number");
    }
    this.logger = new Logger("EnsembleRetriever");
    this.vectorRetriever = vectorRetriever;
    this.keywordRetriever = keywordRetriever;
    this.RRF_CONSTANT = rrfK;
    this.logger.info("EnsembleRetriever initialized");
  }

  /**
   * Perform ensemble search using manual RRF
   */
  public async search(query: string, options: EnsembleSearchOptions): Promise<EnsembleSearchResult[]> {
    this.validateOptions(options);
    if (!this.keywordRetriever.isInitialized()) {
      throw new Error("EnsembleRetriever not initialized. KeywordRetriever must be initialized first.");
    }

    const startTime = Date.now();

    const k = options.k;
    let vectorWeight = options.vectorWeight;
    let bm25Weight = options.bm25Weight;

    if (vectorWeight < 0 || bm25Weight < 0) {
      throw new Error("Weights must be non-negative");
    }
    // Normalize if they don't sum to ~1.0
    const totalWeight = vectorWeight + bm25Weight;
    if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 0.01) {
      vectorWeight = vectorWeight / totalWeight;
      bm25Weight = bm25Weight / totalWeight;
    }

    this.logger.info("Starting ensemble search with manual RRF", {
      query: query.substring(0, 100),
      k,
      vectorWeight,
      bm25Weight,
    });

    try {
      // Fetch extra documents for re-ranking
      const fetchCount = k * 3;

      // Get results from both retrievers in parallel
      // Vector arm gets natural language for optimal embedding quality;
      // BM25 arm gets keyword-extracted query for better term matching.
      const bm25Query = extractKeywords(query).join(" ") || query;

      const [vectorResults, bm25Results] = await Promise.all([
        this.vectorRetriever.getDocuments(query, fetchCount),
        this.keywordRetriever.search(bm25Query, fetchCount),
      ]);

      // Apply Reciprocal Rank Fusion (RRF)
      const rrfK = options.rrfK ?? this.RRF_CONSTANT;
      const fusedResults = this.reciprocalRankFusion(
        vectorResults,
        bm25Results.map((r) => r.document),
        vectorWeight,
        bm25Weight,
        rrfK,
      );

      // Limit to k results
      const limitedResults = fusedResults.slice(0, k);

      const searchTime = Date.now() - startTime;

      this.logger.info("Ensemble search complete", {
        resultCount: limitedResults.length,
        searchTime,
      });

      // Convert to our result format
      return limitedResults;
    } catch (error) {
      this.logger.error("Ensemble search failed", {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  private validateOptions(options: EnsembleSearchOptions): void {
    if (!Number.isInteger(options.k) || options.k <= 0) {
      throw new Error("k must be a positive integer");
    }
    if (!Number.isFinite(options.vectorWeight) || !Number.isFinite(options.bm25Weight)) {
      throw new Error("Weights must be finite");
    }
    if (options.vectorWeight < 0 || options.bm25Weight < 0) {
      throw new Error("Weights must be non-negative");
    }
    if (options.vectorWeight + options.bm25Weight <= 0) {
      throw new Error("At least one retrieval weight must be positive");
    }
    if (options.rrfK !== undefined && (!Number.isFinite(options.rrfK) || options.rrfK <= 0)) {
      throw new Error("RRF constant must be a finite positive number");
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
    bm25Weight: number,
    rrfK: number,
  ): EnsembleSearchResult[] {
    const scoreMap = new Map<
      string,
      { doc: LangChainDocument; vectorContribution: number; keywordContribution: number }
    >();

    vectorResults.forEach((doc, index) => {
      const docId = this.getDocumentId(doc);
      const rrf = vectorWeight / (rrfK + index + 1);
      if (scoreMap.has(docId)) {
        scoreMap.get(docId)!.vectorContribution += rrf;
      } else {
        scoreMap.set(docId, { doc, vectorContribution: rrf, keywordContribution: 0 });
      }
    });

    bm25Results.forEach((doc, index) => {
      const docId = this.getDocumentId(doc);
      const rrf = bm25Weight / (rrfK + index + 1);
      if (scoreMap.has(docId)) {
        scoreMap.get(docId)!.keywordContribution += rrf;
      } else {
        scoreMap.set(docId, { doc, vectorContribution: 0, keywordContribution: rrf });
      }
    });

    return Array.from(scoreMap.values())
      .map((item) => ({
        document: item.doc,
        score: item.vectorContribution + item.keywordContribution,
        scoreKind: "rrf" as const,
        componentScores: {
          vector: item.vectorContribution,
          keyword: item.keywordContribution,
        },
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Get a unique ID for a document
   */
  private getDocumentId(doc: LangChainDocument): string {
    return getDocumentIdentity(doc);
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
