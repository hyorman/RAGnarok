# Codex Comprehensive Branch Review — `mcp-server` vs `main`

**Reviewed commit:** `0baa40541a24b2c0965ea70cd3129efa520d0620`  
**Base:** `main` at `f138eefd6faca3376952470850887af282cd1548`  
**Scope:** 12 commits, 221 changed files, approximately 116,936 insertions / 9,969 deletions  
**Verdict:** **Block merge/release until the P0 findings are fixed.**

## 1. Executive assessment

This branch is a strong architectural step: the monorepo separation is real, the portable core has useful dependency-injection seams, the MCP adapter is comparatively thin, stdio logging is protocol-safe, config validation is thoughtful, and the test suite has good breadth.

The release posture is nevertheless unsafe. Two failures were reproduced directly against the current checkout:

1. The bundled default reranker cannot load, and its initialization error escapes the intended degradation path. In the default MCP configuration this makes normal RAG queries fail.
2. A memory table loaded after restart cannot be saved again because LanceDB vectors are retained as Arrow objects. The save drops the old table before recreation, so the failed mutation deletes all persisted memories in that scope.

This review also found important issues absent from the supplied report. Most notably, switching to a different embedding model with the same vector dimension is allowed while memories exist, even though the vectors are in a different semantic space. Recall then silently becomes meaningless. Model switching is not transactional, MCP cancellation is not connected to the query service, and common/read-only databases use local embedding metadata and local knowledge-graph storage.

The architecture should be kept. The persistence and runtime wiring need another hardening pass before release.

## 2. Verification performed

| Check | Result |
|---|---|
| TypeScript workspace build | Pass |
| Core tests | 690 passing, 20 benchmark tests pending |
| MCP tests | 149 passing when rerun outside the filesystem/network sandbox |
| Package smoke test | Pass; clean-consumer install verified |
| Default reranker real-model initialization | **Fail, reproduced**: loader requests missing `onnx/model.onnx` |
| Restart → load → mutate memory table | **Fail, reproduced**: Arrow vector inference error, then zero rows remain |
| Default lint command | Not rerun to completion; the supplied report's default-heap OOM remains credible and the configuration has not changed |

The first MCP test run had 10 HTTP failures because the review sandbox prohibited binding `127.0.0.1`; the same compiled test suite passed 149/149 outside that sandbox. Those failures are environmental, not product failures.

## 3. P0 — merge blockers

### P0.1 Default MCP queries fail because the bundled reranker is not loadable

**Code:** `packages/core/src/rerankers/crossEncoderReranker.ts:74-82, 224-237`; `packages/mcp-server/src/index.ts:139-145`

The branch uses Transformers.js v3 but passes the removed v2-style option `{ quantized: true }`. V3 expects a `dtype` such as `"q8"`. Because the option is ignored, Transformers.js requests `onnx/model.onnx`, while the package contains only `onnx/model_quantized.onnx`.

Direct reproduction on the reviewed checkout produced:

```text
dtype not specified for "model". Using the default dtype (fp32)
Local file missing at ".../onnx/model.onnx"
```

The intended graceful fallback does not catch this: `rerank()` calls `initialize()` before its `try` block. The MCP host injects an uninitialized reranker directly into `RAGQueryService`, bypassing the service's guarded `createReranker()` path. The result is a release-blocking default-path failure, not an optional feature failure.

**Required fix:**

- Load the packaged artifact with the correct v3 option (`dtype: "q8"`) or ship the filename the loader requests.
- Move initialization inside the degradation `try/catch` and return the original candidate order on any load/scoring failure.
- Add defense-in-depth around reranking in `RAGAgent`.
- Add a packaged-binary integration test using the actual bundled model, not a stub.
- Add a reranker enable/disable escape hatch.

### P0.2 First memory mutation after restart can delete every persisted entry in the scope

**Code:** `packages/core/src/memory/memoryVectorStore.ts:143-169, 173-209, 218-265`; `packages/core/src/memory/memoryStore.ts:112-190`

`loadEntriesUnlocked()` and `searchEntriesUnlocked()` cast `row.vector` to `number[]`; LanceDB actually returns an Arrow vector object. When the loaded entries are saved, schema inference descends into fields such as `vector.isValid` and fails.

