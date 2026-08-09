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

import { IConfigProvider, ILLMProvider } from "../interfaces";
import { TopicManager } from "../managers/topicManager";
import { RAGAgent } from "./ragAgent";
import type { RAGAgentOptions } from "./ragAgent";
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
    super(`Topic "${topicName}" exists but has no documents. ` + `Add documents to the topic before querying.`);
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
  if ((linesFrom !== undefined && linesFrom !== null) || (linesTo !== undefined && linesTo !== null)) {
    return `lines ${linesFrom ?? 0}-${linesTo ?? 0}`;
  }
  return `chars ${metadata?.startPosition ?? 0}-${metadata?.endPosition ?? 0}`;
}

/**
 * Normalize a heading path into a display string. Accepts a live array, the
 * JSON-serialized array persisted to LanceDB, or a plain string.
 */
function formatHeadingPath(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
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
  private rerankerExternallyManaged = false;

  constructor(
    private readonly topicManager: TopicManager,
    private readonly config: IConfigProvider,
    private readonly llmProvider: ILLMProvider,
  ) {}

  /**
   * Inject a shared reranker instance so the SAME object serves queries and
   * management tooling — a model switch through the management tools then
   * affects query behaviour instead of only a parallel private instance.
   * The service will not construct its own lazy reranker after this.
   */
  public setReranker(reranker: Reranker): void {
    this.cachedReranker = reranker;
    this.rerankerExternallyManaged = true;
    // Cached agents hold the previous reranker.
    this.ragAgents.clear();
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
    // Cached agents share this instance, so reconcile config-driven model
    // changes before the cache can serve the query.
    await this.getOrCreateReranker();

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
      params.retrievalStrategy ?? (this.config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "") as RetrievalStrategy);

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
          resultsCount: ragResult.results.filter((r) => (r.originalSubQuery ?? r.subQuery) === sq.query).length,
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
          scoreKind: result.scoreKind ?? result.document.metadata.scoreKind,
          componentScores: result.componentScores ?? result.document.metadata.componentScores,
          originalScore: result.originalScore,
          originalScoreKind: result.originalScoreKind,
          originalComponentScores: result.originalComponentScores,
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
  }

  /**
   * Dispose all cached agents.
   */
  public async dispose(): Promise<void> {
    if (this.cachedReranker) {
      await this.cachedReranker.dispose();
      this.cachedReranker = undefined;
    }
    this.ragAgents.clear();
    this.logger.info("RAGQueryService disposed");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

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

    // Create reranker (shared across agents)
    const reranker = await this.getOrCreateReranker();

    await agent.initialize(vectorStore, {
      documentFetcher,
      reranker: reranker ?? undefined,
    });

    // Evict oldest if cache is full
    if (this.ragAgents.size >= MAX_CACHED_AGENTS) {
      const firstKey = this.ragAgents.keys().next().value;
      if (firstKey) {
        this.ragAgents.delete(firstKey);
      }
    }
    this.ragAgents.set(topicId, agent);

    return agent;
  }

  private async getOrCreateReranker(): Promise<Reranker | null> {
    if (this.cachedReranker !== undefined) {
      const desiredModel = this.config.get<string>(CONFIG.RERANKER_MODEL, "");
      if (
        this.cachedReranker &&
        !this.rerankerExternallyManaged &&
        desiredModel &&
        this.cachedReranker.getCurrentModel &&
        this.cachedReranker.switchModel &&
        this.cachedReranker.getCurrentModel() !== desiredModel
      ) {
        try {
          await this.cachedReranker.switchModel(desiredModel);
          this.ragAgents.clear();
        } catch (error) {
          this.logger.warn("Reranker model switch failed; retaining the previous generation", {
            requestedModel: desiredModel,
            activeModel: this.cachedReranker.getCurrentModel(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return this.cachedReranker;
    }
    this.cachedReranker = await this.createReranker();
    return this.cachedReranker;
  }

  /**
   * Create the cross-encoder reranker.
   * Lazily imports to avoid loading ONNX at startup.
   */
  private async createReranker(): Promise<Reranker | null> {
    if (!this.config.get<boolean>(CONFIG.RERANKER_ENABLED, DEFAULTS.RERANKER_ENABLED)) {
      return null;
    }
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
