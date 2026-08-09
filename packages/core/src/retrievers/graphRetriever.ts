/**
 * GraphRetriever - Entity-aware retrieval using knowledge graph traversal
 *
 * Performs local search by: (1) identifying entities in the query via name matching
 * and embedding similarity, (2) traversing the KG neighborhood via BFS,
 * (3) scoring entities by match quality and hop distance, (4) collecting source chunks.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { KnowledgeGraph } from "../stores/knowledgeGraph";
import { VectorRetriever, VectorSearchResult } from "./vectorRetriever";
import { EmbeddingService } from "../embeddings/embeddingService";
import { GraphEntity } from "../utils/graphTypes";
import { Logger } from "../logger";
import { getChunkId, getDocumentIdentity } from "../utils/retrievalIdentity";
import { BASE_STOP_WORDS } from "../utils/keywords";

export { getChunkId, getDocumentIdentity } from "../utils/retrievalIdentity";

/** Minimum share of an entity's name tokens that must appear in the query. */
const MIN_NAME_COVERAGE = 0.5;
/** Score awarded when the whole normalized entity name equals the query text. */
const EXACT_NAME_SCORE = 1;
/** Ceiling for a partial (token-coverage) name match. */
const MAX_PARTIAL_NAME_SCORE = 0.85;
/**
 * Share of a graph chunk's score retained when the query has no vector
 * similarity for it. Graph traversal exists to surface chunks the vector index
 * ranks poorly, so relevance may modulate the structural score but must not
 * zero it.
 */
const RELEVANCE_FLOOR = 0.35;

/**
 * Split text into comparable whole tokens.
 *
 * Technical corpora carry identifiers like `ragnarok.graph.visualization.v1`,
 * `@ragnarok/mcp-server`, and `snake_case`, so punctuation and camelCase are
 * treated as token boundaries. Stop words are dropped so that common filler in
 * a natural-language question cannot match an entity on its own.
 */
export function tokenizeForEntityMatch(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !BASE_STOP_WORDS.has(token));
}

/**
 * Grade how well an entity name is covered by the query's tokens.
 *
 * Returns null when coverage is below `MIN_NAME_COVERAGE`, so a single shared
 * token cannot drag a many-worded entity into the seed set. Grading matters as
 * much as filtering: seeds enter BFS at this score, so a flat value would make
 * every depth-0 chunk score identically and destroy ranking.
 */
export function scoreNameMatch(entityName: string, queryTokens: ReadonlySet<string>): number | null {
  const nameTokens = tokenizeForEntityMatch(entityName);
  if (nameTokens.length === 0) {
    return null;
  }
  const distinct = new Set(nameTokens);
  let matched = 0;
  for (const token of distinct) {
    if (queryTokens.has(token)) {
      matched++;
    }
  }
  if (matched === 0) {
    return null;
  }
  const coverage = matched / distinct.size;
  if (coverage < MIN_NAME_COVERAGE) {
    return null;
  }
  // Full-name match is the strongest signal; partial matches scale with
  // coverage and are additionally damped when the name is a single token, so a
  // one-word entity cannot outrank a fully matched multi-word entity.
  if (coverage === 1) {
    return distinct.size > 1 ? EXACT_NAME_SCORE : MAX_PARTIAL_NAME_SCORE;
  }
  return Math.min(MAX_PARTIAL_NAME_SCORE, coverage * MAX_PARTIAL_NAME_SCORE);
}

export interface GraphSearchOptions {
  /** Number of results to return */
  k: number;
  /** Maximum BFS hop depth from matched entities (default: 2) */
  maxHopDepth?: number;
  /** Score decay per hop (default: 0.5) */
  hopDecay?: number;
  /** Minimum score threshold (default: 0) */
  minScore?: number;
  /** Minimum raw cosine similarity for embedding entity matches (default: 0.6) */
  entitySimilarityThreshold?: number;
  /**
   * Vector results already fetched by a composing retriever. Supplying these
   * prevents a second vector query while preserving document hydration and
   * standalone graph/vector blending.
   */
  precomputedVectorResults?: readonly VectorSearchResult[];
}

