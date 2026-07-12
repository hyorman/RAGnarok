# MCP, Knowledge Graph, and Memory Implementation Review

Date: 2026-07-10  
Branch: `mcp-server`  
Review target: staged changes relative to `HEAD` (136 files; ~25,557 additions / 2,467 deletions)

## Executive summary

The implementation is substantial and generally well structured: the core package owns reusable retrieval/memory logic, the MCP package is mostly an adapter layer, the MCP tools have broad unit coverage, and the core test suite passes. The branch is **not ready to merge or publish**, however. There are persistence correctness bugs in memory deletion/decay, branch-scope identity collisions, a graph-promotion consistency problem, missing runtime lifecycle handling, weak configuration/input validation, and failing lint/format gates.

The highest-risk defects are broken published npm artifacts, stdout corruption in MCP stdio mode, silent data resurrection after restart, and incomplete/dead knowledge-graph wiring. These are not caught by the current tests because the suites run against the monorepo source/build layout, call tool handlers in-process, and mostly assert against the same live memory cache rather than packed artifacts, a real stdio client, or a freshly reloaded store.

## Verification performed

- TypeScript build: passed for `core`, `vscode`, and `mcp-server`.
- Core tests: **668 passing, 20 pending** (benchmark suites intentionally gated by environment flags).
- MCP tests: **131 passing**.
- VS Code extension tests: **24 passing**.
- Full `test:all`: passed end to end, but downloaded VS Code 1.128.0 (272 MB), so this remains an environment/network-heavy CI path.
- ESLint: **failed** with 1 error and 100 warnings. Blocking error: forbidden CommonJS `require()` in `packages/vscode/src/vscodeLmBackend.ts:23`.
- Prettier: **failed**; 81 files reported formatting differences.
- `git diff --cached --check`: failed due to an extra blank line at EOF in `packages/vscode/src/ragTool.ts:160`.
- Bundled reranker model was inspected and is a real ~22 MB ONNX file, not a broken pointer.
- Second pass: packed both npm workspaces with `npm pack` and inspected/executed the exact tarball contents.
- No commit was created.

## Second-pass release blockers and new findings

### P0 — Both published npm packages are missing required runtime JavaScript

This was reproduced using `npm pack --workspace=packages/core` and `npm pack --workspace=packages/mcp-server`, followed by inspection of the exact tarballs. The core tarball contains only `dist/index.js`; every other compiled runtime `.js` file imported by it is absent. Requiring the packed core fails immediately with `Cannot find module './interfaces'`. The MCP tarball likewise contains only `dist/index.js`, while `./config`, `./adapters`, `./tools`, `./llmProviders`, and `./httpServer` are absent.

The cause is the repository `.gitignore`, which ignores `dist/`, `*.js`, and `*.js.map` (`.gitignore:1-7`), combined with packages that have neither a `files` allowlist nor package-level `.npmignore`. npm force-includes the declared `main` file and type declarations, but not the other runtime JavaScript. The tarballs also unnecessarily include `src/`, tests, test configuration, Docker files, and stale build declarations.

Add explicit `files` allowlists (normally `dist`, README, LICENSE, and intentionally bundled assets), clean before build, and a `prepack` script. Make CI pack each workspace, install the tarballs into a clean temporary consumer, require `@ragnarok/core`, and launch the installed `ragnarok-mcp` binary. Publication must remain blocked until this passes.

### P0 — Console logging corrupts MCP stdio protocol output

`StdioServerTransport` owns stdout, but the MCP adapters write info/debug/progress output through `console.log` and `console.debug` (`packages/mcp-server/src/adapters.ts:47-52`, `73-90`). Startup invokes these paths before and after connecting the transport (`packages/mcp-server/src/index.ts`). Model download progress and tool-time notifications also write stdout. Any such text is interleaved with JSON-RPC frames and can make stdio clients reject or disconnect from the server.

