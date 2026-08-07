/**
 * LangGraph Query Pipeline
 *
 * Compiles a StateGraph that orchestrates the full RAG query flow:
 *   recallMemory → planQuery → retrieve → evaluate → [shouldRefine]
 *                                                       ↓ refine → retrieve (loop)
 *                                                       ↓ memorize → formatOutput → END
 */

import { createHash } from "crypto";
import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { IConfigProvider, ILLMProvider, INotifier } from "../interfaces";
import { EmbeddingService } from "../embeddings/embeddingService";
import { TopicManager } from "../managers/topicManager";
import { MemoryStore } from "../memory/memoryStore";
import { QueryPlannerAgent } from "./queryPlannerAgent";
import { RAGAgent } from "./ragAgent";
import {
  QueryPipelineState,
  QueryPipelineStateType,
  QueryPipelineUpdateType,
  RetrievalResultEntry,
  QueryPlanRef,
} from "./graphState";
import { RetrievalStrategy } from "../utils/types";
import { CONFIG } from "../constants";
import { Logger } from "../logger";
import type { Reranker } from "../rerankers/reranker";
import { Document as LangChainDocument } from "@langchain/core/documents";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { QueryPlan } from "./queryPlannerAgent";
import type { RetrievalResult } from "./ragAgent";
import { getChunkId } from "../retrievers/graphRetriever";

// ── Dependencies ─────────────────────────────────────────────────────

export interface QueryGraphDeps {
  llmProvider: ILLMProvider;
  config: IConfigProvider;
  notifier: INotifier;
  embeddingService: EmbeddingService;
  topicManager: TopicManager;
  memoryStore?: MemoryStore;
  reranker?: Reranker;
  checkpointer?: BaseCheckpointSaver;
}

// ── Node Functions ───────────────────────────────────────────────────

const logger = new Logger("QueryGraph");

/**
 * Recall relevant memories for the query.
 * Skips gracefully when no memory store is available.
 */
