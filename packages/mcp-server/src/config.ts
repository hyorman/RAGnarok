/**
 * MCP server configuration loaded from environment variables
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";

let cachedVersion: string | null = null;

/**
 * The package's own version, read from its package.json.
 * Single source for the MCP protocol serverInfo and the HTTP health endpoint.
 */
export function getServerVersion(): string {
  if (cachedVersion === null) {
    try {
      // Compiled layout: dist/config.js → ../package.json is this package's manifest
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
      cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      cachedVersion = "unknown";
    }
  }
  return cachedVersion ?? "unknown";
}

export interface McpConfig {
  storageDir: string;
  /** Project root for git-branch-scoped memory (empty = fall back to cwd). */
  workingDir: string;
  /**
   * Roots that rag_add_documents may read from (RAGNAROK_ALLOWED_PATHS,
   * path-delimiter separated). Empty = default to the working directory.
   */
  allowedPaths: string[];
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  retrievalStrategy: string;
  maxIterations: number;
  confidenceThreshold: number;
  langGraphEnabled: boolean;
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
  rerankerModel: string;
  rerankerMaxCandidates: number;
  rerankerCandidateMultiplier: number;
}

/**
 * Startup validation: every env-derived value is range/enum-checked once,
 * with cross-field rules for provider credentials. Invalid configuration
 * fails fast with a readable message instead of surfacing much later as
 * NaN math, silent misrouting, or confusing runtime errors.
 */
const configSchema = z
  .object({
    storageDir: z.string().min(1),
    workingDir: z.string(),
    allowedPaths: z.array(z.string()),
    embeddingModel: z.string().min(1),
    chunkSize: z.number().int().min(50).max(20000),
    chunkOverlap: z.number().int().min(0).max(10000),
    topK: z.number().int().min(1).max(50),
    retrievalStrategy: z.enum(["vector", "hybrid", "ensemble", "bm25", "graph", "graph_hybrid"]),
    maxIterations: z.number().int().min(1).max(10),
    confidenceThreshold: z.number().min(0).max(1),
    langGraphEnabled: z.boolean(),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    port: z.number().int().min(1).max(65535),
    llmProvider: z.enum(["none", "openai", "anthropic", "ollama"]),
    llmApiKey: z.string(),
    llmModel: z.string(),
    llmBaseUrl: z.string(),
    embeddingProvider: z.enum(["huggingface", "openai", "ollama"]),
    embeddingBaseUrl: z.string(),
    embeddingApiKey: z.string(),
    apiKey: z.string(),
    corsOrigin: z.string().min(1),
    httpHost: z.string().min(1),
    rerankerModel: z.string().min(1),
    rerankerMaxCandidates: z.number().int().min(1).max(200),
    rerankerCandidateMultiplier: z.number().int().min(1).max(20),
  })
  .superRefine((cfg, ctx) => {
    if ((cfg.llmProvider === "openai" || cfg.llmProvider === "anthropic") && !cfg.llmApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llmApiKey"],
        message: `RAGNAROK_LLM_API_KEY is required when RAGNAROK_LLM_PROVIDER=${cfg.llmProvider}`,
      });
    }
    if (cfg.embeddingProvider !== "huggingface" && !cfg.embeddingBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddingBaseUrl"],
        message: "RAGNAROK_EMBEDDING_BASE_URL is required when RAGNAROK_EMBEDDING_PROVIDER is not huggingface",
      });
    }
    if (cfg.chunkOverlap >= cfg.chunkSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkOverlap"],
        message: `RAGNAROK_CHUNK_OVERLAP (${cfg.chunkOverlap}) must be smaller than RAGNAROK_CHUNK_SIZE (${cfg.chunkSize})`,
      });
    }
  });

export function loadConfig(): McpConfig {
  const raw: McpConfig = {
    storageDir: process.env.RAGNAROK_STORAGE_DIR || path.join(os.homedir(), ".ragnarok"),
    workingDir: process.env.RAGNAROK_WORKING_DIR || "",
    allowedPaths: (process.env.RAGNAROK_ALLOWED_PATHS || "")
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
    embeddingModel: process.env.RAGNAROK_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
    chunkSize: parseInt(process.env.RAGNAROK_CHUNK_SIZE || "1000", 10),
    chunkOverlap: parseInt(process.env.RAGNAROK_CHUNK_OVERLAP || "200", 10),
    topK: parseInt(process.env.RAGNAROK_TOP_K || "10", 10),
    retrievalStrategy: process.env.RAGNAROK_RETRIEVAL_STRATEGY || "hybrid",
    maxIterations: parseInt(process.env.RAGNAROK_MAX_ITERATIONS || "3", 10),
    confidenceThreshold: parseFloat(process.env.RAGNAROK_CONFIDENCE_THRESHOLD || "0.7"),
    langGraphEnabled:
      process.env.RAGNAROK_LANGGRAPH_ENABLED === "true" || process.env.RAGNAROK_LANGGRAPH_ENABLED === "1",
    logLevel: process.env.RAGNAROK_LOG_LEVEL || "info",
    port: parseInt(process.env.RAGNAROK_PORT || "3000", 10),
    llmProvider: process.env.RAGNAROK_LLM_PROVIDER || "none",
    llmApiKey: process.env.RAGNAROK_LLM_API_KEY || "",
    llmModel: process.env.RAGNAROK_LLM_MODEL || "",
    // No default here: each provider applies its own (Ollama falls back to
    // http://localhost:11434). A global Ollama default silently routed
    // OpenAI/Anthropic requests to localhost.
    llmBaseUrl: process.env.RAGNAROK_LLM_BASE_URL || "",
    embeddingProvider: process.env.RAGNAROK_EMBEDDING_PROVIDER || "huggingface",
    embeddingBaseUrl: process.env.RAGNAROK_EMBEDDING_BASE_URL || "",
    embeddingApiKey: process.env.RAGNAROK_EMBEDDING_API_KEY || "",
    apiKey: process.env.RAGNAROK_API_KEY || "",
    // WARNING: Default '*' allows all origins. Restrict in production (e.g. "https://yourdomain.com").
    corsOrigin: process.env.RAGNAROK_CORS_ORIGIN || "*",
    httpHost: process.env.RAGNAROK_HTTP_HOST || "127.0.0.1",
    rerankerModel: process.env.RAGNAROK_RERANKER_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerMaxCandidates: parseInt(process.env.RAGNAROK_RERANKER_MAX_CANDIDATES || "20", 10),
    rerankerCandidateMultiplier: parseInt(process.env.RAGNAROK_RERANKER_CANDIDATE_MULTIPLIER || "4", 10),
  };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid RAGnarōk configuration:\n${issues}`);
  }
  return parsed.data;
}
