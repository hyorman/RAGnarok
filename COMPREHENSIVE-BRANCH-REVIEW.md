# Comprehensive Branch Review — `mcp-server` vs `main`

**Reviewed head:** `0baa405` (12 commits, 221 files, ~117k insertions)
**Review date:** 2026-07-11
**Method:** Independent from-scratch review — requirements synthesis from docs, full source review of the MCP server / memory / knowledge-graph / retrieval subsystems, build + test + lint verification, and **live integration testing of the MCP server** (stdio + HTTP transports, RAG + memory + LangGraph, restart/persistence, auth, lifecycle). Prior Codex/Copilot reports were read but every claim relied on here was re-verified against the current head.

---

## 1. Executive Summary

The branch converts a single VS Code extension into a well-architected three-package monorepo (`@ragnarok/core`, `@ragnarok/vscode`, `@ragnarok/mcp-server`) and adds standalone memory, a knowledge graph, cross-encoder reranking, optional LangGraph pipelines, remote embeddings, and packaging/benchmark infrastructure. The architecture is genuinely good: clean dependency-injection seams, a shared `RAGQueryService`, stderr-only diagnostics for stdio safety, zod-validated config, path allowlisting with symlink resolution, and timing-safe HTTP auth. The automated suite is broad and green (690 core + 149 MCP tests passing).

**However, the branch is not releasable in its current state.** Live integration testing found two critical defects that the unit suites cannot see because they stub the model and storage layers:

1. **`rag_query` never works in the default MCP configuration.** The bundled reranker ships only `model_quantized.onnx`, but `CrossEncoderReranker` passes `{ quantized: true }` — a transformers.js **v2** option that v3 ignores (v3 uses `dtype: "q8"`). The loader looks for `model.onnx`, fails, and because reranker initialization is not guarded, **every query on every strategy returns an error**. Verified live: 0/8 query scenarios pass out-of-the-box; all pass once a loadable model is substituted.
2. **The memory store destroys all persisted memories on the first mutation after a restart.** Entries loaded from LanceDB carry Arrow `Vector` objects in the `vector` field; `saveEntries` drops the table *first*, then `createTable` fails on type inference — leaving the scope's table deleted. Verified live: store 2 memories → restart → store 1 more → error → restart → **0 memories remain**. The in-memory cache masks the failure inside the session, so the loss is silent until the next restart.

A third carried-over P1 (LangGraph ingestion atomicity) was re-confirmed at the code level, and the docker-compose security defaults previously flagged remain unchanged.

**Verdict:** Approve the architecture; **block merge/release** until the two critical defects are fixed with integration-level regression tests, and the P1/P2 items below are triaged.

---

## 2. Requirements Inventory & Coverage

Synthesized from README, ARCHITECTURE.md, BENCHMARKS.md, `docs/knowledge-graph/phase-1..4`, and `docs/cross-encoder-reranking-design.md`.

| # | Requirement | Status | Notes |
|---|------------|--------|-------|
| R1 | Monorepo: portable core + vscode + mcp-server | ✅ Done | Clean DI seams (`IConfigProvider`, `ILogger`, `INotifier`, `ILLMProvider`) |
| R2 | Multi-format ingestion (PDF/MD/HTML/TXT/GitHub/web) | ✅ Core / ⚠️ MCP | MCP exposes **local file paths only** — no GitHub/web ingestion tool |
| R3 | Pluggable embeddings (HF local, VS Code LM, remote) | ✅ Done | Remote backend clean; per-topic model metadata prevents dimension breakage |
| R4 | 6 retrieval strategies incl. graph, graph_hybrid | ✅ Done* | *Graph strategies silently fall back to vector unless the topic was ingested with LangGraph enabled **and** an LLM — not stated in README |
| R5 | Cross-encoder reranking | ❌ **Broken** | Critical defect C1; also always-on with no disable flag (design doc specified graceful failure) |
| R6 | Knowledge graph (extraction, graphology, Louvain, persistence) | ✅ Done | Louvain verified working on directed multigraphs; persistence is drop-and-recreate (same durability pattern as memory) |
| R7 | Standalone memory (scopes, decay, export, `rag_memory`) | ⚠️ **Data-loss defect** | Feature-complete API; C2 makes persistence unreliable; TTL is dead code (nothing can set `expiresAt`) |
| R8 | Agentic planning + refinement | ✅ Done | Heuristic fallback verified live without LLM |
| R9 | LangGraph pipelines "with checkpointing" | ⚠️ Partial | Pipelines work (verified live). **Checkpointing claim is false** — `LanceDBCheckpointer` is exported and tested but no production host constructs it or passes thread IDs |
| R10 | MCP server (13 tools, stdio+HTTP, Docker) | ✅ Done* | *Subject to C1; HTTP auth/sessions verified live; asymmetric API (no delete/export) |
| R11 | VS Code extension (commands, views, tokens, LM tool) | ✅ Done | Memory module **not wired at all** in VS Code (see §6.3) |
| R12 | Packaging (VSIX×6, npm, Docker, version-sync) | ⚠️ Concerns | npm `@ragnarok/core` ships ~145 MB of ONNX/tokenizer assets; Docker runs as root with dev deps |
| R13 | Benchmarks (BEIR/FRAMES/rerank) | ✅ Done | Env-gated suites; BENCHMARKS.md documents results |