Route every diagnostic/progress message to stderr in stdio mode, or inject a transport-aware logger whose stdout is disabled. Add an actual child-process MCP test that launches the built/packed binary with `StdioClientTransport`, completes initialization, lists tools, calls a tool, and asserts that no non-protocol stdout is emitted.

### P1 — OpenAI is routed to Ollama by default

`loadConfig()` gives `llmBaseUrl` the unconditional default `http://localhost:11434` (`packages/mcp-server/src/config.ts:49`). The OpenAI factory then passes every truthy `llmBaseUrl` into the OpenAI SDK (`packages/mcp-server/src/llmProviders.ts:281-284`). Therefore setting only `RAGNAROK_LLM_PROVIDER=openai` plus an API key sends OpenAI model/chat requests to local Ollama instead of OpenAI.

Use provider-specific base URLs: undefined/default SDK endpoint for OpenAI, `http://localhost:11434` for Ollama, and an explicit optional OpenAI-compatible override. Add a factory test that inspects the constructed OpenAI client configuration rather than merely checking `instanceof`.

### P1 — Topic knowledge graphs are not built by production ingestion

There are two partial ingestion paths, but neither completes the production wiring:

- `DocumentPipeline.setKnowledgeGraph()` enables extraction, yet has no production caller. Even if called, the pipeline mutates the in-memory graph but does not persist it.
- `executeIndexingGraph()` persists a graph, but is only exported and unit-tested; no MCP, VS Code, `TopicManager`, or `DocumentPipeline` path invokes it.

As a result, ordinary `rag_add_documents`/VS Code ingestion creates vector chunks but no topic graph. The exposed `graph` and `graph_hybrid` strategies normally fall back to vector retrieval. This is separate from standalone `rag_memory`, whose own entity graph is reachable when an LLM is configured.

Choose one ingestion implementation, wire it through `TopicManager.addDocuments`, and add an end-to-end test: create topic, ingest a real document with deterministic extraction, restart/reload, assert `KnowledgeGraphStore.hasGraph()`, then query with `graph` and prove a graph-derived hit.

### P1 — Persisted chunks lose the identifiers and location metadata graph retrieval needs

`VectorStoreFactory.normalizeDocumentMetadata()` allowlists metadata but omits `chunkId`, `startPosition`, `endPosition`, `headingPath`, and `sectionTitle` (`packages/core/src/stores/vectorStoreFactory.ts:441-487`). It explicitly suppresses a warning for dropping `chunkId` without copying it. It also converts `loc` to `loc_lines_from`/`loc_lines_to`, while `RAGQueryService` reads `metadata.loc.lines` or the dropped start/end fields (`packages/core/src/agents/ragQueryService.ts:191-201`).

Consequences:

- graph entities point at chunk IDs that do not exist on persisted documents;
- `GraphRetriever` cannot hydrate graph-derived chunks;
- chunk-based deduplication degrades to content heuristics;
- API position metadata commonly becomes `chars 0-0` and headings disappear.

Preserve a stable scalar `chunkId` plus the scalar location/heading fields expected by readers, and add a real LanceDB round-trip test rather than graph tests that inject mock documents already containing `chunkId`.

### P1 — The MCP decay workflow tells users to perform an impossible operation

The `decay` response says to use `forget` to remove expired entries (`packages/mcp-server/src/tools.ts:818-837`), and `MemoryStore.forget()` supports `{ expired: true }`. However, the MCP schema has no `expired` field and the handler never passes it (`tools.ts:593-637`, `747-753`). Calling `forget` without an ID/age filter removes nothing, so expired entries cannot be purged through the public tool.

Expose a validated `expired` boolean or a dedicated `purge_expired` action, require explicit confirmation semantics for bulk deletion, and add a persistence-reload test after the purge.

### P1 — MCP embedding switching is disconnected from topic management and can corrupt memory

`rag_switch_embedding_model` only calls `embeddingService.initialize(model)`. Unlike the VS Code configuration-change path, it never calls `TopicManager.reinitializeWithNewModel()` or updates the config/factory. The `VectorStoreFactory` retains the old model and a later topic operation can switch the shared backend back to that stored model, making the reported switch transient. Meanwhile, standalone memory immediately uses the new model against tables that contain vectors from the old model/dimension.

