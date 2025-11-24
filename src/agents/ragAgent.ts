/**
 * RAG Agent - Main orchestrator for Agentic RAG
 * Coordinates query planning, retrieval, and iterative refinement
 *
 * Architecture: Agent pattern with confidence-based iteration
 * Integrates: QueryPlannerAgent + HybridRetriever + Result Evaluation
 */

import * as vscode from 'vscode';
import { VectorStore } from '@langchain/core/vectorstores';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { QueryPlannerAgent, QueryPlan, SubQuery } from './queryPlannerAgent';
import { HybridRetriever, HybridSearchResult } from '../retrievers/hybridRetriever';
import { EnsembleRetrieverWrapper, EnsembleSearchResult } from '../retrievers/ensembleRetriever';
import { BM25RetrieverWrapper, BM25SearchResult } from '../retrievers/bm25Retriever';
import { Logger } from '../utils/logger';
import { CONFIG } from '../utils/constants';
import { RetrievalStrategy } from '../utils/types';

export interface RAGAgentOptions {
  /** Topic name for context */
  topicName?: string;

  /** Workspace context */
  workspaceContext?: string;

  /** Enable iterative refinement */
  enableIterativeRefinement?: boolean;

  /** Maximum iterations */
  maxIterations?: number;

  /** Confidence threshold (0-1) */
  confidenceThreshold?: number;

  /** Use LLM for query planning */
  useLLM?: boolean;

  /** Retrieval strategy */
  retrievalStrategy?: RetrievalStrategy;

  /** Default topK */
  topK?: number;

  /** LLM model family */
  modelFamily?: string;
}

export interface RetrievalResult {
  document: LangChainDocument;
  score: number;
  source: RetrievalStrategy | 'keyword';
  subQuery?: string;
  explanation?: string;
}

export interface RAGResult {
  /** Original query */
  query: string;

  /** Query plan used */
  plan: QueryPlan;

  /** Retrieved documents */
  results: RetrievalResult[];

  /** Number of iterations performed */
  iterations: number;

  /** Average confidence score */
  avgConfidence: number;

  /** Whether confidence threshold was met */
  confidenceMet: boolean;

  /** Total execution time */
  executionTime: number;

  /** Metadata about the search */
  metadata: {
    totalResults: number;
    uniqueDocuments: number;
    strategy: string;
    subQueriesExecuted: number;
  };
}

/**
 * Main RAG Agent orchestrator
 */
export class RAGAgent {
  private logger: Logger;
  private queryPlanner: QueryPlannerAgent;
  private retriever: HybridRetriever | null = null;
  private ensembleRetriever: EnsembleRetrieverWrapper | null = null;
  private bm25Retriever: BM25RetrieverWrapper | null = null;
  private vectorStore: VectorStore | null = null;

  constructor() {
    this.logger = new Logger('RAGAgent');
    this.queryPlanner = new QueryPlannerAgent();
    this.logger.info('RAGAgent initialized');
  }

  /**
   * Initialize agent with vector store
   */
  public async initialize(vectorStore: VectorStore, documents?: LangChainDocument[]): Promise<void> {
    this.logger.info('Initializing RAGAgent with vector store');

    this.vectorStore = vectorStore;

    this.logger.info('RAGAgent initialized successfully');
  }

