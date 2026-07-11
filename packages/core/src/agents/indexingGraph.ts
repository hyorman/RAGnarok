/**
 * LangGraph Indexing Pipeline
 *
 * Compiles a StateGraph that orchestrates the document indexing flow:
 *   START → loadDocuments → chunkDocuments → embedAndStore → [hasLLM?]
 *     hasLLM=true  → extractEntities → storeEntities → buildResult → END
 *     hasLLM=false → buildResult → END
 *
 * Documents are loaded and chunked exactly ONCE: the same chunks flow to
 * entity extraction and to vector storage, so extracted sourceChunkIds always
 * agree with the persisted chunks. Storage goes through the store-only
 * pipeline path (TopicManager.storeProcessedChunks) — it must never re-run
 * the full load/chunk pipeline.
 *
 * A failed stage routes directly to buildResult instead of flowing stale
 * state through dependent stages. All intermediate data lives in graph state,
 * so a compiled graph is safe to reuse and to invoke concurrently.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { IConfigProvider, ILLMProvider } from "../interfaces";
import type { TopicManager } from "../managers/topicManager";
import { DocumentLoaderFactory } from "../loaders/documentLoaderFactory";
import { SemanticChunker } from "../splitters/semanticChunker";
import { EntityExtractor } from "./entityExtractor";
import { DEFAULT_ENTITY_EXTRACTOR_OPTIONS } from "./entityExtractorTypes";
import { KnowledgeGraph } from "../stores/knowledgeGraph";
import { IndexingPipelineState, IndexingPipelineStateType, IndexingPipelineUpdateType } from "./graphState";
import { upsertExtractedGraphData } from "../utils/knowledgeGraphAssembly";
import { Logger } from "../logger";

// ── Dependencies ─────────────────────────────────────────────────────

export interface IndexingGraphDeps {
  topicManager: TopicManager;
  llmProvider?: ILLMProvider;
  /** Config provider so chunking uses the host's configured options. */
  config?: IConfigProvider;
  checkpointer?: BaseCheckpointSaver;
}

// ── Node Functions ───────────────────────────────────────────────────

const logger = new Logger("IndexingGraph");

/**
 * Load documents from file paths using DocumentLoaderFactory.
 * Delegates to the same loader the DocumentPipeline uses internally.
 */
function createLoadDocumentsNode(_deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    logger.info("loadDocuments: starting", { fileCount: state.filePaths.length });

    try {
      const loader = new DocumentLoaderFactory();
      const loaderInputs = state.filePaths.map((filePath) => ({ filePath }));
      const results = await loader.loadDocuments(loaderInputs);
      const docs = results.flatMap((r) => r.documents);

      if (docs.length === 0) {
        const msg = "loadDocuments failed: no documents loaded (check file paths and loader configuration)";
        logger.error(msg);
        return { errors: [msg], completedStage: "loaded" };
      }

      logger.info("loadDocuments: complete", { documentCount: docs.length });
      return { loadedDocs: docs, documentCount: docs.length, completedStage: "loaded" };
    } catch (error) {
      const msg = `loadDocuments failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(msg);
      return { errors: [msg], completedStage: "loaded" };
    }
  };
}

/**
 * Chunk the loaded documents using SemanticChunker with the host's configured
 * chunking options — the SAME options the storage stage uses, so chunk IDs
 * seen by entity extraction match the persisted chunks.
 */
function createChunkDocumentsNode(deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    logger.info("chunkDocuments: starting", { documentCount: state.loadedDocs.length });

    try {
      const chunker = new SemanticChunker(deps.config);
      const result = await chunker.chunkDocuments(state.loadedDocs);

      if (result.chunkCount === 0) {
        const msg = "chunkDocuments failed: no chunks produced";
        logger.error(msg);
        return { errors: [msg], completedStage: "chunked" };
      }

      logger.info("chunkDocuments: complete", { chunkCount: result.chunkCount });
      return { chunks: result.chunks, chunkCount: result.chunkCount, completedStage: "chunked" };
    } catch (error) {
      const msg = `chunkDocuments failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(msg);
      return { errors: [msg], completedStage: "chunked" };
    }
  };
}

