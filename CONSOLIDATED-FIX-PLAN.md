# Consolidated Fix Plan — RAGnarok 0.4.0 Release

Merges the two planning docs:
- **Plan A** — `now-create-comprehensive-plan-serialized-rabbit.md` (Claude, phased P0→P2, backward-compatible)
- **Plan B** — `-CODEX-PLAN.md` (Codex, "Full Functional Release", storage-v2 clean reset)

> ⚠️ **Critical status note — read first.** Plan B is **not hypothetical: it is already partially implemented in the working tree.** As of this consolidation the branch has **54 files changed (+2,462 / −749)** plus new files `packages/core/src/utils/storageV2.ts`, `packages/core/assets/models/manifest.json`, `scripts/{shutdown-soak,verify-model-manifest}.mjs`, and `.github/workflows/release.yml`. Spot-checks confirm the reranker `dtype:"q8"` fix, memory `Array.from` normalization, read/write token split, storage-v2 wiring, and 6 new MCP tools are already in place. **None of this is committed or test-verified yet.** So this document is really "the target end-state + what still needs doing + which decisions are baked in," not a from-scratch build order.

> 🔄 **Update 2026-07-12 (post-verification + federation design).** The working tree was verified against this plan (`CODEX-CHANGES-REVIEW.md`): C1/C2/C3 are correctly fixed (C1 empirically probed), auth exceeds the plan (structural default-deny), SSRF/Docker/session hardening implemented, and all Phase-8 tools are present. Statuses below have been updated in place — legend now includes **[verified]** = independently confirmed by review/probe. Two blockers surfaced: **the test suite is currently red** (`packages/core/test/queryGraph.test.ts` — 10 fixtures missing the now-required `allowMemoryWrites`; see §7 step 0) and **AA-1 (cross-process lock) is confirmed absent**. A new **Phase 10** adds the federated shared-KB topology from `docs/superpowers/specs/2026-07-12-federated-shared-kb-design.md`; Phase 7's MB-4 work is absorbed into it as `FolderSharedSource`.

---

## 1. How the two plans relate

The plans agree on **~90% of the work**. Plan B (Codex) is a strict superset in most areas and adds several real bugs Plan A (Claude) missed; Plan A adds a few items Plan B omits. Neither plan is wrong — they differ mainly in **aggressiveness** (Plan B breaks existing storage and rebuilds the format; Plan A preserves it) and **breadth** (Plan B adds common-DB routing, export/import, embedding fingerprints, cancellation, HTTP role tokens).

Both plans independently identified: C1 reranker dtype, C2 memory Arrow/data-loss, C3 LangGraph ingestion atomicity, e2e real-binary harness + CI, checkpointer wiring, opt-in memorize node, Docker hardening, HTTP session TTL/rate limit, topK validation, lint repair, MCP API completeness, LangGraph refinement parity, memory TTL/decay-aware recall/version-chain repair, resultsCount, graph-fallback signal, LLM availability caching, async git detection, ONNX disposal, VS Code memory wiring, docs reconciliation, keep-models-bundled.

---

## 2. Conflicts (decisions that are effectively already made)

| # | Topic | Plan A (Claude) | Plan B (Codex) | Resolution |
|---|-------|-----------------|----------------|------------|
| CF-1 | **Storage format** | Backward-compatible: normalize on read + in-place `mergeInsert`/`delete`, no data reset | **Storage v2 + version gate**; unversioned non-empty storage **fails closed**; `--reset-storage`/`RAGNAROK_RESET_STORAGE=1` with timestamped backup | **Adopt B (already implemented).** Both npm packages are unpublished, so a pre-release reset is acceptable. ⚠️ The user's real `~/.ragnarok` (their shell points at it) will be rejected until reset — the backup-on-reset flow must be verified to actually preserve data. |
| CF-2 | **HTTP auth** | Single `RAGNAROK_API_KEY`, fail-closed on non-loopback | **Read/write token split**: `RAGNAROK_API_KEY`=read, `RAGNAROK_WRITE_API_KEY`=write; session role fixed at init; readers cause zero durable writes | **Adopt B (already implemented in config.ts + httpServer.ts).** Richer; supersedes A. |
| CF-3 | **C2 mechanism** | `Array.from` on read + crash-safe `mergeInsert` | **Explicit Arrow schemas** on table creation (also fixes mixed-format inference) + `Array.from` | **Adopt B superset.** B's explicit schemas fix an additional bug (§3, MB-1) A didn't catch. Keep A's cache-rollback-on-persist-failure idea (verify B has it). |
| CF-4 | **Persistence primitive** | `mergeInsert(id)` + `delete` NOT IN | Explicit-schema row-level insert/update/merge/delete; empty collections retain empty tables | Converge — same direction; B more explicit. |
| CF-5 | **Version / archives** | Not addressed | Lock `0.4.0`; storage v2 + `.rag` export 2.0; reject old archives with actionable reset message | **Adopt B.** |

