/**
 * Hybrid Retriever - Composite retriever combining vector and keyword search
 *
 * Delegates retrieval to VectorRetriever and KeywordRetriever, then applies
 * weighted score fusion to produce a single ranked list.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { VectorRetriever } from "./vectorRetriever";
import { KeywordRetriever } from "./keywordRetriever";
import { Logger } from "../logger";
import { extractKeywords } from "../utils/keywords";
import { getDocumentIdentity } from "../utils/retrievalIdentity";

export interface HybridSearchOptions {
  /** Number of results to return */
  k: number;
  /** Weight for vector similarity (0-1) */
  vectorWeight: number;
  /** Weight for keyword matching (0-1) */
  keywordWeight: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity: number;
  /** Enable keyword boosting */
  keywordBoosting?: boolean;
}

/** Default hybrid search options (weights and threshold) */
export const DEFAULT_HYBRID_OPTIONS = {
  vectorWeight: 0.9,
  keywordWeight: 0.1,
  minSimilarity: 0.0,
} as const;

export interface HybridSearchResult {
  document: LangChainDocument;
  score: number;
  vectorScore: number;
  keywordScore: number;
  scoreKind: "weighted_fusion" | "vector_similarity";
  componentScores: { vector?: number; keyword?: number };
  explanation?: string;
}

/**
 * Hybrid retriever combining vector and keyword search with weighted score fusion
 */
export class HybridRetriever {
  private logger: Logger;
  private vectorRetriever: VectorRetriever;
  private keywordRetriever: KeywordRetriever;

  constructor(vectorRetriever: VectorRetriever, keywordRetriever: KeywordRetriever) {
    this.logger = new Logger("HybridRetriever");
    this.vectorRetriever = vectorRetriever;
    this.keywordRetriever = keywordRetriever;

    this.logger.info("HybridRetriever initialized");
  }

  /**
   * Perform hybrid search combining vector and keyword search
   */
  public async search(query: string, options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const startTime = Date.now();

    const k = options.k;
    this.validateOptions(options);
    const totalWeight = options.vectorWeight + options.keywordWeight;
    const vectorWeight = options.vectorWeight / totalWeight;
    const keywordWeight = options.keywordWeight / totalWeight;
    const minSimilarity = options.minSimilarity;

    this.logger.info("Starting hybrid search", {
      query: query.substring(0, 100),
      k,
      vectorWeight,
      keywordWeight,
    });

    try {
      // Step 1: Fetch vector candidates (more than needed for re-ranking)
      const candidateCount = k * 3;
      const vectorResults = await this.vectorRetriever.search(query, candidateCount);

      this.logger.debug("Vector search complete", {
        candidateCount: vectorResults.length,
      });

      // Step 2: Extract keywords
      const keywords = extractKeywords(query);

      this.logger.debug("Keywords extracted", {
        keywords,
        count: keywords.length,
      });

      // Step 3: Build candidate map from vector results
      const candidateMap = new Map<string, { doc: LangChainDocument; vectorScore?: number }>();
      for (const { document: doc, score: vectorScore } of vectorResults) {
        const key = getDocumentIdentity(doc);
        if (!candidateMap.has(key)) {
          candidateMap.set(key, { doc, vectorScore });
        }
      }

      // Step 4: Fetch BM25 candidates and their scores
      const bm25ScoreMap = new Map<string, number>();
      if (this.keywordRetriever.isInitialized()) {
        const bm25Query = keywords.join(" ") || query;
        const bm25Results = await this.keywordRetriever.search(bm25Query, candidateCount);

        // Build a map of BM25 scores for all BM25 results
        for (const { document: doc, score: bm25Score } of bm25Results) {
          const key = getDocumentIdentity(doc);
          bm25ScoreMap.set(key, bm25Score);
        }

        let bm25Added = 0;
        for (const { document: doc } of bm25Results) {
          const key = getDocumentIdentity(doc);
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { doc });
            bm25Added++;
          }
        }
        this.logger.debug("BM25 candidates merged", {
          bm25Total: bm25Results.length,
          bm25Added,
          totalCandidates: candidateMap.size,
        });
      }

