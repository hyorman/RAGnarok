/**
 * RAGQueryService — Portable RAG query execution service
 *
 * Encapsulates the full query pipeline shared by the VS Code extension
 * and the MCP server:
 *   1. Resolve topic by name (exact → fallback → semantic)
 *   2. Ensure topic has documents
 *   3. Get/create a RAGAgent for the topic (with optional caching)
 *   4. Run the query
 *   5. Format the raw RAGResult into a structured RAGQueryResult
 *
 * VS Code adds workspace context injection on top.
 * MCP uses it directly with no extra layers.
 */

import { IConfigProvider, ILLMProvider, INotifier } from "../interfaces";
import { TopicManager } from "../managers/topicManager";
import { RAGAgent } from "./ragAgent";
import type { RAGAgentOptions } from "./ragAgent";
import { createQueryGraph, executeQueryGraph } from "./queryGraph";
import type { QueryGraphDeps } from "./queryGraph";
import type { RetrievalResultEntry } from "./graphState";
import type { MemoryStore } from "../memory/memoryStore";
import type { EmbeddingService } from "../embeddings/embeddingService";
import { Logger } from "../logger";
import { CONFIG, DEFAULTS } from "../constants";
import { RAGQueryParams, RAGQueryResult, RetrievalStrategy } from "../utils/types";
import type { Reranker } from "../rerankers/reranker";

/**
 * Thrown when a topic exists but contains no documents.
 * Callers can catch this specifically to distinguish "empty topic" from real errors.
 */
export class TopicEmptyError extends Error {
  public readonly topicName: string;

  constructor(topicName: string) {
    super(
      `Topic "${topicName}" exists but has no documents. ` +
        `Add documents to the topic before querying.`,
    );
    this.name = "TopicEmptyError";
    this.topicName = topicName;
  }
}

const MAX_CACHED_AGENTS = 10;

/**
 * Build a human-readable position label from a retrieved document's metadata.
 * Handles both the in-memory shape (nested `loc.lines`) and the persisted
 * LanceDB shape (flattened `loc_lines_from`/`loc_lines_to`), falling back to
 * character offsets (`startPosition`/`endPosition`).
 */
function formatPosition(metadata: Record<string, any> | undefined): string {
  const loc = metadata?.loc as { lines?: { from?: number; to?: number } } | undefined;
  const linesFrom = loc?.lines?.from ?? metadata?.loc_lines_from;
  const linesTo = loc?.lines?.to ?? metadata?.loc_lines_to;
  if (linesFrom != null || linesTo != null) {
    return `lines ${linesFrom ?? 0}-${linesTo ?? 0}`;
  }
  return `chars ${metadata?.startPosition ?? 0}-${metadata?.endPosition ?? 0}`;
}

/**
 * Normalize a heading path into a display string. Accepts a live array, the
 * JSON-serialized array persisted to LanceDB, or a plain string.
 */
function formatHeadingPath(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return raw.join(" → ");
  }
  if (typeof raw === "string") {
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.join(" → ");
        }
      } catch {
        // Not JSON — fall through and treat as a plain string.
      }
    }
    return raw;
  }
  return String(raw);
}

export class RAGQueryService {
  private logger = new Logger("RAGQueryService");
  private ragAgents: Map<string, RAGAgent> = new Map();
  // undefined = not attempted yet, null = attempted but failed
  private cachedReranker: Reranker | null | undefined = undefined;
  // Compiled LangGraph query pipeline — compiled once and reused so the
  // per-topic RAGAgent cache inside its retrieve node survives across queries
  // (recompiling per query forced a full agent rebuild every time).
  private compiledQueryGraph: ReturnType<typeof createQueryGraph> | null = null;

  private memoryStore?: MemoryStore;
  private notifier?: INotifier;
  private embeddingService?: EmbeddingService;

  constructor(
    private readonly topicManager: TopicManager,
    private readonly config: IConfigProvider,
    private readonly llmProvider: ILLMProvider,
  ) {}

  /** Set optional dependencies for LangGraph pipeline. */
  public setGraphDeps(deps: {
    memoryStore?: MemoryStore;
    notifier?: INotifier;
    embeddingService?: EmbeddingService;
  }): void {
    this.memoryStore = deps.memoryStore;
    this.notifier = deps.notifier;
    this.embeddingService = deps.embeddingService;
    // Dependencies feeding the compiled graph changed — recompile lazily.
    this.compiledQueryGraph = null;
  }

