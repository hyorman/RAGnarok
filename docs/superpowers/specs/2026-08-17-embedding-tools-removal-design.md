# Embedding tools removal — design

**Status:** approved
**Date:** 2026-08-17
**Applies to:** `packages/mcp-server` (tool surface, tests), `scripts/docker-gate.mjs`,
`scripts/test-release-static.mjs`, living docs. **`packages/core` is untouched.**

---

## 1. Motivation

The MCP server exposes three embedding-management tools: `rag_list_embedding_models`,
`rag_embedding_info`, and `rag_switch_embedding_model`. They exist so an agent can
inspect and change the embedding model. Two facts make that pointless:

1. **Per-topic auto-switch already answers every runtime question.** Each topic
   records its embedding model at creation; queries and ingestion into an existing
   topic resolve *that topic's* model through the `EmbeddingServiceRegistry`
   (`vectorStoreFactory.ts:288`, one immutable service per embedding space,
   LRU-capped). The runtime never consults any model list — it loads whatever name
   the topic recorded. The agent has no decision left that the tools inform.
2. **The default model is operator configuration**, exactly like the reranker model
   and the LLM provider, both of which already have no tools. The configured
   `embedding.model` governs only two things: the model a *new* topic gets pinned
   to, and the standalone memory embedding space.

The tools also carry known defects that removal eliminates rather than fixes: the
`active` flag compares bare names against the backend-prefixed `getCurrentModel()`
and is false for every row on a warmed-up server; before the first embed,
`currentModel` reports the registry default instead of the configured model; and
the switch is ephemeral — nothing writes back to `config.json`, so a restart boots
the old model against a memory store fingerprinted for the new one, manufacturing a
fail-closed state.

## 2. The decision

Remove all three embedding tools. No replacement tool. The MCP surface drops from
11 to **8 tools**:

```
rag_query            rag_ingest           rag_topic            rag_delete_topic
rag_remove_document  rag_memory           rag_reset_memory     rag_memory_visualize
```

An earlier direction in this conversation (one consolidated `rag_embeddings` tool
with `list`/`switch` operations) is **superseded by this decision** and must not be
implemented.

## 3. The model-management contract after removal

Model selection is config-file-only: the operator edits `embedding.model` (and
`embedding.provider` for remote backends) in `config.json` and restarts the server.
This is safe because every guard lives below the tool layer and survives:

| Concern | Guard (all pre-existing, none touched) |
| --- | --- |
| Old topics after a default change | Per-topic pinning: reads and ingestion use the topic's recorded model |
| New topics | Pinned to the new configured default at creation |
| Memory vectors in the old space | Fingerprint validation fails closed on the next mutation; the error path points at `rag_reset_memory` |
| Dimension mixing inside one topic | `EmbeddingFingerprintMismatchError` from the vector-store factory |

**Documented consequence, not hidden:** if the operator configures a model that is
neither bundled nor cached, the first embed downloads it mid-operation. With the
tools gone there is no pre-flight warning path; the download appears as first-use
latency plus a stderr log line. This is accepted and must be stated in the MCP
README's configuration section.

## 4. Code changes

### 4.1 `packages/mcp-server/src/tools.ts`

- Delete the three tool registrations (including yesterday's `remoteListingFailed`
  computation and `configuredModel`/`configuredProvider` echo — they lived inside
  the deleted handlers).
- The removals leave three `registerTools` parameters with **zero remaining uses**
  (verified: every reference sits inside the three deleted handlers):
  `embeddingService`, `memoryStore`, and `runMemoryMutation`. Remove all three.
  The new signature:

```ts
export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  ragQueryService: RAGQueryService,
  memoryService?: MemoryService,
  graphVisualizationService?: GraphVisualizationService,
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
  runMutation: MutationRunner = (operation) => operation(),
  runtime: ToolRuntime = { run: (operation) => operation() },
): void
```

- Remove the now-unused `EmbeddingService` value import and `AvailableModel` type
  import; keep `MemoryStore` (still used by the `memoryBranchProvider` type).
