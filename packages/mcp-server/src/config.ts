/**
 * MCP server configuration: environment variables first, then the optional
 * config.json in the storage directory, then the built-in defaults.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { readConfigFile } from "./configFile";

let cachedVersion: string | null = null;

/**
 * The package's own version, read from its package.json.
 * Single source for the MCP protocol serverInfo.
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

const REMOVED_ENV_VARS = [
  "RAGNAROK_DEPLOYMENT_MODE",
  "RAGNAROK_PORT",
  "RAGNAROK_HTTP_HOST",
  "RAGNAROK_ALLOWED_HOSTS",
  "RAGNAROK_CORS_ORIGIN",
  "RAGNAROK_TLS_CERT_PATH",
  "RAGNAROK_TLS_KEY_PATH",
  "RAGNAROK_API_KEY",
  "RAGNAROK_WRITE_API_KEY",
  "RAGNAROK_ADMIN_API_KEY",
  "RAGNAROK_RATE_LIMIT_PER_MINUTE",
  "RAGNAROK_TRUSTED_PROXIES",
  "RAGNAROK_TRANSFER_TTL_MS",
  "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
  "RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES",
  "RAGNAROK_TRANSFER_MAX_SESSIONS",
] as const;

/**
 * Reject configuration that only made sense for the removed HTTP transport.
 * Failing loudly matters: someone who set TLS certificates and API keys
 * believes they are running a hardened network service, and silently starting
 * a stdio server would leave that belief intact.
 */
