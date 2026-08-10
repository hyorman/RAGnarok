/**
 * MCP server configuration loaded from environment variables
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isIP } from "net";
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
  deploymentMode?: "local" | "shared";
  /** True for configurations produced by loadConfig(). */
  deploymentModeExplicit?: boolean;
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
  port: number;
  llmProvider: string;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  embeddingProvider: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  apiKey: string;
  writeApiKey: string;
  adminApiKey?: string;
  corsOrigin: string;
  httpHost: string;
  /** Exact public Host values accepted by HTTP, without ports or wildcards. */
  allowedHosts: string[];
  tlsCertPath?: string;
  tlsKeyPath?: string;
  trustedProxies?: string[];
  shutdownDrainMs?: number;
  llmRequestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  transferMaxFileBytes?: number;
  transferMaxAggregateBytes?: number;
  transferMaxSessions?: number;
  transferTtlMs?: number;
  rerankerModel: string;
  rerankerEnabled: boolean;
  rerankerMaxCandidates: number;
  rerankerCandidateMultiplier: number;
  rateLimitPerMinute: number;
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
    port: z.number().int().min(1).max(65535),
    llmProvider: z.enum(["none", "openai", "anthropic", "ollama"]),
    llmApiKey: z.string(),
    llmModel: z.string(),
    llmBaseUrl: z.string(),
    embeddingProvider: z.enum(["huggingface", "openai", "ollama"]),
    embeddingBaseUrl: z.string(),
    embeddingApiKey: z.string(),
    apiKey: z.string(),
    writeApiKey: z.string(),
    corsOrigin: z.string().min(1),
    httpHost: z.string().min(1),
    allowedHosts: z.array(z.string().min(1)),
    rerankerModel: z.string().min(1),
    rerankerEnabled: z.boolean(),
    rerankerMaxCandidates: z.number().int().min(1).max(200),
    rerankerCandidateMultiplier: z.number().int().min(1).max(20),
    rateLimitPerMinute: z.number().int().min(1).max(100_000),
    exportDir: z.string().min(1),
    githubHosts: z.array(z.string().min(1)).min(1),
    githubToken: z.string(),
    resetStorage: z.boolean(),
    deploymentMode: z.enum(["local", "shared"]),
    deploymentModeExplicit: z.boolean(),
    adminApiKey: z.string(),
    tlsCertPath: z.string(),
    tlsKeyPath: z.string(),
    trustedProxies: z.array(z.string().min(1)),
    shutdownDrainMs: z.number().int().min(1_000).max(120_000),
    llmRequestTimeoutMs: z.number().int().min(1_000).max(300_000),
    maxRequestBytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
    transferMaxFileBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024 * 1024),
    transferMaxAggregateBytes: z
      .number()
      .int()
      .min(1_024)
      .max(4 * 1024 * 1024 * 1024),
    transferMaxSessions: z.number().int().min(1).max(64),
    transferTtlMs: z.number().int().min(1_000).max(86_400_000),
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
    const configuredTokens = [cfg.apiKey, cfg.writeApiKey, cfg.adminApiKey].filter(Boolean);
    if (new Set(configuredTokens).size !== configuredTokens.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adminApiKey"],
        message: "read and write tokens must differ; reader, curator, and admin tokens must all be distinct",
      });
    }
    if (cfg.deploymentMode === "shared") {
      if (!cfg.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKey"],
          message: "RAGNAROK_API_KEY is required in shared deployment mode",
        });
      }
      for (const [field, token] of [
        ["apiKey", cfg.apiKey],
        ["writeApiKey", cfg.writeApiKey],
        ["adminApiKey", cfg.adminApiKey],
      ] as const) {
        if (token && Buffer.byteLength(token, "utf8") < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} must be at least 32 bytes long in shared mode; generate it from random bytes`,
          });
        }
      }
    }
    if (Boolean(cfg.tlsCertPath) !== Boolean(cfg.tlsKeyPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tlsCertPath"],
        message: "RAGNAROK_TLS_CERT_PATH and RAGNAROK_TLS_KEY_PATH must be configured together",
      });
    }
    const useHttp = process.argv.includes("--http");
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(cfg.httpHost.toLowerCase());
    for (const host of cfg.allowedHosts) {
      const validDnsName =
        host === "localhost" ||
        isIP(host) !== 0 ||
        (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) &&
          !host.includes("..") &&
          !host.startsWith(".") &&
          !host.endsWith("."));
      if (!validDnsName || host.includes("*") || (isIP(host) === 0 && host.includes(":"))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedHosts"],
          message: "RAGNAROK_ALLOWED_HOSTS entries must be exact DNS names or IP addresses without ports/wildcards",
        });
      }
    }
    if (useHttp && (cfg.deploymentMode === "shared" || !loopback) && cfg.allowedHosts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedHosts"],
        message: "RAGNAROK_ALLOWED_HOSTS is required for shared or non-loopback HTTP",
      });
    }
    if (!loopback && !cfg.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "RAGNAROK_API_KEY is required for non-loopback HTTP binds",
      });
    }
    if (!loopback && (cfg.corsOrigin === "*" || cfg.corsOrigin === "loopback")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["corsOrigin"],
        message: "RAGNAROK_CORS_ORIGIN must be an explicit trusted origin for non-loopback HTTP binds",
      });
    }
    const verifiedTlsTopology = Boolean(cfg.tlsCertPath && cfg.tlsKeyPath) || cfg.trustedProxies.length > 0;
    if (useHttp && (cfg.deploymentMode === "shared" || !loopback) && !verifiedTlsTopology) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tlsCertPath"],
        message:
          "HTTP shared/public deployment requires native TLS or RAGNAROK_TRUSTED_PROXIES with forwarded HTTPS enforcement",
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
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        const loopbackEndpoint = host === "localhost" || host === "127.0.0.1" || host === "::1";
        if (cfg.deploymentMode === "shared" && parsed.protocol !== "https:" && !loopbackEndpoint) {
          throw new Error("insecure shared endpoint");
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be an HTTP(S) URL without embedded credentials; shared remote endpoints require HTTPS`,
        });
      }
    }
    for (const proxy of cfg.trustedProxies) {
      if (isIP(proxy) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trustedProxies"],
          message: "RAGNAROK_TRUSTED_PROXIES entries must be explicit IPv4 or IPv6 addresses",
        });
      }
    }
  });

