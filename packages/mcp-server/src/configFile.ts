import { z } from "zod";
import type { McpConfig } from "./config";

/** McpConfig fields that may be set from the config file. */
export type FileField =
  | "embeddingProvider"
  | "embeddingModel"
  | "embeddingBaseUrl"
  | "llmProvider"
  | "llmModel"
  | "llmBaseUrl"
  | "llmRequestTimeoutMs"
  | "retrievalStrategy"
  | "topK"
  | "maxIterations"
  | "confidenceThreshold"
  | "rerankerEnabled"
  | "rerankerModel"
  | "rerankerMaxCandidates"
  | "rerankerCandidateMultiplier"
  | "chunkSize"
  | "chunkOverlap"
  | "allowedPaths"
  | "githubHosts"
  | "exportDir"
  | "maxResponseBytes"
  | "shutdownDrainMs"
  | "logLevel";

/** The slice of McpConfig a config file is allowed to supply. */
export type ConfigFileValues = Partial<Pick<McpConfig, FileField>>;

export interface FileKey {
  /** [section, name] in the JSON file. */
  readonly path: readonly [string, string];
  /** Flat McpConfig field this maps to. */
  readonly field: FileField;
  readonly schema: z.ZodTypeAny;
  /** Value shown in $defaults. exportDir is storage-relative, so it is a literal. */
  readonly shown: unknown;
}

const positiveInt = z.number().int().positive();

export const FILE_KEYS: readonly FileKey[] = [
  { path: ["embedding", "provider"], field: "embeddingProvider", schema: z.string(), shown: "huggingface" },
  { path: ["embedding", "model"], field: "embeddingModel", schema: z.string(), shown: "Xenova/all-MiniLM-L6-v2" },
  { path: ["embedding", "baseUrl"], field: "embeddingBaseUrl", schema: z.string(), shown: "" },

  { path: ["llm", "provider"], field: "llmProvider", schema: z.string(), shown: "none" },
  { path: ["llm", "model"], field: "llmModel", schema: z.string(), shown: "" },
  { path: ["llm", "baseUrl"], field: "llmBaseUrl", schema: z.string(), shown: "" },
  { path: ["llm", "requestTimeoutMs"], field: "llmRequestTimeoutMs", schema: positiveInt, shown: 30000 },

  {
    path: ["retrieval", "strategy"],
    field: "retrievalStrategy",
    schema: z.enum(["vector", "hybrid", "bm25"]),
    shown: "hybrid",
  },
  { path: ["retrieval", "topK"], field: "topK", schema: positiveInt, shown: 10 },
  { path: ["retrieval", "maxIterations"], field: "maxIterations", schema: positiveInt, shown: 3 },
  {
    path: ["retrieval", "confidenceThreshold"],
    field: "confidenceThreshold",
    schema: z.number().min(0).max(1),
    shown: 0.7,
  },

  { path: ["reranker", "enabled"], field: "rerankerEnabled", schema: z.boolean(), shown: true },
  {
    path: ["reranker", "model"],
    field: "rerankerModel",
    schema: z.string(),
    shown: "Xenova/ms-marco-MiniLM-L-6-v2",
  },
  { path: ["reranker", "maxCandidates"], field: "rerankerMaxCandidates", schema: positiveInt, shown: 20 },
  {
    path: ["reranker", "candidateMultiplier"],
    field: "rerankerCandidateMultiplier",
    schema: positiveInt,
    shown: 4,
  },

  { path: ["ingestion", "chunkSize"], field: "chunkSize", schema: positiveInt, shown: 1000 },
  { path: ["ingestion", "chunkOverlap"], field: "chunkOverlap", schema: z.number().int().min(0), shown: 200 },

  { path: ["security", "allowedPaths"], field: "allowedPaths", schema: z.array(z.string()), shown: [] },
  { path: ["security", "githubHosts"], field: "githubHosts", schema: z.array(z.string()), shown: ["github.com"] },

  { path: ["storage", "exportDir"], field: "exportDir", schema: z.string(), shown: "<storageDir>/exports" },

  { path: ["limits", "maxResponseBytes"], field: "maxResponseBytes", schema: positiveInt, shown: 1048576 },
  { path: ["limits", "shutdownDrainMs"], field: "shutdownDrainMs", schema: positiveInt, shown: 10000 },

  { path: ["logging", "level"], field: "logLevel", schema: z.string(), shown: "info" },
];

/** Nested schema, derived from the table. `.strict()` makes unknown keys fatal. */
export const configFileSchema = (() => {
  const sections = new Map<string, Record<string, z.ZodTypeAny>>();
  for (const key of FILE_KEYS) {
    const [section, name] = key.path;
    if (!sections.has(section)) {
      sections.set(section, {});
    }
    sections.get(section)![name] = key.schema.optional();
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [section, fields] of sections) {
    shape[section] = z.object(fields).strict().optional();
  }
  return z.object(shape).strict();
})();

/** The `$defaults` documentation block. Never read as configuration. */
export function buildDefaultsBlock(_storageDir: string): Record<string, unknown> {
  const block: Record<string, Record<string, unknown>> = {};
  for (const key of FILE_KEYS) {
    const [section, name] = key.path;
    block[section] ??= {};
    block[section][name] = key.shown;
  }
  return block;
}