---

## 3. Verification Evidence

| Gate | Result |
|------|--------|
| `npm run compile` (tsc -b all packages) | ✅ exit 0 |
| Core tests (compiled) | ✅ 690 passing, 20 pending (env-gated benchmarks) |
| MCP tests (compiled) | ✅ 149 passing |
| Prettier `format:check` | ✅ clean |
| ESLint | ⚠️ **OOMs at default 2 GB Node heap** (Mark-Compact death spiral after ~350 s); the lint gate is effectively unrunnable without `--max-old-space-size` — likely the type-aware config is including huge generated/test surfaces. Needs project-service scoping or per-package lint |
| Integration (stdio, default config) | ❌ 25/38 — all 8 query scenarios fail (C1), memory forget crashes (C2) |
| Integration (stdio, loadable reranker) | ✅ 35/38 — remaining 3 failures are all C2 |
| Integration (HTTP + API key) | ✅ 7/7 — health, 401 on missing/wrong key, session flow, shared storage, graceful SIGTERM |
| Restart persistence | ✅ topics/queries; ❌ memory (C2) |
| Lifecycle | ✅ server exits cleanly on client stdin EOF (no orphan); note: the debounced memory flushes are only awaited on SIGINT/SIGTERM, not on stdin-EOF |
| LangGraph pipeline (flag on) | ✅ indexing + query work; ⚠️ memorize-node pollution and iteration waste confirmed (§5.4, §6.6) |

Integration harness and full logs: session scratchpad `it/` (`mcp-it.cjs`, `http-it.cjs`, `langgraph-smoke.cjs`, `restart-store.cjs`, `results.json`).

---

## 4. Critical Defects (release blockers)

### C1 — `rag_query` is completely broken in the default MCP configuration
`packages/core/src/rerankers/crossEncoderReranker.ts:236` passes `{ quantized: true }` to `from_pretrained`. That option existed in transformers.js **v2**; the project uses **v3** (`@huggingface/transformers ^3.7.6`), where the equivalent is `dtype: "q8"`. v3 silently ignores `quantized` and resolves `onnx/model.onnx` — but the bundled asset is `packages/core/assets/models/Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_quantized.onnx` only. Model load throws.

The failure is then amplified twice:
- `CrossEncoderReranker.rerank()` calls `await this.initialize()` **outside** its try/catch (`crossEncoderReranker.ts:80-82`), so the "graceful degradation" path only covers scoring errors, not load errors.
- `RAGAgent` calls `rerankResults` unguarded (`ragAgent.ts:246`, `:328`), so the load error fails the entire query.

The MCP server injects the reranker via `setReranker()` without pre-initializing it (`mcp-server/src/index.ts:140-145`), bypassing `RAGQueryService.createReranker()`'s guard that returns `null` on load failure (`ragQueryService.ts:459-473`). Net effect, verified live: **every `rag_query`, every strategy, fails**. All 839 unit tests pass because they stub this layer.

**Fix:** pass `dtype: "q8"` (or ship `model.onnx`); wrap `initialize()` inside `rerank()`'s degradation path (log once, return original order); wrap `rerankResults` calls in RAGAgent as defense-in-depth; add one integration test that runs a real query through the packaged model. Consider a `RAGNAROK_RERANKER_ENABLED=false` escape hatch (the design doc's Phase-1 exit criteria promised graceful failure).