      // Step 5: Score all candidates with hybrid formula
      // Normalize BM25 scores to [0,1] range using min-max normalization for fair fusion with vector scores
      const hybridResults: HybridSearchResult[] = [];
      for (const [key, { doc, vectorScore }] of candidateMap.entries()) {
        let keywordScore: number;
        const rawBm25 = bm25ScoreMap.get(key);
        const lexicalScore = this.keywordRetriever.scoreDocument(doc.pageContent, keywords, options.keywordBoosting);
        if (rawBm25 !== undefined) {
          // BM25 can collapse to an all-zero score set for small corpora (for
          // example when IDF is non-positive). Preserve real literal-match
          // evidence rather than reporting the matching component as absent.
          keywordScore = Math.max(rawBm25, lexicalScore);
        } else {
          // Fallback to TF scorer for candidates not in BM25 results
          keywordScore = lexicalScore;
        }

        const hybridScore = vectorWeight * (vectorScore ?? 0) + keywordWeight * keywordScore;

        hybridResults.push({
          document: doc,
          score: hybridScore,
          vectorScore: vectorScore ?? 0,
          keywordScore,
          scoreKind: "weighted_fusion",
          componentScores: {
            ...(vectorScore !== undefined ? { vector: vectorScore } : {}),
            ...(rawBm25 !== undefined || keywordScore > 0 ? { keyword: keywordScore } : {}),
          },
        });
      }

      // Step 6: Re-rank by hybrid score
      hybridResults.sort((a, b) => b.score - a.score);

      // Step 7: Filter by minimum similarity and limit results
      const filteredResults = hybridResults.filter((result) => result.score >= minSimilarity).slice(0, k);

      const searchTime = Date.now() - startTime;

      this.logger.info("Hybrid search complete", {
        resultCount: filteredResults.length,
        searchTime,
        avgScore: this.calculateAvgScore(filteredResults),
      });

      // Add explanations
      if (filteredResults.length > 0) {
        this.addExplanations(filteredResults, keywords);
      }

      return filteredResults;
    } catch (error) {
      this.logger.error("Hybrid search failed", {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Perform vector-only search (semantic similarity)
   */
  public async vectorSearch(query: string, k: number): Promise<HybridSearchResult[]> {
    this.logger.debug("Performing vector-only search", { query, k });

    try {
      const results = await this.vectorRetriever.search(query, k);

      return results.map(({ document: doc, score }) => ({
        document: doc,
        score,
        vectorScore: score,
        keywordScore: 0,
        scoreKind: "vector_similarity",
        componentScores: { vector: score },
      }));
    } catch (error) {
      this.logger.error("Vector search failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private validateOptions(options: HybridSearchOptions): void {
    if (!Number.isInteger(options.k) || options.k < 1) {
      throw new Error("Hybrid k must be a positive integer");
    }
    if (
      !Number.isFinite(options.vectorWeight) ||
      !Number.isFinite(options.keywordWeight) ||
      options.vectorWeight < 0 ||
      options.keywordWeight < 0 ||
      options.vectorWeight + options.keywordWeight <= 0
    ) {
      throw new Error("Hybrid weights must be finite, non-negative, and have a positive sum");
    }
    if (!Number.isFinite(options.minSimilarity) || options.minSimilarity < 0 || options.minSimilarity > 1) {
      throw new Error("Hybrid minSimilarity must be between 0 and 1");
    }
  }

  // ==================== Private Methods ====================

  /**
   * Add human-readable explanations to results
   */
  private addExplanations(results: HybridSearchResult[], keywords: string[]): void {
    results.forEach((result) => {
      const parts: string[] = [];

      if (result.vectorScore > 0) {
        parts.push(`Semantic: ${(result.vectorScore * 100).toFixed(1)}%`);
      }

      if (result.keywordScore > 0) {
        const matchedKeywords = keywords.filter((kw) => result.document.pageContent.toLowerCase().includes(kw));
        if (matchedKeywords.length > 0) {
          parts.push(`Keywords: ${(result.keywordScore * 100).toFixed(1)}% (${matchedKeywords.join(", ")})`);
        }
      }

      parts.push(`Overall: ${(result.score * 100).toFixed(1)}%`);

      result.explanation = parts.join(" | ");
    });
  }

  /**
   * Calculate average score for results
   */
  private calculateAvgScore(results: HybridSearchResult[]): number {
    if (results.length === 0) {
      return 0;
    }

    const sum = results.reduce((acc, r) => acc + r.score, 0);
    return sum / results.length;
  }
}
