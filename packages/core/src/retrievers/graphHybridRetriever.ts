/**
 * GraphHybridRetriever - Fusion of graph-based and vector-based retrieval
 *
 * Combines results from GraphRetriever (entity-aware) and VectorRetriever (semantic)
 * using weighted score fusion. Falls back gracefully when either source is unavailable.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { GraphRetriever, GraphSearchResult, GraphSearchOptions, GraphRetrievalLimitError } from "./graphRetriever";
import { KnowledgeGraphEmbeddingMismatchError } from "../stores/knowledgeGraph";
import { KnowledgeGraphCorruptionError, KnowledgeGraphLimitError } from "../stores/knowledgeGraphStore";
import { VectorRetriever, VectorSearchResult } from "./vectorRetriever";
import { Logger } from "../logger";
import { getDocumentIdentity } from "../utils/retrievalIdentity";

export interface GraphHybridSearchOptions {
  /** Number of results to return */
  k: number;
  /** Weight for graph-based scores (default: 0.3) */
  graphWeight?: number;
  /** Weight for vector-based scores (default: 0.7) */
  vectorWeight?: number;
  /** Minimum fused score threshold (default: 0) */
  minSimilarity?: number;
  /** Graph search options */
  graphOptions?: Partial<GraphSearchOptions>;
}

export const DEFAULT_GRAPH_HYBRID_OPTIONS = {
  graphWeight: 0.3,
  vectorWeight: 0.7,
  minSimilarity: 0.0,
} as const;

export interface GraphHybridSearchResult {
  document: LangChainDocument;
  score: number;
  scoreKind: "graph_similarity" | "weighted_fusion" | "vector_similarity";
  graphScore: number;
  vectorScore: number;
  componentScores: { graph?: number; vector?: number };
  matchedEntities: string[];
  hopDepth: number;
  effectiveStrategy: "graph_hybrid" | "graph" | "vector";
  degradedFrom?: "graph_hybrid";
  fallbackReason?: "no_graph_matches" | "no_graph_chunks" | "graph_error" | "no_vector_matches" | "vector_error";
}

/**
 * Hybrid retriever combining graph traversal and vector similarity search
 */
export class GraphHybridRetriever {
  private logger: Logger;

  constructor(
    private graphRetriever: GraphRetriever,
    private vectorRetriever: VectorRetriever,
  ) {
    this.logger = new Logger("GraphHybridRetriever");
    this.logger.info("GraphHybridRetriever initialized");
  }

