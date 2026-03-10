/**
 * Central constants for the RAGnarōk extension
 * All identifiers, command names, and configuration keys are defined here
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
  // Basic configuration
  LOCAL_MODEL_PATH: "localModelPath",
  TOP_K: "topK",
  CHUNK_SIZE: "chunkSize",
  CHUNK_OVERLAP: "chunkOverlap",
  LOG_LEVEL: "logLevel",
  RETRIEVAL_STRATEGY: "retrievalStrategy",
  // Embedding backend configuration
  EMBEDDING_BACKEND: "embeddingBackend",
  EMBEDDING_VSCODE_MODEL_ID: "embeddingVscodeModelId",
  // RAG query configuration
  MAX_ITERATIONS: "maxIterations",
  CONFIDENCE_THRESHOLD: "confidenceThreshold",
  LLM_MODEL: "llmModel",
  INCLUDE_WORKSPACE: "includeWorkspaceContext",
  GAP_SCORE_THRESHOLD: "gapScoreThreshold",
  // Common database configuration
  COMMON_DATABASE_PATH: "commonDatabasePath",
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  LOCAL_MODEL_PATH: "",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
} as const;

/**
 * Command identifiers
 */
export const COMMANDS = {
  // Built-in VS Code command
  SET_CONTEXT: "setContext",
  // Extension commands
  CREATE_TOPIC: "ragnarok.createTopic",
  DELETE_TOPIC: "ragnarok.deleteTopic",
  ADD_DOCUMENT: "ragnarok.addDocument",
  ADD_GITHUB_REPO: "ragnarok.addGithubRepo",
  ADD_WEB_URL: "ragnarok.addWebUrl",
  REFRESH_TOPICS: "ragnarok.refreshTopics",
  CLEAR_MODEL_CACHE: "ragnarok.clearModelCache",
  CLEAR_DATABASE: "ragnarok.clearDatabase",
  SET_EMBEDDING_MODEL: "ragnarok.setEmbeddingModel",
  SELECT_VSCODE_EMBEDDING_MODEL: "ragnarok.selectVscodeEmbeddingModel",
  SELECT_HF_EMBEDDING_MODEL: "ragnarok.selectHfEmbeddingModel",
  SELECT_LLM_MODEL: "ragnarok.selectLLMModel",
  EDIT_CONFIG_ITEM: "ragnarok.editConfigItem",
  // GitHub token management
  ADD_GITHUB_TOKEN: "ragnarok.addGithubToken",
  LIST_GITHUB_TOKENS: "ragnarok.listGithubTokens",
  REMOVE_GITHUB_TOKEN: "ragnarok.removeGithubToken",
  // Import/Export
  EXPORT_TOPIC: "ragnarok.exportTopic",
  IMPORT_TOPIC: "ragnarok.importTopic",
  RENAME_TOPIC: "ragnarok.renameTopic",
} as const;

/**
 * View identifiers
 */
export const VIEWS = {
  RAG_TOPICS: "ragTopics",
  RAG_CONFIG: "ragConfig",
} as const;

/**
 * Global state keys
 */
export const STATE = {
  HAS_SHOWN_WELCOME: "ragnarok.hasShownWelcome",
} as const;

/**
 * VS Code context keys (used with setContext for when-clauses)
 */
export const CONTEXT = {
  LOADED: "ragnarok.loaded",
  HAS_TOPICS: "ragnarok.hasTopics",
} as const;

/**
 * Tool identifiers
 */
export const TOOLS = {
  RAG_QUERY: "ragQuery",
} as const;

/**
 * Tree-view config item keys — used in both topicTreeView.ts and commands.ts
 * to avoid duplicated hardcoded strings.
 */
export const TREE_CONFIG_KEY = {
  EMBEDDING_MODEL: "embedding-model",
  EMBEDDING_BACKEND: "embedding-backend",
  RETRIEVAL_STRATEGY: "retrieval-strategy",
  TOP_K: "top-k",
  CHUNK_SIZE: "chunk-size",
  CHUNK_OVERLAP: "chunk-overlap",
  LLM_MODEL: "llm-model",
  INCLUDE_WORKSPACE_CONTEXT: "include-workspace-context",
  MAX_ITERATIONS: "max-iterations",
  CONFIDENCE_THRESHOLD: "confidence-threshold",
} as const;