The persistence algorithm makes the type bug destructive: it drops the existing table before attempting to create the replacement. I independently reproduced the exact sequence with the real `MemoryVectorStore`:

```text
save one entry → construct a new store → load → append → save
mutation failed: Failed to infer data type for field vector.isValid
entries after failed mutation: 0
```

The in-memory cache is populated before persistence, so callers can temporarily observe the new state even though durable storage has been deleted.

**Required fix:**

- Normalize every vector read with `Array.from(row.vector)` in both load and search paths, and defensively before writes.
- Stop using destructive drop-then-create replacement. Use a temporary table plus validated swap, or LanceDB row-level delete/add/upsert operations.
- Roll back or invalidate cache mutations when persistence fails.
- Add a restart → mutate → restart regression test. Existing persistence tests reload data but do not mutate the reloaded Arrow-backed entries.

### P0.3 Same-dimension embedding-model switches silently corrupt memory recall

**Code:** `packages/mcp-server/src/tools.ts:427-472`; `packages/core/src/memory/memoryVectorStore.ts:143-166`

The model-switch guard rejects a change only when the new embedding dimension differs from the old dimension. Equal dimension does **not** imply compatible embedding spaces. Two 384-dimensional models generally place the same text at unrelated coordinates.

Memory rows store only vectors; there is no embedding provider/model/version metadata per memory table. Therefore switching from one 384-dimensional model to another succeeds while memories exist, after which new query vectors are compared with old vectors from a different semantic space. The API returns plausible scores rather than an error, making this a silent correctness failure.

This is more dangerous than a dimension mismatch because LanceDB cannot detect it.

**Required fix:**

- Until migration exists, block **any model/provider identity change** while memory data exists, not only dimension changes.
- Better: persist a stable embedding fingerprint (`provider`, endpoint identity where relevant, model, revision, dimension) for each memory table and re-embed atomically during migration.
- Add a same-dimension switch regression test; the current test covers only 384 → 768.

### P0.4 LangGraph ingestion reports failure after vectors are committed, causing duplicate storage on retry

**Code:** `packages/core/src/agents/indexingGraph.ts:179-267, 279-325`; `packages/core/src/managers/topicManager.ts` LangGraph `addDocuments` path

Vector storage occurs before entity extraction and graph persistence. If extraction or graph storage fails, the final result is `success: false`; `TopicManager` then does not record document metadata even though chunks are already in LanceDB. A retry stores those chunks again.

**Required fix:** treat graph enrichment failure as partial success and record committed document/chunk metadata with an explicit `graphExtractionStatus`, or implement a real rollback. Partial success is the safer design because the vector data is valid.

## 4. P1 — high-priority correctness and operational issues

### P1.1 Model-switch operations are not transactional

**Code:** `packages/core/src/rerankers/crossEncoderReranker.ts:138-165`; `packages/mcp-server/src/tools.ts:624-665`; `packages/mcp-server/src/tools.ts:435-505`

`CrossEncoderReranker.switchModel()` clears the working model and changes `modelName` before loading the replacement. If loading fails, the tool returns an error but leaves the shared query reranker pointed at the failed model. Future queries retry that failure.

The embedding switch has a similar boundary: after the new backend/model is initialized, failure in `topicManager.reinitializeWithNewModel()` returns an error without restoring the previous embedding state. Memory recall may already be using the new semantic space.

**Fix:** stage and fully initialize replacement objects first, then swap references atomically. On every failure, retain the prior working model and metadata.

### P1.2 Common/read-only topics read local metadata and cannot load their knowledge graph

**Code:** `packages/core/src/stores/vectorStoreFactory.ts:146-205, 226-243`; `packages/core/src/managers/topicManager.ts:329-351, 710-760, 769-810`

`loadStore(topicId, customStorageDir)` correctly opens the common database's LanceDB directory, but calls `getStoreMetadata(topicId)` without the custom directory. `ensureEmbeddingModelCompatibility()` does the same. Both therefore consult the local database's metadata (or no metadata), potentially selecting the wrong embedding backend/model for the common table.

