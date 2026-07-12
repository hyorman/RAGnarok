# Review: Codex's Unstaged Changes vs the Plan

**Date:** 2026-07-12
**Base:** working tree at review time (Codex still actively editing; changes uncommitted)
**Method:** read current file state for the critical paths, plus runtime verification — `npm run compile` (pass), a direct load/rerank probe of the bundled default reranker, and `npm run test:fast`.

## Verdict

**High-quality, thorough implementation of the plan — but mid-flight and not yet green.** All three release blockers from my review (C1, C2, C3) are correctly and robustly fixed; several fixes are *better* than what I proposed. Source compiles and the C1 fix is empirically verified. However the **test suite does not currently compile** (one lagging file), one plan item is confirmed **not implemented** (cross-process lock), and a few minor gaps remain.

## Verified correct (with evidence)

| Item | Status | Evidence |
|---|---|---|
| **C1 reranker** | ✅ **fixed + empirically confirmed** | `dtype:"q8"` (matches bundled `model_quantized.onnx`); `initialize()` moved *inside* the try so load failure degrades to original order; abort re-thrown. Probe: default bundled model **loads (332ms) and reranks correctly** (relevant doc first @ 0.9934). This was the "every query fails" blocker — genuinely resolved. |
| **C2 memory data-loss** | ✅ fixed, better than planned | `Array.from()` on every read/write boundary; **explicit Arrow schemas** via `createEmptyTable`; crash-safe `mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().whenNotMatchedBySourceDelete()` replacing drop-then-create (single transactional merge — no data-loss window). Empty collection → `delete("true")` (retains table). |
| **C3 ingestion atomicity** | ✅ fixed | `buildResult`: `success = vectorStored && chunkCount>0`; graph failure demoted to `warnings` (stage:"graph") with `partial:true`/`graphExtracted:false`. Idempotent chunk storage + checkpoint resume ⇒ no duplicate vectors on retry. |
| **Storage v2** | ✅ | version marker + fail-closed on unversioned data (actionable message); `atomicWriteFile` (temp+fsync+rename+dir-fsync); `resetStorageToV2` backs up to `backup-v1-<ts>` **with rollback** — your CF-1 data-preservation concern is handled (restore is manual). |
| **MB-1 mixed-format** | ✅ | `normalizeDocumentMetadata` forces a fixed set of typed columns w/ defaults for every chunk regardless of format + explicit schema; no more first-file inference divergence. |
| **Persistence consistency** | ✅ | topic store, KG store, and memory store all converted to explicit-schema + `Array.from` + `mergeInsert`/`delete`. |
| **Auth hardening** | ✅ exceeds recommendation | read/write token split; **structural default-deny** — `registerWriteTool = writer ? server.tool : noop`, so 12 write tools are *absent* (not just guarded) for reader sessions; `writerOnly()` per-action on mixed `rag_memory`; `runMutation` promise-chain **serializes all writes**; session role pinned at init + TTL reaping + max-sessions; config fails closed on non-loopback without token / with CORS `*`. |
| **SSRF (webLoader)** | ✅ strong | DNS resolution + block private/loopback/link-local (IPv4 + IPv6 ULA/link-local) + **DNS-pinning** (defeats rebinding TOCTOU) + per-redirect revalidation + redirect cap. |
| **Docker** | ✅ | `USER node`, `npm prune --omit=dev`, `chown` data dir, `/ready` endpoint. |
| **New MCP tools** | ✅ | list/delete/rename topic, remove/list documents, add_url, add_github_repo, export/import, reset_memory, storage_status — all writer-gated + `runMutation`. |
| **MB-5 cancellation** | ✅ | `signal.throwIfAborted()` threaded through store/recall/rerank/embed/indexing; reranker re-throws abort vs degrading. |
| **Misc (MB-3/6, perf)** | ✅ | embedding fingerprint (`remote:openai` vs `remote:ollama`); remote-embedding response validation (count/indices); `gitBranchDetector` async (`.git/HEAD` + worktree); LLM `isAvailable` 10s cache; memorize node opt-in (`QUERY_MEMORY_ENABLED` default false, threshold floored at 0.7, `auto:query-insight` tag, recall `includeAuto:false`); `forgetById` now persists the graph (my M3); version-chain repair on forget. |
| **MB-2 SIGABRT** | ⚠️ likely handled | server uses `process.exitCode` + natural drain; my probe's native abort (`mutex lock failed`) fired **only** on forced `process.exit(0)`; natural drain exits clean (0). Confirm via the 20× `shutdown-soak.mjs` gate; any future force-exit after ONNX use reintroduces it. |

## Open / incomplete (needs finishing)

1. **🔴 Test suite doesn't compile.** `packages/core/test/queryGraph.test.ts` — 10 fixtures missing the now-**required** `allowMemoryWrites` field on `QueryPipelineOptions` (added for the reader-no-writes plumbing). Source builds; only the test file lags the type. Trivial fix, but **CI is red until done** — this is the top priority. (No other test-compile errors.)
2. **🟠 Cross-process lock (AA-1) — not implemented** (confirmed absent). Still the gap for scenarios 1 & 2 (two VS Code windows / two stdio servers on one storage dir → concurrent whole-table writers). `runMutation` only serializes *within one process*.
3. **🟡 Cache-rollback on persist failure — not added.** `memoryStore.store()` sets the cache before `persistEntries`; a persist throw leaves the cache falsely showing success. Low severity now (mergeInsert is crash-safe ⇒ false in-session success, not data loss) — invalidate cache on persist error to close it.
4. **🟡 Verify stable `documentId`/`chunkId` assignment** before `storeProcessedChunks`. `normalizeDocumentMetadata` defaults them to `""`; if the pipeline doesn't assign real ids, empty-id chunks collide on the `chunk_id` mergeInsert key. Confirm the ingestion path sets them.
5. **🟢 Column-naming redundancy** (not a bug). Topic schema declares both snake (`document_id`/`chunk_id`) and camel (`documentId`/`chunkId`); all four are populated and referenced, so it works — just wasteful/confusing. Standardize on one convention.
6. **Federation (`SharedSource`/remote) — not started.** Expected: it's the net-new design from our brainstorm (`docs/superpowers/specs/2026-07-12-federated-shared-kb-design.md`), not in Codex's plan.
7. **C1 needs the CI e2e gate.** I verified the load by direct probe; the plan's real-binary e2e test (A4) must lock it so it can't silently regress.

## Bottom line

Codex has implemented the overwhelming majority of the consolidated plan correctly, including all three critical blockers, and in places improved on it (crash-safe merge, structural default-deny auth, DNS-pinned SSRF). Before this can be called done: **(a)** fix `queryGraph.test.ts` so the suite compiles and run it green, **(b)** add the cross-process lock, **(c)** close the cache-rollback + documentId/chunkId verification nits, **(d)** land the e2e + shutdown-soak gates so C1 and MB-2 can't regress. Federation is separate follow-on work.