/** Default graph search options */
export const DEFAULT_GRAPH_OPTIONS = {
  maxHopDepth: 2,
  hopDecay: 0.5,
  minScore: 0,
  entitySimilarityThreshold: 0.6,
} as const;

export interface GraphSearchResult {
  document: LangChainDocument;
  score: number;
  scoreKind: "graph_similarity" | "weighted_fusion" | "vector_similarity";
  componentScores: { graph?: number; vector?: number };
  /** Entities that contributed to this result */
  matchedEntities: string[];
  /** Minimum hop distance from a matched entity */
  hopDepth: number;
  /** Requested strategy that degraded to this result's effective strategy. */
  degradedFrom?: "graph";
  fallbackReason?: "no_graph_matches" | "no_graph_chunks";
  effectiveStrategy: "graph" | "vector";
}

const MAX_DOCS_FOR_GRAPH_LOOKUP = 50_000;

export class GraphRetrievalLimitError extends Error {
  constructor(limit: number) {
    super(
      `Graph retrieval requires hydrating more than ${limit} chunks. ` +
        "Narrow or rebuild the topic before using graph retrieval; results were not silently truncated.",
    );
    this.name = "GraphRetrievalLimitError";
  }
}

/**
 * Shared chunk-id accessor. Extracts a normalized chunk-id string from a
 * document/result metadata bag, or null when absent. Vector, graph, and
 * graph-hybrid candidate keying should all funnel through this helper so a
 * chunk is identified consistently no matter which retrieval path produced
 * it (ad-hoc `metadata.chunkId` variants can silently disagree on type
 * coercion or fallback behavior and break dedup/merge across retrievers).
 */
/**
 * Graph retriever that leverages knowledge graph entity relationships
 * to find relevant document chunks.
 */
export class GraphRetriever {
  private logger: Logger;

  constructor(
    private knowledgeGraph: KnowledgeGraph,
    private vectorRetriever: VectorRetriever,
    private embeddingService: EmbeddingService,
    private documentFetcher?: (limit: number) => Promise<LangChainDocument[]>,
  ) {
    this.logger = new Logger("GraphRetriever");
  }

  private chunkDocumentMapPromise: Promise<Map<string, LangChainDocument>> | null = null;

