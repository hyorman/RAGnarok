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
    const vectorWeight = options.vectorWeight;
    const keywordWeight = options.keywordWeight;
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
      const candidateMap = new Map<string, { doc: LangChainDocument; vectorScore: number }>();
      for (const { document: doc, score: vectorScore } of vectorResults) {
        const key = doc.metadata?.chunkId ?? doc.pageContent;
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
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          bm25ScoreMap.set(key, bm25Score ?? 0);
        }

        // Compute vector score floor: minimum of all vector scores (so BM25-only docs aren't penalized asymmetrically)
        const vectorScores = Array.from(candidateMap.values()).map((c) => c.vectorScore);
        const vectorScoreFloor = vectorScores.length > 0 ? Math.min(...vectorScores) : 0;

        let bm25Added = 0;
        for (const { document: doc } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { doc, vectorScore: vectorScoreFloor });
            bm25Added++;
          }
        }
        this.logger.debug("BM25 candidates merged", {
          bm25Total: bm25Results.length,
          bm25Added,
          totalCandidates: candidateMap.size,
          vectorScoreFloor,
        });
      }

      // Step 5: Score all candidates with hybrid formula
      // Normalize BM25 scores to [0,1] range using min-max normalization for fair fusion with vector scores
      const bm25Values = bm25ScoreMap.size > 0 ? Array.from(bm25ScoreMap.values()) : [];
      const maxBm25Score = bm25Values.length > 0 ? Math.max(...bm25Values) : 0;
      const minBm25Score = bm25Values.length > 0 ? Math.min(...bm25Values) : 0;
      const bm25Range = maxBm25Score - minBm25Score;
      const hybridResults: HybridSearchResult[] = [];
      for (const [key, { doc, vectorScore }] of candidateMap.entries()) {
        let keywordScore: number;
        const rawBm25 = bm25ScoreMap.get(key);
        if (rawBm25 !== undefined && bm25Range > 0) {
          // Min-max normalization: spreads scores across [0,1] based on relative position
          keywordScore = (rawBm25 - minBm25Score) / bm25Range;
        } else if (rawBm25 !== undefined && maxBm25Score > 0) {
          // All BM25 scores identical — assign uniform score
          keywordScore = 1.0;
        } else {
          // Fallback to TF scorer for candidates not in BM25 results
          keywordScore = this.keywordRetriever.scoreDocument(doc.pageContent, keywords, options.keywordBoosting);
        }

        const hybridScore = vectorWeight * vectorScore + keywordWeight * keywordScore;

        hybridResults.push({
          document: doc,
          score: hybridScore,
          vectorScore,
          keywordScore,
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
      }));
    } catch (error) {
      this.logger.error("Vector search failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
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