  /**
   * Perform hybrid search combining graph and vector results with weighted score fusion.
   */
  public async search(query: string, options: GraphHybridSearchOptions): Promise<GraphHybridSearchResult[]> {
    const startTime = Date.now();
    const graphWeight = options.graphWeight ?? DEFAULT_GRAPH_HYBRID_OPTIONS.graphWeight;
    const vectorWeight = options.vectorWeight ?? DEFAULT_GRAPH_HYBRID_OPTIONS.vectorWeight;
    const minSimilarity = options.minSimilarity ?? DEFAULT_GRAPH_HYBRID_OPTIONS.minSimilarity;
    this.validateOptions(options.k, graphWeight, vectorWeight, minSimilarity);
    const totalWeight = graphWeight + vectorWeight;
    const normalizedGraphWeight = graphWeight / totalWeight;
    const normalizedVectorWeight = vectorWeight / totalWeight;
    const candidateCount = options.k * 3;

    this.logger.info("Starting graph-hybrid search", {
      query: query.substring(0, 100),
      k: options.k,
      graphWeight,
      vectorWeight,
    });

    // Fetch vector candidates exactly once. GraphRetriever consumes the same
    // result set for document hydration/overlap instead of issuing its own
    // hidden vector query.
    const vectorOutcome = await this.safeVectorSearch(query, candidateCount);
    const graphOutcome = await this.safeGraphSearch(query, {
      k: candidateCount,
      ...options.graphOptions,
      precomputedVectorResults: vectorOutcome.results,
    });
    const graphResults = graphOutcome.results;
    const vectorResults = vectorOutcome.results;

    this.logger.debug("Candidate retrieval complete", {
      graphCandidates: graphResults.length,
      vectorCandidates: vectorResults.length,
    });

    // Build candidate map keyed by chunkId
    const candidateMap = new Map<
      string,
      {
        document: LangChainDocument;
        graphScore: number;
        vectorScore: number;
        hasGraphArm: boolean;
        hasVectorArm: boolean;
        matchedEntities: string[];
        hopDepth: number;
        graphFallbackReason?: GraphHybridSearchResult["fallbackReason"];
      }
    >();

    // Add graph results
    for (const gr of graphResults) {
      const key = getDocumentIdentity(gr.document);
      const graphScore =
        gr.effectiveStrategy === "vector" || gr.degradedFrom ? 0 : (gr.componentScores?.graph ?? gr.score);
      candidateMap.set(key, {
        document: gr.document,
        graphScore,
        vectorScore: gr.componentScores?.vector ?? 0,
        hasGraphArm: gr.effectiveStrategy !== "vector" && !gr.degradedFrom,
        hasVectorArm: gr.componentScores?.vector !== undefined,
        matchedEntities: gr.matchedEntities,
        hopDepth: gr.hopDepth,
        graphFallbackReason: gr.fallbackReason,
      });
    }

    // Merge vector results
    for (const vr of vectorResults) {
      const key = getDocumentIdentity(vr.document);
      const existing = candidateMap.get(key);
      if (existing) {
        existing.vectorScore = vr.score;
        existing.hasVectorArm = true;
      } else {
        candidateMap.set(key, {
          document: vr.document,
          graphScore: 0,
          vectorScore: vr.score,
          hasGraphArm: false,
          hasVectorArm: true,
          matchedEntities: [],
          hopDepth: -1,
          graphFallbackReason: graphOutcome.fallbackReason,
        });
      }
    }

    // Compute fused scores
    const fusedResults: GraphHybridSearchResult[] = [];
    for (const [, candidate] of candidateMap) {
      const hasGraph = candidate.hasGraphArm;
      const hasVector = candidate.hasVectorArm;
      if (!hasGraph && !hasVector) {
        continue;
      }

      const fusedScore =
        hasGraph && hasVector
          ? normalizedGraphWeight * candidate.graphScore + normalizedVectorWeight * candidate.vectorScore
          : hasGraph
            ? candidate.graphScore
            : candidate.vectorScore;
      if (fusedScore >= minSimilarity) {
        const effectiveStrategy = hasGraph && hasVector ? "graph_hybrid" : hasGraph ? "graph" : "vector";
        const fallbackReason: GraphHybridSearchResult["fallbackReason"] | undefined =
          effectiveStrategy === "graph_hybrid"
            ? undefined
            : effectiveStrategy === "vector"
              ? (graphOutcome.fallbackReason ?? candidate.graphFallbackReason ?? "no_graph_matches")
              : (vectorOutcome.fallbackReason ?? "no_vector_matches");
        fusedResults.push({
          document: candidate.document,
          score: fusedScore,
          scoreKind:
            effectiveStrategy === "graph_hybrid"
              ? "weighted_fusion"
              : effectiveStrategy === "graph"
                ? "graph_similarity"
                : "vector_similarity",
          graphScore: candidate.graphScore,
          vectorScore: candidate.vectorScore,
          componentScores: {
            ...(hasGraph ? { graph: candidate.graphScore } : {}),
            ...(hasVector ? { vector: candidate.vectorScore } : {}),
          },
          matchedEntities: candidate.matchedEntities,
          hopDepth: candidate.hopDepth,
          effectiveStrategy,
          degradedFrom: effectiveStrategy === "graph_hybrid" ? undefined : "graph_hybrid",
          fallbackReason,
        });
      }
    }

    // Sort by fused score, limit to k
    fusedResults.sort((a, b) => b.score - a.score);
    const finalResults = fusedResults.slice(0, options.k);

    const searchTime = Date.now() - startTime;
    this.logger.info("Graph-hybrid search complete", {
      resultCount: finalResults.length,
      graphHits: finalResults.filter((r) => r.componentScores.graph !== undefined).length,
      vectorHits: finalResults.filter((r) => r.componentScores.vector !== undefined).length,
      overlapHits: finalResults.filter(
        (r) => r.componentScores.graph !== undefined && r.componentScores.vector !== undefined,
      ).length,
      searchTime,
    });

    return finalResults;
  }

  /**
   * Safe graph search — returns empty on failure instead of throwing.
   */
  private async safeGraphSearch(
    query: string,
    options: GraphSearchOptions,
  ): Promise<{
    results: GraphSearchResult[];
    fallbackReason?: "no_graph_matches" | "no_graph_chunks" | "graph_error";
  }> {
    try {
      const results = await this.graphRetriever.search(query, options);
      const graphResult = results.find((result) => result.effectiveStrategy !== "vector" && !result.degradedFrom);
      const fallbackReason = graphResult ? undefined : (results[0]?.fallbackReason ?? "no_graph_matches");
      return { results, fallbackReason };
    } catch (error) {
      if (
        error instanceof KnowledgeGraphEmbeddingMismatchError ||
        error instanceof KnowledgeGraphCorruptionError ||
        error instanceof KnowledgeGraphLimitError ||
        error instanceof GraphRetrievalLimitError
      ) {
        throw error;
      }
      this.logger.warn("Graph search failed, proceeding with vector only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { results: [], fallbackReason: "graph_error" };
    }
  }

  /**
   * Safe vector search — returns empty on failure instead of throwing.
   */
  private async safeVectorSearch(
    query: string,
    k: number,
  ): Promise<{ results: VectorSearchResult[]; fallbackReason?: "no_vector_matches" | "vector_error" }> {
    try {
      const results = await this.vectorRetriever.search(query, k);
      return { results, fallbackReason: results.length === 0 ? "no_vector_matches" : undefined };
    } catch (error) {
      this.logger.warn("Vector search failed, proceeding with graph only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { results: [], fallbackReason: "vector_error" };
    }
  }

  private validateOptions(k: number, graphWeight: number, vectorWeight: number, minSimilarity: number): void {
    if (!Number.isInteger(k) || k < 1) {
      throw new Error("Graph-hybrid k must be a positive integer");
    }
    if (
      !Number.isFinite(graphWeight) ||
      !Number.isFinite(vectorWeight) ||
      graphWeight < 0 ||
      vectorWeight < 0 ||
      graphWeight + vectorWeight <= 0
    ) {
      throw new Error("Graph-hybrid weights must be finite, non-negative, and have a positive sum");
    }
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      throw new Error("Graph-hybrid minSimilarity must be between 0 and 1");
    }
  }
}
