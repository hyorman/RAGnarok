# RAGnarok `mcp-server` Branch — Comprehensive Fix Plan

## Context

The comprehensive review (`COMPREHENSIVE-BRANCH-REVIEW.md`, verified live against head `0baa405`) found the branch architecturally sound but unreleasable: two critical defects (C1: `rag_query` never works with the bundled reranker; C2: memory store destroys all persisted memories on first mutation after restart), one carried-over atomicity bug (C3), and ~30 high/medium/low issues. This plan fixes **everything** (P0+P1+P2) per user decision, with two scoping choices locked in: **wire in** the LanceDBCheckpointer (make the "with checkpointing" claim true), make the memorize node **opt-in + isolated**, and **defer** npm model-asset extraction (keep bundling).

Ordering: Phase A (blockers + e2e harness) → Phase B (hardening) → Phase C (features/quality/docs). Each phase leaves the tree green (`npm run test:fast` + new e2e).

**Key facts constraining design** (verified): `@lancedb/lancedb` 0.19 has `Table.mergeInsert(on)`, `Table.delete(predicate)`, `Table.add()` but **no** `Connection.renameTable` — so crash-safety comes from in-place upsert/delete, not table swap. transformers.js v3 uses `dtype: "q8"` (the `quantized: true` option is v2-only, silently ignored). Bundled reranker asset is `model_quantized.onnx` only.

---

## Phase A — Release blockers (P0)

### A1. Fix C1 — reranker model load + graceful degradation
Files: `packages/core/src/rerankers/crossEncoderReranker.ts`, `packages/core/src/agents/ragAgent.ts`, `packages/mcp-server/src/index.ts`, `packages/core/src/agents/queryGraph.ts` (deps passthrough only)

1. `crossEncoderReranker.ts:236` — replace `{ quantized: true }` with `{ dtype: "q8" }` (matches bundled `model_quantized.onnx`; Xenova hub repos all ship q8 variants).
2. `rerank()` — move the `await this.initialize()` call **inside** the try/catch degradation path. On init failure: log **once** (add `initFailedLogged` flag), return `candidates.slice(0, topK)` with original order/scores. `switchModel()` resets the failure flag (explicit user action may fix the model).
3. `ragAgent.ts:246` and `:328` — wrap `rerankResults` calls in try/catch returning `rankedResults.slice(0, topK)` (defense-in-depth; keep reranker failures out of the query path permanently).
4. `mcp-server/src/index.ts:140-145` — after constructing the shared reranker, kick off `reranker.initialize().catch(...)` in the background (non-blocking warm-up: fast first query + early startup diagnostics instead of first-query surprise).
5. Add `RAGNAROK_RERANKER_ENABLED` env (default `true`) in `config.ts` + `index.ts`: when false, skip reranker construction entirely (`setReranker` not called → `RAGQueryService` lazy path also gated via new `CONFIG.RERANKER_ENABLED` mapping in `EnvConfigProvider` and `vsCodeConfigProvider`; add matching `ragnarok.rerankerEnabled` VS Code setting in root `package.json`). This is the escape hatch the design doc promised.
6. Unit tests: init-failure → rerank returns originals, only one log; switchModel resets. Extend `packages/core/test/crossEncoderReranker.test.ts` and `packages/mcp-server/test/tools.test.ts`.

### A2. Fix C2 — memory Arrow-vector data loss + crash-safe persistence
Files: `packages/core/src/memory/memoryVectorStore.ts`, `packages/core/src/memory/memoryStore.ts`

1. **Normalize on read** (the trigger): `Array.from(row.vector)` in `loadEntriesUnlocked` (~line 195), `searchEntriesUnlocked` (~line 249), and `loadGraphUnlocked` entity rows (~line 351). Mirror the existing pattern in `knowledgeGraphStore.ts:122` and `memoryScopeLinker.ts`. Defensive `Array.from(e.vector)` in both savers too.
2. **Crash-safe writes** (the amplifier): rewrite `saveEntriesUnlocked` from drop→create to in-place reconciliation:
   - Table missing → `createTable` (as today). Empty collection → `dropTableIfExists` (as today).
   - Otherwise: `table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows)`, then `table.delete("\`id\` NOT IN (...)")` for ids no longer in the collection (build the predicate from current row ids; chunk the IN-list if large).
   - On schema-mismatch error from mergeInsert (old tables missing newer columns): one-time migration fallback to drop+create, **but only after** the new rows have been validated serializable — do a cheap `JSON`-free sanity pass ensuring every `vector` is a plain array before any drop.
   - Apply the same pattern to `saveGraphUnlocked` (entities + edges keyed on `id`).