  /**
   * Execute RAG query with agentic capabilities
   */
  public async query(
    query: string,
    options: RAGAgentOptions = {}
  ): Promise<RAGResult> {
    const startTime = Date.now();

    this.logger.info('Starting RAG query', {
      query: query.substring(0, 100),
      options,
    });

    try {
      // Ensure initialized
      if (!this.vectorStore) {
        throw new Error('RAGAgent not initialized. Call initialize() first.');
      }

      // Merge options with config
      const mergedOptions = this.mergeOptions(options);

      // Step 1: Create query plan
      const plan = await this.createQueryPlan(query, mergedOptions);

      this.logger.info('Query plan created', {
        complexity: plan.complexity,
        subQueries: plan.subQueries.length,
        strategy: plan.strategy,
      });

      // Step 2: Execute retrieval (with or without iteration)
      let results: RetrievalResult[];
      let iterations = 1;
      let avgConfidence = 0;
      let confidenceMet = false;

      if (mergedOptions.enableIterativeRefinement && plan.complexity !== 'simple') {
        // Iterative retrieval with confidence checking
        const iterativeResult = await this.iterativeRetrieval(
          plan,
          mergedOptions
        );
        results = iterativeResult.results;
        iterations = iterativeResult.iterations;
        avgConfidence = iterativeResult.avgConfidence;
        confidenceMet = iterativeResult.confidenceMet;
      } else {
        // Single-shot retrieval
        results = await this.executeRetrieval(plan, mergedOptions);
        avgConfidence = this.calculateAvgConfidence(results);
        confidenceMet = avgConfidence >= mergedOptions.confidenceThreshold!;
      }

      // Step 3: Deduplicate and rank results
      const uniqueResults = this.deduplicateResults(results);
      const rankedResults = this.rankResults(uniqueResults);

      // Step 4: Limit to topK
      const topK = mergedOptions.topK || 5;
      const finalResults = rankedResults.slice(0, topK);

      const executionTime = Date.now() - startTime;

      const ragResult: RAGResult = {
        query,
        plan,
        results: finalResults,
        iterations,
        avgConfidence,
        confidenceMet,
        executionTime,
        metadata: {
          totalResults: results.length,
          uniqueDocuments: uniqueResults.length,
          strategy: mergedOptions.retrievalStrategy!,
          subQueriesExecuted: plan.subQueries.length,
        },
      };

      this.logger.info('RAG query completed', {
        resultCount: finalResults.length,
        iterations,
        avgConfidence,
        confidenceMet,
        executionTime,
      });

      return ragResult;
    } catch (error) {
      this.logger.error('RAG query failed', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Execute simple query without planning (fast path)
   */
  public async simpleQuery(
    query: string,
    topK: number = 5,
    strategy: RetrievalStrategy = RetrievalStrategy.HYBRID
  ): Promise<RetrievalResult[]> {
    this.logger.debug('Executing simple query', { query, topK, strategy });

    if (!this.vectorStore) {
      throw new Error('RAGAgent not initialized');
    }

    try {
      // Initialize retrievers on-demand based on strategy
      await this.initializeRetrieversForStrategy(strategy);

      let searchResults: Array<HybridSearchResult | EnsembleSearchResult | BM25SearchResult>;

      if (strategy === RetrievalStrategy.BM25 && this.bm25Retriever) {
        searchResults = await this.bm25Retriever.search(query, { k: topK });
      } else if (strategy === RetrievalStrategy.ENSEMBLE && this.ensembleRetriever) {
        searchResults = await this.ensembleRetriever.search(query, { k: topK });
      } else if (strategy === RetrievalStrategy.HYBRID && this.retriever) {
        searchResults = await this.retriever.search(query, { k: topK });
      } else if (strategy === RetrievalStrategy.VECTOR && this.retriever) {
        searchResults = await this.retriever.vectorSearch(query, topK);
      } else {
        throw new Error(`Retriever for strategy ${strategy} not initialized`);
      }

      return searchResults.map((result) => ({
        document: result.document,
        score: result.score || 0,
        source: strategy,
        explanation: 'explanation' in result ? result.explanation : undefined,
      }));
    } catch (error) {
      this.logger.error('Simple query failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ==================== Private Methods ====================

  /**
   * Initialize retrievers on-demand based on strategy
   */
  private async initializeRetrieversForStrategy(strategy: RetrievalStrategy): Promise<void> {
    if (!this.vectorStore) {
      throw new Error('Vector store not initialized');
    }

    // Initialize hybrid retriever if needed (for HYBRID and VECTOR strategies)
    if ((strategy === RetrievalStrategy.HYBRID || strategy === RetrievalStrategy.VECTOR) && !this.retriever) {
      this.logger.info('Initializing HybridRetriever on-demand');
      this.retriever = new HybridRetriever(this.vectorStore);
    }

    // Initialize ensemble retriever if needed
    if (strategy === RetrievalStrategy.ENSEMBLE && !this.ensembleRetriever) {
      this.logger.info('Initializing EnsembleRetriever on-demand');
      this.ensembleRetriever = new EnsembleRetrieverWrapper(this.vectorStore);

      try {
        // Fetch documents from vector store for BM25
        const allDocs = await this.vectorStore.similaritySearch('', 10000);
        await this.ensembleRetriever.initialize(allDocs);
        this.logger.info('EnsembleRetriever initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize EnsembleRetriever', error);
        throw new Error('Failed to initialize EnsembleRetriever for query');
      }
    }

    // Initialize BM25 retriever if needed
    if (strategy === RetrievalStrategy.BM25 && !this.bm25Retriever) {
      this.logger.info('Initializing BM25Retriever on-demand');
      this.bm25Retriever = new BM25RetrieverWrapper();

      try {
        // Fetch documents from vector store
        const allDocs = await this.vectorStore.similaritySearch('', 10000);
        await this.bm25Retriever.initialize(allDocs);
        this.logger.info('BM25Retriever initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize BM25Retriever', error);
        throw new Error('Failed to initialize BM25Retriever for query');
      }
    }
  }

  /**
   * Create query plan using QueryPlannerAgent
   */
  private async createQueryPlan(
    query: string,
    options: Required<RAGAgentOptions>
  ): Promise<QueryPlan> {
    return await this.queryPlanner.createPlan(query, {
      topicName: options.topicName,
      workspaceContext: options.workspaceContext,
      maxSubQueries: options.maxIterations,
      defaultTopK: options.topK,
      useLLM: options.useLLM,
      modelFamily: options.modelFamily,
    });
  }

  /**
   * Execute retrieval for all sub-queries in the plan
   */
  private async executeRetrieval(
    plan: QueryPlan,
    options: Required<RAGAgentOptions>
  ): Promise<RetrievalResult[]> {
    const allResults: RetrievalResult[] = [];

    if (plan.strategy === 'parallel') {
      // Execute all sub-queries in parallel
      const promises = plan.subQueries.map((subQuery: SubQuery) =>
        this.executeSubQuery(subQuery, options)
      );
      const results = await Promise.all(promises);
      allResults.push(...results.flat());
    } else {
      // Execute sub-queries sequentially
      for (const subQuery of plan.subQueries) {
        const results = await this.executeSubQuery(subQuery, options);
        allResults.push(...results);
      }
    }

    return allResults;
  }

  /**
   * Execute a single sub-query
   */
  private async executeSubQuery(
    subQuery: SubQuery,
    options: Required<RAGAgentOptions>
  ): Promise<RetrievalResult[]> {
    if (!this.vectorStore) {
      throw new Error('Agent not initialized');
    }

    const topK = subQuery.topK || options.topK;
    const strategy = options.retrievalStrategy;

    this.logger.debug('Executing sub-query', {
      query: subQuery.query,
      topK,
      strategy,
      reasoning: subQuery.reasoning,
    });

    try {
      // Initialize retrievers on-demand
      await this.initializeRetrieversForStrategy(strategy);

      let searchResults: Array<HybridSearchResult | EnsembleSearchResult | BM25SearchResult>;

      if (strategy === RetrievalStrategy.BM25 && this.bm25Retriever) {
        searchResults = await this.bm25Retriever.search(subQuery.query, { k: topK });
      } else if (strategy === RetrievalStrategy.ENSEMBLE && this.ensembleRetriever) {
        searchResults = await this.ensembleRetriever.search(subQuery.query, { k: topK });
      } else if (strategy === RetrievalStrategy.HYBRID && this.retriever) {
        searchResults = await this.retriever.search(subQuery.query, { k: topK });
      } else if (strategy === RetrievalStrategy.VECTOR && this.retriever) {
        searchResults = await this.retriever.vectorSearch(subQuery.query, topK);
      } else {
        throw new Error(`Retriever for strategy ${strategy} not initialized`);
      }

      return searchResults.map((result) => ({
        document: result.document,
        score: result.score || 0,
        source: strategy,
        subQuery: subQuery.query,
        explanation: 'explanation' in result ? result.explanation : undefined,
      }));
    } catch (error) {
      this.logger.error('Sub-query execution failed', {
        error: error instanceof Error ? error.message : String(error),
        subQuery: subQuery.query,
      });
      return [];
    }
  }

  /**
   * Iterative retrieval with confidence checking
   */
  private async iterativeRetrieval(
    initialPlan: QueryPlan,
    options: Required<RAGAgentOptions>
  ): Promise<{
    results: RetrievalResult[];
    iterations: number;
    avgConfidence: number;
    confidenceMet: boolean;
  }> {
    const allResults: RetrievalResult[] = [];
    let currentPlan = initialPlan;
    let iterations = 0;
    const maxIter = options.maxIterations;
    const threshold = options.confidenceThreshold;

    this.logger.debug('Starting iterative retrieval', {
      maxIterations: maxIter,
      threshold,
    });

    while (iterations < maxIter) {
      iterations++;

      // Execute current plan
      const iterResults = await this.executeRetrieval(currentPlan, options);
      allResults.push(...iterResults);

      // Calculate confidence
      const avgConfidence = this.calculateAvgConfidence(allResults);

      this.logger.debug('Iteration complete', {
        iteration: iterations,
        resultCount: iterResults.length,
        avgConfidence,
      });

      // Check if confidence threshold met
      if (avgConfidence >= threshold) {
        this.logger.info('Confidence threshold met', {
          avgConfidence,
          threshold,
          iterations,
        });
        return {
          results: allResults,
          iterations,
          avgConfidence,
          confidenceMet: true,
        };
      }

      // Check if we should continue
      if (iterations >= maxIter) {
        this.logger.info('Max iterations reached', {
          iterations,
          avgConfidence,
        });
        break;
      }

      // Refine query plan for next iteration
      // (In a full implementation, this would use LLM to refine based on gaps)
      // For now, we'll just stop after first iteration
      break;
    }

    const avgConfidence = this.calculateAvgConfidence(allResults);

    return {
      results: allResults,
      iterations,
      avgConfidence,
      confidenceMet: avgConfidence >= threshold,
    };
  }

  /**
   * Deduplicate results based on document content
   */
  private deduplicateResults(results: RetrievalResult[]): RetrievalResult[] {
    const seen = new Set<string>();
    const unique: RetrievalResult[] = [];

    for (const result of results) {
      // Use content hash or chunk ID for deduplication
      const key =
        result.document.metadata.chunkId ||
        result.document.pageContent.substring(0, 100);

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(result);
      }
    }

    this.logger.debug('Deduplicated results', {
      original: results.length,
      unique: unique.length,
    });

    return unique;
  }

  /**
   * Rank results by score
   */
  private rankResults(results: RetrievalResult[]): RetrievalResult[] {
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate average confidence from results
   */
  private calculateAvgConfidence(results: RetrievalResult[]): number {
    if (results.length === 0) {
      return 0;
    }

    const sum = results.reduce((acc, r) => acc + r.score, 0);
    return sum / results.length;
  }

  /**
   * Merge options with sensible defaults
   */
  private mergeOptions(options: RAGAgentOptions): Required<RAGAgentOptions> {
    return {
      topicName: options.topicName || '',
      workspaceContext: options.workspaceContext || '',
      enableIterativeRefinement: options.enableIterativeRefinement ?? true,
      maxIterations: options.maxIterations ?? 3,
      confidenceThreshold: options.confidenceThreshold ?? 0.7,
      useLLM: options.useLLM ?? false,
      retrievalStrategy: options.retrievalStrategy ?? RetrievalStrategy.HYBRID,
      topK: options.topK ?? 5,
      modelFamily: options.modelFamily || 'gpt-4o',
    };
  }

  /**
   * Update vector store (useful for switching topics)
   */
  public setVectorStore(vectorStore: VectorStore): void {
    this.vectorStore = vectorStore;
    // Clear all retrievers - they'll be re-initialized on-demand with new vector store
    this.retriever = null;
    this.ensembleRetriever = null;
    this.bm25Retriever = null;
    this.logger.debug('Vector store updated, retrievers cleared');
  }
}
