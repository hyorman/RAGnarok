/**
 * Hybrid Retriever - Composite retriever combining vector and keyword search
 *
 * Delegates retrieval to VectorRetriever and KeywordRetriever, then applies
 * weighted score fusion to produce a single ranked list.
 */

import { Document as LangChainDocument } from '@langchain/core/documents';
import { VectorRetriever } from './vectorRetriever';
import { KeywordRetriever } from './keywordRetriever';
import { Logger } from '../utils/logger';

export interface HybridSearchOptions {
  /** Number of results to return */
  k?: number;

  /** Weight for vector similarity (0-1) */
  vectorWeight?: number;

  /** Weight for keyword matching (0-1) */
  keywordWeight?: number;

  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;

  /** Enable keyword boosting */
  keywordBoosting?: boolean;

  /** Custom stop words to filter */
  customStopWords?: string[];
}

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
  private keywordRetriever?: KeywordRetriever;

  // Default weights
  private readonly DEFAULT_VECTOR_WEIGHT = 0.7;
  private readonly DEFAULT_KEYWORD_WEIGHT = 0.3;
  private readonly DEFAULT_K = 5;
  private readonly DEFAULT_MIN_SIMILARITY = 0.0;

  constructor(vectorRetriever: VectorRetriever, keywordRetriever?: KeywordRetriever) {
    this.logger = new Logger('HybridRetriever');
    this.vectorRetriever = vectorRetriever;
    this.keywordRetriever = keywordRetriever;

    this.logger.info('HybridRetriever initialized', {
      hasKeywordRetriever: !!keywordRetriever,
    });
  }

  /**
   * Perform hybrid search combining vector and keyword search
   */
  public async search(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult[]> {
    const startTime = Date.now();

    const k = options.k || this.DEFAULT_K;
    const vectorWeight = options.vectorWeight ?? this.DEFAULT_VECTOR_WEIGHT;
    const keywordWeight = options.keywordWeight ?? this.DEFAULT_KEYWORD_WEIGHT;
    const minSimilarity = options.minSimilarity ?? this.DEFAULT_MIN_SIMILARITY;

    this.logger.info('Starting hybrid search', {
      query: query.substring(0, 100),
      k,
      vectorWeight,
      keywordWeight,
    });

    try {
      // Step 1: Fetch vector candidates (more than needed for re-ranking)
      const candidateCount = Math.max(k * 3, 20);
      const vectorResults = await this.vectorRetriever.search(query, candidateCount);

      this.logger.debug('Vector search complete', {
        candidateCount: vectorResults.length,
      });

      // Step 2: Extract keywords (delegate to keyword retriever or local fallback)
      const keywords = this.keywordRetriever
        ? this.keywordRetriever.extractKeywords(query, options.customStopWords)
        : this.extractKeywordsFallback(query, options.customStopWords);

      this.logger.debug('Keywords extracted', {
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

      // Step 4: If keyword retriever is initialized, fetch BM25 candidates to expand pool
      if (this.keywordRetriever?.isInitialized()) {
        const bm25Results = await this.keywordRetriever.search(query, candidateCount);
        let bm25Added = 0;
        for (const { document: doc } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { doc, vectorScore: 0 });
            bm25Added++;
          }
        }
        this.logger.debug('BM25 candidates merged', {
          bm25Total: bm25Results.length,
          bm25Added,
          totalCandidates: candidateMap.size,
        });
      }

      // Step 5: Score all candidates with hybrid formula
      const hybridResults: HybridSearchResult[] = [];
      for (const { doc, vectorScore } of candidateMap.values()) {
        const keywordScore = this.keywordRetriever
          ? this.keywordRetriever.scoreDocument(doc.pageContent, keywords, options.keywordBoosting)
          : this.scoreDocumentFallback(doc.pageContent, keywords, options.keywordBoosting);

        const hybridScore =
          vectorWeight * vectorScore +
          keywordWeight * keywordScore;

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
      const filteredResults = hybridResults
        .filter((result) => result.score >= minSimilarity)
        .slice(0, k);

      const searchTime = Date.now() - startTime;

      this.logger.info('Hybrid search complete', {
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
      this.logger.error('Hybrid search failed', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Perform vector-only search (semantic similarity)
   */
  public async vectorSearch(
    query: string,
    k: number = this.DEFAULT_K
  ): Promise<HybridSearchResult[]> {
    this.logger.debug('Performing vector-only search', { query, k });

    try {
      const results = await this.vectorRetriever.search(query, k);

      return results.map(({ document: doc, score }) => ({
        document: doc,
        score,
        vectorScore: score,
        keywordScore: 0,
      }));
    } catch (error) {
      this.logger.error('Vector search failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  // ==================== Private Methods ====================

  /** Minimal keyword extraction fallback when no KeywordRetriever is provided */
  private static readonly FALLBACK_STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
    'to', 'was', 'will', 'with', 'what', 'when', 'where', 'who', 'how',
    'this', 'these', 'those', 'they', 'their', 'there', 'which', 'can',
    'could', 'would', 'should', 'do', 'does', 'did', 'have', 'had', 'been',
  ]);

  private extractKeywordsFallback(query: string, customStopWords?: string[]): string[] {
    const stopWords = customStopWords
      ? new Set([...HybridRetriever.FALLBACK_STOP_WORDS, ...customStopWords])
      : HybridRetriever.FALLBACK_STOP_WORDS;
    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));
    return [...new Set(tokens)];
  }

  private scoreDocumentFallback(text: string, keywords: string[], boosting?: boolean): number {
    if (keywords.length === 0) return 0;
    const textLower = text.toLowerCase();
    const textLength = textLower.split(/\s+/).length;
    let score = 0;
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = textLower.match(regex);
      const tf = matches ? matches.length : 0;
      if (tf > 0) {
        const tfScore = Math.log(1 + tf);
        const lengthNorm = 1 / (1 + Math.log(1 + textLength / 100));
        let positionBoost = 1;
        if (boosting !== false) {
          const pos = textLower.indexOf(keyword);
          if (pos >= 0) positionBoost = 1 + (1 - pos / textLength);
        }
        score += Math.min(1.0, tfScore * lengthNorm * positionBoost);
      }
    }
    return Math.min(1.0, score / keywords.length);
  }

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
        const matchedKeywords = keywords.filter((kw) =>
          result.document.pageContent.toLowerCase().includes(kw)
        );
        if (matchedKeywords.length > 0) {
          parts.push(
            `Keywords: ${(result.keywordScore * 100).toFixed(1)}% (${matchedKeywords.join(', ')})`
          );
        }
      }

      parts.push(`Overall: ${(result.score * 100).toFixed(1)}%`);

      result.explanation = parts.join(' | ');
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