3. **No silent cache divergence**: in `memoryStore.ts`, on any persist failure, `invalidateCache(scopeKey)` and rethrow so the MCP tool reports the true error and the next operation reloads disk truth. In `store()`, wrap steps 4 (persist) so a failure undoes the optimistic `entries.push` via cache invalidation.
4. **forgetById graph persistence** (M3): add `await this.persistGraph(scope, branch)` after `cleanupOrphanedEntities` in both branches of `forgetById` (`memoryStore.ts:815-841`), matching `forgetByFilter`/`forgetExpired`.
5. Tests (`packages/core/test/memoryVectorStore.test.ts`, `memoryStore.test.ts` — these already use real LanceDB in tmp dirs):
   - save → **new store instance** → load → mutate (store/forget) → save → reload → assert full contents (regression for the Arrow bug; the existing persistence tests reload but never mutate after reload).
   - persist-failure injection → assert cache invalidated + error surfaced + on-disk table intact (crash-safety).
   - forgetById → new instance → assert orphaned entities gone.

### A3. Fix C3 — LangGraph ingestion atomicity
Files: `packages/core/src/managers/topicManager.ts` (`processDocumentViaGraph`, `addDocuments`)

1. Treat vector storage as the commit point: in `processDocumentViaGraph` (~line 655), compute `stored = stageReached("stored")`; set `success = stored` (extraction/graph failures no longer fail the document), report `chunksStored/chunksEmbedded = stored ? chunkCount : 0`, and add `graphExtracted: boolean` + surviving `errors` to `PipelineResult.metadata` so callers can see partial state.
2. `addDocuments` (~line 567): document metadata is now recorded whenever vectors committed; log extraction failures as warnings on the result. No duplicate vectors on retry (retry of a stored doc is a no-op at the caller level — the doc record exists).
3. Tests: extend `packages/core/test/indexingGraph.test.ts` + `topicManager` coverage — extraction-failure run: vectors stored, document recorded, `graphExtracted:false`, re-add doesn't duplicate counts.

### A4. Port the e2e integration harness into the repo + CI
New files: `packages/mcp-server/test-e2e/` (own mocha config, excluded from unit `npm test`), scripts in root `package.json` (`test:e2e`), CI job in `.github/workflows/` (create if absent).