export function assertNoRemovedEnvVars(): void {
  const present = REMOVED_ENV_VARS.filter((name) => process.env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `These environment variables were removed with the HTTP transport and are no longer supported: ` +
        `${present.join(", ")}. RAGnarōk MCP serves stdio only. See MIGRATION.md at the repository root.`,
    );
  }
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
  logLevel: string;
  llmProvider: string;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  embeddingProvider: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  /** Budget for draining in-flight tool calls on SIGINT/SIGTERM. */
  shutdownDrainMs?: number;
  llmRequestTimeoutMs?: number;
  /** Ceiling on a serialized tool response, enforced in tools.ts. */
  maxResponseBytes?: number;
  rerankerModel: string;
  rerankerEnabled: boolean;
  rerankerMaxCandidates: number;
  rerankerCandidateMultiplier: number;
  exportDir: string;
  githubHosts: string[];
  githubToken: string;
  resetStorage: boolean;
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
    retrievalStrategy: z.enum(["vector", "hybrid", "bm25"]),
    maxIterations: z.number().int().min(1).max(10),
    confidenceThreshold: z.number().min(0).max(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    llmProvider: z.enum(["none", "openai", "anthropic", "ollama"]),
    llmApiKey: z.string(),
    llmModel: z.string(),
    llmBaseUrl: z.string(),
    embeddingProvider: z.enum(["huggingface", "openai", "ollama"]),
    embeddingBaseUrl: z.string(),
    embeddingApiKey: z.string(),
    rerankerModel: z.string().min(1),
    rerankerEnabled: z.boolean(),
    rerankerMaxCandidates: z.number().int().min(1).max(200),
    rerankerCandidateMultiplier: z.number().int().min(1).max(20),
    exportDir: z.string().min(1),
    githubHosts: z.array(z.string().min(1)).min(1),
    githubToken: z.string(),
    resetStorage: z.boolean(),
    shutdownDrainMs: z.number().int().min(1_000).max(120_000),
    llmRequestTimeoutMs: z.number().int().min(1_000).max(300_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
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
    for (const [field, rawUrl] of [
      ["llmBaseUrl", cfg.llmBaseUrl],
      ["embeddingBaseUrl", cfg.embeddingBaseUrl],
    ] as const) {
      if (!rawUrl) {
        continue;
      }
      try {
        const parsed = new URL(rawUrl);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error("invalid endpoint");
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be an HTTP(S) URL without embedded credentials`,
        });
      }
    }
  });

export function loadConfig(): McpConfig {
  const storageDir = process.env.RAGNAROK_STORAGE_DIR || path.join(os.homedir(), ".ragnarok");
  const file = readConfigFile(storageDir);

  const raw: McpConfig = {
    storageDir,
    workingDir: process.env.RAGNAROK_WORKING_DIR || "",
    // An empty RAGNAROK_ALLOWED_PATHS means "no paths", not "unset", so the
    // file is consulted only when the variable is genuinely absent.
    allowedPaths:
      process.env.RAGNAROK_ALLOWED_PATHS !== undefined
        ? process.env.RAGNAROK_ALLOWED_PATHS.split(path.delimiter)
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : (file.allowedPaths ?? []),
    embeddingModel: process.env.RAGNAROK_EMBEDDING_MODEL || file.embeddingModel || "Xenova/all-MiniLM-L6-v2",
    chunkSize: parseInt(process.env.RAGNAROK_CHUNK_SIZE || String(file.chunkSize ?? 1000), 10),
    chunkOverlap: parseInt(process.env.RAGNAROK_CHUNK_OVERLAP || String(file.chunkOverlap ?? 200), 10),
    topK: parseInt(process.env.RAGNAROK_TOP_K || String(file.topK ?? 10), 10),
    retrievalStrategy: process.env.RAGNAROK_RETRIEVAL_STRATEGY || file.retrievalStrategy || "hybrid",
    maxIterations: parseInt(process.env.RAGNAROK_MAX_ITERATIONS || String(file.maxIterations ?? 3), 10),
    confidenceThreshold: parseFloat(
      process.env.RAGNAROK_CONFIDENCE_THRESHOLD || String(file.confidenceThreshold ?? 0.7),
    ),
    logLevel: process.env.RAGNAROK_LOG_LEVEL || file.logLevel || "info",
    llmProvider: process.env.RAGNAROK_LLM_PROVIDER || file.llmProvider || "none",
    llmApiKey: process.env.RAGNAROK_LLM_API_KEY || "",
    llmModel: process.env.RAGNAROK_LLM_MODEL || file.llmModel || "",
    // No default here: each provider applies its own (Ollama falls back to
    // http://localhost:11434). A global Ollama default silently routed
    // OpenAI/Anthropic requests to localhost.
    llmBaseUrl: process.env.RAGNAROK_LLM_BASE_URL || file.llmBaseUrl || "",
    embeddingProvider: process.env.RAGNAROK_EMBEDDING_PROVIDER || file.embeddingProvider || "huggingface",
    embeddingBaseUrl: process.env.RAGNAROK_EMBEDDING_BASE_URL || file.embeddingBaseUrl || "",
    embeddingApiKey: process.env.RAGNAROK_EMBEDDING_API_KEY || "",
    shutdownDrainMs: parseInt(process.env.RAGNAROK_SHUTDOWN_DRAIN_MS || String(file.shutdownDrainMs ?? 10000), 10),
    llmRequestTimeoutMs: parseInt(
      process.env.RAGNAROK_LLM_REQUEST_TIMEOUT_MS || String(file.llmRequestTimeoutMs ?? 30000),
      10,
    ),
    maxResponseBytes: parseInt(process.env.RAGNAROK_MAX_RESPONSE_BYTES || String(file.maxResponseBytes ?? 1048576), 10),
    rerankerModel: process.env.RAGNAROK_RERANKER_MODEL || file.rerankerModel || "Xenova/ms-marco-MiniLM-L-6-v2",
    // `false` is a meaningful env value, so absence - not falsiness - is what
    // hands the decision to the file.
    rerankerEnabled:
      process.env.RAGNAROK_RERANKER_ENABLED !== undefined
        ? process.env.RAGNAROK_RERANKER_ENABLED !== "0" && process.env.RAGNAROK_RERANKER_ENABLED !== "false"
        : (file.rerankerEnabled ?? true),
    rerankerMaxCandidates: parseInt(
      process.env.RAGNAROK_RERANKER_MAX_CANDIDATES || String(file.rerankerMaxCandidates ?? 20),
      10,
    ),
    rerankerCandidateMultiplier: parseInt(
      process.env.RAGNAROK_RERANKER_CANDIDATE_MULTIPLIER || String(file.rerankerCandidateMultiplier ?? 4),
      10,
    ),
    exportDir: process.env.RAGNAROK_EXPORT_DIR || file.exportDir || path.join(storageDir, "exports"),
    // As with allowedPaths, an empty RAGNAROK_GITHUB_HOSTS is a deliberate
    // "no hosts" rather than an absent setting.
    githubHosts:
      process.env.RAGNAROK_GITHUB_HOSTS !== undefined
        ? process.env.RAGNAROK_GITHUB_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean)
        : (file.githubHosts ?? ["github.com"]),
    githubToken: process.env.RAGNAROK_GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN || "",
    resetStorage:
      process.argv.includes("--reset-storage") ||
      process.env.RAGNAROK_RESET_STORAGE === "1" ||
      process.env.RAGNAROK_RESET_STORAGE === "true",
  };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid RAGnarōk configuration:\n${issues}`);
  }
  return parsed.data;
}
