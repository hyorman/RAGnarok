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
  ROOT: "ragnarok",
  LOCAL_MODEL_PATH: "localModelPath",
  TOP_K: "topK",
  CHUNK_SIZE: "chunkSize",
  CHUNK_OVERLAP: "chunkOverlap",
  LOG_LEVEL: "logLevel",
  RETRIEVAL_STRATEGY: "retrievalStrategy",
  EMBEDDING_BACKEND: "embeddingBackend",
  EMBEDDING_VSCODE_MODEL_ID: "embeddingVscodeModelId",
  MAX_ITERATIONS: "maxIterations",
  CONFIDENCE_THRESHOLD: "confidenceThreshold",
  LLM_MODEL: "llmModel",
  INCLUDE_WORKSPACE: "includeWorkspaceContext",
  GAP_SCORE_THRESHOLD: "gapScoreThreshold",
  COMMON_DATABASE_PATH: "commonDatabasePath",
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  LOCAL_MODEL_PATH: "",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
} as const;
