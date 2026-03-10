/**
 * KeywordRetriever - Unified keyword-based search module
 *
 * Combines BM25 retrieval (via LangChain) with custom TF-based keyword scoring.
 * Used as a building block by HybridRetriever and EnsembleRetriever,
 * and directly for the pure BM25 retrieval strategy.
 */

import { Document as LangChainDocument } from '@langchain/core/documents';
import { BM25Retriever } from '@langchain/community/retrievers/bm25';
import { Logger } from '../utils/logger';

export interface KeywordSearchResult {
  document: LangChainDocument;
  score?: number; // BM25 doesn't return scores
}

/**
 * Keyword retriever for BM25 search and custom keyword scoring
 */
export class KeywordRetriever {
  private logger: Logger;
  private bm25Retriever?: BM25Retriever;
  private documents: LangChainDocument[] = [];

  private readonly DEFAULT_K = 5;

  // Stop words for keyword extraction (common English words + query-intent words)
  private readonly STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
    'to', 'was', 'will', 'with', 'what', 'when', 'where', 'who', 'how',
    'this', 'these', 'those', 'they', 'their', 'there', 'which', 'can',
    'could', 'would', 'should', 'do', 'does', 'did', 'have', 'had', 'been',
  ]);

  constructor() {
    this.logger = new Logger('KeywordRetriever');
  }

  /**
   * Initialize the BM25 retriever with documents.
   * All documents must be loaded in memory for BM25 to work.
   */
  public async initialize(documents: LangChainDocument[]): Promise<void> {
    this.logger.info('Initializing keyword retriever', { documentCount: documents.length });

    if (!documents || documents.length === 0) {
      throw new Error('KeywordRetriever requires documents to initialize');
    }

    this.documents = documents;
    this.bm25Retriever = BM25Retriever.fromDocuments(this.documents, {
      k: this.DEFAULT_K,
    });

    this.logger.info('Keyword retriever initialized', {
      documentCount: this.documents.length,
    });
  }

  /**
   * Perform BM25 keyword search (ranked retrieval).
   * Returns documents ordered by BM25 relevance.
   */
  public async search(
    query: string,
    k: number = this.DEFAULT_K
  ): Promise<KeywordSearchResult[]> {
    if (!this.bm25Retriever) {
      throw new Error('KeywordRetriever not initialized. Call initialize() first.');
    }

    const startTime = Date.now();

    this.logger.info('Starting BM25 search', {
      query: query.substring(0, 100),
      k,
    });

    try {
      const results = await this.bm25Retriever.invoke(query);
      const limitedResults = results.slice(0, k);
      const searchTime = Date.now() - startTime;

      this.logger.info('BM25 search complete', {
        resultCount: limitedResults.length,
        searchTime,
      });

      return limitedResults.map((doc: LangChainDocument) => ({
        document: doc,
      }));
    } catch (error) {
      this.logger.error('BM25 search failed', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Score a document against keywords using custom BM25-like scoring.
   * Uses log-scaled TF, length normalization, and optional position boosting.
   */
  public scoreDocument(
    text: string,
    keywords: string[],
    boosting: boolean = true
  ): number {
    if (keywords.length === 0) {
      return 0;
    }

    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/);
    const textLength = textWords.length;

    let score = 0;

    for (const keyword of keywords) {
      // Count occurrences
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = textLower.match(regex);
      const termFrequency = matches ? matches.length : 0;

      if (termFrequency > 0) {
        // TF component: log-scaled term frequency
        const tfScore = Math.log(1 + termFrequency);

        // Length normalization (penalize very long documents)
        const lengthNorm = 1 / (1 + Math.log(1 + textLength / 100));

        // Position boosting (keyword near start of document is weighted more)
        let positionBoost = 1;
        if (boosting) {
          const firstOccurrence = textLower.indexOf(keyword);
          if (firstOccurrence >= 0) {
            positionBoost = 1 + (1 - firstOccurrence / textLength);
          }
        }

        score += Math.min(1.0, tfScore * lengthNorm * positionBoost);
      }
    }

    // Normalize by number of keywords (0-1 range)
    return Math.min(1.0, score / keywords.length);
  }

  /**
   * Extract keywords from query text, filtering stop words
   */
  public extractKeywords(query: string, customStopWords?: string[]): string[] {
    const stopWords = customStopWords
      ? new Set([...this.STOP_WORDS, ...customStopWords])
      : this.STOP_WORDS;

    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));

    return [...new Set(tokens)];
  }

  /**
   * Check if the retriever is initialized with documents
   */
  public isInitialized(): boolean {
    return this.bm25Retriever !== undefined;
  }

  /**
   * Get the number of indexed documents
   */
  public getDocumentCount(): number {
    return this.documents.length;
  }

  /**
   * Refresh with new documents
   */
  public async refresh(documents: LangChainDocument[]): Promise<void> {
    this.logger.info('Refreshing keyword retriever');
    this.bm25Retriever = undefined;
    this.documents = [];
    await this.initialize(documents);
  }
}
