/**
 * Core constants for RAGnarōk (portable, no VS Code dependency)
 */

import { RetrievalStrategy } from "./utils/types";

/**
 * Extension identifiers
 */
export const EXTENSION = {
  ID: "ragnarok",
  DISPLAY_NAME: "RAGnarōk",
  DATABASE_DIR: "database",
  TOPICS_INDEX_FILENAME: "topics.json",
  /** The human-readable memory export each host writes into its storage directory. */
  MEMORIES_MARKDOWN_FILENAME: "memories.md",
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
  RERANKER_MODEL: "rerankerModel",
  RERANKER_MAX_CANDIDATES: "rerankerMaxCandidates",
  RERANKER_CANDIDATE_MULTIPLIER: "rerankerCandidateMultiplier",
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  LOCAL_MODEL_PATH: "",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  RERANKER_MODEL: "Xenova/ms-marco-MiniLM-L-6-v2",
  // 40, not 20: this is the ceiling on candidates handed to the cross-encoder,
  // and it must not bind before RERANKER_CANDIDATE_MULTIPLIER does. At the
  // default topK of 10, a ceiling of 20 silently reduced the documented 4x
  // over-fetch to 2x, and at the maximum topK of 20 it removed it entirely —
  // leaving the reranker able only to reorder results it could not improve.
  RERANKER_MAX_CANDIDATES: 40,
  RERANKER_CANDIDATE_MULTIPLIER: 4,
  // Each value below equals the VS Code manifest's default for the setting and,
  // where MCP has the setting, its config.json default. topK is deliberately
  // absent: the VS Code setting defaults to 5 and MCP's to 10.
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 200,
  RETRIEVAL_STRATEGY: RetrievalStrategy.HYBRID,
  MAX_ITERATIONS: 3,
  CONFIDENCE_THRESHOLD: 0.7,
  LOG_LEVEL: "info",
  EMBEDDING_BACKEND: "auto",
  /** Weight-bearing embedding models kept resident at once (MCP: embedding.maxResidentModels). */
  MAX_RESIDENT_MODELS: 2,
} as const;

/** Single source of truth for per-provider default model ids. */
export const PROVIDER_DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  ollama: "llama3",
} as const;
export type LLMProviderName = keyof typeof PROVIDER_DEFAULT_MODELS;

/** Public GitHub's host. Its API is api.github.com; a GitHub Enterprise host serves /api/v3. */
export const GITHUB_HOST = "github.com";