### C2 — Memory store: first mutation after restart silently destroys the scope's data
`memoryVectorStore.ts:190-209` (`loadEntriesUnlocked`) maps `vector: row.vector as number[]` — but LanceDB returns Arrow `Vector` objects, not plain arrays. Any subsequent `saveEntries` on loaded entries fails `createTable` type inference (`"Failed to infer data type for field vector.isValid"`). Because `saveEntriesUnlocked` **drops the table before recreating it** (`memoryVectorStore.ts:165-166`), the failed save leaves the table deleted.

Live reproduction: store 2 memories → restart → store 1 more → tool returns the inference error, but `list` still shows 3 (the cache was mutated before persist, masking the failure) → restart → **0 memories**. The same defect fires on `forget` by id after `promote` (cache invalidation forces a disk reload). The author clearly knew about the Arrow pitfall — `knowledgeGraphStore.loadGraph` and `MemoryScopeLinker` both call `Array.from(...)` — but `memoryVectorStore.loadEntries`/`searchEntriesUnlocked` do not.

**Fix (three layers):**
1. Normalize on read: `vector: Array.from(row.vector)` in both `loadEntriesUnlocked` and `searchEntriesUnlocked` (and defensively in `saveEntriesUnlocked`).
2. Make persistence crash-safe: write to a temp table then swap (or use LanceDB delete+add / `mergeInsert`) instead of drop-then-create — this window also exists for the knowledge-graph store.
3. On persist failure, roll back / invalidate the in-memory cache so the API doesn't report success-shaped state it didn't durably store.
Add a restart-mutate-restart integration test; the existing "persistence" tests reload but never mutate after reload, which is exactly why this escaped.

### C3 — LangGraph ingestion is not atomic (carried from prior review; re-confirmed)
`indexingGraph.ts` stores vectors (`embedAndStore`) before optional entity extraction; a later `extractEntities`/`storeEntities` failure routes to `buildResult` with `success:false`. `topicManager.addDocuments` (`topicManager.ts:567`) then `continue`s — document metadata is never recorded, `chunksStored` is reported as 0 despite chunks being persisted, and a retry re-stores the same chunks (duplicate vectors, inflated counts).
**Fix:** treat extraction failure as a partial success (record the document, flag `graphExtracted:false`), or roll back stored chunks on failure. Prefer the former: the vectors are valid.

---

## 5. High-Priority Issues

### 5.1 Memory durability & concurrency model
- **Drop-then-create everywhere** (`memoryVectorStore`, `knowledgeGraphStore`): every save is a full-table rewrite with a data-loss window; write amplification is O(n) per store/forget/reinforcement flush.
- **In-process mutex only.** Two MCP server instances sharing a storage dir (e.g., Claude Desktop + Cursor each spawning `ragnarok-mcp` against `~/.ragnarok`) interleave whole-table rewrites — silent last-writer-wins data loss. No cross-process lock, no lock file, no doc warning. This is the *default* topology for MCP servers configured globally.

### 5.2 Docker/compose security defaults (carried; still open)
`docker-compose.yml` publishes port 4000 to the host with `RAGNAROK_API_KEY` defaulting to empty (auth disabled) and CORS `*`. The image runs as **root** (no `USER` directive) and copies the full `node_modules` including devDependencies (`npm ci` without `--omit=dev`) into the runtime stage. Fail closed: refuse `--http` on non-loopback binds without an API key (or generate one and log it), add `USER node`, prune dev deps.

### 5.3 `@ragnarok/core` npm package ships ~145 MB of model assets
`files: ["dist", "assets", ...]` includes the 90 MB `model.onnx`, two ~30 MB `tokenizer.json` files, and the 23 MB quantized reranker. Every `npm install @ragnarok/core` (and every Docker build layer) pays this. Standard practice: post-install/on-demand download with checksum (transformers.js already supports hub download + cache), or a separate optional `@ragnarok/models` package.

### 5.4 `memorize` node pollutes user memory on every LangGraph query
`queryGraph.ts:282-316` auto-stores "Query: …/Top result: …" into the **user's** memory store whenever confidence ≥ `memoryConfidenceThreshold`, whose default is **0.1** (i.e., nearly always; no host maps this config key, so the default always applies). Confirmed live: one query → one `query-insight` entry. Consequences: recall/list results mix auto-noise with user facts, each query triggers an LLM entity-extraction attempt (hidden cost/latency), and recalled auto-memories feed back into future planning context. Should be opt-in, scoped to a dedicated partition/tag filtered out of default recall, with a sane threshold.

