/**
 * VS Code-specific constants - extends core constants
 */

// Re-export everything from core
export { EXTENSION, CONFIG, DEFAULTS } from "@ragnarok/core";

/**
 * Tool identifiers
 */
export const TOOLS = {
  RAG_QUERY: "ragQuery",
} as const;

/**
 * Command identifiers
 */
export const COMMANDS = {
  SET_CONTEXT: "setContext",
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
  ADD_GITHUB_TOKEN: "ragnarok.addGithubToken",
  LIST_GITHUB_TOKENS: "ragnarok.listGithubTokens",
  REMOVE_GITHUB_TOKEN: "ragnarok.removeGithubToken",
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
 * VS Code context keys
 */
export const CONTEXT = {
  LOADED: "ragnarok.loaded",
  HAS_TOPICS: "ragnarok.hasTopics",
} as const;

/**
 * Tree view configuration keys
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