**Net: Plan B's aggressive posture wins on every conflict, and the implementation already reflects that.** The only thing the user must actively confirm is CF-1's data-reset tradeoff for their existing `~/.ragnarok`.

---

## 3. Bugs Plan B found that Plan A (my review) missed — fold in, do not drop

These are genuine additional findings from Codex worth preserving:

- **MB-1 Mixed-format ingestion schema inference.** Ingesting TXT/MD/HTML/PDF in different first-file orders breaks LanceDB schema inference. Fix: explicit Arrow schemas + normalize every chunk row to typed columns with defaults (markdown/loc/heading/file/source). *(My review only saw single-format corpora, so I missed this.)*
- **MB-2 Native `SIGABRT` on shutdown.** LanceDB connections / ONNX sessions not closed before process exit cause a native abort under repeated cycles. Fix: close stores + ONNX before termination; **20× clean exit-code-0** soak test (`scripts/shutdown-soak.mjs`). *(My lifecycle test checked stdin-EOF once and it passed — the abort is intermittent / HTTP-path.)*
- **MB-3 EmbeddingFingerprint.** Persist {backend kind, provider format, model, revision, dimension, endpoint hash} per topic + memory manifest. Reject memory embedding change on fingerprint mismatch **even when dimensions match**; distinguish `remote:openai` vs `remote:ollama`. *(My review only had per-topic model metadata — weaker.)*
- **MB-4 Common/read-only database routing.** Route common-topic vector metadata, embeddings, docs, caches, KGs through the common-DB location; cache keys = location+topicId; validate common topics with different fingerprints; enforce read-only. *(My review didn't exercise the common-DB feature.)*
- **MB-5 Cancellation propagation.** Thread MCP `extra.signal` through RAGQueryService → embeddings → reranker → LLM → LangGraph → ingestion; no post-cancel writes.
- **MB-6 Remote embedding response validation** (count, indices, finite values, dimension consistency, empty-batch).
- **MB-7 Graph provenance by document/chunk** so reingestion/removal updates shared entities without deleting references owned by other documents.
- **MB-8 Ingestion journal** to finish metadata bookkeeping after a crash between vector and index commits.
- **MB-9 Export/import as v2 archives** (SHA-256, checksums, traversal + zip-bomb protection, fingerprint inclusion).
- **MB-10 Model manifest + packaging gate** (filenames, SHA-256, role, dtype, dimension; build fails on missing/renamed artifact). `verify-model-manifest.mjs` present.

## 4. Items Plan A covered that Plan B omits — add to the merged plan

- **AA-1 Cross-process storage lock.** *(Confirmed NOT implemented.)* Two `ragnarok-mcp` processes sharing one storage dir (e.g., Claude Desktop + Cursor both on `~/.ragnarok`) still do concurrent whole-table writes → silent loss. B's write coordinator is **intra-process only**; it does not stop a second OS process. Add `<storageDir>/.ragnarok.lock` (pid + stale detection, `RAGNAROK_IGNORE_LOCK` override) acquired in `MemoryStore`/`TopicManager.create`, released on dispose/exit. Document the single-instance constraint. **This is the one substantive gap in Codex's plan.**
- **AA-2 e2e env hygiene.** The user's shell exports `RAGNAROK_*` (remote OpenAI-format providers at `host.docker.internal:3000`) that silently reconfigure any spawned server — this corrupted my first review run (all queries "network error"). The e2e harness **must clear/override all `RAGNAROK_*`** in the spawn env. Add to the CI harness.
- **AA-3 Reranker background warm-up.** After constructing the shared reranker in `mcp-server/src/index.ts`, kick off `reranker.initialize().catch(...)` non-blocking, so first query is fast and load failures surface at startup (B catches the failure but doesn't warm up).

---

## 5. Consolidated build order (with implementation status)

Status legend: **[verified]** = independently confirmed by review/probe (`CODEX-CHANGES-REVIEW.md`) · **[impl]** = appears implemented in working tree (spot-checked, **not** test-verified) · **[partial]** · **[todo]**

### Phase 1 — Storage v2 & durable persistence  *(CF-1, CF-3, CF-4, MB-1, MB-8)*
- [impl] `storage-format.json` v2 + version gate + `--reset-storage`/`RAGNAROK_RESET_STORAGE` with timestamped backup (`storageV2.ts` wired in 9 files).
- [impl] `Array.from` at all LanceDB read boundaries (memory `:143/:206/:259`, verify KG store + vectorStoreFactory).
- [todo/verify] Explicit Arrow schemas on **all** table creation (memory entries/graph, KG, topic vector store) + normalized typed chunk columns for mixed-format ingestion (MB-1).
- [todo] Atomic JSON writes (temp + fsync + rename) for topic/document indexes.
- [todo] Stable `documentId`/`chunkId` + normalized source descriptor; reingest reconciles via `mergeInsert(chunkId)` and deletes obsolete chunks.
- [todo] Ingestion journal (MB-8). `dispose()` on every LanceDB-backed store.
- **[impl] AA-1 cross-process lock** — `packages/core/src/utils/storageLock.ts`: `<storageDir>/.ragnarok.lock` (pid+hostname+heartbeat, stale reclaim, `RAGNAROK_IGNORE_LOCK` override), refcounted per dir within a process; wired into `TopicManager.create` (released on failed init and dispose) and `MemoryStore` (lazy on first data access, released on dispose). 12 unit tests + MemoryStore integration tests.

### Phase 2 — Embeddings, reranking, ingestion correctness  *(C1, MB-3, MB-6, C3)*
- [verified] Reranker `dtype:"q8"` — empirically probed: bundled default model loads (332ms) and reranks correctly.
- [verified] Reranker init+scoring failures inside degradation boundary (init inside try, abort re-thrown); transactional model switch (swap-after-success); `rerankerEnabled` config. **[impl] AA-3 warm-up** — non-blocking `reranker.initialize()` at MCP startup; failures logged as warnings.
- [impl] EmbeddingFingerprint per topic + memory manifest; `remote:openai` vs `remote:ollama` distinguished (MB-3).
- [todo] Transactional embedding switch (probe before global state change).
- [impl] Remote embedding response validation (MB-6).
- [verified] C3: vector commit = success even if graph extraction fails; graph failure demoted to warnings (`stage:"graph"`, `partial:true`, `graphExtracted:false`); idempotent chunk storage ⇒ no duplicates on retry. Graph provenance by doc/chunk (MB-7).
- [todo] Verify stable `documentId`/`chunkId` assignment before `storeProcessedChunks` — `normalizeDocumentMetadata` defaults them to `""`; empty ids would collide on the `chunk_id` mergeInsert key.

### Phase 3 — Memory correctness & restart regressions  *(C2, memory quality)*
- [verified] Row-level memory persistence: `Array.from` at read boundaries + explicit Arrow schemas + crash-safe `mergeInsert(id).whenMatchedUpdateAll().whenNotMatchedInsertAll().whenNotMatchedBySourceDelete()` (single transactional merge, better than planned); empty collections retain empty tables.
- [impl] Cache rollback on persist failure — `persistScopeOrInvalidate()` drops the scope's entry+graph caches on any persist error and rethrows; applied to `store`, `forgetById` (both scopes), `forgetExpired`, `forgetByFilter`. Regression test: injected save failure → error surfaced, same-instance `list()` shows disk truth, store works after recovery.
- [verified] `forgetById` persists graph; version-chain repair. [impl] links branch-scope resolution; `promote` accepts `ids:string[]`; TTL `ttlDays`→`expiresAt`; decay-aware recall; score-scale normalization; opt-in `queryMemoryEnabled=false`, conf floor 0.7, `auto:query-insight` tag, `includeAuto:false` recall default.

### Phase 4 — Real-process e2e harness & CI baseline  *(A4, AA-2)*
- [partial] `.github/workflows/release.yml` exists — expand to Plan B's matrix (Node 20/22; Linux/macOS/Windows native; VS Code ext on Linux; npm pack/install/require/stdio smoke; Docker build+non-root+auth+persistence+shutdown smoke; VSIX×6 with content+manifest verify; dep/license + artifact-size audit).
- [todo] Port review harness (`it/*.cjs`) into mocha e2e specs spawning the **built binary + bundled models**, **clearing all `RAGNAROK_*`** (AA-2). Coverage: 6 strategies with bundled reranker (C1 gate); restart→mutate→restart memory (C2 gate); mixed-format ordering (MB-1); LangGraph index+query; HTTP roles/401/session/SIGTERM; **20× shutdown soak exit-0** (MB-2 gate).

### Phase 5 — HTTP access, lifecycle, Docker  *(CF-2, MB-2, MB-5, HTTP hardening)*
- [verified] Read/write token split (timing-safe); session role fixed at init; **structural default-deny** — write tools absent (not just guarded) for reader sessions; `writerOnly()` per-action on mixed `rag_memory`; readers cause zero durable writes.
- [verified] Process-level write coordinator (`runMutation` promise-chain serializer, 14 mutation sites); session idle TTL + max sessions. [impl] configurable rate limit + direct `cors`/`express-rate-limit` deps (verify direct-dep status).
- [impl] MB-5 cancellation propagation (signal threaded through store/recall/rerank/embed/indexing). MB-2: server uses `process.exitCode` + natural drain — probe showed the native abort fires **only** on forced `process.exit(0)`; **[todo]** 20× shutdown-soak gate to lock it.
- [verified] Docker: `USER node`, `npm prune --omit=dev`, chown data dir, `/ready` healthcheck; config fails closed on non-loopback without token / CORS `*`.

### Phase 6 — LangGraph checkpointing & parity  *(B2, C2-parity)*
- [todo] Wire `LanceDBCheckpointSaver` in MCP + VS Code when `langGraphEnabled`; deterministic ingestion thread IDs (topic+source+revision), resume incomplete, delete checkpoints after success+retention; per-query ephemeral thread IDs cleaned immediately.
- [todo] Bounded checkpoint state (clear `loadedDocs` after chunking; no model/store objects) + size test.
- [todo] Replace string-append refinement with shared legacy gap-analysis/follow-up; confidence on deduplicated single-domain scores; per-sub-query counts (fix `resultsCount`); chunkId normalization across vector/graph/hybrid/LangGraph; explicit `graphUsed`/`fallbackReason`/matched-entities/hop-depth in responses.

### Phase 7 — Retrieval quality & misc perf  *(MB-4 moved to Phase 10)*
- **MB-4 (common-DB routing) is absorbed into Phase 10** as `FolderSharedSource` — same work, now framed by the federation design.
- [impl] LLM availability 10s cache; async `.git/HEAD` branch detection (worktree-aware); ONNX disposal (async dispose in reranker). [todo] reranker over-fetch aligned to candidate limit; `KnowledgeGraphStore` connection memoization (verify); streaming validation + refreshed provider defaults.

### Phase 8 — MCP API completeness & VS Code memory  *(C1-features, MB-9, C6)*
- [verified] All new tools present and writer-gated + `runMutation`-wrapped: `rag_list_documents`, `rag_delete_topic`, `rag_add_url`, `rag_export_topic`, `rag_reset_memory`, `rag_storage_status`, `rag_remove_document`, `rag_rename_topic`, `rag_add_github_repo`, `rag_import_topic`.
- [verified] Web ingestion SSRF guard: DNS resolution + private/loopback/link-local blocking (IPv4+IPv6) + **DNS-pinning** (defeats rebinding TOCTOU) + per-redirect revalidation + redirect cap. [todo/verify] GitHub host allowlist; export/import archive checksums + traversal/zip-bomb protection (MB-9).
- [todo] VS Code `MemoryStore` wiring into LangGraph deps (extension storage + workspace); settings for reranking/query-memory/auto-memory visibility; no memory UI this release.

### Phase 9 — Contracts, packaging, docs  *(MB-10, CF-5, C5)*
- [todo] `VectorStoreMetadata` += `schemaVersion` + `embeddingFingerprint`; `DocumentSource` discriminated union with `addDocuments(string[])` compat wrapper over `addSources()`; pipeline metadata += `graphExtracted`/`partial`/`documentId`/warnings; memory options += `ttlDays`/`includeAuto`/`reinforce`.
- [impl/verify] Model manifest + packaging gate (MB-10).
- [todo] Pin release-critical direct deps to CI-validated exact versions; declare Node engine range.
- [todo] Lint gate repair (scope type-aware globs / per-package; fix the `require()` error + burn down warnings) + zero-warning CI.
- [todo] Docs reconciliation: tool counts (now ~18), defaults (`TOP_K`=10), storage reset, graph prerequisites (LangGraph+LLM+fallback), access roles, checkpoint behavior, hybrid 90/10 (fix ARCHITECTURE 70/30), single-instance constraint, provider support.

### Phase 10 — Federated shared KB & topology  *(design: `docs/superpowers/specs/2026-07-12-federated-shared-kb-design.md`)*

Serving decision: **retrieval-serving** — the remote MCP host is the primary shared-KB channel (zero-install consumers incl. sandboxed agents; no embedding-model pinning). Config rule: **exactly one RAGnarok MCP entry per agent context** (consumer/sandbox → remote only; power user → local only, remote is an engine setting; curator → direct writer session). Both-configured degrades safely via namespacing + self-describing servers + minimal tool overlap.

**Land with 0.4.0 (small, security-relevant for any token-configured host):**
- [impl] **Shared-mode tool surface:** `--http` + tokens configured ⇒ shared deployment ⇒ no `MemoryStore` constructed and `rag_memory`/`rag_reset_memory` structurally unregistered for every role (double-gated in `tools.ts`); stdio and token-less loopback HTTP keep them. Tests: shared+writer+store ⇒ memory tools absent, rest of surface intact.
- [impl] **Self-describing servers:** MCP `instructions` set per deployment in `index.ts`; every tool description prefixed `[Team shared KB]` on shared hosts via a decoration wrapper in `registerTools`. Tests assert prefix on all tools in shared mode, none in local.

**0.5.0 milestone (federation proper — depends on Phase 4 harness + green suite):**
- [todo] `SharedSource` abstraction + `FolderSharedSource` over `commonDatabasePath` (absorbs **MB-4**: route common-topic metadata/embeddings/docs/caches/KGs through the common location; cache keys include location+topicId; fingerprint validation; enforce read-only).
- [todo] `RemoteSharedSource`: MCP client (`Client` + `StreamableHTTPClientTransport`) with read token; cached remote-topic registry with periodic refresh.
- [todo] Per-topic federation in `RAGQueryService`: topic resolves local / shared / both; "both" → concurrent per-side retrieval + **RRF fusion** (reuse `ensembleRetriever`) + origin tags; remote timeout → graceful local-only with surfaced note.
- [todo] Config: `RAGNAROK_REMOTE_URL` / `RAGNAROK_REMOTE_TOKEN` + VS Code `ragnarok.*` equivalents; optional per-workspace storage.
- [todo] Tests: federation matrix (local-only / shared-only / both→RRF / remote-down); memory tools absent in token mode for reader **and** writer sessions; curator writer-session e2e; reader-session tests double as the consumer/sandbox profile.
- [todo] Docs: the three profiles + the one-entry-per-context rule.

---

## 6. Release gates (union of both plans)

- `npm run test:all` + e2e + package smoke + Docker smoke + lint (zero-warning) + format — all green from clean checkout.
- Dedicated passing regressions for the **four reproduced failures**: reranker load (C1), mixed schemas (MB-1), restart memory loss (C2), HTTP `SIGABRT` (MB-2). *(C1 and C2 are also in my review's Appendix A matrix.)*
- Deterministic mock servers for OpenAI/Anthropic/Ollama/embeddings/GitHub/web-redirects (no paid creds); user's docker proxy is fine for manual smoke only.
- 20× HTTP + stdio shutdown, every process exit-0, no native abort, no pending writes.
- Every review finding closed or explicitly classified post-release.

---

## 7. Recommended immediate next steps

Because Plan B is already largely written into the tree but **uncommitted and unverified**, the highest-value next action is not more planning but **reconciliation + verification**:

0. ~~Fix the red suite~~ **Done**: the 10 `queryGraph.test.ts` fixtures now pass `allowMemoryWrites: true`; also fixed a race in `httpTransport.test.ts`'s cancellation test (it asserted the server-side abort before the SDK's fire-and-forget `notifications/cancelled` POST could land — now awaits the handler-abort signal with a 2s timeout; propagation itself verified working, ~54ms).
1. **Verify the in-tree implementation compiles + passes**: `npm run compile` then `npm run test:fast`, then re-run the e2e harness (`it/` in the session scratchpad) against the **built** server with a clean `RAGNAROK_*` env, on a **fresh** storage dir (storage-v2 will reject the old one). *(compile + C1 probe already done in `CODEX-CHANGES-REVIEW.md`.)*
2. **Confirm the four regressions actually pass** (C1 all-strategies, C2 restart→mutate→restart, MB-1 mixed-format ordering, MB-2 20× shutdown).
3. **Add the confirmed gaps**: AA-1 cross-process lock, cache-rollback-on-persist-failure, AA-3 warm-up, AA-2 e2e env hygiene, plus Phase 10's two 0.4.0 items (shared-mode tool surface, self-describing servers).
4. **Confirm the CF-1 backup-on-reset** genuinely preserves the user's existing `~/.ragnarok` before anyone runs `--reset-storage`.
5. Then continue Phases 6–9 (checkpointing, retrieval quality, VS Code memory, docs) and Phase 10's 0.5.0 federation milestone.

> The single decision that still needs the user: **CF-1** — accept storage-v2's clean reset (with backup) of existing `~/.ragnarok`, or add a genuine v1→v2 migration path instead. Everything else converges on Plan B's already-implemented direction plus Plan A's AA-1/AA-2/AA-3 additions.