Knowledge graphs are worse: `TopicManager` constructs one `KnowledgeGraphStore` for the local database, and `getKnowledgeGraph()` has no common-database routing. Graph strategies on common topics therefore silently lose the common topic's graph and fall back toward vector behavior.

**Fix:** make the database location part of the store identity and pass it through metadata, vector, document, and graph access consistently. Add an integration test where local and common stores intentionally use different embedding models and the common topic has a graph.

### P1.3 MCP request cancellation is not wired

**Code:** `packages/mcp-server/src/tools.ts:51-99`; `packages/core/src/agents/ragQueryService.ts:145-168`

The core service accepts an `AbortSignal`, and VS Code supplies one. The MCP `rag_query` handler ignores the callback's request context and invokes `executeQuery(params)` without a signal. A cancelled/disconnected MCP request can therefore continue embedding, reranking, LLM calls, refinement, and memory writes.

**Fix:** accept the MCP SDK handler context, pass its signal to `RAGQueryService.executeQuery`, and add a transport-level cancellation test that asserts downstream work stops.

### P1.4 Remote embedding identity is collapsed to the generic name `remote`

**Code:** `packages/core/src/embeddings/remoteEmbeddingBackend.ts:21-36`; `packages/mcp-server/src/adapters.ts:15-33`; `packages/core/src/managers/documentPipeline.ts:524-532`

OpenAI-compatible and Ollama embeddings both persist `embeddingBackend: "remote"`. Provider, normalized base URL, and model revision are not represented. A store created through one provider can later be treated as compatible with a different provider merely because the active backend is also named `remote`. If dimensions match, results are silently wrong; if they differ, failure occurs late at query/add time.

**Fix:** persist a stable backend fingerprint, at least `remote:openai` vs `remote:ollama`, plus a non-secret endpoint identifier and model/revision. Compatibility checks must use that fingerprint.

### P1.5 Memory/knowledge-graph persistence is full-table rewrite with no cross-process safety

**Code:** `packages/core/src/memory/memoryVectorStore.ts:118-169, 277-325`; `packages/core/src/stores/knowledgeGraphStore.ts:19-87`

Every mutation rewrites entire tables by dropping them first. Besides the reproduced single-process data loss, two MCP processes sharing the default storage directory can overwrite each other with last-writer-wins snapshots. The mutex is process-local.

**Fix:** use row-level transactions/upserts where possible and add a cross-process lock or explicitly enforce single-writer ownership. Crash-safe replacement is required even with locking.

### P1.6 HTTP sessions are unbounded and never expire

**Code:** `packages/mcp-server/src/httpServer.ts:102-141, 171-193`

Sessions are removed only when clients explicitly close or the transport closes. Abandoned sessions retain a transport and `McpServer` indefinitely. There is no idle TTL, maximum session count, or admission control.

**Fix:** track last activity, reap idle sessions, cap concurrent sessions, and return a resource-limit response when full.

### P1.7 Docker HTTP defaults are unsafe for accidental production use

The compose setup publishes the HTTP service with authentication disabled by default and permissive CORS. The runtime image also runs as root and carries development dependencies.

**Fix:** refuse non-loopback HTTP binding without an API key, use a non-root user, declare security middleware as direct dependencies, install production dependencies only, and document reverse-proxy/TLS expectations.

## 5. P2 — medium-priority defects and design gaps

