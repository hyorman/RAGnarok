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

> 🔄 **Update 2026-07-13 (0.4.0-completion plan reconciliation).** A five-task execution pass closed the remaining LangGraph evaluate-node parity gaps, repaired the lint gate, centralized provider defaults, and documented the storage lock — see the per-item flips below. **Remaining after 2026-07-13:**
> - **CF-1** user-run backup-on-reset verification — someone must actually run `--reset-storage` against a real populated `~/.ragnarok` and confirm the timestamped backup restores cleanly; not yet done in any session.
> - **First real CI matrix run** — `.github/workflows/release.yml`'s Node 20/22 × Linux/macOS/Windows matrix has never executed on a real push/PR; still unverified in practice (see Phase 4).
> - **Phase 10 federation (0.5.0 milestone)** — `SharedSource`/`FolderSharedSource`/`RemoteSharedSource`, per-topic federation in `RAGQueryService`, RRF fusion across origins, federation config + tests + docs; explicitly out of 0.4.0 scope (only the two small shared-mode-surface items landed with 0.4.0).
> - **Phase 9 dependency pinning** — release-critical direct deps are still not pinned to CI-validated exact versions (the Node engine-range half of that bullet is now done; see Phase 9).
> - **Phase 8 MB-9** — GitHub host allowlist verification and export/import archive checksums + traversal/zip-bomb protection remain `[todo/verify]`.
> - **Phase 9 contract additions** — `VectorStoreMetadata` += `schemaVersion`/`embeddingFingerprint`, discriminated `DocumentSource`, pipeline metadata fields, memory option additions all still `[todo]`.

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
- [verified] Stable `documentId`/`chunkId` assignment before `storeProcessedChunks` — closed by the Phase 4 stdio E2E: `documentId` matches `doc-<sha256>` (non-empty, collision-resistant) and reingestion replaces rather than duplicates the source document (`stdioTransport.test.ts:115,138`).

### Phase 3 — Memory correctness & restart regressions  *(C2, memory quality)*
- [verified] Row-level memory persistence: `Array.from` at read boundaries + explicit Arrow schemas + crash-safe `mergeInsert(id).whenMatchedUpdateAll().whenNotMatchedInsertAll().whenNotMatchedBySourceDelete()` (single transactional merge, better than planned); empty collections retain empty tables.
- [impl] Cache rollback on persist failure — `persistScopeOrInvalidate()` drops the scope's entry+graph caches on any persist error and rethrows; applied to `store`, `forgetById` (both scopes), `forgetExpired`, `forgetByFilter`. Regression test: injected save failure → error surfaced, same-instance `list()` shows disk truth, store works after recovery.
- [verified] `forgetById` persists graph; version-chain repair. [impl] links branch-scope resolution; `promote` accepts `ids:string[]`; TTL `ttlDays`→`expiresAt`; decay-aware recall; score-scale normalization; opt-in `queryMemoryEnabled=false`, conf floor 0.7, `auto:query-insight` tag, `includeAuto:false` recall default.