Make model switching a coordinated service operation: validate existing topic/memory compatibility, update durable configuration and factories, clear dependent caches/rerankers, and either migrate/re-embed memory or reject the switch while incompatible data exists.

### P1 — Superseded memory versions can crowd current memories out of recall

`MemoryVectorStore.searchEntries()` applies `.limit(topK)` before `MemoryStore.recall()` filters `entry.isLatest === false` (`packages/core/src/memory/memoryVectorStore.ts:148-174`; `memoryStore.ts:231-259`). A query close to several historical versions can fill the database top-K with superseded rows; filtering afterward returns fewer than requested or even no current result although matching current memories exist outside the database limit.

Filter `isLatest` at query time before limiting, or store current/history separately. Add a test with more than `topK` historical versions whose vectors are closer than the latest entry.

### P1 — One failed HuggingFace load permanently bricks the backend instance

After model initialization exhausts retries, `HuggingFaceBackend` stores `initError`; every future initialization immediately rethrows it (`packages/core/src/embeddings/huggingFaceBackend.ts:219-252`). `dispose()` does not clear `initError` (`lines 191-198`). This also defeats the advertised fallback in `initialize()`: after the requested model fails, initializing the fallback hits the cached error before trying it.

Clear or scope the cached failure by target model, reset it on dispose/switch, and test failure of model A followed by successful fallback/model B initialization.

### P2 — IndexingGraph reprocesses documents and has unsafe shared invocation state

The graph loads and chunks files, then `embedAndStore` calls `TopicManager.addDocuments()` with the original paths, causing a second full load/chunk pass (`packages/core/src/agents/indexingGraph.ts:111-143`). Entity extraction uses the first pass with a default `SemanticChunker`, whereas persistence uses configured pipeline options in the second pass; entity `sourceChunkIds` can therefore disagree with stored chunks.

Additionally, `createIndexingGraph()` keeps `loadedDocs`, `chunks`, and extraction results in one closure (`lines 39-49`, `304-328`). Reusing or concurrently invoking a compiled graph shares this mutable bag. A failed later load does not clear prior documents, so stale data can flow into the next run. Put intermediate data in LangGraph state, reset per invocation, and route failures around dependent nodes instead of continuing through chunk/store after load failure.

### P2 — LangGraph functionality is present but effectively unreachable and ignores cancellation

The query path checks `CONFIG.LANGGRAPH_ENABLED`, but MCP config has no environment field/mapping for it and VS Code contributes no setting. The indexing graph has no caller at all. The documentation still calls LangGraph “reserved for future integration.” Also, `RAGQueryService.executeViaGraph()` accepts an `AbortSignal` but does not pass it into `executeQueryGraph`, so cancellation supported by the legacy path is lost when graph mode is eventually enabled.

Either finish and expose the feature flag with cancellation/checkpoint lifecycle tests, or remove the half-active code from the release surface until it is wired.

### P2 — Branch auto-detection uses the server process directory, not an explicit project root

The MCP server constructs `MemoryStore` with `workingDir: process.cwd()` (`packages/mcp-server/src/index.ts`). Global MCP clients frequently launch servers from a home/application directory rather than the repository being discussed. In that case branch-scoped stores silently fall back to workspace scope, or associate memory with the wrong repository.

Add `RAGNAROK_WORKING_DIR`/workspace identity configuration, expose the resolved workspace/branch in status, and avoid silent fallback for an explicitly requested branch scope.

### P2 — Partial/failed ingestion is reported as full success

`TopicManager.addDocuments()` catches per-file failures and only returns successful results. `rag_add_documents` nevertheless sets `success: true` and `documentsAdded: filePaths.length`, not `results.length` (`packages/mcp-server/src/tools.ts:245-263`). The indexing graph similarly treats an empty resolved result as a successful storage stage. Return per-file success/error records and derive aggregate status/counts from actual outcomes.

