/**
 * GraphHybridRetriever - Fusion of graph-based and vector-based retrieval
 *
 * Combines results from GraphRetriever (entity-aware) and VectorRetriever (semantic)
 * using weighted score fusion. Falls back gracefully when either source is unavailable.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { GraphRetriever, GraphSearchResult, GraphSearchOptions, getChunkId } from "./graphRetriever";
import { VectorRetriever } from "./vectorRetriever";
import { Logger } from "../logger";

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
  graphScore: number;
  vectorScore: number;
  matchedEntities: string[];
  hopDepth: number;
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
    const candidateCount = options.k * 3;

    this.logger.info("Starting graph-hybrid search", {
      query: query.substring(0, 100),
      k: options.k,
      graphWeight,
      vectorWeight,
    });

    // Fetch candidates from both sources in parallel
    const [graphResults, vectorResults] = await Promise.all([
      this.safeGraphSearch(query, {
        k: candidateCount,
        ...options.graphOptions,
      }),
      this.safeVectorSearch(query, candidateCount),
    ]);

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
        matchedEntities: string[];
        hopDepth: number;
      }
    >();

    // Add graph results
    for (const gr of graphResults) {
      const key = getChunkId(gr.document.metadata) ?? gr.document.pageContent.substring(0, 100);
      candidateMap.set(key, {
        document: gr.document,
        graphScore: gr.score,
        vectorScore: 0,
        matchedEntities: gr.matchedEntities,
        hopDepth: gr.hopDepth,
      });
    }

    // Merge vector results
    for (const vr of vectorResults) {
      const key = getChunkId(vr.document.metadata) ?? vr.document.pageContent.substring(0, 100);
      const existing = candidateMap.get(key);
      if (existing) {
        existing.vectorScore = vr.score;
      } else {
        candidateMap.set(key, {
          document: vr.document,
          graphScore: 0,
          vectorScore: vr.score,
          matchedEntities: [],
          hopDepth: -1,
        });
      }
    }

    // Compute fused scores
    const fusedResults: GraphHybridSearchResult[] = [];
    for (const [, candidate] of candidateMap) {
      const fusedScore = graphWeight * candidate.graphScore + vectorWeight * candidate.vectorScore;
      if (fusedScore >= minSimilarity) {
        fusedResults.push({
          document: candidate.document,
          score: fusedScore,
          graphScore: candidate.graphScore,
          vectorScore: candidate.vectorScore,
          matchedEntities: candidate.matchedEntities,
          hopDepth: candidate.hopDepth,
        });
      }
    }

    // Sort by fused score, limit to k
    fusedResults.sort((a, b) => b.score - a.score);
    const finalResults = fusedResults.slice(0, options.k);

    const searchTime = Date.now() - startTime;
    this.logger.info("Graph-hybrid search complete", {
      resultCount: finalResults.length,
      graphHits: finalResults.filter((r) => r.graphScore > 0).length,
      vectorHits: finalResults.filter((r) => r.vectorScore > 0).length,
      overlapHits: finalResults.filter((r) => r.graphScore > 0 && r.vectorScore > 0).length,
      searchTime,
    });

    return finalResults;
  }

  /**
   * Safe graph search — returns empty on failure instead of throwing.
   */
  private async safeGraphSearch(query: string, options: GraphSearchOptions): Promise<GraphSearchResult[]> {
    try {
      return await this.graphRetriever.search(query, options);
    } catch (error) {
      this.logger.warn("Graph search failed, proceeding with vector only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Safe vector search — returns empty on failure instead of throwing.
   */
  private async safeVectorSearch(
    query: string,
    k: number,
  ): Promise<Array<{ document: LangChainDocument; score: number }>> {
    try {
      return await this.vectorRetriever.search(query, k);
    } catch (error) {
      this.logger.warn("Vector search failed, proceeding with graph only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