1. **`topK` validation is inconsistent.** MCP startup accepts up to 50 (`config.ts:77`), the legacy query service allows only 20 (`ragQueryService.ts:188-191`), and the LangGraph path does not share the same validator. A valid startup config can break all legacy queries.
2. **`forgetById` does not persist graph cleanup.** `memoryStore.ts:815-837` removes orphaned entities in memory and persists entries, but not the graph. Orphan entities return after restart.
3. **The LangGraph `memorize` node writes query snippets into user memory by default.** `queryGraph.ts:282-305` uses a default threshold of 0.1, making hidden memory pollution a normal query side effect.
4. **Checkpointing is implemented but not wired by either host.** The graph factories accept a checkpointer, but production construction passes none and no stable thread ID. Product copy claiming checkpointing is inaccurate.
5. **Stdio EOF does not run graceful disposal.** `index.ts:175-205` flushes memory reinforcement and markdown only for SIGINT/SIGTERM. Normal client stdin closure relies on process exit; unref'd pending flushes may be lost.
6. **HTTP middleware is an undeclared best-effort transitive dependency.** `cors` and `express-rate-limit` are dynamically imported and silently skipped if the MCP SDK changes its dependency tree.
7. **Remote embedding responses are not structurally validated.** `remoteEmbeddingBackend.ts:133-174` trusts array count, ordering, numeric values, non-empty vectors, and consistent dimensions. Malformed provider responses can produce `undefined` or corrupt a table before a useful error appears.
8. **`embedBatch([])` makes a remote API call.** The zero-length case falls into the `<= BATCH_SIZE` branch instead of returning `[]`, unlike expected batch semantics.
9. **Reranker candidate accounting is inconsistent.** Retrieval can fetch up to 50 candidates while the reranker defaults to a hard cap of 20, wasting retrieval work and making the configured multiplier misleading.
10. **Legacy `agenticMetadata.steps[].resultsCount` is effectively always zero.** It filters on `metadata.subQueryIndex`, which retrieval does not set.
11. **The `links` memory action misparses bare `branch`.** A branch scope without `branch:<name>` is treated as workspace by the internal parser, so the response can be mislabeled.
12. **Memory TTL is not reachable from the public store/MCP API.** Decay honors `expiresAt`, but callers cannot set it.
13. **Graph strategy availability is silent.** Topics indexed without LangGraph+LLM, including common topics, degrade without exposing that no graph participated.
14. **`@ragnarok/core` is a ~99.9 MB compressed / 116.2 MB unpacked package.** The package smoke test confirms model binaries dominate every install. Consider an optional models package or checksum-verified on-demand download.
15. **Lint is not a practical release gate at the default Node heap.** Scope type-aware lint per package and exclude generated/benchmark-heavy surfaces, then enforce it in CI.

## 6. Product/API gaps

- MCP can create topics and add local documents but cannot delete topics/documents, rename, export/import, or ingest GitHub/web sources already supported by core.
- Standalone memory is wired only in the MCP host; the VS Code product does not expose the memory feature described in the architecture docs.
- Graph retrieval requires graph-enriched ingestion, but the UI/docs do not clearly state the prerequisite or distinguish real graph retrieval from fallback.
- Docs drift on tool counts, default `topK`, retrieval weights, checkpointing, and experimental behavior.

## 7. What should be preserved

- The package separation and host-neutral core interfaces.
- Shared `RAGQueryService` orchestration rather than duplicating host logic.
- Protocol-safe stderr logging in stdio mode.
- Zod startup validation and symlink-aware file allowlisting.
- Per-topic embedding metadata concept; extend it to full backend fingerprints instead of removing it.
- Cache invalidation hooks and true LRU promotion in the query service.
- The large unit suite; add a smaller real-storage/real-model contract layer rather than replacing it.

## 8. Recommended merge plan

### Before merge

1. Fix and integration-test P0.1–P0.4.
2. Make memory persistence crash-safe and model-aware.
3. Make model switches transactional.
4. Add one packaged-server CI scenario: create topic → add documents → query → store memory → restart → mutate memory → restart → verify; run with the bundled reranker.

### Before first public release

5. Fix common-database routing, MCP cancellation, session TTL/caps, Docker security defaults, and cross-process storage safety.
6. Wire checkpointing or remove the claim; make automatic memorization opt-in.
7. Align validation and make graph fallback observable.
8. Make lint runnable and mandatory.

### Follow-up

9. Complete the MCP management API and reconcile documentation.
10. Move large model assets to an optional/downloaded distribution model.
11. Improve LangGraph refinement and confidence calibration so all strategies use comparable signals.

## 9. Final verdict

**Do not merge this commit as a releasable branch.** The design is worth continuing, but the current default query path and durable memory path both fail under real dependencies, and the memory embedding lifecycle has a second silent-corruption path even after the Arrow fix. Once those are corrected with real integration coverage, the remaining findings are tractable release-hardening work rather than reasons to abandon the architecture.