  /**
   * Execute a RAG query end-to-end.
   *
   * `topK` and `retrievalStrategy` from `params` override config defaults.
   * All other agent settings come from `IConfigProvider`.
   *
   * @param params - Query parameters (topic, query, optional topK / strategy)
   * @param workspaceContext - Optional workspace context string (VS Code only)
   * @throws {TopicEmptyError} if the resolved topic has no documents
   */
  public async executeQuery(
    params: RAGQueryParams,
    workspaceContext?: string,
    signal?: AbortSignal,
  ): Promise<RAGQueryResult> {
    this.logger.info(`RAG query: "${params.query}" for topic: "${params.topic}"`);

    // ── LangGraph pipeline (opt-in) ──
    const langGraphEnabled = this.config.get<boolean>(CONFIG.LANGGRAPH_ENABLED, false);
    if (langGraphEnabled) {
      return this.executeViaGraph(params, workspaceContext, signal);
    }

    return this.executeQueryLegacy(params, workspaceContext, signal);
  }

  /**
   * Existing procedural query flow (RAGAgent-based).
   * Extracted so the LangGraph fallback can invoke it without recursion.
   */
  private async executeQueryLegacy(
    params: RAGQueryParams,
    workspaceContext?: string,
    signal?: AbortSignal,
  ): Promise<RAGQueryResult> {
    // 1. Resolve topic
    const topicMatch = await this.topicManager.resolveTopicByName(params.topic);

    // 2. Check topic has documents
    const stats = await this.topicManager.getTopicStats(topicMatch.topic.id);
    if (!stats || stats.documentCount === 0) {
      throw new TopicEmptyError(topicMatch.topic.name);
    }

    this.logger.info(
      `Topic matched: ${topicMatch.topic.name} (${topicMatch.matchType}), ` +
        `${stats.documentCount} documents, ${stats.chunkCount} chunks`,
    );

    // 3. Get or create RAGAgent for this topic
    const agent = await this.getOrCreateAgent(topicMatch.topic.id);

    // 4. Build agent options: params → config (platforms own their defaults)
    const topK = params.topK ?? this.config.get<number>(CONFIG.TOP_K, 0);
    if (topK < 1 || topK > 20 || !Number.isInteger(topK)) {
      throw new Error(`Invalid topK value: ${topK}. Must be an integer between 1 and 20.`);
    }

    const maxIterations = this.config.get<number>(CONFIG.MAX_ITERATIONS, 0);
    if (maxIterations <= 0 || !Number.isFinite(maxIterations)) {
      throw new Error(`Invalid maxIterations: ${maxIterations}. Must be a positive number.`);
    }

    const confidenceThreshold = this.config.get<number>(CONFIG.CONFIDENCE_THRESHOLD, 0);
    if (confidenceThreshold < 0 || confidenceThreshold > 1) {
      throw new Error(`Invalid confidenceThreshold: ${confidenceThreshold}. Must be between 0 and 1.`);
    }

    const retrievalStrategy =
      params.retrievalStrategy ??
      (this.config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "") as RetrievalStrategy);

    const agentOptions: RAGAgentOptions = {
      topicName: topicMatch.topic.name,
      topK,
      retrievalStrategy,
      maxIterations,
      confidenceThreshold,
      modelFamily: this.config.get<string>(CONFIG.LLM_MODEL, ""),
      workspaceContext: workspaceContext ?? "",
      signal,
    };

    // 5. Run query
    const ragResult = await agent.query(params.query, agentOptions);

    this.logger.info(
      `Query done: ${ragResult.results.length} results, confidence: ${ragResult.avgConfidence.toFixed(2)}`,
    );

