import { GITHUB_HOST } from "@ragnarok/core";

/**
 * Defaults of the MCP server's own settings: loadConfig() falls back to them and
 * config.json's $defaults block shows them. Settings every host shares take
 * their defaults from @ragnarok/core's DEFAULTS instead.
 */
export const MCP_DEFAULTS = {
  /** MCP's own topK default; the VS Code setting defaults to 5 in the extension manifest. */
  TOP_K: 10,
  LLM_PROVIDER: "none",
  EMBEDDING_PROVIDER: "huggingface",
  LLM_REQUEST_TIMEOUT_MS: 30_000,
  SHUTDOWN_DRAIN_MS: 10_000,
  MAX_RESPONSE_BYTES: 1_048_576,
  GITHUB_HOSTS: [GITHUB_HOST],
  /** exportDir's default folder, inside the storage directory. */
  EXPORT_DIRNAME: "exports",
} as const;