### 5.5 "Checkpointing" is claimed but not wired
The VS Code setting text and README say the LangGraph pipeline runs "with checkpointing". `LanceDBCheckpointer` (422 lines + tests) is dead production code: no host constructs it; `executeIndexingGraph`/`executeQueryGraph` are never given a checkpointer or `thread_id`. Either wire it (construct in hosts, pass thread IDs, prove resume-after-crash in a test — note checkpointing every superstep will serialize all loaded docs/chunks into LanceDB, so measure) or delete it and fix the copy. Shipping tested-but-unwired persistence machinery is maintenance debt.

---

## 6. Medium-Priority Issues

1. **HTTP sessions never expire** (`httpServer.ts`): abandoned sessions (no `DELETE /mcp`) leak a `McpServer`+transport pair each, forever. Add idle TTL reaping and a max-session cap. Rate limit (100/min) is hardcoded.
2. **Security middleware is best-effort**: `cors` and `express-rate-limit` are dynamic-imported *transitive* deps of the MCP SDK; if the SDK drops them they silently no-op (warn only). Declare them as direct dependencies; fail closed when auth is enabled.
3. **`forgetById` persists entries but not the graph** (`memoryStore.ts:815-841`): `cleanupOrphanedEntities` mutates the entity graph, but unlike `forgetByFilter`/`forgetExpired` there is no `persistGraph` call — orphan removal is lost on restart; stale entities resurrect with dangling `sourceMemoryIds`.
4. **topK validation mismatch**: MCP config accepts `RAGNAROK_TOP_K` up to 50 (`config.ts:77`), but `RAGQueryService.executeQueryLegacy` throws for topK > 20 (`ragQueryService.ts:189`). Setting 21–50 passes startup validation and then fails **every** query. Align the bounds (and the LangGraph path validates nothing — make both paths share one validator).
5. **Memory TTL is dead code**: `expiresAt` is honored by the decay engine but no API (StoreOptions, MCP tool) can set it. Either expose `ttlDays` on store or remove the field.
6. **`links` action scope bug**: `tools.ts:1022` passes raw `"branch"` when scope=branch without a name; `parseScope` treats any string not starting with `branch:` as **workspace**, so results are computed for the wrong source and mislabeled. (Also: `promote` overloads the single-`id` schema field as a comma-separated list — make it `ids: string[]`.)
7. **ESLint gate OOMs** (see §3) — nobody can currently run `npm run lint` to completion on a default heap; CI presumably fails or was never run. Scope the type-aware config (exclude `dist-test`, assets, benchmarks) or lint per package.
8. **`agenticMetadata.steps[].resultsCount` is always 0** (`ragQueryService.ts:236`): it filters on `document.metadata.subQueryIndex`, which no retrieval path sets (verified live). Track counts per sub-query during retrieval instead.
9. **Graph-strategy score semantics**: `GraphRetriever.search` already blends vector results into "graph" scores (50/50 overlap boost, 0.8× fallbacks), and `GraphHybridRetriever` then fuses *that* with vector again at 70/30 — the documented weights don't describe the actual mixture. Also candidate keys mix `metadata.chunkId` raw (number) with stringified forms across the two retrievers; normalize via one `getChunkId`.
10. **GraphRetriever chunk-document map staleness**: the full-table snapshot (up to 50k docs) is cached per retriever instance and never invalidated on ingestion; graph hits for newly added chunks can't hydrate until the agent cache is cleared. (Mitigated today because `TopicManager` clears agent caches on addDocuments — document this coupling or invalidate explicitly.)
11. **Reranker over-fetch vs cap mismatch**: sub-queries over-fetch `topK×multiplier` capped at 50 (`ragAgent.ts:514`), but the reranker slices to `maxCandidates` (default 20) — 30 candidates are retrieved, ranked, then unconditionally discarded. Align the two (fetch ≤ maxCandidates) or raise maxCandidates.
12. **LLM provider `isAvailable()` semantics**: OpenAI/Ollama do a `models.list` network round-trip **per call** — and `MemoryEntityExtractor.extract` calls it on every memory store (hidden latency); Anthropic's returns true without validating anything. Cache availability with a TTL and unify semantics.

---

## 7. Missing Features / Requirement Gaps

