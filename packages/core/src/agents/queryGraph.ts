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
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    if (!deps.memoryStore) {
      logger.debug("No memory store, skipping recall");
      return {};
    }

    try {
      const result = await deps.memoryStore.recall({
        query: state.query,
        topK: 3,
      });
      const memoryContext = result.memories.map((m) => m.entry.content);

      logger.debug("Recalled memories", { count: memoryContext.length });
      return { memoryContext };
    } catch (error) {
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
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
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

  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
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
    const results = state.retrievalResults;
    if (results.length === 0) {
      return { confidence: 0 };
    }

    // Use top-K results for confidence (matching RAGAgent.calculateAvgConfidence pattern)
    const topK = state.options.topK;
    const topResults = results
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const avgScore = topResults.reduce((sum, r) => sum + r.score, 0) / topResults.length;

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
  return async (state: QueryPipelineStateType): Promise<QueryPipelineUpdateType> => {
    if (!state.plan) {
      return {};
    }

    // Identify sub-queries with poor coverage
    const gapThreshold = deps.config.get<number>(CONFIG.GAP_SCORE_THRESHOLD, 0.4);
    const resultsBySubQuery = new Map<string, number[]>();

    for (const r of state.retrievalResults) {
      const sq = (r.metadata?.subQuery as string) ?? "";
      if (!resultsBySubQuery.has(sq)) {
        resultsBySubQuery.set(sq, []);
      }
      resultsBySubQuery.get(sq)!.push(r.score);
    }

    const refinedSubQueries: QueryPlanRef["subQueries"] = [];

    for (const sq of state.plan.subQueries) {
      const scores = resultsBySubQuery.get(sq.query) ?? [];
      const avgScore = scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;

      if (avgScore < gapThreshold) {
        // Broaden the query by appending context
        refinedSubQueries.push({
          query: `${sq.query} overview context`,
          reasoning: `Refinement of "${sq.query}" (avg score: ${avgScore.toFixed(2)})`,
          topK: sq.topK,
        });
      }
    }

    // If no gaps found, re-search with the original query broadened
    if (refinedSubQueries.length === 0) {
      refinedSubQueries.push({
        query: `${state.query} summary`,
        reasoning: "Broadened original query for additional coverage",
        topK: state.options.topK,
      });
    }

    logger.debug("Refined plan", { newSubQueries: refinedSubQueries.length });

    return {
      plan: {
        ...state.plan,
        subQueries: refinedSubQueries,
        explanation: `${state.plan.explanation} (refined iteration ${state.iterations})`,
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
    if (!deps.memoryStore) {
      return {};
    }

    const memoryThreshold = deps.config.get<number>(
      CONFIG.MEMORY_CONFIDENCE_THRESHOLD,
      0.1,
    );

    if (state.confidence < memoryThreshold || state.retrievalResults.length === 0) {
      return {};
    }

    try {
      // Store a summary of the top result as a memory
      const topResult = state.retrievalResults
        .slice()
        .sort((a, b) => b.score - a.score)[0];

      const memoryContent =
        `Query: ${state.query}\n` +
        `Top result (score: ${topResult.score.toFixed(2)}): ${topResult.content.substring(0, 200)}`;

      await deps.memoryStore.store({
        content: memoryContent,
        tags: ["query-insight", state.topicId],
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
  const chunkId = result.metadata?.chunkId;
  if (typeof chunkId === "string" || typeof chunkId === "number") {
    return String(chunkId);
  }

  return createHash("sha256").update(result.content).digest("hex");
}

// ── Routing ──────────────────────────────────────────────────────────

/**
 * Conditional routing: decide whether to refine or proceed to memorize.
 */
function shouldRefine(state: QueryPipelineStateType): "refine" | "memorize" {
  if (
    state.confidence >= state.confidenceThreshold ||
    state.iterations >= state.maxIterations
  ) {
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
    options?.retrievalStrategy ??
    deps.config.get<string>(CONFIG.RETRIEVAL_STRATEGY, RetrievalStrategy.VECTOR);
  const topK = options?.topK ?? deps.config.get<number>(CONFIG.TOP_K, 5);
  const modelFamily = options?.modelFamily ?? deps.config.get<string>(CONFIG.LLM_MODEL, "");
  const maxIterations =
    options?.maxIterations ?? deps.config.get<number>(CONFIG.MAX_ITERATIONS, 3);
  const confidenceThreshold =
    options?.confidenceThreshold ??
    deps.config.get<number>(CONFIG.CONFIDENCE_THRESHOLD, 0.7);

  const initialState: Partial<QueryPipelineStateType> = {
    query,
    topicId,
    options: {
      retrievalStrategy,
      topK,
      modelFamily,
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
