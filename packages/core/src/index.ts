/**
 * @ragnarok/core — Portable RAG engine
 *
 * Zero VS Code dependencies. Provides document loading, embedding,
 * vector storage, retrieval, and agentic query planning.
 */

// Interfaces
export {
  IConfigProvider,
  ILogger,
  ILoggerFactory,
  INotifier,
  ILLMMessage,
  ILLMModel,
  ILLMProvider,
} from "./interfaces";
export { LogLevel } from "./interfaces";

// Logger
export { Logger, setLoggerFactory, sanitizeErrorMessage } from "./logger";

// Constants
export { EXTENSION, CONFIG, DEFAULTS, PROVIDER_DEFAULT_MODELS } from "./constants";
export type { LLMProviderName } from "./constants";

// Types
export {
  RetrievalStrategy,
  Topic,
  TopicSource,
  Document,
  DocumentSource,
  TextChunk,
  TopicData,
  TopicsIndex,
  SearchResult,
  RAGQueryParams,
  RAGQueryResult,
  ExportedTopicData,
  TopicMatch,
} from "./utils/types";
export { extractKeywords, BASE_STOP_WORDS, QUERY_INTENT_WORDS } from "./utils/keywords";
export type { ExtractKeywordsOptions } from "./utils/keywords";

// Loaders
export { DocumentLoaderFactory } from "./loaders/documentLoaderFactory";
export type { SupportedFileType, LoaderOptions, LoadedDocument } from "./loaders/documentLoaderFactory";
export type { DocumentLoader } from "./loaders/types";
export { TextDocumentLoader, LangChainTextLoader } from "./loaders/textLoader";
export { MarkdownDocumentLoader } from "./loaders/markdownLoader";
export { HtmlDocumentLoader } from "./loaders/htmlLoader";
export { PdfDocumentLoader } from "./loaders/pdfLoader";
export { WebDocumentLoader } from "./loaders/webLoader";
export { GithubDocumentLoader } from "./loaders/githubLoader";

// Splitters
export { SemanticChunker } from "./splitters/semanticChunker";
export type { ChunkingOptions, ChunkingResult } from "./splitters/semanticChunker";

// Embeddings
export type {
  EmbeddingBackend,
  EmbeddingBackendType,
  EmbeddingFingerprint,
  EmbeddingFingerprintInfo,
} from "./embeddings/embeddingBackend";
export { EmbeddingService } from "./embeddings/embeddingService";
export type { AvailableModel } from "./embeddings/embeddingService";
export { ModelRegistry } from "./models/modelRegistry.js";
export { HuggingFaceBackend } from "./embeddings/huggingFaceBackend";
export { RemoteEmbeddingBackend } from "./embeddings/remoteEmbeddingBackend";
export type { RemoteEmbeddingFormat } from "./embeddings/remoteEmbeddingBackend";
export { TransformersEmbeddings } from "./embeddings/langchainEmbeddings";

// Vector Store
export { VectorStoreFactory } from "./stores/vectorStoreFactory";
export type { VectorStoreConfig, VectorStoreMetadata } from "./stores/vectorStoreFactory";

// Knowledge Graph
export {
  EntityType,
  RelationshipType,
  GraphEntity,
  GraphRelationship,
  GraphCommunity,
  KnowledgeGraphData,
  KnowledgeGraphStats,
  VALID_ENTITY_TYPES,
  VALID_RELATIONSHIP_TYPES,
} from "./utils/graphTypes";
export { KnowledgeGraph } from "./stores/knowledgeGraph";
export { KnowledgeGraphStore } from "./stores/knowledgeGraphStore";

// Retrievers
export { VectorRetriever } from "./retrievers/vectorRetriever";
export { KeywordRetriever } from "./retrievers/keywordRetriever";
export { HybridRetriever, DEFAULT_HYBRID_OPTIONS } from "./retrievers/hybridRetriever";
export type { HybridSearchOptions } from "./retrievers/hybridRetriever";
export { EnsembleRetrieverWrapper, DEFAULT_ENSEMBLE_OPTIONS } from "./retrievers/ensembleRetriever";
export type { EnsembleSearchOptions } from "./retrievers/ensembleRetriever";
export { GraphRetriever, DEFAULT_GRAPH_OPTIONS, getChunkId } from "./retrievers/graphRetriever";
export type { GraphSearchOptions, GraphSearchResult } from "./retrievers/graphRetriever";
export { GraphHybridRetriever, DEFAULT_GRAPH_HYBRID_OPTIONS } from "./retrievers/graphHybridRetriever";
export type { GraphHybridSearchOptions, GraphHybridSearchResult } from "./retrievers/graphHybridRetriever";