### Phase 4 — Real-process e2e harness & CI baseline  *(A4, AA-2)*
- [partial] `.github/workflows/release.yml` exists — expand to Plan B's matrix (Node 20/22; Linux/macOS/Windows native; VS Code ext on Linux; npm pack/install/require/stdio smoke; Docker build+non-root+auth+persistence+shutdown smoke; VSIX×6 with content+manifest verify; dep/license + artifact-size audit).
- [impl] Real-binary mocha e2e specs spawning the **built binary + bundled models** landed in `packages/mcp-server/test/`, covering all five Phase-4 gates:
  - **C1** — existing stdio all-strategies loop in `stdioTransport.test.ts` (`vector`/`hybrid`/`ensemble`/`bm25`/`graph`/`graph_hybrid`, both the legacy path and the opt-in LangGraph path) with the bundled reranker.
  - **C2** — `memoryPersistenceE2E.test.ts`: restart → mutate → restart with zero loss.
  - **MB-1** — `mixedFormatE2E.test.ts`: order-independent txt→md→html / html→md→txt ingestion, including the mixed-b "silver relay" sentinel query.
  - **AA-1** — `storageLockE2E.test.ts`: second process fails fast on a locked storage dir; lock releases on clean exit.
  - **MB-2** — hardened `scripts/shutdown-soak.mjs` (ONNX lifecycle exercised, `RAGNAROK_*` env scrubbed, 20× stdio exit-0) plus `httpBinaryE2E.test.ts`'s "exits 0 on SIGTERM with no native-abort traces" case for the HTTP path.
  - These specs run inside `test:mcp:compiled` (`npm run test:fast`), so the CI `quality`/`native-process` jobs pick them up with **zero workflow changes**. ⚠️ Caveat: the `release-gates` workflow (`.github/workflows/release.yml`) has not yet had a real push/PR run on any OS — the Node 20/22 × Linux/macOS/Windows matrix is unverified in practice. ~~The `quality` job will also stay red on the known lint OOM...~~ **Resolved 2026-07-13**: Phase 9's per-package lint split landed (`npm run lint` exits 0 in 3.73s, see Phase 9), so `quality` is no longer expected to fail on lint; `native-process` (which actually exercises these e2e specs and the shutdown soak) was always independent of the lint issue. Both jobs still need one real CI run to confirm the matrix is green in practice.
- **[impl] AA-2 e2e env hygiene** — the harness (`StdioHarness`) and the shutdown soak both clear/override all `RAGNAROK_*` env vars in the spawn env, preventing the developer shell's remote-provider config from leaking into e2e runs.
- Closes the Phase 2 `documentId`/`chunkId` verification item: `stdioTransport.test.ts` asserts the `doc-<sha256>` id pattern (line 115) and that reingestion replaces rather than duplicates the source document (line 138, "reingestion must replace, not duplicate, the source").

### Phase 5 — HTTP access, lifecycle, Docker  *(CF-2, MB-2, MB-5, HTTP hardening)*
- [verified] Read/write token split (timing-safe); session role fixed at init; **structural default-deny** — write tools absent (not just guarded) for reader sessions; `writerOnly()` per-action on mixed `rag_memory`; readers cause zero durable writes.
- [verified] Process-level write coordinator (`runMutation` promise-chain serializer, 14 mutation sites); session idle TTL + max sessions. [impl] configurable rate limit + direct `cors`/`express-rate-limit` deps (verify direct-dep status).
- [impl] MB-5 cancellation propagation (signal threaded through store/recall/rerank/embed/indexing). MB-2: server uses `process.exitCode` + natural drain — probe showed the native abort fires **only** on forced `process.exit(0)`; **[impl]** 20× shutdown-soak gate — see Phase 4 (hardened soak, ONNX lifecycle exercised).
- [verified] Docker: `USER node`, `npm prune --omit=dev`, chown data dir, `/ready` healthcheck; config fails closed on non-loopback without token / CORS `*`.

