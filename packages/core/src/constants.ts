/**
 * Core constants for RAGnarōk (portable, no VS Code dependency)
 */

/**
 * Extension identifiers
 */
export const EXTENSION = {
  ID: "ragnarok",
  DISPLAY_NAME: "RAGnarōk",
  DATABASE_DIR: "database",
  TOPICS_INDEX_FILENAME: "topics.json",
} as const;

/**
 * Configuration keys
 */
export const CONFIG = {
  LOCAL_MODEL_PATH: "localModelPath",
  TOP_K: "topK",
  CHUNK_SIZE: "chunkSize",
  CHUNK_OVERLAP: "chunkOverlap",
  LOG_LEVEL: "logLevel",
  RETRIEVAL_STRATEGY: "retrievalStrategy",
  EMBEDDING_BACKEND: "embeddingBackend",
  MAX_ITERATIONS: "maxIterations",
  CONFIDENCE_THRESHOLD: "confidenceThreshold",
  LLM_MODEL: "llmModel",
  GAP_SCORE_THRESHOLD: "gapScoreThreshold",
  COMMON_DATABASE_PATH: "commonDatabasePath",
  MEMORY_CONFIDENCE_THRESHOLD: "memoryConfidenceThreshold",
  LANGGRAPH_ENABLED: "langGraphEnabled",
  RERANKER_MODEL: "rerankerModel",
  RERANKER_ENABLED: "rerankerEnabled",
  RERANKER_MAX_CANDIDATES: "rerankerMaxCandidates",
  RERANKER_CANDIDATE_MULTIPLIER: "rerankerCandidateMultiplier",
  QUERY_MEMORY_ENABLED: "queryMemoryEnabled",
  CHECKPOINT_RETENTION_MS: "checkpointRetentionMs",
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  LOCAL_MODEL_PATH: "",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  RERANKER_MODEL: "Xenova/ms-marco-MiniLM-L-6-v2",
  RERANKER_ENABLED: true,
  RERANKER_MAX_CANDIDATES: 20,
  RERANKER_CANDIDATE_MULTIPLIER: 4,
} as const;