/**
 * Embed and persist the chunks produced by chunkDocuments through the
 * store-only pipeline path. This is the single storage pass — it must NOT
 * call TopicManager.addDocuments, which would re-load and re-chunk the files
 * (and, with the LangGraph flag enabled, recurse back into this graph).
 */
function createEmbedAndStoreNode(deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    logger.info("embedAndStore: starting", {
      topicId: state.topicId,
      chunkCount: state.chunks.length,
    });

    try {
      await deps.topicManager.storeProcessedChunks(state.topicId, state.chunks);

      logger.info("embedAndStore: complete", { chunksStored: state.chunks.length });
      return { completedStage: "stored" };
    } catch (error) {
      const msg = `embedAndStore failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(msg);
      return { errors: [msg], completedStage: "stored" };
    }
  };
}

/**
 * Extract entities and relationships from the SAME chunks that were stored.
 * Only runs when an LLM provider is available.
 */
function createExtractEntitiesNode(deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    if (!deps.llmProvider) {
      logger.debug("extractEntities: no LLM provider, skipping");
      return { completedStage: "extracted" };
    }

    if (state.chunks.length === 0) {
      logger.debug("extractEntities: no chunks, skipping");
      return { entityCount: 0, relationshipCount: 0, completedStage: "extracted" };
    }

    logger.info("extractEntities: starting", { chunkCount: state.chunks.length });

    try {
      const extractor = new EntityExtractor(deps.llmProvider);
      const result = await extractor.extractFromChunks(state.chunks, {
        batchSize: DEFAULT_ENTITY_EXTRACTOR_OPTIONS.batchSize,
        rateLimitMs: DEFAULT_ENTITY_EXTRACTOR_OPTIONS.rateLimitMs,
        maxConsecutiveFailures: DEFAULT_ENTITY_EXTRACTOR_OPTIONS.maxConsecutiveFailures,
        entityTypes: [...DEFAULT_ENTITY_EXTRACTOR_OPTIONS.entityTypes],
      });

      logger.info("extractEntities: complete", {
        entities: result.entities.length,
        relationships: result.relationships.length,
      });

      return {
        extractedEntities: result.entities,
        extractedRelationships: result.relationships,
        entityCount: result.entities.length,
        relationshipCount: result.relationships.length,
        completedStage: "extracted",
      };
    } catch (error) {
      const msg = `extractEntities failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(msg);
      return { errors: [msg], completedStage: "extracted" };
    }
  };
}

/**
 * Persist extracted entities into KnowledgeGraph (in-memory) + KnowledgeGraphStore (LanceDB).
 */
