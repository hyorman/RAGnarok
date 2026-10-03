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
  TopicsIndex,
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
export { EmbeddingServiceRegistry, isCapExempt } from "./embeddings/embeddingServiceRegistry";
export type { EmbeddingResolution, EmbeddingServiceRegistryOptions } from "./embeddings/embeddingServiceRegistry";

// Vector Store
export {
  VectorStoreFactory,
  VectorStoreMetadataCorruptionError,
  EmbeddingFingerprintMismatchError,
  EmbeddingEndpointMismatchError,
  VectorStoreLoadError,
} from "./stores/vectorStoreFactory";
export type { VectorStoreConfig, VectorStoreMetadata } from "./stores/vectorStoreFactory";

// Graph visualization types
export { projectMemoryGraphVisualization, reduceGraphVisualizationDocument } from "./visualization/graphVisualization";
export type {
  JsonValue,
  GraphVisualizationSource,
  GraphVisualizationNode,
  GraphVisualizationEdge,
  GraphVisualizationGroup,
  GraphVisualizationDocument,
  GraphVisualizationOptions,
} from "./visualization/graphVisualization";
export { GraphVisualizationService } from "./visualization/graphVisualizationService";
export type { GraphVisualizationRequest } from "./visualization/graphVisualizationService";

// Retrievers
export { VectorRetriever } from "./retrievers/vectorRetriever";
export type { VectorSearchResult } from "./retrievers/vectorRetriever";
export { lanceDistanceToSimilarity, unitCosineToLanceDistance } from "./utils/vectorMath";
export { KeywordRetriever } from "./retrievers/keywordRetriever";
export { HybridRetriever, DEFAULT_HYBRID_OPTIONS } from "./retrievers/hybridRetriever";
export type { HybridSearchOptions } from "./retrievers/hybridRetriever";
export { getChunkId, getDocumentIdentity } from "./utils/retrievalIdentity";

// Rerankers
export type { Reranker, ScoredDocument, RerankerOptions } from "./rerankers/reranker";
export { CrossEncoderReranker } from "./rerankers/crossEncoderReranker";
export { RerankerModelRegistry } from "./models/rerankerModelRegistry.js";
export type { AvailableRerankerModel } from "./models/rerankerModelRegistry.js";

// Agents
export { RAGAgent } from "./agents/ragAgent";
export { QueryPlannerAgent } from "./agents/queryPlannerAgent";
export { RAGQueryService, TopicEmptyError } from "./agents/ragQueryService";
export type { RAGAgentOptions, RetrievalResult } from "./agents/ragAgent";
export type { QueryPlannerOptions, QueryPlan, SubQuery } from "./agents/queryPlannerAgent";

// Managers
export { TopicManager } from "./managers/topicManager";
export type {
  TopicManagerOptions,
  CreateTopicOptions,
  TopicStats,
  AddDocumentResult,
  StorageExternalChange,
} from "./managers/topicManager";
export { DocumentPipeline } from "./managers/documentPipeline";
export type { PipelineOptions, PipelineProgress, PipelineResult } from "./managers/documentPipeline";

// Shared tool contracts and executors
export * from "./tools";

// Standalone Memory Module
export {
  MemoryStore,
  MemoryOperationCoordinator,
  MemoryService,
  MemoryServiceError,
  reduceMemoryOperationResult,
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
} from "./memory";

// Storage format and durable JSON helpers
export {
  STORAGE_FORMAT_VERSION,
  STORAGE_FORMAT_FILENAME,
  STORAGE_CONFIG_FILENAME,
  StorageFormatVersionError,
  StorageResetInterruptedError,
  UnsupportedStorageError,
  atomicWriteFile,
  atomicWriteJson,
  ensureStorageFormat,
  inspectStorage,
  resetStorage,
} from "./utils/storage";
export type { StorageFormatMarker, StorageInspection } from "./utils/storage";
export { SharedTopicRegistry } from "./sharedTopics/registry";
export { ArchiveFolderSource, createSharedTopicSources } from "./sharedTopics/archiveFolderSource";
export { SharedArchiveCache, deriveSharedTopicId } from "./sharedTopics/archiveCache";
export { SharedTopicReadOnlyError } from "./sharedTopics/types";
export type { SharedTopicSource, SharedTopicSourceContext, ResolvedSharedTopic } from "./sharedTopics/types";
export { SHARED_TOPIC_CACHE_DIRNAME } from "./utils/storage";
export {
  acquireStorageLock,
  acquireOperationLease,
  StorageLockHeldError,
  StorageBusyError,
  STORAGE_LOCK_FILENAME,
} from "./utils/storageLock";
export type { StorageLockHandle, StorageLockOptions, OperationLeaseOptions, LockFileInfo } from "./utils/storageLock";
export { StorageTransactionCoordinator } from "./utils/storageTransactionCoordinator";
export type { StorageTransactionFence, StorageTransactionOperation } from "./utils/storageTransactionCoordinator";
export type {
  MemoryStoreOptions,
  MemoryServiceErrorCode,
  MemoryBranchContext,
  MemoryHostContext,
  MemoryOperationInput,
  MemoryResultMeasurement,
  MemoryResponseMeta,
  StoreMemoryResult,
  RecallMemoryResult,
  ForgetMemoryResult,
  MemoryStatsResult,
  ListMemoryResult,
  DecayMemoryResult,
  HistoryMemoryResult,
  PromoteMemoryResult,
  LinksMemoryResult,
  CommunitiesMemoryResult,
  MemoryOperationResult,
  MemoryResetResult,
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
  MemoryGraphSnapshot,
  MemoryCommunity,
  DecayStatus,
  ScopeLink,
  ExtractedMemoryEntity,
  ExtractedMemoryRelationship,
  ExtractionResult as MemoryExtractionResult,
} from "./memory";
