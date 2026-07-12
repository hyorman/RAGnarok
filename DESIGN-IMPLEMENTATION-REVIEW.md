# Branch Design and Implementation Review

**Branch:** `mcp-server`  
**Baseline:** `main` (`f138eefd6faca3376952470850887af282cd1548`)  
**Reviewed head:** `0baa405`  
**Review date:** 2026-07-11

## Executive summary

This branch is a release-sized expansion rather than a narrow MCP addition. It changes 221 files and introduces a three-workspace monorepo, a portable core package, a VS Code adapter, an MCP server with stdio and HTTP transports, remote embeddings, cross-encoder reranking, a knowledge graph, standalone memory, optional LangGraph pipelines, packaging automation, and benchmark infrastructure.

The architecture is directionally strong. In particular, extracting platform-neutral behavior into `@ragnarok/core`, using explicit host interfaces, sharing `RAGQueryService` between VS Code and MCP, keeping stdio diagnostics off stdout, and testing persistence/restart behavior are good decisions. The current automated suite is broad and passes.

The branch is not yet ready for an unqualified production release. Three issues should be resolved before merge/release:

1. LangGraph ingestion is not atomic: vector storage commits before optional graph extraction, but a later graph failure marks the whole document failed and skips document metadata. Retrying can duplicate vectors and counts.
2. The product says LangGraph runs “with checkpointing,” but neither production host constructs a checkpointer or supplies thread IDs. The persistence implementation is exported and tested but unused in production.
3. Docker Compose publishes the HTTP server on all interfaces with authentication disabled and CORS `*` by default.

Recommendation: **approve the architecture, but hold production merge/release until P1 items are fixed and covered by integration tests.** Experimental merge behind flags is reasonable only if the Docker default is also hardened and the limitations are documented.

## Scope and method

Reviewed:

- all committed changes in `main...HEAD`;
- production code in `packages/core`, `packages/mcp-server`, and `packages/vscode`;
- build, package, Docker, configuration, and documentation changes;
- tests and benchmark harnesses;
- four existing untracked review reports in the workspace, with their claims rechecked against current code. Those reports were preserved and not modified.

The diff contains **116,936 insertions and 9,969 deletions**. Large model/tokenizer assets dominate the raw line count; production TypeScript is approximately 23K lines across the three packages and scripts.

## Implemented design

### Package boundaries

```text
VS Code extension ─┐
                   ├─> @ragnarok/core ─> embeddings / LanceDB / retrievers
MCP stdio + HTTP ──┘                    ├> knowledge graph / memory
                                        └> RAGAgent / optional LangGraph
```

- `@ragnarok/core` owns portable retrieval, ingestion, storage, graph, memory, reranking, and orchestration.
- `@ragnarok/vscode` adapts VS Code configuration, language models, logging, notification, commands, and tree UI.
- `@ragnarok/mcp-server` adapts environment configuration and model providers, registers tools, and exposes stdio or stateful multi-session HTTP.
- `RAGQueryService` is the common façade for topic resolution, agent lifecycle, query validation, execution, and response formatting.

### Main runtime flows

Legacy ingestion remains the default: load, chunk, optionally extract, embed/store, and update topic metadata. When `langGraphEnabled` is on, a StateGraph loads and chunks once, stores those chunks, optionally extracts/persists entities, and maps the graph result back to the legacy result shape.

Legacy and LangGraph query paths both resolve a topic, create retrieval-ready agents, support all core retrieval strategies, and optionally rerank. The LangGraph path additionally recalls/stores memory insights and supports iterative graph nodes, but production checkpoint persistence is not enabled.

The standalone memory subsystem is well isolated from topic RAG storage. It has separate vector/graph persistence, workspace and encoded branch scopes, decay, versioning, promotion, markdown export, and deferred reinforcement persistence.

## What is well implemented

- **Portable core boundary:** VS Code dependencies are removed from core and replaced with narrow interfaces.
- **Shared query façade:** MCP and VS Code no longer duplicate the query algorithm; agent caching and formatting have one owner.
- **Protocol safety:** MCP stdio logging uses stderr, and an end-to-end test verifies protocol-clean stdout.
- **HTTP session model:** each stateful MCP transport has its own `McpServer`, while expensive application services are shared. Multi-session, termination, auth, and shutdown tests pass.
- **Persistence corrections:** empty memory/graph collections are persisted as deletions; corrupt rows fail loudly; encoded branch names avoid collisions; promotion moves graph data as well as entries.
- **Embedding safety:** model/backend metadata compatibility is checked, remote providers are validated, and dimension-changing memory model switches are rejected and rolled back.
- **Path containment:** MCP document ingestion resolves symlinks and checks real paths against configured roots.
- **Reranker sharing:** MCP management tools and query agents share one reranker, so model switching affects actual queries.
- **Test breadth:** restart, concurrency, multi-session HTTP, stdio, graph round-trip, query/index graph, package contents, and VS Code host tests are present.

## Prioritized findings

### P1 — LangGraph ingestion can commit vectors but report the document as failed

