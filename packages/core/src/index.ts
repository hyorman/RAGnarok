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
export { EXTENSION, CONFIG, DEFAULTS } from "./constants";

// Types
export {
  RetrievalStrategy,
  Topic,
  TopicSource,
  Document,
  TextChunk,
  TopicData,
  TopicsIndex,
  SearchResult,
  RAGQueryParams,
  RAGQueryResult,
  ExportedTopicData,
} from "./utils/types";

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
export type { EmbeddingBackend, EmbeddingBackendType } from "./embeddings/embeddingBackend";
export { EmbeddingService } from "./embeddings/embeddingService";
export type { AvailableModel } from "./embeddings/embeddingService";
export { ModelRegistry } from "./embeddings/modelRegistry";
export { HuggingFaceBackend } from "./embeddings/huggingFaceBackend";
export { RemoteEmbeddingBackend } from "./embeddings/remoteEmbeddingBackend";
export type { RemoteEmbeddingFormat } from "./embeddings/remoteEmbeddingBackend";
export { TransformersEmbeddings } from "./embeddings/langchainEmbeddings";

// Vector Store
export { VectorStoreFactory } from "./stores/vectorStoreFactory";
export type { VectorStoreConfig, VectorStoreMetadata } from "./stores/vectorStoreFactory";

// Retrievers
export { VectorRetriever } from "./retrievers/vectorRetriever";
export { KeywordRetriever } from "./retrievers/keywordRetriever";
export { HybridRetriever } from "./retrievers/hybridRetriever";
export type { HybridSearchOptions } from "./retrievers/hybridRetriever";
export { EnsembleRetrieverWrapper } from "./retrievers/ensembleRetriever";

// Agents
export { RAGAgent } from "./agents/ragAgent";
export { QueryPlannerAgent } from "./agents/queryPlannerAgent";
export type { RAGAgentOptions, RetrievalResult } from "./agents/ragAgent";
export type { QueryPlannerOptions, QueryPlan, SubQuery } from "./agents/queryPlannerAgent";

// Managers
export { TopicManager } from "./managers/topicManager";
export type { TopicManagerOptions, CreateTopicOptions, TopicStats, AddDocumentResult } from "./managers/topicManager";
export { DocumentPipeline } from "./managers/documentPipeline";
export type { PipelineOptions, PipelineProgress, PipelineResult } from "./managers/documentPipeline";