    // 6. Format into RAGQueryResult
    return {
      query: params.query,
      topicName: topicMatch.topic.name,
      topicMatched: topicMatch.matchType,
      requestedTopic: topicMatch.matchType !== "exact" ? params.topic : undefined,
      availableTopics: topicMatch.availableTopics,
      agenticMetadata: {
        mode: "agentic",
        steps: ragResult.plan.subQueries.map((sq, idx) => ({
          stepNumber: idx + 1,
          query: sq.query,
          resultsCount: ragResult.results.filter((r) => r.document?.metadata?.subQueryIndex === idx).length,
          confidence: ragResult.avgConfidence,
          reasoning: sq.reasoning,
        })),
        totalIterations: ragResult.iterations,
        queryComplexity: ragResult.plan.complexity,
        confidence: ragResult.avgConfidence,
      },
      results: ragResult.results.map((result) => ({
        text: result.document.pageContent,
        documentName: result.document.metadata.source || "Unknown",
        similarity: Math.round(result.score * 100) / 100,
        retrievalStrategy: result.source || "unknown",
        metadata: {
          chunkIndex: result.document.metadata.chunkIndex || 0,
          position: formatPosition(result.document.metadata),
          headingPath: formatHeadingPath(result.document.metadata.headingPath),
          sectionTitle: result.document.metadata.sectionTitle,
        },
      })),
    };
  }

  /**
   * Invalidate the cached RAGAgent for a topic (call when topic is deleted/updated).
   */
  public clearAgentCache(topicId: string): void {
    const removed = this.ragAgents.delete(topicId);
    if (removed) {
      this.logger.debug(`Cleared agent cache for topic: ${topicId}`);
    }
    // The compiled query graph holds its own per-topic agents; drop it so
    // the next graph query rebuilds against the topic's fresh state.
    this.compiledQueryGraph = null;
  }

  /**
   * Dispose all cached agents.
   */
  public dispose(): void {
    if (this.cachedReranker) {
      this.cachedReranker.dispose();
      this.cachedReranker = undefined;
    }
    this.ragAgents.clear();
    this.compiledQueryGraph = null;
    this.logger.info("RAGQueryService disposed");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Execute query via the LangGraph pipeline, mapping the result back to
   * the standard RAGQueryResult format. Falls back to the existing flow
   * on unrecoverable errors so callers see consistent behaviour.
   */
  private async executeViaGraph(
    params: RAGQueryParams,
    workspaceContext?: string,
    signal?: AbortSignal,
  ): Promise<RAGQueryResult> {
    // Resolve topic first (same as existing flow)
    const topicMatch = await this.topicManager.resolveTopicByName(params.topic);

    const stats = await this.topicManager.getTopicStats(topicMatch.topic.id);
    if (!stats || stats.documentCount === 0) {
      throw new TopicEmptyError(topicMatch.topic.name);
    }

    // Build a no-op notifier when the caller hasn't provided one
    const notifier: INotifier = this.notifier ?? {
      showInfo: () => {},
      showWarning: () => {},
      showError: () => {},
      withProgress: async <T>(_title: string, task: (report: (msg: string) => void) => Promise<T>) =>
        task(() => {}),
    };

    const embeddingService =
      this.embeddingService ?? this.topicManager.getEmbeddingService();
    const reranker = await this.getOrCreateReranker();

    const deps: QueryGraphDeps = {
      llmProvider: this.llmProvider,
      config: this.config,
      notifier,
      embeddingService,
      topicManager: this.topicManager,
      memoryStore: this.memoryStore,
      reranker: reranker ?? undefined,
    };

    try {
      // Compile once and reuse — the compiled graph caches per-topic agents.
      this.compiledQueryGraph ??= createQueryGraph(deps);

      const graphResult = await executeQueryGraph(
        deps,
        params.query,
        topicMatch.topic.id,
        {
          retrievalStrategy:
            params.retrievalStrategy ??
            this.config.get<string>(CONFIG.RETRIEVAL_STRATEGY, ""),
          topK: params.topK ?? this.config.get<number>(CONFIG.TOP_K, 5),
          modelFamily: this.config.get<string>(CONFIG.LLM_MODEL, ""),
          maxIterations: this.config.get<number>(CONFIG.MAX_ITERATIONS, 3),
          confidenceThreshold: this.config.get<number>(CONFIG.CONFIDENCE_THRESHOLD, 0.7),
          signal,
          compiledGraph: this.compiledQueryGraph,
        },
      );

      return this.mapGraphResult(graphResult, params, topicMatch);
    } catch (error) {
      // A cancelled query must stay cancelled — never fall back to a fresh run.
      if (signal?.aborted) {
        throw error;
      }
      this.logger.warn(
        "LangGraph query pipeline failed, falling back to existing flow",
        { error: error instanceof Error ? error.message : String(error) },
      );
      // Fall back: run through the standard procedural path (bypass flag)
      return this.executeQueryLegacy(params, workspaceContext, signal);
    }
  }

  /**
   * Map the raw graph result record to the standard RAGQueryResult shape.
   */
  private mapGraphResult(
    graphResult: Record<string, unknown>,
    params: RAGQueryParams,
    topicMatch: { topic: { name: string }; matchType: "exact" | "similar" | "fallback"; availableTopics?: string[] },
  ): RAGQueryResult {
    const results = (graphResult.results ?? []) as RetrievalResultEntry[];
    const plan = graphResult.plan as
      | { subQueries: { query: string; reasoning: string }[]; complexity: string }
      | undefined;
    const confidence = (graphResult.confidence as number) ?? 0;
    const iterations = (graphResult.iterations as number) ?? 1;

    return {
      query: params.query,
      topicName: topicMatch.topic.name,
      topicMatched: topicMatch.matchType,
      requestedTopic: topicMatch.matchType !== "exact" ? params.topic : undefined,
      availableTopics: topicMatch.availableTopics,
      agenticMetadata: {
        mode: "agentic",
        steps: plan?.subQueries.map((sq, idx) => ({
          stepNumber: idx + 1,
          query: sq.query,
          resultsCount: results.filter(
            (r) => (r.metadata?.subQuery as string) === sq.query,
          ).length,
          confidence,
          reasoning: sq.reasoning,
        })),
        totalIterations: iterations,
        queryComplexity: (plan?.complexity as "simple" | "moderate" | "complex") ?? "simple",
        confidence,
      },
      results: results.map((r) => ({
        text: r.content,
        documentName: r.source || "Unknown",
        similarity: Math.round(r.score * 100) / 100,
        retrievalStrategy: (r.metadata?.retrievalStrategy as string) || "vector",
        metadata: {
          chunkIndex: (r.metadata?.chunkIndex as number) || 0,
          position: formatPosition(r.metadata),
          headingPath: formatHeadingPath(r.metadata?.headingPath),
          sectionTitle: r.metadata?.sectionTitle as string | undefined,
        },
      })),
    };
  }

  private async getOrCreateAgent(topicId: string): Promise<RAGAgent> {
    if (this.ragAgents.has(topicId)) {
      const agent = this.ragAgents.get(topicId)!;
      // Promote to most-recently-used position for true LRU eviction
      this.ragAgents.delete(topicId);
      this.ragAgents.set(topicId, agent);
      return agent;
    }

    this.logger.debug(`Creating RAGAgent for topic: ${topicId}`);
    const agent = new RAGAgent(this.config, this.llmProvider);

    const vectorStore = await this.topicManager.getVectorStore(topicId);
    if (!vectorStore) {
      throw new Error(`Failed to load vector store for topic: ${topicId}`);
    }

    const documentFetcher = (limit: number) => this.topicManager.getAllDocuments(topicId, limit);

    // Load knowledge graph if available (for GRAPH/GRAPH_HYBRID strategies)
    const knowledgeGraph = await this.topicManager.getKnowledgeGraph(topicId);

    // Create reranker (shared across agents)
    const reranker = await this.getOrCreateReranker();

    await agent.initialize(vectorStore, {
      documentFetcher,
      knowledgeGraph: knowledgeGraph ?? undefined,
      embeddingService: knowledgeGraph ? this.topicManager.getEmbeddingService() : undefined,
      reranker: reranker ?? undefined,
    });

    // Evict oldest if cache is full
    if (this.ragAgents.size >= MAX_CACHED_AGENTS) {
      const firstKey = this.ragAgents.keys().next().value;
      if (firstKey) {this.ragAgents.delete(firstKey);}
    }
    this.ragAgents.set(topicId, agent);

    return agent;
  }

  private async getOrCreateReranker(): Promise<Reranker | null> {
    if (this.cachedReranker !== undefined) return this.cachedReranker;
    this.cachedReranker = await this.createReranker();
    return this.cachedReranker;
  }

  /**
   * Create the cross-encoder reranker.
   * Lazily imports to avoid loading ONNX at startup.
   */
  private async createReranker(): Promise<Reranker | null> {
    try {
      const { CrossEncoderReranker } = await import("../rerankers/crossEncoderReranker.js");
      const model = this.config.get<string>(CONFIG.RERANKER_MODEL, "") || undefined;
      const maxCandidates = this.config.get<number>(CONFIG.RERANKER_MAX_CANDIDATES, DEFAULTS.RERANKER_MAX_CANDIDATES);
      const reranker = new CrossEncoderReranker(model, { maxCandidates });
      await reranker.initialize();
      return reranker;
    } catch (error) {
      this.logger.warn("Failed to create reranker, proceeding without reranking", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