`embedAndStore` persists chunks before entity extraction (`packages/core/src/agents/indexingGraph.ts:112-123`). An extraction or graph-save error is appended to graph state (`:171-175`, `:231-235`), and `buildResult` then makes the entire operation unsuccessful (`:242-255`). `TopicManager.addDocuments` skips document metadata whenever that result is unsuccessful (`packages/core/src/managers/topicManager.ts:563-573`).

Consequences:

- chunks and vector-store metadata exist with no matching `TopicDocument`;
- topic stats disagree depending on whether they come from topic metadata or vector metadata;
- retrying the same file appends duplicate chunks and increments metadata again;
- the MCP response says the file failed even though its content may already be queryable.

The legacy pipeline treats entity extraction as non-fatal, so the two modes also have different success semantics.

**Fix:** define the vector store as the ingestion commit point and treat graph enrichment as a warning, or implement rollback/idempotent upsert. Return separate `indexingSuccess`, `graphEnrichmentSuccess`, and warnings. Add an integration test that forces extraction and graph-save failures after vector persistence, restarts the manager, retries, and asserts one logical document and one set of chunks.

### P1 — Production checkpointing is advertised but not connected

The VS Code setting describes LangGraph execution “with checkpointing” (`package.json:135-138`). `LanceDBCheckpointSaver` is implemented, exported, and tested, and graph factories accept an optional checkpointer. However, no code in either production host constructs it. `RAGQueryService` and `TopicManager` call graph execution without a checkpointer or thread ID. Repository search shows production references only in the generic graph APIs.

Consequences:

- no durable resume after crash/cancellation;
- no cross-request thread continuity;
- the new LanceDB checkpoint code ships without serving a runtime feature;
- user-facing behavior differs from configuration documentation.

**Fix:** either wire a host-owned saver and a deliberate thread-ID policy, including retention/deletion, or remove the checkpointing claim and defer the saver from the release. Do not derive thread IDs only from topic IDs; concurrent queries need isolation.

### P1 — Docker defaults expose an unauthenticated MCP service

The image binds `0.0.0.0:4000`; Compose publishes `${RAGNAROK_PORT:-4000}:4000`, passes an empty API key by default, and uses CORS `*` (`packages/mcp-server/docker-compose.yml`). This differs materially from the direct-server default of `127.0.0.1`.

Anyone who can reach the host port can list/query topics and mutate topic/memory data. Rate limiting is not an authorization boundary.

**Fix:** bind the published port to loopback by default (`127.0.0.1:${RAGNAROK_PORT:-4000}:4000`) or fail startup in non-loopback HTTP mode unless an API key is set. Use an explicit insecure-development override. Restrict CORS when binding beyond loopback and add a Compose/startup test for the secure default.

### P2 — Knowledge-graph controls are inconsistent across VS Code surfaces

Core and the tree view support `graph` and `graph_hybrid`, but the contributed VS Code setting enum lists only vector/hybrid/ensemble/BM25 (`package.json:109-124`) and the language-model tool schema also excludes graph strategies (`package.json:394-402`). Thus the settings UI and tool contract disagree with the tree view and README.

`ARCHITECTURE.md:712` also says `QueryPlannerAgent` can select a graph strategy based on analysis. It does not: retrieval strategy is supplied by config/request and passed into the planner.

**Fix:** define retrieval strategies once and generate/validate host schemas from that source. Add graph strategies to both VS Code schemas, or explicitly scope graph retrieval to MCP/advanced configuration. Correct the planner claim.

### P2 — Existing topics have no graph backfill path

Graphs are built only while ingesting with LangGraph enabled and an LLM available. Enabling the feature after documents already exist does not create graphs, and there is no reindex/backfill command. Graph strategies then silently fall back to vector retrieval.

**Fix:** add a “build/rebuild knowledge graph” operation that reads persisted chunks without re-embedding or duplicating them. Store graph schema/extractor version and last-built time so stale graphs are detectable. Report fallback explicitly in query metadata.

### P2 — MCP `topK` contracts disagree

- environment validation accepts `RAGNAROK_TOP_K` up to 50 (`packages/mcp-server/src/config.ts:77`);
- the legacy shared query service rejects values above 20 (`packages/core/src/agents/ragQueryService.ts:188-191`);
- the MCP tool schema caps per-call values at 20;
- MCP runtime default is 10 (`packages/mcp-server/src/config.ts:133`), while its README says 5 (`packages/mcp-server/README.md:82`).

With `RAGNAROK_TOP_K=21..50`, startup succeeds but ordinary legacy queries fail. LangGraph does not apply the same validation, creating mode-dependent behavior.

**Fix:** centralize a `QueryOptions` schema in core and reuse it at startup and tool boundaries. Choose one maximum/default, enforce it in both execution paths, and update documentation.

### P2 — Reranking has no off switch or explicit lifecycle policy

Reranking is always constructed in MCP (`packages/mcp-server/src/index.ts:139-145`) and lazily constructed by the shared service elsewhere (`packages/core/src/agents/ragQueryService.ts:459-466`). There is no `rerankerEnabled` setting. The core npm package includes both ONNX models and packs to roughly **99.9 MB compressed / 116.2 MB unpacked**, with the embedding and reranker assets accounting for about 110 MB on disk.