### P2 — Distribution/docs/API inconsistencies

- The package is named `@ragnarok/mcp-server`, but docs recommend `npx ragnarok-mcp`, which resolves a package name rather than this package's bin in a clean environment. Document a correct scoped-package invocation/install flow.
- MCP README says nine tools and omits memory/reranker actions; actual registration is larger. It also documents port 3000 in Docker examples while Compose exposes 4000 by default.
- HTTP health resolves `../../package.json` from `dist/httpServer.js`, which points to `packages/package.json`, so version commonly reports `unknown`; use `../package.json` or an injected build constant.
- `DEFAULT_ENTITY_EXTRACTOR_OPTIONS` is a runtime constant but is re-exported with `export type`, so it is absent from the core runtime API.
- Remote embedding mode still lists the local curated HuggingFace registry rather than calling the registered remote backend's `listModels()`.
- The packed core contains stale declarations from previously removed/moved modules because builds do not clean `dist` before emitting.

## Critical / high-severity findings

### P0 — Deleting the last memory in a scope is not persisted

`MemoryStore.persistEntries()` only calls the vector store when `entries.length > 0` (`packages/core/src/memory/memoryStore.ts:602-607`). `MemoryVectorStore.saveEntries()` independently returns immediately for an empty list (`packages/core/src/memory/memoryVectorStore.ts:53-56`). Consequently, forgetting the final entry removes it only from the live cache; the old LanceDB table remains and the memory returns after process restart.

This affects `forgetById`, age-based forgetting, and expiry cleanup. Fix by making an empty save drop the relevant table (or add an explicit `deleteEntriesTable` operation), and add restart-oriented tests: store one entry, forget it, create a new `MemoryStore`, and assert list/recall are empty.

### P0 — Removing the last graph entity/edge leaves stale graph data on disk

`MemoryVectorStore.saveGraph()` only replaces entity and edge tables when their new arrays are non-empty (`packages/core/src/memory/memoryVectorStore.ts:183-243`). If cleanup removes the final entity or final relationship, the old table is never dropped. After restart, forgotten entities/relationships reappear, possibly referencing deleted memories.

Always reconcile both tables: drop the existing table first, then recreate only when rows exist. Add reload tests for emptying entities, emptying edges while retaining entities, and deleting the last memory with extracted entities.

### P1 — Branch table naming is lossy and collision-prone

Branch names are converted by replacing all non `[A-Za-z0-9_-]` characters with `_` (`packages/core/src/memory/memoryVectorStore.ts:47-48`). This makes distinct branches such as `feature/foo`, `feature_foo`, and `feature@foo` share the same tables. It can leak or overwrite memory across branches. `listBranches()` also returns sanitized identifiers rather than original branch names (`memoryVectorStore.ts:308-321`), breaking round-trip identity.

Use a reversible encoding (base64url) or a stable hash plus stored original branch metadata. Detect/migrate existing sanitized tables.

### P1 — Promotion copies entries but not their knowledge graph

`MemoryScopeLinker.promoteToWorkspace()` copies memory rows and keeps their existing `entityIds`, but it does not copy/merge the corresponding branch entities or relationships into the workspace graph (`packages/core/src/memory/memoryScopeLinker.ts:69-131`). Promoted entries can therefore reference entity IDs absent from the workspace graph; `includeEntities` recall and markdown output become incomplete/inconsistent.

Promotion should atomically merge entries, entities, relationships, and source-memory references, remapping IDs where deduplication occurs. Alternatively, clear `entityIds` and re-extract entities, though that loses graph fidelity and costs LLM calls.

### P1 — MCP server shutdown does not dispose resources or close transport/server

The memory store can own an interval (`MemoryStore.dispose()`), the query service/reranker owns native/model resources, and HTTP transport/server need closing, but `packages/mcp-server/src/index.ts` installs no `SIGINT`/`SIGTERM` cleanup. `httpServer.ts` claims graceful shutdown in its header but implements none. This risks hanging processes, corrupt/incomplete writes during container shutdown, and leaked native resources in tests/embedders.

