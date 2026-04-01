/**
 * MCP server configuration loaded from environment variables
 */

import * as os from "os";
import * as path from "path";

export interface McpConfig {
  storageDir: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  retrievalStrategy: string;
  maxIterations: number;
  confidenceThreshold: number;
  logLevel: string;
  port: number;
  llmProvider: string;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  embeddingProvider: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  apiKey: string;
  corsOrigin: string;
  httpHost: string;
}

export function loadConfig(): McpConfig {
  return {
    storageDir: process.env.RAGNAROK_STORAGE_DIR || path.join(os.homedir(), ".ragnarok"),
    embeddingModel: process.env.RAGNAROK_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
    chunkSize: parseInt(process.env.RAGNAROK_CHUNK_SIZE || "1000", 10),
    chunkOverlap: parseInt(process.env.RAGNAROK_CHUNK_OVERLAP || "200", 10),
    topK: parseInt(process.env.RAGNAROK_TOP_K || "5", 10),
    retrievalStrategy: process.env.RAGNAROK_RETRIEVAL_STRATEGY || "hybrid",
    maxIterations: parseInt(process.env.RAGNAROK_MAX_ITERATIONS || "3", 10),
    confidenceThreshold: parseFloat(process.env.RAGNAROK_CONFIDENCE_THRESHOLD || "0.7"),
    logLevel: process.env.RAGNAROK_LOG_LEVEL || "info",
    port: parseInt(process.env.RAGNAROK_PORT || "3000", 10),
    llmProvider: process.env.RAGNAROK_LLM_PROVIDER || "none",
    llmApiKey: process.env.RAGNAROK_LLM_API_KEY || "",
    llmModel: process.env.RAGNAROK_LLM_MODEL || "gpt-4o-mini",
    llmBaseUrl: process.env.RAGNAROK_LLM_BASE_URL || "http://localhost:11434",
    embeddingProvider: process.env.RAGNAROK_EMBEDDING_PROVIDER || "huggingface",
    embeddingBaseUrl: process.env.RAGNAROK_EMBEDDING_BASE_URL || "",
    embeddingApiKey: process.env.RAGNAROK_EMBEDDING_API_KEY || "",
    apiKey: process.env.RAGNAROK_API_KEY || "",
    // WARNING: Default '*' allows all origins. Restrict in production (e.g. "https://yourdomain.com").
    corsOrigin: process.env.RAGNAROK_CORS_ORIGIN || "*",
    httpHost: process.env.RAGNAROK_HTTP_HOST || "127.0.0.1",
  };
}