  /**
   * Local search: find entities matching the query, traverse their neighborhoods,
   * and collect scored document chunks.
   */
  public async search(query: string, options: GraphSearchOptions): Promise<GraphSearchResult[]> {
    const startTime = Date.now();
    const maxHopDepth = options.maxHopDepth ?? 2;
    const hopDecay = options.hopDecay ?? 0.5;
    const minScore = options.minScore ?? 0;
    const entitySimilarityThreshold =
      options.entitySimilarityThreshold ?? DEFAULT_GRAPH_OPTIONS.entitySimilarityThreshold;

    this.logger.info("Starting graph search", {
      query: query.substring(0, 100),
      k: options.k,
      maxHopDepth,
    });

    if (typeof this.embeddingService.getFingerprint === "function") {
      this.knowledgeGraph.validateEmbeddingFingerprint(await this.embeddingService.getFingerprint());
    }

    // Step 1: Find matching entities (name match + embedding similarity)
    const matchedEntities = await this.findMatchingEntities(query, options.k * 2, entitySimilarityThreshold);

    if (matchedEntities.length === 0) {
      this.logger.info("No matching entities found, falling back to vector search");
      return this.fallbackToVector(query, options.k, "no_graph_matches", options.precomputedVectorResults);
    }

    this.logger.debug("Matched entities", {
      count: matchedEntities.length,
      names: matchedEntities.slice(0, 5).map((m) => m.entity.name),
    });

    // Vector results are fetched before scoring, not after, because the graph
    // score alone carries no query-to-chunk relevance signal: every chunk
    // reachable from one entity at one depth scores identically, so a hub
    // entity spanning much of the corpus hands all of its chunks the same
    // value and ranking among them degenerates to insertion order.
    let vectorResults: readonly VectorSearchResult[] = options.precomputedVectorResults ?? [];
    if (!options.precomputedVectorResults) {
      try {
        vectorResults = await this.vectorRetriever.search(query, options.k * 3);
      } catch (error) {
        this.logger.warn("Vector search failed during graph search; using graph-only results when available", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const relevanceByChunk = new Map<string, number>();
    for (const vr of vectorResults) {
      const chunkId = getChunkId(vr.document.metadata);
      if (chunkId && Number.isFinite(vr.score)) {
        relevanceByChunk.set(chunkId, Math.max(0, Math.min(1, vr.score)));
      }
    }

    // Entity specificity. An entity mentioned across most of the corpus
    // discriminates nothing, so weight each by inverse chunk frequency.
    const entityIdf = this.computeEntityIdf(this.knowledgeGraph.getAllEntities());

    // Step 2: BFS traverse neighborhoods and score by hop distance
    const chunkScores = new Map<string, { score: number; entities: Set<string>; hopDepth: number }>();

    for (const match of matchedEntities) {
      // Collect source chunks from the matched entity itself
      this.addChunkScores(chunkScores, match.entity, match.score, 0, entityIdf);

      // Traverse neighbors via BFS
      this.knowledgeGraph.traverseBFS(
        match.entity.id,
        (neighbor: GraphEntity, depth: number) => {
          if (depth === 0) {
            return;
          } // Skip self (already handled)
          const neighborScore = match.score * Math.pow(hopDecay, depth);
          this.addChunkScores(chunkScores, neighbor, neighborScore, depth, entityIdf);
        },
        maxHopDepth,
      );
    }

    // Blend query relevance into the structural score. The floor keeps
    // graph-only discoveries alive — chunks outside the vector top-N are
    // exactly what graph traversal exists to surface — while letting query
    // similarity break the ties a hub entity would otherwise create.
    for (const [chunkId, data] of chunkScores) {
      const relevance = relevanceByChunk.get(chunkId) ?? 0;
      data.score = data.score * (RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * relevance);
    }

    // Step 3: Collect unique chunk IDs, sorted by score
    const rankedChunkIds = Array.from(chunkScores.entries())
      .filter(([, data]) => data.score >= minScore)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, options.k * 2)
      .map(([chunkId]) => chunkId);

    if (rankedChunkIds.length === 0) {
      this.logger.info("No chunks found from graph traversal, falling back to vector search");
      return this.fallbackToVector(query, options.k, "no_graph_chunks", options.precomputedVectorResults);
    }

    // Step 4: Hydrate graph-derived chunk IDs to documents.
    const resultsByKey = new Map<string, GraphSearchResult>();

    await this.hydrateGraphChunkResults(rankedChunkIds, chunkScores, resultsByKey);

    const vectorFallbacks: GraphSearchResult[] = [];

    for (const vr of vectorResults) {
      const chunkId = getChunkId(vr.document.metadata);
      const resultKey = this.getResultKey(vr.document);

      if (chunkId && chunkScores.has(chunkId)) {
        const chunkData = chunkScores.get(chunkId)!;
        resultsByKey.set(resultKey, {
          document: vr.document,
          score: Math.min(1, vr.score * 0.5 + chunkData.score * 0.5),
          scoreKind: "weighted_fusion",
          componentScores: { vector: vr.score, graph: chunkData.score },
          matchedEntities: Array.from(chunkData.entities),
          hopDepth: chunkData.hopDepth,
          effectiveStrategy: "graph",
        });
        continue;
      }

      if (!resultsByKey.has(resultKey)) {
        vectorFallbacks.push({
          document: vr.document,
          score: vr.score,
          scoreKind: "vector_similarity",
          componentScores: { vector: vr.score },
          matchedEntities: [],
          hopDepth: -1,
          degradedFrom: "graph",
          fallbackReason: "no_graph_chunks",
          effectiveStrategy: "vector",
        });
      }
    }

    const results = Array.from(resultsByKey.values()).sort((a, b) => b.score - a.score);
    for (const fallback of vectorFallbacks) {
      if (results.length >= options.k) {
        break;
      }
      results.push(fallback);
    }

    results.sort((a, b) => b.score - a.score);
    const finalResults = results.slice(0, options.k);

    const searchTime = Date.now() - startTime;
    this.logger.info("Graph search complete", {
      resultCount: finalResults.length,
      graphHits: finalResults.filter((r) => r.matchedEntities.length > 0).length,
      searchTime,
    });

    return finalResults;
  }

  /**
   * Find entities matching the query via name matching and embedding similarity.
   */
  private async findMatchingEntities(
    query: string,
    limit: number,
    entitySimilarityThreshold: number,
  ): Promise<Array<{ entity: GraphEntity; score: number }>> {
    const matchMap = new Map<string, { entity: GraphEntity; score: number }>();

    // Method 1: Name matching over whole tokens.
    //
    // Substring containment was previously used here and matched far too
    // eagerly: the query token "port" matched the entity "exports", and short
    // entity names matched any token that happened to contain them. Because
    // every hit also scored a flat 0.8, unrelated entities seeded traversal at
    // the same weight as exact matches, and every depth-0 chunk then landed on
    // an identical score — ranking within that tier was arbitrary. Matching on
    // whole tokens and grading by name coverage fixes both.
    const queryTokens = new Set(tokenizeForEntityMatch(query));
    const allEntities = this.knowledgeGraph.getAllEntities();

    if (queryTokens.size > 0) {
      for (const entity of allEntities) {
        const nameScore = scoreNameMatch(entity.name, queryTokens);
        if (nameScore === null) {
          continue;
        }
        const existing = matchMap.get(entity.id);
        if (!existing || existing.score < nameScore) {
          matchMap.set(entity.id, { entity, score: nameScore });
        }
      }
    }

    // Method 2: Embedding similarity — embed the query and search entity vectors
    try {
      const queryVector = await this.embeddingService.embed(query);
      const embeddingResults = this.knowledgeGraph.searchEntitiesByEmbedding(queryVector, limit);

      for (const { entity, score } of embeddingResults) {
        // Entity search returns raw cosine similarity. Zero is orthogonal (or
        // a dimension mismatch), not a neutral 0.5 match. Only positive,
        // sufficiently similar entities may seed graph traversal.
        if (!Number.isFinite(score) || score < entitySimilarityThreshold) {
          continue;
        }
        const normalizedScore = Math.max(0, Math.min(1, score));
        const existing = matchMap.get(entity.id);
        if (!existing || existing.score < normalizedScore) {
          matchMap.set(entity.id, { entity, score: Math.max(existing?.score ?? 0, normalizedScore) });
        }
      }
    } catch (error) {
      this.logger.warn("Embedding search for entities failed, using name matching only", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Sort by score, limit results
    return Array.from(matchMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Add chunk scores from an entity, merging with existing scores.
   */
  /**
   * Inverse chunk frequency per entity, over the chunk universe the graph
   * itself references. An entity covering most chunks (measured: "RAGnarok"
   * spanned 37 of 222) adds almost no evidence that a particular chunk answers
   * the query, so it is damped relative to a specific entity.
   */
  private computeEntityIdf(entities: readonly GraphEntity[]): Map<string, number> {
    const universe = new Set<string>();
    for (const entity of entities) {
      for (const chunkId of entity.sourceChunkIds) {
        universe.add(chunkId);
      }
    }
    const total = universe.size;
    const idf = new Map<string, number>();
    if (total === 0) {
      return idf;
    }
    const maxIdf = Math.log(1 + total);
    for (const entity of entities) {
      const raw = Math.log(1 + total / (1 + entity.sourceChunkIds.length));
      idf.set(entity.id, maxIdf > 0 ? Math.max(0, Math.min(1, raw / maxIdf)) : 1);
    }
    return idf;
  }

  private addChunkScores(
    chunkScores: Map<string, { score: number; entities: Set<string>; hopDepth: number }>,
    entity: GraphEntity,
    rawScore: number,
    depth: number,
    entityIdf?: ReadonlyMap<string, number>,
  ): void {
    const score = rawScore * (entityIdf?.get(entity.id) ?? 1);
    for (const chunkId of entity.sourceChunkIds) {
      const existing = chunkScores.get(chunkId);
      if (existing) {
        existing.score = Math.max(existing.score, score);
        existing.entities.add(entity.name);
        existing.hopDepth = Math.min(existing.hopDepth, depth);
      } else {
        chunkScores.set(chunkId, {
          score,
          entities: new Set([entity.name]),
          hopDepth: depth,
        });
      }
    }
  }

  /**
   * Fallback to pure vector search when no graph entities match.
   */
  private async fallbackToVector(
    query: string,
    k: number,
    fallbackReason: "no_graph_matches" | "no_graph_chunks",
    precomputedVectorResults?: readonly VectorSearchResult[],
  ): Promise<GraphSearchResult[]> {
    const vectorResults = precomputedVectorResults ?? (await this.vectorRetriever.search(query, k));
    return vectorResults.map((vr) => ({
      document: vr.document,
      score: vr.score,
      scoreKind: "vector_similarity",
      componentScores: { vector: vr.score },
      matchedEntities: [],
      hopDepth: -1,
      degradedFrom: "graph",
      fallbackReason,
      effectiveStrategy: "vector",
    }));
  }

  private async hydrateGraphChunkResults(
    rankedChunkIds: string[],
    chunkScores: Map<string, { score: number; entities: Set<string>; hopDepth: number }>,
    resultsByKey: Map<string, GraphSearchResult>,
  ): Promise<void> {
    if (!this.documentFetcher) {
      return;
    }

    try {
      const chunkDocumentMap = await this.getChunkDocumentMap();

      for (const chunkId of rankedChunkIds) {
        const document = chunkDocumentMap.get(chunkId);
        const chunkData = chunkScores.get(chunkId);
        if (!document || !chunkData) {
          continue;
        }

        resultsByKey.set(this.getResultKey(document), {
          document,
          score: chunkData.score,
          scoreKind: "graph_similarity",
          componentScores: { graph: chunkData.score },
          matchedEntities: Array.from(chunkData.entities),
          hopDepth: chunkData.hopDepth,
          effectiveStrategy: "graph",
        });
      }
    } catch (error) {
      if (error instanceof GraphRetrievalLimitError) {
        throw error;
      }
      this.logger.warn("Failed to hydrate graph chunk documents from table scan", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getChunkDocumentMap(): Promise<Map<string, LangChainDocument>> {
    if (!this.documentFetcher) {
      return new Map();
    }

    if (!this.chunkDocumentMapPromise) {
      this.chunkDocumentMapPromise = this.documentFetcher(MAX_DOCS_FOR_GRAPH_LOOKUP + 1)
        .then((documents) => {
          if (documents.length > MAX_DOCS_FOR_GRAPH_LOOKUP) {
            throw new GraphRetrievalLimitError(MAX_DOCS_FOR_GRAPH_LOOKUP);
          }
          const documentMap = new Map<string, LangChainDocument>();

          for (const document of documents) {
            const chunkId = getChunkId(document.metadata);
            if (chunkId && !documentMap.has(chunkId)) {
              documentMap.set(chunkId, document);
            }
          }

          this.logger.debug("Indexed chunk documents for graph retrieval", {
            documentCount: documents.length,
            chunkCount: documentMap.size,
          });

          return documentMap;
        })
        .catch((error) => {
          this.chunkDocumentMapPromise = null;
          throw error;
        });
    }

    return this.chunkDocumentMapPromise;
  }

  private getResultKey(document: LangChainDocument): string {
    return getDocumentIdentity(document);
  }
}