Centralize ownership and install idempotent shutdown handlers that close the transport/server and dispose `MemoryStore`, `RAGQueryService`, reranker, and embedding/model resources.

## Medium-severity findings

### P2 — Recall mutates access counters but returns stale values

`MemoryVectorStore.searchEntries()` creates detached entry objects. `MemoryStore.recall()` increments matching cached objects and persists them (`memoryStore.ts:195-211`), but returns the detached search objects. The response therefore reports pre-increment `accessCount`/`lastAccessedAt`, while storage contains new values. Return the updated cached entry or update both instances.

### P2 — Read errors are silently converted into “no data”

`loadEntries()` and `searchEntries()` log and return empty arrays on any exception (`memoryVectorStore.ts:94-130`, `133-178`); `loadGraph()` similarly returns `null`. Corrupt JSON, schema incompatibility, dimension mismatch, and I/O failures are indistinguishable from an empty store. This can cause subsequent saves to overwrite recoverable data.

Only treat explicit table-not-found as empty. Propagate corruption/schema/I/O errors with context, and introduce a schema version/migration strategy.

### P2 — Configuration is parsed but not validated

`loadConfig()` accepts `NaN`, negative values, invalid strategies/providers, out-of-range thresholds, invalid ports, and arbitrary CORS/log strings (`packages/mcp-server/src/config.ts`). Some values fail much later; others create unsafe or confusing behavior. Validate once at startup with Zod, including cross-field requirements for provider URLs/API keys.

### P2 — MCP numeric schemas allow invalid or abusive values

Tool fields such as `topK`, `olderThan`, and `limit` use unconstrained `z.number()` (`packages/mcp-server/src/tools.ts:605-636`). Negative `olderThan` has surprising deletion semantics; huge limits/topK can create excessive work; floats are accepted where integers are expected. Apply `.int().min(...).max(...)`, trim/nonempty strings, cap tag count/content sizes, and validate branch names.

### P2 — Embedding model switching does not protect existing indexes/memory vectors

`rag_switch_embedding_model` switches the shared embedding service immediately. Existing topic and memory vectors may have a different dimension/model. Topic indexing has some model checks, but standalone memory tables have no model/dimension metadata or migration guard. Recall can then fail and be silently reported as no matches because search errors are swallowed.

Persist embedding model/dimension per memory scope, reject incompatible switching while data exists, or support explicit re-embedding/migration.

### P2 — Reranker wiring is duplicated and misleading

`index.ts` constructs a `CrossEncoderReranker` and passes it to MCP management tools, while `RAGQueryService` independently lazily constructs its own reranker (`ragQueryService.ts:402-425`). Switching via `rag_switch_reranker_model` changes the management instance, not necessarily the instance used for queries. Thus the tool may report success without changing query behavior.

Inject one shared reranker into `RAGQueryService` and tool registration, or expose switching through the service that owns it.

### P2 — Server version is inconsistent/hard-coded

The MCP protocol server advertises version `0.3.0` in `packages/mcp-server/src/index.ts`, while packages are `0.4.0`. HTTP health tries to find `../../package.json` relative to compiled output (`httpServer.ts:59-69`), which is packaging-layout sensitive and may report `unknown`. Use a generated/shared package version constant.

### P2 — HTTP transport architecture needs multi-client/session verification

One stateful `StreamableHTTPServerTransport` is created and connected once for all requests (`httpServer.ts:95-107`). Verify this against the SDK's session semantics under concurrent clients; typically stateful HTTP examples maintain transports keyed by session ID or intentionally run stateless transports. Add tests with two independent clients, invalid/expired session IDs, DELETE session termination, and concurrent requests.

### P2 — Path validation is not a meaningful authorization boundary

`rag_add_documents` rejects explicit `..` segments but permits any normalized absolute path. A remote authenticated MCP client can request arbitrary readable server files. If this is intentional, document the capability prominently. Otherwise restrict paths to configured allowlisted roots and resolve symlinks before containment checks.