Consequences include mandatory first-query model initialization, extra CPU/memory, and a large package even for remote-embedding or non-reranking deployments. `RAGQueryService.dispose()` owns and disposes the injected reranker, while MCP then disposes it a second time, indicating unclear ownership even though current disposal is idempotent.

**Fix:** add an explicit enable/disable policy, make ownership (`owned` vs injected) explicit, dispose once, and consider optional model download/package variants. Record reranking applied/degraded status in result metadata.

### P2 — Benchmark results were not reproduced by the default validation

The default core run reports 20 pending benchmark cases. BEIR and FRAMES suites require environment flags and external datasets; the published `BENCHMARKS.md` results therefore were not reproduced during this review. This is not proof the numbers are wrong, but it is a release-evidence gap.

**Fix:** publish dataset revision/hash, command, model hash, sample/full mode, machine details, and raw result artifact for every table. Add a small deterministic benchmark smoke test to CI and run full benchmarks as a release job.

### P3 — Architecture and configuration documentation drift

`ARCHITECTURE.md:775-777` still labels LangGraph as future/planned even though both graphs are implemented. MCP README defaults differ from runtime. Phase documents mix plans with delivered behavior and do not clearly mark deviations. The root README links to a Phase 4 plan rather than an as-built description.

**Fix:** separate ADR/design-plan documents from an as-built architecture reference. Add a configuration matrix generated from actual schemas and a release checklist that verifies documented defaults.

### P3 — Quality gates allow substantial warning debt and oversized modules

Lint succeeds with **106 warnings**, including explicit `any`, unused symbols, equality/style issues, and an unused disable directive. Several classes have become broad change hotspots: `TopicManager` (1,527 lines), `RAGAgent` (1,261), MCP `tools.ts` (1,064), `MemoryStore` (1,056), and VS Code commands/tree view (roughly 1,000+ each).

**Fix:** establish a warning budget that cannot increase; then reduce it incrementally. Split MCP tools by domain, topic persistence from topic orchestration, retrieval execution from refinement, and memory persistence from lifecycle/export concerns.

## Open and missing points

- No documented migration/backfill strategy for pre-0.4 topics, knowledge graphs, or checkpoint schema changes.
- No per-topic graph freshness/version metadata.
- No production checkpoint retention, cleanup, thread identity, or resume UX.
- No explicit result field indicating graph fallback or reranker degradation.
- No document-level delete/update workflow; topic deletion exists, but correcting one indexed source requires broader rebuilding.
- No explicit reranker disable setting or lightweight core distribution.
- No CI workflow is added in this branch despite a much larger multi-package release surface.
- HTTP auth is a single static bearer token; acceptable for local use, but roles, rotation, TLS termination guidance, and audit logging are undefined for shared deployment.
- The memory feature is MCP-only at the host layer; this matches current docs but should be stated as a product boundary so VS Code users do not expect memory UI/commands.

## Recommended improvement sequence

1. Make ingestion idempotent/atomic and add forced-failure/retry/restart tests.
2. Secure Docker defaults.
3. Decide whether checkpointing is a release feature; wire it fully or remove the claim/code from the runtime path.
4. Centralize query/config schemas and align `topK`, retrieval enums, defaults, and documentation.
5. Add graph backfill/versioning and expose graph strategies consistently.
6. Add a reranker enable policy and clarify resource ownership/package strategy.
7. Add CI for compile, core/MCP tests, VS Code host tests, lint warning budget, formatting, package smoke, and stdio protocol smoke.
8. Refresh as-built architecture and reproducible benchmark evidence.
9. Refactor the largest orchestration files by responsibility after correctness contracts are protected by tests.

## Verification results

| Check                                | Result                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `git diff --check main...HEAD`       | Pass                                                                                                                                       |
| TypeScript builds for all workspaces | Pass                                                                                                                                       |
| Core tests                           | 690 passing, 20 benchmark tests pending by design                                                                                          |
| VS Code extension-host tests         | 24 passing                                                                                                                                 |
| MCP tests                            | 149 passing                                                                                                                                |
| Formatting                           | Pass                                                                                                                                       |
| ESLint                               | Exit 0; 106 warnings, 0 errors                                                                                                             |
| Package smoke                        | Initial run blocked by root-owned `~/.npm` cache; rerun with isolated cache packed both workspaces and reached clean-consumer installation |

The package smoke rerun should be recorded as fully passing only once its clean-consumer install/import and MCP binary checks complete in the local environment.

## Final assessment

The branch demonstrates a coherent target architecture and unusually good test investment for its size. Most severe findings from earlier workspace reviews have been fixed in later commits: package contents, stdio logging, provider routing, deletion persistence, branch encoding, promotion graphs, shutdown, model-switch coordination, graph wiring, cancellation, cache invalidation, and multi-session HTTP all have current code/tests.

The remaining risk is concentrated at integration boundaries rather than in the individual algorithms. Resolve the three P1 items, align cross-layer schemas, and add graph migration/observability before calling 0.4 production-ready.