1. **MCP API is create-only.** No `rag_delete_topic`, no document removal, no rename/export/import. Stores grow unboundedly with no remote way to clean up — operationally painful for a server whose whole point is remote management. (VS Code has all of these.)
2. **No GitHub/web ingestion via MCP** although core ships `githubLoader`/`webLoader`. A `rag_add_github_repo` / `rag_add_url` tool (with SSRF-conscious allowlisting) is the obvious next tool.
3. **Memory is invisible in VS Code.** `packages/vscode` has zero references to `MemoryStore`: no memory UI, no ragTool episode capture (design doc Phase 4 F2/F4 dropped), and with `langGraphEnabled` the query graph's memory nodes silently no-op. Either wire it or update README/ARCHITECTURE, which currently present memory as a product feature rather than an MCP-only one.
4. **Graph retrieval is only reachable via the experimental flag.** The knowledge graph is built exclusively inside the LangGraph indexing path, which requires `langGraphEnabled` **and** an LLM provider; `graph`/`graph_hybrid` on normally-ingested topics quietly degrade to vector search. README's Knowledge Graph section doesn't say this; users will select `graph` and unknowingly get vector results. Add a "graph unavailable — fell back" signal in query responses (the data exists: `matchedEntities`/`hopDepth`).
5. **Design-doc items silently dropped:** remote reranker (reranking doc Phase 3), reranker enable/disable config, cross-topic memory links table, episodes/`classifyMemoryType` (implemented in `EntityExtractor` but never called), memory boosting in `rankResults` (Phase 4 D1), scheduled forgetting (no host passes `autoDecayIntervalMs`; `decay` action is report-only — fine, but the plan's automatic hygiene loop doesn't exist). Update the docs to reflect reality or track these as roadmap items.
6. **Doc drift:** root README's MCP tool table lists 10 of 13 tools (reranker tools missing); MCP README says `RAGNAROK_TOP_K` default 5, code says 10; ARCHITECTURE's query-flow diagram says hybrid is 70/30 while the implementation and README say 90/10; README "Iterative Refinement" describes the legacy loop, not the LangGraph one.

---

## 8. Suboptimal / Could Be Done Better

- **LangGraph refinement is a stub compared to the legacy path.** `refine` appends literal strings ("… overview context", "… summary") whereas the procedural `RAGAgent` does LLM gap analysis and follow-up generation. Live run: a 2-doc corpus with a 0.999-scoring top hit still burned all 3 iterations, because early iterations average sub-threshold raw retrieval scores while later iterations average reranker sigmoid scores over accumulated duplicates — three different score scales feeding one `confidenceThreshold`. Reuse the legacy gap-analysis in the refine node and compute confidence on deduplicated, consistently-scaled scores.
- **Whole-scope table rewrites for 2-counter updates**: recall reinforcement rewrites every row+vector of a scope (debounced, but still O(n) per flush). LanceDB supports `update`/`mergeInsert` — use row-level updates.
- **`GitBranchDetector` uses `execSync`** on query/store paths (5 s cache mitigates; still a ≤3 s event-loop stall risk in a server). Use async exec or read `.git/HEAD` directly.
- **Entity source-chunk attribution is O(entities × chunks) substring scanning** (`knowledgeGraphAssembly.ts`), and entities whose extracted name doesn't literally appear in chunk text get no `sourceChunkIds` — unreachable via graph retrieval. Pass per-chunk extraction provenance through instead of re-scanning.
- **`KnowledgeGraphStore` reconnects per operation** (`connect()` in every method) while `MemoryVectorStore` memoizes — unify on the memoized pattern.
- **Duplicate-memory versioning uses one global cosine threshold (0.92)**: a *contradicting* fact phrased similarly supersedes the old one silently, while recall never surfaces superseded content. Reasonable default, but expose the threshold and consider LLM-assisted contradiction checks when a provider exists (the `contradicts`/`updates` relationship types already exist).
- **Entity/memory score scales are mixed in recall** when `includeEntities: true`: entries use `1/(1+L2)`, entities use raw cosine, and linked entities get a hardcoded 0.5 — three scales in one ranked payload.
- **`switchModel`/`dispose` null out ONNX sessions without disposing them** — WASM memory is only reclaimed by GC luck; transformers.js sessions have explicit `dispose()`.
- **Anthropic default model string (`claude-sonnet-4-20250514`) is dated**; make the per-provider defaults config-file driven so they age better.

---

## 9. What's Done Well (keep this)