### Phase 6 — LangGraph checkpointing & parity  *(B2, C2-parity)*
- [verified] `LanceDBCheckpointSaver` wired in MCP (`mcp-server/src/index.ts:103-104`) and VS Code (`vscode/src/extension.ts:61-62`) when `langGraphEnabled`. Deterministic thread IDs: per-query `query:${uuid}` (`ragQueryService.ts:357`), per-ingest `ingest:${topicId}:${sha256(source)}` (`topicManager.ts:893`) — the deterministic ingest id is what makes resume-past-completed-stages possible. Post-success sweep in both pipelines — `deleteThreadAfter`/`deleteThread` (`ragQueryService.ts:379-381`, `topicManager.ts:910-913`) — plus a `deleteOlderThan` retention sweep at the top of each run. Readers get an **uncheckpointed** graph: `checkpointer: readOnly ? undefined : this.checkpointer` (`ragQueryService.ts:346`), so a read causes zero durable checkpoint writes.
- [verified] Bounded checkpoint state: `loadedDocs` cleared to `[]` both at chunk time (`indexingGraph.ts:152`) and again at `buildResult` (`indexingGraph.ts:329`), so loaded document content never lingers in a persisted checkpoint past the stage that needs it. *(No dedicated checkpoint-size regression test found in this pass — candidate for 0.5.0 if wanted.)*
- [verified] Refinement parity closed — no more string-append. Refine node delegates to the same legacy machinery: `RAGAgent.analyzeGaps`/`generateFollowUpPlan` (`queryGraph.ts:251-292`, call sites `:274`/`:279`). Confidence on deduplicated single-domain scores: dedup was already pre-existing (`queryGraph.ts:211-219`, `Set` keyed by `getRetrievalResultKey`); `originalScore` preference newly added (`queryGraph.ts:235-238` — `scoreOf` prefers pre-rerank `metadata.originalScore` over the sigmoid-scaled reranked `score`). Per-sub-query `resultsCount`: graph-pipeline path was already correct (`queryGraph.ts:374-379`); legacy path's dead-code filter (`subQueryIndex`, never set anywhere) fixed to `(r.originalSubQuery ?? r.subQuery) === sq.query` (`ragQueryService.ts:255`). chunkId normalization: shared exported `getChunkId(metadata)` accessor (`graphRetriever.ts:42-57`, exported at `index.ts:98`), consumers switched over in `graphHybridRetriever.ts:97,109` and `queryGraph.ts:397-403`; `RAGAgent#getDocumentKey`'s ad-hoc falsy-`chunkId:0` bug also moved onto the same accessor (`ragAgent.ts:22`, commit `4e20696`). `graphUsed`/`fallbackReason`/`matchedEntities`/`hopDepth`: response-metadata plumbing was already present pre-existing (`ragQueryService.ts:239-249` legacy path, `:423-435` graph-pipeline path), but the underlying signal was wrong — `dispatchSearch` now returns `{ results, effectiveStrategy }` so a `GRAPH`/`GRAPH_HYBRID`→`VECTOR` internal fallback is labeled correctly instead of claiming the originally-requested strategy (`ragAgent.ts:448-551`). Tests: `queryGraph.test.ts:447-490`, `ragQueryService.test.ts:293-360`, `graphRetriever.test.ts:236-256`, `graphHybridRetriever.test.ts:149-168`, `ragAgent.test.ts:623-648`. Commits `1ad615d`, `4e20696`.

### Phase 7 — Retrieval quality & misc perf  *(MB-4 moved to Phase 10)*
- **MB-4 (common-DB routing) is absorbed into Phase 10** as `FolderSharedSource` — same work, now framed by the federation design.
- [impl] LLM availability 10s cache; async `.git/HEAD` branch detection (worktree-aware); ONNX disposal (async dispose in reranker).
- [verified] Reranker over-fetch aligned to candidate limit: `topK = Math.min(topK * multiplier, reranker.getMaxCandidates?.() ?? 50)` (`ragAgent.ts:534-538`, multiplier from `CONFIG.RERANKER_CANDIDATE_MULTIPLIER`). [verified] `KnowledgeGraphStore` connection memoized — `getDb()` caches a single `dbPromise` (`stores/knowledgeGraphStore.ts:261-267`). [verified] Streaming responses validated in all three providers — each rejects a non-string/wrong-type stream delta: OpenAI (`llmProviders.ts:43`), Anthropic (`:147`), Ollama (`:235`). [impl] Provider defaults centralized: single `PROVIDER_DEFAULT_MODELS` map (`constants.ts:54`) replaces five scattered literals across `llmProviders.ts`/`ragAgent.ts`/`topicTreeView.ts` — pure centralization, default values intentionally unchanged (commit `244527e`).