1. Port the review harness (session scratchpad `it/mcp-it.cjs`, `http-it.cjs`, `langgraph-smoke.cjs`, `restart-store.cjs`) into mocha specs that spawn the **built server binary** (`dist/index.js`) with real bundled models and a temp storage dir. Explicitly **clear all `RAGNAROK_*` env** in the spawn env (the user's shell exports remote-provider vars that silently reconfigure the server — this corrupted the first review run).
2. Coverage (matrix from review Appendix A): 13 tools listed; create/add/allowlist-block; all 6 strategies return results **with the bundled reranker** (C1 regression); memory store/recall/list/history/promote/forget; **restart → mutate → restart** memory persistence (C2 regression); LangGraph flag on: index + query + (memorize disabled by default) ; HTTP: health, 401s, session call, SIGTERM.
3. Wire `test:e2e` into CI after `test:fast`. Budget ~3-4 min (model load dominates; share one server across ordered specs where possible).

---

## Phase B — Hardening (P1)

### B1. Docker/compose security
Files: `packages/mcp-server/Dockerfile`, `docker-compose.yml`, `packages/mcp-server/src/index.ts`, `config.ts`, `httpServer.ts`

- Fail closed: in `--http` mode, if `httpHost` is non-loopback and `apiKey` is empty → refuse to start with a clear message (override: `RAGNAROK_ALLOW_INSECURE_HTTP=true`). Update compose to require `RAGNAROK_API_KEY` (no empty default: use `${RAGNAROK_API_KEY:?set RAGNAROK_API_KEY}`).
- Dockerfile: add `USER node` (chown `/data/ragnarok` in image; document volume ownership), split deps: `npm ci --omit=dev --ignore-scripts` for the runtime-stage copy (build stage keeps dev deps). Default `RAGNAROK_CORS_ORIGIN` in compose: drop the `*` default, document explicitly.

### B2. Wire the LanceDBCheckpointer (make "with checkpointing" true)
Files: `packages/core/src/agents/ragQueryService.ts`, `packages/core/src/managers/topicManager.ts`, `packages/core/src/agents/indexingGraph.ts`, `graphState.ts`, `packages/mcp-server/src/index.ts`, `packages/vscode/src/extension.ts`

1. **Ingestion (where resume has real value):** `TopicManager` accepts an optional `checkpointer` (constructed by hosts from `stores/lanceDBCheckpointer.ts` against the storage dir). `processDocumentViaGraph` passes it with deterministic `thread_id = "index:{topicId}:{sha256(filePath+mtime)}"` so a crashed ingestion resumes past completed stages instead of re-embedding.
2. **State slimming first:** `IndexingPipelineState.loadedDocs` must not persist into checkpoints wholesale — clear `loadedDocs` in the update returned by `chunkDocuments` (set to `[]` once chunks exist) so checkpoints carry chunks only; measure checkpoint sizes in the test.
3. **Queries:** ephemeral `thread_id = "query:{uuid}"` (no resume semantics; gives observability). Pass the checkpointer through `QueryGraphDeps` from `RAGQueryService.executeViaGraph`.
4. Both hosts construct the checkpointer only when `langGraphEnabled` (MCP `index.ts`; VS Code `extension.ts` → provide to TopicManager/RAGQueryService).
5. Test: kill-and-resume ingestion e2e — run indexing with a failing `storeEntities` (inject), re-invoke with same thread_id, assert load/chunk/store stages skipped (checkpoint hit) and graph stage completes.

### B3. Memorize node: opt-in + isolated (user decision)
Files: `packages/core/src/agents/queryGraph.ts`, `packages/core/src/constants.ts`, `packages/mcp-server/src/config.ts` + `adapters.ts`, `packages/core/src/memory/memoryStore.ts` (recall filter)

- New config `CONFIG.QUERY_MEMORY_ENABLED` (default **false**); map from `RAGNAROK_QUERY_MEMORY` env + `ragnarok.queryMemory` VS Code setting. Memorize node no-ops unless enabled.
- Raise `MEMORY_CONFIDENCE_THRESHOLD` default 0.1 → 0.7; map the config key in `EnvConfigProvider` (currently unmapped so defaults always applied).
- Isolation: store auto-entries with reserved tag `"auto:query-insight"`; `recall()`/`list()` exclude entries carrying reserved `auto:` tags unless `includeAuto: true` (new option, exposed on the MCP tool schema).

### B4. Cross-process safety for shared storage dirs
Files: new `packages/core/src/utils/storageLock.ts`, wired in `MemoryStore` ctor + `TopicManager.create`

- Acquire an exclusive lock file (`<storageDir>/.ragnarok.lock`, `fs.open` with `wx` + pid + stale-detection via pid liveness/heartbeat mtime). Second instance → fail fast with a clear message naming the holder pid (override env `RAGNAROK_IGNORE_LOCK=true` for advanced users). Release on `dispose()` and process exit hooks. Document the single-instance constraint in both READMEs.

### B5. topK bounds + shared parameter validation
Files: `packages/core/src/agents/ragQueryService.ts`, `packages/mcp-server/src/config.ts`

- Single source: extract `validateQueryOptions(topK, maxIterations, confidenceThreshold)` used by **both** `executeQueryLegacy` and `executeViaGraph`; raise the service bound to 50 to match config (`config.ts:77`), keep the MCP per-call zod max at 20 for `rag_query`'s own param (explicit override still capped, config default may be up to 50 — align docs).

### B6. Lint gate repair + CI
Files: `eslint.config.mjs`, root `package.json`, CI workflow

1. Diagnose: run `npx eslint` (bypassing the rtk wrapper) per package with `TIMING=1` to find the pathological files.
2. Fix ignores (flat-config globs are root-relative): `["**/dist/**", "**/dist-test/**", "**/out/**", "**/*.d.ts", "**/node_modules/**", ".vscode-test/**", "stubs/**", "**/assets/**"]`.
3. Add per-package `lint` scripts and make root `lint` iterate workspaces (bounds memory per process). Wire into CI next to `format:check`.
4. Fix whatever real errors/warnings surface once it completes (prior report: 1 error — CommonJS `require()` in `vscodeLmBackend.ts` — plus ~100 warnings; burn these down or explicitly waive per rule).

### B7. HTTP session lifecycle + middleware
Files: `packages/mcp-server/src/httpServer.ts`, `package.json`, `config.ts`

- Idle session reaping: track `lastActivity` per session; sweep on interval (default TTL 30 min, `RAGNAROK_SESSION_TTL_SECONDS`), close+delete expired transports. Cap concurrent sessions (`RAGNAROK_MAX_SESSIONS`, default 50) → 429 on excess.
- Promote `cors` and `express-rate-limit` to direct dependencies of `@ragnarok/mcp-server`; remove the silent-skip fallbacks (fail closed when `apiKey` set). Make rate limit configurable (`RAGNAROK_RATE_LIMIT_PER_MINUTE`, default 100).

---

## Phase C — Features, quality, docs (P2)

### C1. MCP API completeness (new tools in `packages/mcp-server/src/tools.ts`)
Reuse existing core methods — no new core logic needed for the first three:
- `rag_delete_topic` (→ `topicManager.deleteTopic`; refuse for common/read-only topics), `rag_remove_document` (→ existing document removal path in TopicManager/DocumentPipeline), `rag_rename_topic` (→ `topicManager.renameTopic`).
- `rag_add_github_repo` (→ `loaders/githubLoader.ts` via `topicManager.addDocuments`-equivalent repo path; token via env `RAGNAROK_GITHUB_TOKEN`; restrict to github.com + configured GHES host allowlist) and `rag_add_url` (→ `loaders/webLoader.ts`; SSRF guard: block private/link-local IP ranges after DNS resolution, http(s) only).
- Update both READMEs' tool tables (root README currently lists 10 of 13; will become 18).
- Tests in `packages/mcp-server/test/tools.test.ts` + e2e additions for delete/rename round-trip.

### C2. LangGraph query pipeline parity
Files: `packages/core/src/agents/queryGraph.ts`, `ragAgent.ts` (export gap-analysis helpers)

- Replace the string-append `refine` node with the legacy LLM gap analysis / follow-up generation (extract the relevant `RAGAgent` private methods into a shared helper module `agents/refinement.ts`; heuristic fallback when no LLM).
- Confidence consistency: `evaluate` deduplicates (reuse `getRetrievalResultKey`) before averaging and uses `originalScore` when a result was reranked, so iteration decisions aren't skewed by sigmoid-scale scores and accumulated duplicates (review live-run: 3 wasted iterations on a 2-doc corpus).

### C3. Memory quality pass
Files: `packages/core/src/memory/*`, `packages/mcp-server/src/tools.ts`

- **TTL exposure**: add `ttlDays?` to `StoreOptions` → sets `expiresAt`; expose on `rag_memory` store schema (kills the dead-code finding).
- **Decay-aware recall**: multiply recall scores by `decayEngine.effectiveConfidence(entry, graph)` (memoryStore has both at hand in `recall()`); document the ranking.
- **Score-scale unification**: convert entry scores and entity cosine scores to one 0-1 scale; replace the hardcoded `0.5` for linked entities with the linking entity's own score × constant.
- **`links` scope bug**: `tools.ts:1022` — when scope=branch without a name, resolve via `memoryStore.getCurrentBranch()` (error if none, same rule as store/recall) instead of passing raw `"branch"`.
- **`promote` API**: add `ids?: string[]` param to the tool schema; deprecate the comma-separated `id` hack (accept both for one release).
- **Version-chain forget repair**: when `forgetById` removes an entry with `previousVersionId`, reinstate the predecessor (`isLatest = true`, clear `supersededBy`) so content isn't permanently hidden.

### C4. Misc correctness & performance (small, independent items)
- `resultsCount` always 0: count per sub-query during retrieval (`ragAgent.retrieveWithPlan` already knows `subQuery`; aggregate counts into `RAGResult.metadata` and use in `ragQueryService.ts:236` and `mapGraphResult`).
- chunkId key normalization: use one shared `getChunkId()` (exists in `graphRetriever.ts:344`) in `graphHybridRetriever.ts` candidate maps and `queryGraph.ts`.
- GraphRetriever chunk-document map: add `invalidate()` called from the same `TopicManager.onAgentCacheCleanup` event RAGQueryService already subscribes to (document the coupling).
- Over-fetch cap: in `ragAgent.executeSubQuery` (~line 514), cap at `min(topK*multiplier, rerankerMaxCandidates)` from config instead of hardcoded 50.
- LLM `isAvailable()` caching: memoize with 60s TTL in `OpenAILLMProvider`/`OllamaLLMProvider`; make Anthropic's do a real (cached) check via a cheap API call; `MemoryEntityExtractor.extract` stops paying a network round-trip per store.
- ONNX disposal: call the transformers.js session `dispose()` in `CrossEncoderReranker.dispose()`/`switchModel` and `HuggingFaceBackend.dispose()` where the API exposes it.
- `KnowledgeGraphStore`: memoize the LanceDB connection (copy the `dbPromise` pattern from `memoryVectorStore.ts:27-38`).
- `GitBranchDetector`: switch `execSync` to reading `.git/HEAD` directly (async fs), keep the 5s cache; fall back to exec for worktrees/packed refs edge cases.
- Anthropic default model string: move per-provider defaults to a single `PROVIDER_DEFAULTS` map in `llmProviders.ts` and refresh the model id.

### C5. Docs reconciliation (single commit at the end)
- Root `README.md`: MCP tool table (all tools incl. new ones), graph-strategy prerequisites (LangGraph flag + LLM, fallback behavior), memory = MCP-only unless C6 lands, hybrid 90/10 (fix ARCHITECTURE 70/30 diagram), reranker enable flag, checkpointing description (now true, describe scope), single-instance storage constraint.
- `packages/mcp-server/README.md`: `RAGNAROK_TOP_K` default 10 (not 5), new env vars (`RERANKER_ENABLED`, `QUERY_MEMORY`, `SESSION_TTL_SECONDS`, `MAX_SESSIONS`, `RATE_LIMIT_PER_MINUTE`, `ALLOW_INSECURE_HTTP`), security guidance.
- Design docs: mark dropped Phase-3/4 items (remote reranker, cross-topic link table, episodes, memory boosting) as roadmap-not-shipped.

### C6. VS Code memory wiring (minimal)
Files: `packages/vscode/src/extension.ts`
- Construct a `MemoryStore` (storage under `context.globalStorageUri`, workingDir = first workspace folder) when `langGraphEnabled`, pass via `ragQueryService.setGraphDeps` so the recall/memorize (opt-in) nodes function in VS Code. No UI this wave (defer tree view/commands; note in README).

### Deferred (explicit non-goals this wave)
- npm model download-on-demand (user decision: keep bundling).
- Memory UI in VS Code; MCP export/import tools; remote reranker backend.

---

## Suggested commit sequence

1. `fix(core): reranker dtype + graceful degradation` (A1)
2. `fix(memory): Arrow vector normalization + crash-safe persistence + cache rollback` (A2)
3. `fix(core): LangGraph ingestion partial-success semantics` (A3)
4. `test(e2e): real-binary MCP integration suite + CI` (A4)
5. `feat(core): wire LanceDBCheckpointer into pipelines` (B2)
6. `fix(mcp): docker hardening, session TTLs, direct middleware deps, fail-closed HTTP` (B1, B7)
7. `feat(core): opt-in query memory + storage lock + shared query validation` (B3, B4, B5)
8. `chore: repair lint gate + burn down findings` (B6)
9. `feat(mcp): topic/document management + GitHub/web ingestion tools` (C1)
10. `feat(core): LangGraph refinement parity + confidence scaling` (C2)
11. `fix(memory): TTL, decay-aware recall, links/promote/version-chain fixes` (C3)
12. `fix(core): misc correctness + perf pass` (C4)
13. `feat(vscode): minimal memory wiring` (C6)
14. `docs: reconcile READMEs/ARCHITECTURE/design docs` (C5)

## Verification

- After every phase: `npm run test:fast` (build + 690 core + 149 MCP) and the new `npm run test:e2e` (spawns built server with bundled models, clean `RAGNAROK_*` env).
- **C1 gate**: e2e asserts all 6 strategies return results with default config + bundled models (was 0/8).
- **C2 gate**: e2e restart→mutate→restart asserts zero memory loss (was total loss); Arrow regression unit test on real LanceDB tmp dirs.
- **C3 gate**: extraction-failure ingestion records document, no duplicates on retry.
- **B2 gate**: kill-and-resume ingestion test hits checkpoint (stages skipped) + checkpoint size assertion (no `loadedDocs` payloads).
- HTTP: `http-it` port covers 401s, session TTL expiry (fake timer or short TTL), 429 at max sessions, fail-closed startup without API key on `0.0.0.0`.
- Docker: `docker build` + container smoke (`/health`, non-root `whoami`, no `typescript` in `node_modules`).
- Lint: `npm run lint` completes on default heap in CI.
- Manual: one VS Code F5 session — ingest, query, switch reranker model, verify graph strategies with LangGraph flag + an LLM configured (user's docker proxy env can serve as the OpenAI-compatible provider).