// Rerankers
export type { Reranker, ScoredDocument, RerankerOptions } from "./rerankers/reranker";
export { CrossEncoderReranker } from "./rerankers/crossEncoderReranker";
export { RerankerModelRegistry } from "./models/rerankerModelRegistry.js";
export type { AvailableRerankerModel } from "./models/rerankerModelRegistry.js";

// Agents
export { RAGAgent } from "./agents/ragAgent";
export { QueryPlannerAgent } from "./agents/queryPlannerAgent";
export { RAGQueryService, TopicEmptyError } from "./agents/ragQueryService";
export { EntityExtractor } from "./agents/entityExtractor";
export type { RAGAgentOptions, RetrievalResult } from "./agents/ragAgent";
export type { QueryPlannerOptions, QueryPlan, SubQuery } from "./agents/queryPlannerAgent";
export type {
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  ExtractionProgress,
  EntityExtractorOptions,
} from "./agents/entityExtractorTypes";
// Runtime constant — a type-only re-export would erase it from the built API
export { DEFAULT_ENTITY_EXTRACTOR_OPTIONS } from "./agents/entityExtractorTypes";

// LangGraph Pipelines
export { createQueryGraph, executeQueryGraph } from "./agents/queryGraph";
export type { QueryGraphDeps, ExecuteQueryGraphOptions } from "./agents/queryGraph";
export { createIndexingGraph, executeIndexingGraph } from "./agents/indexingGraph";
export type { IndexingGraphDeps } from "./agents/indexingGraph";
export { LLMProviderChatModel } from "./agents/llmAdapter";
export { LanceDBCheckpointSaver } from "./stores/lanceDBCheckpointer";
export { QueryPipelineState, IndexingPipelineState } from "./agents/graphState";
export type {
  QueryPipelineStateType,
  IndexingPipelineStateType,
  RetrievalResultEntry,
  QueryPlanRef,
} from "./agents/graphState";

// Managers
export { TopicManager } from "./managers/topicManager";
export type { TopicManagerOptions, CreateTopicOptions, TopicStats, AddDocumentResult } from "./managers/topicManager";
export { DocumentPipeline } from "./managers/documentPipeline";
export type { PipelineOptions, PipelineProgress, PipelineResult } from "./managers/documentPipeline";

// Standalone Memory Module
export {
  MemoryStore,
  MemoryVectorStore,
  MemoryGraph,
  MemoryEntityExtractor,
  MemoryMarkdownExporter,
  MemoryDecayEngine,
  MemoryScopeLinker,
  GitBranchDetector,
  DUPLICATE_SIMILARITY_THRESHOLD,
  DEFAULT_TOP_K,
  MEMORY_TABLE_PREFIX,
  DECAY_LAMBDA,
  MIN_CONFIDENCE_THRESHOLD,
  DECAY_INTERVAL_MS,
} from "./memory";

// Storage format and durable JSON helpers
export {
  STORAGE_FORMAT_VERSION,
  STORAGE_FORMAT_FILENAME,
  atomicWriteFile,
  atomicWriteJson,
  ensureStorageFormatV2,
  resetStorageToV2,
} from "./utils/storageV2";
export type { StorageFormatMarker } from "./utils/storageV2";
export { acquireStorageLock, StorageLockHeldError, STORAGE_LOCK_FILENAME } from "./utils/storageLock";
export type { StorageLockHandle, StorageLockOptions } from "./utils/storageLock";
export type {
  MemoryStoreOptions,
  MemoryScope,
  MemoryEntry,
  MemoryEntity as StandaloneMemoryEntity,
  MemoryEntityType,
  MemoryRelationship as StandaloneMemoryRelationship,
  MemoryRelationshipType,
  StoreOptions as MemoryStoreOpts,
  RecallOptions as MemoryRecallOpts,
  RecallResult as MemoryRecallResult,
  ForgetOptions as MemoryForgetOpts,
  MemoryStats as StandaloneMemoryStats,
  MemoryGraphData,
  DecayStatus,
  ScopeLink,
  ExtractedMemoryEntity,
  ExtractedMemoryRelationship,
  ExtractionResult as MemoryExtractionResult,
} from "./memory";