### Phase 8 — MCP API completeness & VS Code memory  *(C1-features, MB-9, C6)*
- [verified] All new tools present and writer-gated + `runMutation`-wrapped: `rag_list_documents`, `rag_delete_topic`, `rag_add_url`, `rag_export_topic`, `rag_reset_memory`, `rag_storage_status`, `rag_remove_document`, `rag_rename_topic`, `rag_add_github_repo`, `rag_import_topic`.
- [verified] Web ingestion SSRF guard: DNS resolution + private/loopback/link-local blocking (IPv4+IPv6) + **DNS-pinning** (defeats rebinding TOCTOU) + per-redirect revalidation + redirect cap. [todo/verify] GitHub host allowlist; export/import archive checksums + traversal/zip-bomb protection (MB-9).
- [verified] VS Code `MemoryStore` wiring complete: constructed and threaded into LangGraph deps at `extension.ts:92`. Settings all exist as `CONFIG` keys, re-exported into the `ragnarok.*` VS Code settings namespace (`packages/core/src/constants.ts:32,34,37`, read via `VsCodeConfigProvider`/`vscode.workspace.getConfiguration("ragnarok")`): `langGraphEnabled`, `rerankerEnabled`, `queryMemoryEnabled`. No memory UI this release (unchanged).

### Phase 9 — Contracts, packaging, docs  *(MB-10, CF-5, C5)*
- [todo] `VectorStoreMetadata` += `schemaVersion` + `embeddingFingerprint`; `DocumentSource` discriminated union with `addDocuments(string[])` compat wrapper over `addSources()`; pipeline metadata += `graphExtracted`/`partial`/`documentId`/warnings; memory options += `ttlDays`/`includeAuto`/`reinforce`.
- [impl/verify] Model manifest + packaging gate (MB-10).
- [todo] Pin release-critical direct deps to CI-validated exact versions. [verified] Node engine range declared: root `package.json:19` (`"node": ">=20"`), `packages/vscode/package.json:9` (`"node": ">=20"`); `packages/core/package.json:27` and `packages/mcp-server/package.json:32` already had `">=20 <23"` (commit `31a2708`).
- [verified] Lint gate repaired (2026-07-13). Per-package `lint`/`lint:fix` scripts in `packages/{core,mcp-server,vscode}/package.json`, root `npm run lint --workspaces --if-present && eslint test/`, hardened `eslint.config.mjs` ignores (`test/.temp-storage`, `test/chunk-output`, `dist-test`, `.vscode-test`) — commits `fb2ea19`, `33e8d49`. Proven: `npm run lint` exits 0 in **3.73s wall / 476MB peak RSS** (clean shell, default V8 heap), zero findings before and after — no source changes needed. The historical OOM (~2GB ceiling, ~305s, exit 134) did **not** reproduce across three independent attempts against current HEAD; attributed (circumstantially — the machine's V8 default old-space ceiling measured at 2096MB, matching the crash log's plateau almost exactly) to host memory pressure (~95% swap utilization observed at diagnosis time) rather than a discrete lint-config bug. The per-package split bounds per-process peak memory (236-538MB observed per target) regardless of host conditions, closing the exposure either way.
- [impl] Docs reconciliation largely current, per this pass's spot-checks plus the `aa45c7e` `ARCHITECTURE.md` rewrite: tool counts — root `README.md` table (20 rows) + `mcp-server/README.md` table (23 rows, "The server registers 23 tools." at line 32); defaults — `RAGNAROK_TOP_K`=10 documented at `mcp-server/README.md:93`; storage reset — `ARCHITECTURE.md` §5 "Storage format v2"; graph prerequisites (LangGraph+LLM+fallback) — `ARCHITECTURE.md` §10 Knowledge Graph ("Graph extraction is advisory... its absence downgrades graph strategies to hybrid"); access roles — `ARCHITECTURE.md` §13 "Authentication & roles"; checkpoint behavior — `ARCHITECTURE.md` §12 Query Execution; hybrid 90/10 — `ARCHITECTURE.md:237` (`**0.9 vector / 0.1 keyword**`, the old ARCHITECTURE 70/30 error is gone); single-instance constraint — documented in both READMEs (`README.md:504`, `mcp-server/README.md:119-129`, commit `31a2708`); provider support — `ARCHITECTURE.md` §8/§14 provider tables. *(Not re-verified line-by-line in this pass — left `[impl]` rather than `[verified]`.)*

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