function createStoreEntitiesNode(deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    if (state.extractedEntities.length === 0) {
      logger.debug("storeEntities: nothing to store");
      return { completedStage: "entities_stored" };
    }

    logger.info("storeEntities: starting", {
      entities: state.extractedEntities.length,
      relationships: state.extractedRelationships.length,
    });

    try {
      const kgStore = deps.topicManager.getKnowledgeGraphStore();
      if (!kgStore) {
        logger.warn("storeEntities: no KnowledgeGraphStore available");
        return { completedStage: "entities_stored" };
      }

      // Load existing graph or create a new one
      const existingKg = await deps.topicManager.getKnowledgeGraph(state.topicId);
      const kg = existingKg ?? new KnowledgeGraph(state.topicId);

      // Embed entity descriptions
      const embeddingService = deps.topicManager.getEmbeddingService();
      const extractor = new EntityExtractor(deps.llmProvider!);
      const entityEmbeddings = await extractor.embedEntities(state.extractedEntities, embeddingService);

      const graphUpsert = upsertExtractedGraphData({
        knowledgeGraph: kg,
        entities: state.extractedEntities,
        relationships: state.extractedRelationships,
        entityEmbeddings,
        chunks: state.chunks,
      });

      // Persist to LanceDB
      await kgStore.saveGraph(state.topicId, kg.toJSON());

      logger.info("storeEntities: complete", {
        entities: graphUpsert.entityCount,
        relationships: graphUpsert.relationshipCount,
      });

      return {
        entityCount: graphUpsert.entityCount,
        relationshipCount: graphUpsert.relationshipCount,
        completedStage: "entities_stored",
      };
    } catch (error) {
      const msg = `storeEntities failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(msg);
      return { errors: [msg], completedStage: "entities_stored" };
    }
  };
}

/**
 * Compile final result with all counts and status.
 */
function createBuildResultNode(_deps: IndexingGraphDeps) {
  return async (state: IndexingPipelineStateType): Promise<IndexingPipelineUpdateType> => {
    const hasErrors = state.errors.length > 0;

    const result: Record<string, unknown> = {
      success: !hasErrors,
      topicId: state.topicId,
      filePaths: state.filePaths,
      documentCount: state.documentCount,
      chunkCount: state.chunkCount,
      entityCount: state.entityCount,
      relationshipCount: state.relationshipCount,
      completedStage: state.completedStage,
      errors: hasErrors ? state.errors : undefined,
    };

    logger.info("buildResult: indexing pipeline complete", {
      success: !hasErrors,
      documents: state.documentCount,
      chunks: state.chunkCount,
      entities: state.entityCount,
      relationships: state.relationshipCount,
    });

    return { result };
  };
}

// ── Routing ──────────────────────────────────────────────────────────

/** Route to buildResult as soon as a stage has failed. */
function failOr(next: "chunk" | "store") {
  return (state: IndexingPipelineStateType): "fail" | "chunk" | "store" => {
    return state.errors.length > 0 ? "fail" : next;
  };
}

/** After storage: fail → buildResult; otherwise extract when an LLM exists. */
function afterStore(deps: IndexingGraphDeps) {
  return (state: IndexingPipelineStateType): "fail" | "extract" | "build" => {
    if (state.errors.length > 0) {
      return "fail";
    }
    return deps.llmProvider ? "extract" : "build";
  };
}

// ── Graph Factory ────────────────────────────────────────────────────

/**
 * Create a compiled LangGraph StateGraph for the indexing pipeline.
 * The compiled graph carries no per-run state and can be reused.
 */
export function createIndexingGraph(deps: IndexingGraphDeps) {
  const graph = new StateGraph(IndexingPipelineState)
    .addNode("loadDocuments", createLoadDocumentsNode(deps))
    .addNode("chunkDocuments", createChunkDocumentsNode(deps))
    .addNode("embedAndStore", createEmbedAndStoreNode(deps))
    .addNode("extractEntities", createExtractEntitiesNode(deps))
    .addNode("storeEntities", createStoreEntitiesNode(deps))
    .addNode("buildResult", createBuildResultNode(deps))
    // Edges — every stage failure short-circuits to buildResult
    .addEdge(START, "loadDocuments")
    .addConditionalEdges("loadDocuments", failOr("chunk"), {
      fail: "buildResult",
      chunk: "chunkDocuments",
    })
    .addConditionalEdges("chunkDocuments", failOr("store"), {
      fail: "buildResult",
      store: "embedAndStore",
    })
    .addConditionalEdges("embedAndStore", afterStore(deps), {
      fail: "buildResult",
      extract: "extractEntities",
      build: "buildResult",
    })
    .addEdge("extractEntities", "storeEntities")
    .addEdge("storeEntities", "buildResult")
    .addEdge("buildResult", END);

  return graph.compile({
    checkpointer: deps.checkpointer,
  });
}

// ── Execution Helper ─────────────────────────────────────────────────

/**
 * High-level helper: create a compiled indexing graph and invoke it.
 *
 * @param deps      - Graph dependencies (topicManager, optional llmProvider/config)
 * @param filePaths - File paths to index
 * @param topicId   - Target topic ID
 * @param threadId  - Optional thread ID for checkpointer continuity
 * @returns         - The final pipeline result record
 */
export async function executeIndexingGraph(
  deps: IndexingGraphDeps,
  filePaths: string[],
  topicId: string,
  threadId?: string,
): Promise<Record<string, unknown>> {
  const compiled = createIndexingGraph(deps);

  const initialState: Partial<IndexingPipelineStateType> = {
    filePaths,
    topicId,
  };

  const config: Record<string, unknown> = {};
  if (threadId) {
    config.configurable = { thread_id: threadId };
  }

  const finalState = await compiled.invoke(initialState, config);

  return finalState.result ?? {};
}