## Lower-severity / maintainability findings

- `MemoryStore.store()` rewrites the entire scope table on every store, recall-counter update, decay cycle, and delete. This is O(n) write amplification and introduces race/lost-update risk under concurrent MCP calls. Prefer row-level operations or serialize mutations per scope with a mutex/transaction strategy.
- Markdown regeneration is fire-and-forget after every mutation. Concurrent writes can finish out of order, producing stale `memories.md`. Debounce/serialize export and flush it during shutdown.
- Duplicate detection is a linear scan over every cached vector. Use LanceDB nearest-neighbor search with a similarity check, especially as memory grows.
- `list()` and `stats()` load up to 100,000 rows into memory per scope. Pagination and database-side aggregation are needed for sustained use.
- Graph/community metadata is not faithfully persisted by `KnowledgeGraphStore`; load fabricates timestamps/model metadata and resets communities (`packages/core/src/stores/knowledgeGraphStore.ts:153-165`). Persist metadata or clearly make it derived and recompute it.
- The HTTP health endpoint is intentionally unauthenticated and CORS defaults to `*`. Binding to loopback mitigates the default case, but production/container docs should require explicit host, API key, and restrictive origin configuration.
- The all-tests command downloads a 272 MB VS Code build, making local/CI feedback slow and network-dependent. Split fast unit/integration gates from opt-in VS Code E2E tests and cache the downloaded runtime.
- The branch contains multiple generated/review documents and large benchmark suites alongside product functionality. Consider splitting into smaller reviewable commits/PRs (without changing history in this working review) to isolate MCP, memory, graph retrieval, reranking, VS Code refactor, benchmarks, and docs.

## Test gaps to add before merge

1. Persistence reload tests after deleting the final entry/entity/edge.
2. Collision tests for `feature/foo` versus `feature_foo` and preservation of original branch names.
3. Promotion integration test proving graph entities/relationships remain resolvable after restart.
4. Concurrent store/recall/forget tests for a single scope and multiple scopes.
5. Embedding-model dimension change test for memory recall.
6. Corrupt row/invalid JSON/schema-version tests that assert hard failure rather than empty results.
7. MCP end-to-end stdio test launching the built binary and executing initialize/listTools/callTool.
8. HTTP tests with two independent sessions, authentication, termination, malformed bodies, request size limits, and graceful shutdown.
9. Startup configuration validation tests for every numeric enum/range and provider combination.
10. Tool boundary tests for empty/whitespace content, negative/float/huge numeric inputs, oversized content/tags, and unauthorized file paths.

## Recommended fix order

1. Repair npm package contents and add clean-consumer tarball smoke tests.
2. Make stdio protocol-safe by moving all diagnostics/progress off stdout; add a real child-process MCP test.
3. Fix empty-table persistence for entries and graphs; add restart regression tests.
4. Wire one real topic-graph ingestion path and preserve `chunkId`/location metadata through LanceDB.
5. Fix provider/model lifecycle: OpenAI base URL, coordinated MCP embedding switching, HuggingFace error recovery, and shared reranker ownership.
6. Replace lossy branch naming, configure an explicit MCP workspace root, and define migration behavior.
7. Make memory promotion graph-consistent and expose a working expired-memory purge.
8. Add startup/tool input validation, accurate partial-ingestion results, and stop swallowing persistence errors.
9. Implement lifecycle shutdown and concurrent HTTP/session/state-mutation tests.
10. Make lint, formatting, `diff --check`, docs, and packed public API checks green.
11. Add concurrency/performance safeguards and split fast versus heavyweight test commands.

## Merge recommendation

**Do not merge or publish in the current state.** The architecture is promising and the unit suite is broad, but the npm artifacts are non-runnable, stdio output is protocol-unsafe, P0 persistence bugs can resurrect deleted memory, and production ingestion does not create usable topic graphs. After the release blockers and the first nine fix-order items are addressed with packed-binary, restart, graph round-trip, and session tests, the branch should be reassessed for release readiness.