- **The extraction of `@ragnarok/core` is real**, not cosmetic: the MCP server is a thin adapter, and the same `RAGQueryService` verifiably drives both hosts.
- **stdio protocol hygiene**: every log path (logger, notifier, progress) goes to stderr; verified no stdout corruption in live runs.
- **Config validation is exemplary** (`config.ts`): zod with cross-field rules, fail-fast messages. The `rag_add_documents` allowlist does realpath containment (symlink-safe) and per-file outcome reporting — verified blocking `/etc/hosts` live.
- **Thoughtful concurrency fixes with explanatory comments**: single-flight cache loads, debounced markdown/reinforcement flushes, LRU agent cache with true promotion, memoized DB connection, backtick-quoted Lance identifiers, base64url branch encoding (verified round-trip live with `feature/memory-test`).
- **Dimension-mismatch protection on model switch** (probe + rollback for memory; per-topic model metadata for topics) is a class of bug most projects discover in production.
- **Test discipline is genuinely high for unit scope** — 839 green tests, persistence/restart cases, race-condition regressions. The gap (and the lesson of this review) is purely the absence of one *real-binary, real-model, real-storage* integration pass, which caught both critical bugs immediately.

---

## 10. Prioritized Recommendations

**P0 — before merge:**
1. Fix C1 (dtype/q8 + graceful reranker degradation at all three layers) and C2 (Array.from on read + crash-safe table swap + cache rollback on failed persist).
2. Add a CI integration job that runs the packaged server binary with the bundled models against a temp storage dir: create topic → add docs → query each strategy → memory store/recall → restart → mutate → restart → assert. (The review harness in the session scratchpad is a ready template.)
3. Fix C3 (record document metadata when vectors committed; never re-store on retry).

**P1 — before release:**
4. Harden Docker/compose defaults (fail closed without API key on non-loopback, `USER node`, `--omit=dev`).
5. Decide the checkpointing story (wire it or remove it + fix copy).
6. Gate/rework the `memorize` node (opt-in, separate partition, real threshold).
7. Cross-process safety: at minimum a lock file + documented single-instance constraint for shared storage dirs.
8. Fix the topK 20-vs-50 mismatch and the `forgetById` graph persistence gap.
9. Un-break `npm run lint` (scope type-aware config) and wire it into CI.

**P2 — quality/roadmap:**
10. Move model binaries out of the npm package (download-on-demand).
11. MCP tool completeness: delete topic/document, GitHub/web ingestion, session TTLs, configurable rate limit.
12. LangGraph refinement parity with the legacy loop; consistent confidence scaling.
13. Reconcile docs (tool tables, defaults, weights, memory's VS Code status, graph-strategy prerequisites).
14. Memory recall ranking: incorporate effective confidence/decay; expose TTL; unify score scales.

---

## Appendix A — Integration test matrix (final runs)

| Scenario | Default config | Loadable reranker |
|---|---|---|
| listTools (13 tools) | ✅ | ✅ |
| create topic / add 3 docs / allowlist block | ✅ | ✅ |
| query: hybrid, vector, bm25, ensemble, graph, graph_hybrid | ❌ all (C1) | ✅ all |
| relevance sanity (reranked top doc) | ❌ | ✅ |
| semantic topic match / empty-topic handling | ❌ / ✅ | ✅ / ✅ |
| topic stats / list / embedding info / llm status / reranker tools | ✅ (reranker "unavailable") | ✅ |
| memory: store ws + branch(auto-detect) + near-dup version chain | ✅ | ✅ |
| memory: recall (ws + branch), list, stats, history, decay, links, promote | ✅ | ✅ |
| memory: forget by id (after promote) | ❌ crash (C2) | ❌ crash (C2) |
| memories.md export | ✅ | ✅ |
| restart: topics + query persist | ✅ | ✅ |
| restart: memory persists after mutation | ❌ **total loss** (C2) | ❌ **total loss** (C2) |
| stdin-EOF → clean exit (no orphan) | ✅ | ✅ |
| HTTP: health, 401 enforcement, session, query, SIGTERM | — | ✅ 7/7 |
| LangGraph: indexing, query, memorize side-effect | — | ✅ works / ⚠️ pollution confirmed |

## Appendix B — Cross-check against prior in-repo reviews

Of the prior reports' headline items: stdout hygiene, npm pack repair, empty-collection persistence, branch-name collisions, provider routing, and MCP input validation were **fixed and verified**. Still open at this head: LangGraph ingestion atomicity (C3), unwired checkpointer (§5.5), docker-compose defaults (§5.2). Newly found here and absent from all five prior reports: **C1, C2**, memorize-node pollution, topK bound mismatch, TTL dead code, `links` scope bug, session leak, lint OOM, `resultsCount` always 0.