function createRecallMemoryNode(deps: QueryGraphDeps) {
  return async (state: QueryPipelineStateType, runtime?: RunnableConfig): Promise<QueryPipelineUpdateType> => {
    runtime?.signal?.throwIfAborted();
    if (!deps.memoryStore) {
      logger.debug("No memory store, skipping recall");
      return {};
    }

    try {
      const result = await deps.memoryStore.recall({
        query: state.query,
        topK: 3,
        reinforce: false,
        includeAuto: false,
        signal: runtime?.signal,
      });
      const memoryContext = result.memories.map((m) => m.entry.content);

      logger.debug("Recalled memories", { count: memoryContext.length });
      return { memoryContext };
    } catch (error) {
      if (runtime?.signal?.aborted) {
        throw error;
      }
      logger.warn("Memory recall failed, continuing without context", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  };
}

/**
 * Create a query plan via QueryPlannerAgent.
 * Includes memory context in the workspace context string.
 */
function createPlanQueryNode(deps: QueryGraphDeps) {
  return async (state: QueryPipelineStateType, runtime?: RunnableConfig): Promise<QueryPipelineUpdateType> => {
    runtime?.signal?.throwIfAborted();
    const planner = new QueryPlannerAgent(deps.llmProvider);

    // Build workspace context enriched with memory
    let workspaceContext = "";
    if (state.memoryContext.length > 0) {
      workspaceContext = `Relevant memories:\n${state.memoryContext.join("\n---\n")}`;
    }

    const plan = await planner.createPlan(state.query, {
      topicName: state.topicId,
      workspaceContext,
      retrievalStrategy: state.options.retrievalStrategy as RetrievalStrategy,
      topK: state.options.topK,
      modelFamily: state.options.modelFamily,
      signal: runtime?.signal,
    });

    logger.info("Query plan created", {
      complexity: plan.complexity,
      subQueries: plan.subQueries.length,
    });

    const planRef: QueryPlanRef = {
      originalQuery: plan.originalQuery,
      complexity: plan.complexity,
      subQueries: plan.subQueries.map((sq) => ({
        query: sq.query,
        reasoning: sq.reasoning,
        topK: sq.topK,
      })),
      explanation: plan.explanation,
    };

    return {
      plan: planRef,
      iterations: state.iterations + 1,
    };
  };
}

/**
 * Retrieve documents for each sub-query in the plan.
 * Reuses RAGAgent retrieval dispatch so LangGraph stays aligned with the
 * procedural query path for vector, hybrid, BM25, and graph strategies.
 */
function createRetrieveNode(deps: QueryGraphDeps) {
  // Cache retrieval-ready agents per topic for the lifetime of the compiled
  // graph. A Map (not a single slot) so one long-lived compiled graph serves
  // queries across topics without thrashing the cache on topic switches.
  const agentCache = new Map<string, RAGAgent>();

  return async (state: QueryPipelineStateType, runtime?: RunnableConfig): Promise<QueryPipelineUpdateType> => {
    runtime?.signal?.throwIfAborted();
    if (!state.plan || state.plan.subQueries.length === 0) {
      logger.warn("No plan or empty sub-queries, skipping retrieval");
      return {};
    }

    let agent = agentCache.get(state.topicId);
    if (!agent) {
      const vectorStore = await deps.topicManager.getVectorStore(state.topicId);
      if (!vectorStore) {
        return {
          error: `Failed to load vector store for topic: ${state.topicId}`,
        };
      }

      const knowledgeGraph = await deps.topicManager.getKnowledgeGraph(state.topicId);
      const documentFetcher = (limit: number) => deps.topicManager.getAllDocuments(state.topicId, limit);

      agent = new RAGAgent(deps.config, deps.llmProvider);
      await agent.initialize(vectorStore, {
        documentFetcher,
        knowledgeGraph: knowledgeGraph ?? undefined,
        embeddingService: knowledgeGraph ? deps.embeddingService : undefined,
        reranker: deps.reranker,
      });
      agentCache.set(state.topicId, agent);
    }

    const retrievalStrategy = state.options.retrievalStrategy as RetrievalStrategy;
    const retrievalResults = await agent.retrieveWithPlan({
      query: state.query,
      subQueries: state.plan.subQueries,
      retrievalStrategy,
      topK: state.options.topK,
      modelFamily: state.options.modelFamily,
      signal: runtime?.signal,
    });

    const allResults: RetrievalResultEntry[] = retrievalResults.map((result) => ({
      content: result.document.pageContent,
      source: result.document.metadata?.source ?? "unknown",
      score: result.score,
      metadata: {
        ...result.document.metadata,
        subQuery: result.subQuery,
        originalSubQuery: result.originalSubQuery,
        retrievalStrategy: result.source,
        explanation: result.explanation,
        originalScore: result.originalScore,
        originalScoreKind: result.originalScoreKind,
        originalComponentScores: result.originalComponentScores,
        scoreKind: result.scoreKind,
        componentScores: result.componentScores,
        matchedEntities: result.matchedEntities,
        hopDepth: result.hopDepth,
        degradedFrom: result.degradedFrom,
        fallbackReason: result.fallbackReason,
      },
    }));

    logger.debug("Retrieval complete", { totalResults: allResults.length });

    return { retrievalResults: allResults };
  };
}

/**
 * Evaluate retrieval quality by computing average score.
 */
function createEvaluateNode(_deps: QueryGraphDeps) {
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    const seen = new Set<string>();
    const results = state.retrievalResults.filter((result) => {
      const key = getRetrievalResultKey(result);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (results.length === 0) {
      return { confidence: 0 };
    }

    // Use top-K results for confidence (matching RAGAgent.calculateAvgConfidence pattern)
    const topK = state.options.topK;
    const topResults = results
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Reranker scores are sigmoid-scaled (0-1 but a different distribution than
    // raw retrieval scores) and would skew the confidence used for the
    // refine/memorize decision. Prefer the pre-rerank originalScore when present
    // so confidenceThreshold stays comparable across reranked and non-reranked runs.
    const scoreOf = (r: RetrievalResultEntry): number =>
      typeof r.metadata?.originalScore === "number" ? (r.metadata.originalScore as number) : r.score;

    const avgScore = topResults.reduce((sum, r) => sum + scoreOf(r), 0) / topResults.length;

    logger.debug("Evaluation complete", {
      avgScore: avgScore.toFixed(3),
      totalResults: results.length,
      topKUsed: topResults.length,
    });

    return { confidence: avgScore };
  };
}

/**
 * Generate follow-up queries to fill retrieval gaps.
 * Updates the plan with new sub-queries targeting low-scoring areas.
 */
function createRefineNode(deps: QueryGraphDeps) {
  const refinementAgent = new RAGAgent(deps.config, deps.llmProvider);
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    if (!state.plan) {
      return {};
    }

    const plan: QueryPlan = {
      originalQuery: state.plan.originalQuery,
      complexity: state.plan.complexity,
      subQueries: state.plan.subQueries,
      explanation: state.plan.explanation,
    };
    const existingResults: RetrievalResult[] = state.retrievalResults.map((result) => ({
      document: new LangChainDocument({ pageContent: result.content, metadata: result.metadata ?? {} }),
      score: result.score,
      source: (result.metadata?.retrievalStrategy as RetrievalStrategy) ?? RetrievalStrategy.VECTOR,
      subQuery: result.metadata?.subQuery as string | undefined,
      originalSubQuery: result.metadata?.originalSubQuery as string | undefined,
    }));
    const gaps = refinementAgent.analyzeGaps(
      plan,
      existingResults,
      state.options.retrievalStrategy as RetrievalStrategy,
    );
    const followUp = await refinementAgent.generateFollowUpPlan(plan, gaps, existingResults, {
      topicName: state.topicId,
      workspaceContext: "",
      topK: state.options.topK,
      retrievalStrategy: state.options.retrievalStrategy as RetrievalStrategy,
      maxIterations: state.maxIterations,
      confidenceThreshold: state.confidenceThreshold,
      modelFamily: state.options.modelFamily,
    });
    const refinedSubQueries = followUp?.subQueries ?? [];

    logger.debug("Refined plan", { newSubQueries: refinedSubQueries.length });

    return {
      plan: {
        ...(followUp ?? state.plan),
        subQueries: refinedSubQueries,
      },
      iterations: state.iterations + 1,
    };
  };
}

/**
 * Store a key insight in memory when confidence is high.
 */
function createMemorizeNode(deps: QueryGraphDeps) {
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    if (
      state.options.allowMemoryWrites === false ||
      !deps.memoryStore ||
      !deps.config.get<boolean>(CONFIG.QUERY_MEMORY_ENABLED, false)
    ) {
      return {};
    }

    const memoryThreshold = Math.max(0.7, deps.config.get<number>(CONFIG.MEMORY_CONFIDENCE_THRESHOLD, 0.7));

    if (state.confidence < memoryThreshold || state.retrievalResults.length === 0) {
      return {};
    }

    try {
      // Store a summary of the top result as a memory
      const topResult = state.retrievalResults.slice().sort((a, b) => b.score - a.score)[0];

      const memoryContent =
        `Query: ${state.query}\n` +
        `Top result (score: ${topResult.score.toFixed(2)}): ${topResult.content.substring(0, 200)}`;

      await deps.memoryStore.store({
        content: memoryContent,
        tags: ["auto:query-insight", state.topicId],
      });

      logger.debug("Stored query insight in memory");
    } catch (error) {
      logger.debug("Memory store failed, continuing", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {};
  };
}

/**
 * Deduplicate results and build the final output object.
 */
function createFormatOutputNode(_deps: QueryGraphDeps) {
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    // Deduplicate by content hash
    const seen = new Set<string>();
    const unique: RetrievalResultEntry[] = [];

    for (const r of state.retrievalResults) {
      const key = getRetrievalResultKey(r);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }

    // Sort by score descending and limit to topK
    unique.sort((a, b) => b.score - a.score);
    const topK = state.options.topK;
    const finalResults = unique.slice(0, topK);

    const result: Record<string, unknown> = {
      query: state.query,
      topicId: state.topicId,
      results: finalResults,
      confidence: state.confidence,
      iterations: state.iterations,
      plan: state.plan,
      subQueryCounts: Object.fromEntries(
        (state.plan?.subQueries ?? []).map((subQuery) => [
          subQuery.query,
          unique.filter((entry) => entry.metadata?.subQuery === subQuery.query).length,
        ]),
      ),
      metadata: {
        totalRetrieved: state.retrievalResults.length,
        uniqueResults: unique.length,
        finalResults: finalResults.length,
        memoryContextUsed: state.memoryContext.length,
        strategy: state.options.retrievalStrategy,
      },
    };

    logger.info("Query graph complete", {
      results: finalResults.length,
      confidence: state.confidence.toFixed(3),
      iterations: state.iterations,
    });

    return { result };
  };
}

function getRetrievalResultKey(result: RetrievalResultEntry): string {
  const chunkId = getChunkId(result.metadata);
  if (chunkId !== null) {
    return chunkId;
  }

  return createHash("sha256").update(result.content).digest("hex");
}

// ── Routing ──────────────────────────────────────────────────────────

/**
 * Conditional routing: decide whether to refine or proceed to memorize.
 */
function shouldRefine(state: QueryPipelineStateType): "refine" | "memorize" {
  if (state.confidence >= state.confidenceThreshold || state.iterations >= state.maxIterations) {
    logger.debug("Proceeding to memorize", {
      confidence: state.confidence,
      threshold: state.confidenceThreshold,
      iterations: state.iterations,
      maxIterations: state.maxIterations,
    });
    return "memorize";
  }

  logger.debug("Refining query", {
    confidence: state.confidence,
    threshold: state.confidenceThreshold,
    iterations: state.iterations,
  });
  return "refine";
}

// ── Graph Factory ────────────────────────────────────────────────────

/**
 * Create a compiled LangGraph StateGraph for the RAG query pipeline.
 */
export function createQueryGraph(deps: QueryGraphDeps) {
  const graph = new StateGraph(QueryPipelineState)
    .addNode("recallMemory", createRecallMemoryNode(deps))
    .addNode("planQuery", createPlanQueryNode(deps))
    .addNode("retrieve", createRetrieveNode(deps))
    .addNode("evaluate", createEvaluateNode(deps))
    .addNode("refine", createRefineNode(deps))
    .addNode("memorize", createMemorizeNode(deps))
    .addNode("formatOutput", createFormatOutputNode(deps))
    // Edges
    .addEdge(START, "recallMemory")
    .addEdge("recallMemory", "planQuery")
    .addEdge("planQuery", "retrieve")
    .addEdge("retrieve", "evaluate")
    .addConditionalEdges("evaluate", shouldRefine, {
      refine: "refine",
      memorize: "memorize",
    })
    .addEdge("refine", "retrieve")
    .addEdge("memorize", "formatOutput")
    .addEdge("formatOutput", END);

  return graph.compile({
    checkpointer: deps.checkpointer,
  });
}

// ── Execution Helper ─────────────────────────────────────────────────

export interface ExecuteQueryGraphOptions {
  retrievalStrategy?: string;
  topK?: number;
  modelFamily?: string;
  maxIterations?: number;
  confidenceThreshold?: number;
  /** Abort signal — cancels the run between graph steps. */
  signal?: AbortSignal;
  /** False for reader-token sessions: disables automatic query-memory writes. */
  allowMemoryWrites?: boolean;
  /**
   * Reuse a previously compiled graph (see createQueryGraph). Compiling per
   * query discards the per-topic RAGAgent cache inside the retrieve node, so
   * long-lived callers should compile once and pass it here.
   */
  compiledGraph?: ReturnType<typeof createQueryGraph>;
}

/**
 * High-level helper: invoke a compiled query graph (reusing one when
 * provided via options.compiledGraph, otherwise compiling fresh).
 *
 * @param deps       - Graph dependencies (services, stores)
 * @param query      - User query string
 * @param topicId    - Target topic ID
 * @param options    - Optional overrides for retrieval settings
 * @param threadId   - Optional thread ID for checkpointer continuity
 * @returns          - The final pipeline result record
 */
export async function executeQueryGraph(
  deps: QueryGraphDeps,
  query: string,
  topicId: string,
  options?: ExecuteQueryGraphOptions,
  threadId?: string,
): Promise<Record<string, unknown>> {
  const retrievalStrategy =
    options?.retrievalStrategy ?? deps.config.get<string>(CONFIG.RETRIEVAL_STRATEGY, RetrievalStrategy.VECTOR);
  const topK = options?.topK ?? deps.config.get<number>(CONFIG.TOP_K, 5);
  const modelFamily = options?.modelFamily ?? deps.config.get<string>(CONFIG.LLM_MODEL, "");
  const maxIterations = options?.maxIterations ?? deps.config.get<number>(CONFIG.MAX_ITERATIONS, 3);
  const confidenceThreshold = options?.confidenceThreshold ?? deps.config.get<number>(CONFIG.CONFIDENCE_THRESHOLD, 0.7);

  const initialState: Partial<QueryPipelineStateType> = {
    query,
    topicId,
    options: {
      retrievalStrategy,
      topK,
      modelFamily,
      allowMemoryWrites: options?.allowMemoryWrites ?? true,
    },
    maxIterations,
    confidenceThreshold,
  };

  const config: Record<string, unknown> = {};
  if (threadId) {
    config.configurable = { thread_id: threadId };
  }
  if (options?.signal) {
    config.signal = options.signal;
  }

  const compiledGraph = options?.compiledGraph ?? createQueryGraph(deps);
  const finalState = await compiledGraph.invoke(initialState, config);

  if (finalState.error) {
    throw new Error(`Query graph error: ${finalState.error}`);
  }

  return finalState.result ?? {};
}
