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
  | "maxResidentModels"
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
  { path: ["embedding", "maxResidentModels"], field: "maxResidentModels", schema: z.number().int().min(1), shown: 2 },

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
export function buildDefaultsBlock(): Record<string, unknown> {
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

const ENV_ONLY_DOC: Record<string, string> = {
  RAGNAROK_STORAGE_DIR: "bootstrap — this file's location derives from it",
  RAGNAROK_WORKING_DIR: "bootstrap",
  RAGNAROK_LLM_API_KEY: "secret",
  RAGNAROK_EMBEDDING_API_KEY: "secret",
  RAGNAROK_GITHUB_TOKEN: "secret",
  RAGNAROK_RESET_STORAGE: "one-shot; persisting it would reset storage on every launch",
  RAGNAROK_IGNORE_LOCK: "one-shot; persisting it would disable the single-writer lock permanently",
};

function scaffold(): Record<string, unknown> {
  return {
    "//": "Set a key below to override the default. Delete a key to return to the default.",
    "//env": "Secrets and bootstrap settings cannot be set here — see $envOnly.",
    $defaults: buildDefaultsBlock(),
    $envOnly: ENV_ONLY_DOC,
  };
}

/**
 * Replace a file through a same-directory temporary and a rename.
 *
 * A plain writeFileSync opens with O_TRUNC: the file is empty for the width of
 * the write, and what is in that window is the operator's live settings. A
 * crash there loses them, and a second server booting concurrently — this runs
 * before the storage lock is taken — reads the empty file and fails startup
 * with "config.json is not valid JSON". Rename is atomic, so neither happens.
 */
function replaceFileAtomically(filePath: string, contents: string, mode: number): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { flag: "wx", mode });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // Never strand a temporary beside the store: an unrecognised entry there
    // makes an uninitialized storage root read as unversioned v0.3 data.
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Never created, or already renamed away. Nothing to clean up.
    }
    throw error;
  }
}

/**
 * Create the config file if absent, or refresh a stale `$defaults`/`$envOnly` block.
 *
 * Never throws: storage may be read-only (a mounted volume, or a container run
 * with --read-only), and a convenience file must not prevent the server starting.
 */
export function ensureConfigFile(storageDir: string, log: (message: string) => void): void {
  const filePath = path.join(storageDir, CONFIG_FILE_NAME);
  const warn = (error: unknown): void => {
    const code = (error as NodeJS.ErrnoException).code;
    log(`Could not create ${CONFIG_FILE_NAME} at ${filePath}: ${code ?? String(error)}. Using defaults.`);
  };

  // On a genuine first run the storage directory does not exist yet: core does
  // not create it until TopicManager.create, which happens after this. Without
  // this mkdir the write below fails ENOENT, the file appears only on the
  // *second* boot, and the warning misreports a fresh install as read-only
  // storage. Still inside a catch — an unwritable location must warn, not throw.
  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch (error) {
    warn(error);
    return;
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(scaffold(), null, 2)}\n`, { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      warn(error);
      return;
    }
  }

  // The file exists. Refresh the two blocks we author only if one has drifted,
  // preserving every key we did not author. A malformed file is a startup error
  // elsewhere, not something to overwrite.
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const defaults = buildDefaultsBlock();
    if (
      JSON.stringify(raw.$defaults) === JSON.stringify(defaults) &&
      JSON.stringify(raw.$envOnly) === JSON.stringify(ENV_ONLY_DOC)
    ) {
      return;
    }
    raw.$defaults = defaults;
    // $envOnly used to be written at creation and never again, so an existing
    // file's copy drifted unrepairably as the env-only set changed.
    raw.$envOnly = ENV_ONLY_DOC;
    replaceFileAtomically(filePath, `${JSON.stringify(raw, null, 2)}\n`, fs.statSync(filePath).mode & 0o777);
  } catch {
    // Malformed or unreadable: leave it exactly as it is.
  }
}