- Remove `modelName` from `MCP_LIMITS` (its only consumer was the switch schema).
- Update the file-header tool list to the 8-tool surface and extend the existing
  "Reranker and LLM management have no tools" note to include embedding models.

### 4.2 `packages/mcp-server/src/index.ts`

- Update the `registerTools` call: drop `embeddingService`, `memoryStore` (the
  first of the two `memoryStore` arguments — the second is the branch provider and
  stays), and the `runMemoryMutation` lambda.
- `memoryCoordinator` **stays**: `MemoryService` construction and
  `drainToolRuntimeThenMemory` still use it. Only the lambda passed into
  `registerTools` goes.
- The embedding service itself stays fully wired (query pipeline, registry,
  memory store all consume it) — only its path into `registerTools` disappears.

### 4.3 `packages/core`

No changes. `listAvailableModels` (including the 2026-08-17 pre-init resolution
fix) remains — the VS Code tree view consumes it directly.

## 5. Verification-infrastructure changes

### 5.1 `scripts/docker-gate.mjs`

- `expectedToolCount`: 11 → **8**.
- Append the three tool names to the existing removed-names assertion list.
- **Config-read proof** (currently: seed `embedding.model`, assert
  `rag_embedding_info.configuredModel` — both sides are being deleted): seed
  `{ storage: { exportDir: "/data/ragnarok/gate-exports" } }` instead, and after
  the gate creates its persistence topic, call
  `rag_topic { action: "export", topic }` and assert the returned `path` starts
  with `/data/ragnarok/gate-exports/`. Empirically verified against the built
  server: exporting a topic with zero documents succeeds and returns the
  exportDir-prefixed path, entirely offline with no model load. The default
  exportDir is `<storage>/exports`, so only the seeded file produces the
  `gate-exports` prefix — the assertion proves the file was read.

### 5.2 `scripts/test-release-static.mjs`

- The docker-gate contract pin `/expectedToolCount = 11/` → `/expectedToolCount = 8/`.

### 5.3 MCP test suite

- `tools.test.ts`: surface pin 11 → 8; delete the three embedding describes
  (including the five tests added on 2026-08-17); add the three names to the
  removed-tools test; `captureHandlers` loses `embeddingService`, `memoryStore`,
  and `runMemoryMutation`; the two switch/memory-coordination tests
  ("waits for an active memory mutation before switching",
  "blocks a later memory mutation until switching completes") are switch-specific
  and are deleted — remove the `MemoryOperationCoordinator` import and the
  `deferred`/`tick` helpers if they become unused; the read-only inertness
  membership assertion shrinks to the surviving read-only tools.
- `stdioTransport.test.ts`: `LOCAL_ADMIN_TOOLS` shrinks to the 8 names; the
  embedding calls (ids 50–52) are deleted; the three names join the
  removed-tools rejection loop; the read-only annotation spot-check moves off
  `rag_list_embedding_models` onto `rag_query`.
- `memoryTool.test.ts` / `graphVisualize.test.ts`: harness call-site updates for
  the narrowed signature only.

## 6. Documentation changes (living docs only)

- `README.md`: tool table 11 → 8 rows; "complete surface: 11 tools" → 8; the
  config-only sentence extends to embedding models.
- `packages/mcp-server/README.md`: same table and count changes; the
  configuration section gains the first-use-download consequence from §3.
- `ARCHITECTURE.md`: "registers 11 tools" → 8.
- `docs/SECURITY.md`: "All 11 tools" → 8; drop the
  "configuration one (`rag_switch_embedding_model`)" clause.
- Historical plans/specs and root-level notes files are not updated.

## 7. Non-goals

- No `rag_embeddings` consolidated tool (superseded, §2).
- No config write-back / switch persistence (nothing left to persist).
- No change to the VS Code model picker or any core embedding behavior.
- No change to `rag_memory`, `rag_reset_memory`, or the memory fingerprint guards.