export function loadConfig(): McpConfig {
  const configuredMode = process.env.RAGNAROK_DEPLOYMENT_MODE;
  if (configuredMode !== undefined && configuredMode !== "local" && configuredMode !== "shared") {
    throw new Error("RAGNAROK_DEPLOYMENT_MODE must be exactly 'local' or 'shared'");
  }
  const ignoredStorageLock = ["1", "true"].includes((process.env.RAGNAROK_IGNORE_LOCK || "").toLowerCase());
  if (configuredMode === "shared" && ignoredStorageLock) {
    throw new Error("RAGNAROK_IGNORE_LOCK is forbidden in shared deployment mode");
  }
  const useHttp = process.argv.includes("--http");
  if (useHttp && !configuredMode) {
    throw new Error(
      "RAGNAROK_DEPLOYMENT_MODE is required for HTTP transport; set it explicitly to 'local' or 'shared'",
    );
  }
  const deploymentModeExplicit = configuredMode === "local" || configuredMode === "shared";
  const raw: McpConfig = {
    deploymentMode: configuredMode ?? "local",
    deploymentModeExplicit,
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
    writeApiKey: process.env.RAGNAROK_WRITE_API_KEY || "",
    adminApiKey: process.env.RAGNAROK_ADMIN_API_KEY || "",
    // "loopback" accepts browser origins hosted on localhost/127.0.0.1/::1.
    // Requests without Origin (normal MCP CLI clients) are always eligible.
    corsOrigin: process.env.RAGNAROK_CORS_ORIGIN || "loopback",
    httpHost: process.env.RAGNAROK_HTTP_HOST || "127.0.0.1",
    allowedHosts: (process.env.RAGNAROK_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) =>
        host
          .trim()
          .toLowerCase()
          .replace(/^\[|\]$/g, ""),
      )
      .filter(Boolean),
    tlsCertPath: process.env.RAGNAROK_TLS_CERT_PATH || "",
    tlsKeyPath: process.env.RAGNAROK_TLS_KEY_PATH || "",
    trustedProxies: (process.env.RAGNAROK_TRUSTED_PROXIES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    shutdownDrainMs: parseInt(process.env.RAGNAROK_SHUTDOWN_DRAIN_MS || "10000", 10),
    llmRequestTimeoutMs: parseInt(process.env.RAGNAROK_LLM_REQUEST_TIMEOUT_MS || "30000", 10),
    maxRequestBytes: parseInt(process.env.RAGNAROK_MAX_REQUEST_BYTES || "1048576", 10),
    maxResponseBytes: parseInt(process.env.RAGNAROK_MAX_RESPONSE_BYTES || "1048576", 10),
    transferMaxFileBytes: parseInt(process.env.RAGNAROK_TRANSFER_MAX_FILE_BYTES || "67108864", 10),
    transferMaxAggregateBytes: parseInt(process.env.RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES || "268435456", 10),
    transferMaxSessions: parseInt(process.env.RAGNAROK_TRANSFER_MAX_SESSIONS || "8", 10),
    transferTtlMs: parseInt(process.env.RAGNAROK_TRANSFER_TTL_MS || "900000", 10),
    rerankerModel: process.env.RAGNAROK_RERANKER_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerEnabled: process.env.RAGNAROK_RERANKER_ENABLED !== "0" && process.env.RAGNAROK_RERANKER_ENABLED !== "false",
    rerankerMaxCandidates: parseInt(process.env.RAGNAROK_RERANKER_MAX_CANDIDATES || "20", 10),
    rerankerCandidateMultiplier: parseInt(process.env.RAGNAROK_RERANKER_CANDIDATE_MULTIPLIER || "4", 10),
    rateLimitPerMinute: parseInt(process.env.RAGNAROK_RATE_LIMIT_PER_MINUTE || "100", 10),
    exportDir:
      process.env.RAGNAROK_EXPORT_DIR ||
      path.join(process.env.RAGNAROK_STORAGE_DIR || path.join(os.homedir(), ".ragnarok"), "exports"),
    githubHosts: (process.env.RAGNAROK_GITHUB_HOSTS || "github.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
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
