import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { McpConfig } from "./config";

export const CONFIG_FILE_NAME = "config.json";

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

/** Section.name pairs that name an env-only setting, for a better error than "unknown key". */
const ENV_ONLY_HINTS: Record<string, string> = {
  "storage.storageDir": "RAGNAROK_STORAGE_DIR",
  "storage.workingDir": "RAGNAROK_WORKING_DIR",
  "llm.apiKey": "RAGNAROK_LLM_API_KEY",
  "embedding.apiKey": "RAGNAROK_EMBEDDING_API_KEY",
  "security.githubToken": "RAGNAROK_GITHUB_TOKEN",
  "storage.resetStorage": "RAGNAROK_RESET_STORAGE",
  "storage.ignoreLock": "RAGNAROK_IGNORE_LOCK",
};

const isCommentKey = (key: string): boolean => key.startsWith("//") || key.startsWith("$");

/** Strip comment keys at the top level and inside each section. */
function stripComments(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(raw)) {
    if (isCommentKey(section)) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
        if (!isCommentKey(name)) {
          inner[name] = v;
        }
      }
      out[section] = inner;
    } else {
      out[section] = value;
    }
  }
  return out;
}

export function readConfigFile(storageDir: string): ConfigFileValues {
  const filePath = path.join(storageDir, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // An absent file - or an absent storage directory - is not an error. Anything
    // else (EACCES, EISDIR, ELOOP) means a real file we cannot read: say so.
    if (code === "ENOENT") {
      return {};
    }
    throw new Error(`Cannot read ${CONFIG_FILE_NAME} (${filePath}): ${code ?? String(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE_NAME} is not valid JSON (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object (${filePath})`);
  }

  // Comment keys ("//", "$defaults", "$envOnly") must go before validation:
  // configFileSchema is `.strict()`, so a generated file would otherwise be rejected outright.
  const stripped = stripComments(raw as Record<string, unknown>);

  for (const [section, value] of Object.entries(stripped)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    for (const name of Object.keys(value as Record<string, unknown>)) {
      const envVar = ENV_ONLY_HINTS[`${section}.${name}`];
      if (envVar) {
        throw new Error(
          `${CONFIG_FILE_NAME}: "${section}.${name}" is environment-only and cannot be set here. ` +
            `Set ${envVar} in the environment instead. (${filePath})`,
        );
      }
    }
  }

  const parsed = configFileSchema.safeParse(stripped);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ${CONFIG_FILE_NAME} (${filePath}):\n${issues}`);
  }

  const values: Record<string, unknown> = {};
  const data = parsed.data as Record<string, Record<string, unknown> | undefined>;
  for (const key of FILE_KEYS) {
    const [section, name] = key.path;
    const sectionValue = data[section];
    if (sectionValue && sectionValue[name] !== undefined) {
      values[key.field] = sectionValue[name];
    }
  }
  return values as ConfigFileValues;
}
