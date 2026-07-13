# RAGnarōk — Architecture

**Scope:** every load-bearing design aspect of RAGnarōk as implemented on the `mcp-server` branch (v0.4.0 line). Roadmap items are marked as such and live in §17.
**Audience:** contributors and reviewers. Sections are self-contained; cross-references are explicit.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Deployment Topologies & User Profiles](#2-deployment-topologies--user-profiles)
3. [Monorepo Layout](#3-monorepo-layout)
4. [Design Invariants & Key Decisions](#4-design-invariants--key-decisions)
5. [Storage & Durability](#5-storage--durability)
6. [Concurrency Model](#6-concurrency-model)
7. [Ingestion Pipeline](#7-ingestion-pipeline)
8. [Embedding Subsystem](#8-embedding-subsystem)
9. [Retrieval & Ranking](#9-retrieval--ranking)
10. [Knowledge Graph](#10-knowledge-graph)
11. [Memory Subsystem](#11-memory-subsystem)
12. [Query Execution](#12-query-execution)
13. [MCP Server](#13-mcp-server)
14. [VS Code Extension](#14-vs-code-extension)
15. [Security Model](#15-security-model)
16. [Testing & Release Gates](#16-testing--release-gates)
17. [Roadmap: Federated Shared Knowledge Bases](#17-roadmap-federated-shared-knowledge-bases)
18. [Appendix: Configuration & Storage Reference](#18-appendix-configuration--storage-reference)

---

## 1. System Overview

RAGnarōk is a **local-first Retrieval-Augmented Generation engine**. One portable core (`@ragnarok/core`) implements ingestion, embedding, retrieval, reranking, knowledge-graph extraction, and persistent memory; two hosts expose it:

- an **MCP server** (`@ragnarok/mcp-server`) over stdio (local agents: Claude, Cursor, Copilot) and Streamable HTTP (remote/shared deployments), and
- a **VS Code extension** (`@ragnarok/vscode`) exposing a Copilot-compatible language-model tool plus management UI.

All data lives on disk in the user's environment (LanceDB tables + JSON indexes). There is no required cloud dependency: embedding and reranking default to bundled ONNX models executed in-process, and the LLM-dependent features (query planning refinement, entity extraction) degrade to heuristics when no LLM is configured.

| Capability               | Description                                                                           | Where    |
| ------------------------ | ------------------------------------------------------------------------------------- | -------- |
| Multi-format ingestion   | PDF, Markdown, HTML, plain text, GitHub repos, web pages                              | §7       |
| Structure-aware chunking | Heading-aware Markdown splitting, code-aware recursive splitting                      | §7       |
| Pluggable embeddings     | Bundled HuggingFace ONNX (default), remote OpenAI/Ollama-format, VS Code LM API       | §8       |
| 6 retrieval strategies   | vector, hybrid, ensemble (RRF), bm25, graph, graph_hybrid                             | §9       |
| Cross-encoder reranking  | Bundled ms-marco MiniLM ONNX model, always-on with graceful degradation               | §9       |
| Knowledge graph          | LLM entity/relationship extraction into a per-topic graph store                       | §10      |
| Persistent memory        | Workspace/branch-scoped memories with version chains, decay, and an entity graph      | §11      |
| Agentic querying         | Query decomposition, iterative refinement, optional LangGraph orchestration           | §12      |
| Team sharing             | Shared-KB host with read/write token roles (server side today; federation is roadmap) | §13, §17 |

**Versioned surfaces:** storage format v2 (§5), `.rag` export archives v2 (§7), MCP tool surface (§13). All three fail closed on version mismatch with actionable errors.

---

## 2. Deployment Topologies & User Profiles

The same server binary serves two deployment modes, distinguished **by configuration, not code paths chosen by the client**:

| Mode                        | Trigger                                            | Memory tools                       | Tool descriptions            | Typical user                |
| --------------------------- | -------------------------------------------------- | ---------------------------------- | ---------------------------- | --------------------------- |
| **Local (personal engine)** | stdio, or HTTP without auth tokens (loopback-only) | Registered                         | Plain                        | The developer's own machine |
| **Shared (team KB host)**   | `--http` **and** auth tokens configured            | **Never registered, for any role** | Prefixed `[Team shared KB] ` | Central team infrastructure |

The rule is **exactly one RAGnarōk MCP entry per agent context**:

- **Consumer / sandboxed agent** (no local KBs, no memory): the agent connects **directly to the shared host** with a read token. Zero local install. A sandboxed agent _cannot_ run a local engine, which is why the shared host is a first-class MCP server and not merely a sync source.
- **Power user** (local KBs and/or memory): the agent is configured with the **local engine only**. The shared KB becomes a _setting_ of the local engine once federation lands (§17).
- **Curator** (write-token holder): a direct writer session against the shared host, typically in a dedicated curation context. Local-file ingestion into the shared KB goes via export/import or URL ingestion, because the host cannot read the curator's disk.

When both a local and a shared entry are configured anyway, degradation is layered: MCP clients namespace tools per server entry (no hard collision); both servers **self-describe** via MCP `instructions` and the shared host prefixes every tool description, so the LLM routes deliberately; the tool surfaces barely overlap (no memory tools on the host, no write tools for readers); and the worst case of a wrong pick is a duplicate retrieval, never a misplaced write.

Design details and the serving-mode decision record are in `docs/superpowers/specs/2026-07-12-federated-shared-kb-design.md`.

---

## 3. Monorepo Layout

```
packages/
  core/          @ragnarok/core — the portable engine (no VS Code, no MCP imports)
    src/
      agents/      RAGQueryService, RAGAgent, QueryPlannerAgent, LangGraph pipelines, graph state
      embeddings/  EmbeddingService, HuggingFaceBackend, RemoteEmbeddingBackend, fingerprints
      loaders/     text/markdown/html/pdf/github/web loaders (+ SSRF guards)
      managers/    TopicManager (topic lifecycle, ingestion orchestration, export/import)
      memory/      MemoryStore, MemoryVectorStore, MemoryGraph, decay, scope linker, git branch detection
      models/      ModelRegistry, RerankerModelRegistry, bundled-asset resolution
      rerankers/   CrossEncoderReranker
      retrievers/  vector/keyword/hybrid/ensemble/graph/graph-hybrid retrievers
      splitters/   SemanticChunker and text splitters
      stores/      VectorStoreFactory (topic tables), KnowledgeGraphStore, LanceDBCheckpointSaver
      utils/       storageV2, storageLock, vector math, graph types, keywords
    assets/models/ bundled ONNX models + manifest.json (SHA-256 gate)
  mcp-server/    @ragnarok/mcp-server — MCP host (stdio + Streamable HTTP), tools.ts, httpServer.ts, config.ts
  vscode/        @ragnarok/vscode — extension host (activation, commands, LM tool, settings)
```

Dependency direction is strict: hosts depend on `@ragnarok/core`; core depends on neither host. Core's host abstractions are small interfaces (`IConfigProvider`, `INotifier`, `ILLMProvider`, logger factory) implemented by each host (`mcp-server/src/adapters.ts`, VS Code equivalents). Tests compile to `dist-test/` per package; production builds to `dist/`.

---

## 4. Design Invariants & Key Decisions

### Invariants (violations are bugs, not preferences)

- **P1 — Personal data is always local.** Personal KBs and _all_ memory live in the user's environment, read/write. Never on a shared server.
- **P2 — The engine that owns local data runs locally.** A remote server cannot create or modify files on a client's disk; any user wanting local KBs/memory runs a local engine. Users with no local data need no local engine at all (§2).
- **P3 — Memory is always personal → always local.** Only topics are ever shared. Shared deployments do not even _register_ memory tools, and construct no `MemoryStore` (structural, not policy — `mcp-server/src/index.ts`, `tools.ts`).
- **P4 — Data locality dictates compute locality.** A query vector is valid only against the exact embedding model that built the table. Local tables ⇒ local embedding with that topic's recorded model; remotely-served topics ⇒ the host embeds and retrieves (§17).
- **P5 — Auth lives only where parties share data.** Read/write tokens are a property of the shared host. The local engine needs no per-user auth; it is guarded by OS permissions and the storage lock (§6).

### Decision record (ADR-style)

| Decision                  | Choice                                                                                            | Rationale / rejected alternative                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model distribution        | **Bundle ONNX models in the npm package**                                                         | Zero-network first run, deterministic CI; rejected download-on-demand (deferred — package size is the cost). A SHA-256 manifest (`assets/models/manifest.json` + `scripts/verify-model-manifest.mjs`) makes silent asset drift a build failure.                       |
| Pre-1.0 storage evolution | **Versioned format + fail-closed gate + reset-with-backup** (storage v2)                          | Rejected in-place migration: packages are unpublished, migration code would be permanent liability. Reset preserves data via timestamped `backup-v1-*` with rollback on partial failure (§5).                                                                         |
| LanceDB write pattern     | **Single transactional `mergeInsert` (upsert + delete-missing)**                                  | Rejected drop-then-recreate: a crash between drop and create destroyed the table (the historical C2 data-loss bug).                                                                                                                                                   |
| Arrow read boundary       | **`Array.from()` every vector read from LanceDB**                                                 | LanceDB returns Arrow `Vector` objects; persisting a collection containing them serializes garbage. Normalization happens at the read boundary, once, in every store (§5).                                                                                            |
| Shared-KB serving         | **Retrieval-serving (remote MCP host), not data-serving**                                         | Data-serving forces every consumer to run a local engine and pins the shared KB to the bundled embedding model (P4). Retrieval-serving gives zero-install consumers and model freedom. Folder-sync (`commonDatabasePath`) and export/import remain as escape hatches. |
| Reader enforcement        | **Structural default-deny** — write tools are _not registered_ for reader sessions                | Rejected per-handler guards as the primary mechanism (default-open; one forgotten guard leaks writes). `writerOnly()` remains as defense-in-depth on the mixed `rag_memory` tool.                                                                                     |
| Cross-topic result fusion | **None. `rag_query` targets one topic; same-named local+shared topics fuse by RRF (roadmap §17)** | Rejected a combined cross-encoder over heterogeneous sources: scores from different models/rerankers are not comparable; RRF is rank-based and needs no shared scale.                                                                                                 |
| LangGraph pipelines       | **Opt-in (`RAGNAROK_LANGGRAPH_ENABLED`, default false)**                                          | The legacy imperative path is the stable default; the graph path adds checkpointing/observability and is hardened behind a flag until parity (§12).                                                                                                                   |
| Query-time auto-memory    | **Opt-in (`queryMemoryEnabled`, default false) + isolated**                                       | Auto-stored "query insights" polluted recall in live testing. When enabled: confidence floor 0.7, reserved `auto:query-insight` tag, excluded from recall unless `includeAuto: true`.                                                                                 |
| Write serialization (MCP) | **Promise-chain mutation serializer (`runMutation`) shared across sessions**                      | LanceDB whole-table merges must not interleave; reads stay parallel. Cross-process safety is the storage lock's job, not this serializer's (§6).                                                                                                                      |
| Shutdown                  | **Natural drain + `process.exitCode`, never forced `process.exit(0)`**                            | Forced exit after ONNX use aborts natively (`mutex lock failed` SIGABRT). A 10s hard-exit timer remains as a last-resort watchdog. Verified by a 20× soak that loads/disposes the ONNX session every iteration (§16).                                                 |

---

## 5. Storage & Durability

### On-disk layout (per storage dir, default `~/.ragnarok`)

```
<storageDir>/
  storage-format.json          # v2 marker {formatVersion: 2, initializedAt}
  .ragnarok.lock               # cross-process lock (infrastructure — see §6)
  backup-v1-<timestamp>/       # pre-reset backups (never touched by the format gate)
  database/
    topics.json                # topics index: id, name, model, fingerprints, document index
    lancedb/                   # per-topic vector tables + knowledge-graph tables
    checkpoints-lancedb/       # LangGraph checkpoints (when enabled)
  memory-lancedb/              # memory entries + memory graph tables (per scope)
  memory-manifest.json         # memory embedding fingerprint {schemaVersion, embeddingFingerprint}
  memories.md                  # human-readable memory export (debounced regeneration)
  exports/                     # .rag export archives
```

### Storage format v2

`utils/storageV2.ts` is the single authority:

- **`ensureStorageFormatV2`** validates the marker. A directory containing managed data but **no marker fails closed** with an actionable message (`--reset-storage` / `RAGNAROK_RESET_STORAGE=1`). Infrastructure entries (`storage-format.json`, `.ragnarok.lock`, `backup-v1-*`) are excluded from the "has data" judgment — the lock is created _before_ format validation and must not masquerade as legacy data.
- **`resetStorageToV2`** moves managed content into `backup-v1-<ISO timestamp>/`, then initializes the marker. Partial moves roll back; the backup is never auto-deleted (restore is a manual operation).
- **`atomicWriteFile`/`atomicWriteJson`**: temp file in the same directory → write → fsync → rename → best-effort directory fsync. Every JSON index write goes through this; a crash never leaves a half-written index.

### LanceDB usage rules (uniform across all stores)

All three LanceDB-backed stores — topic vectors (`stores/vectorStoreFactory.ts`), knowledge graph (`stores/knowledgeGraphStore.ts`), memory (`memory/memoryVectorStore.ts`) — follow the same contract:

1. **Explicit Arrow schemas** on table creation (`createEmptyTable(name, schema)`). Schema inference from the first row is banned: it made table shape depend on ingestion order (the MB-1 mixed-format bug).
2. **Fixed, typed chunk columns with defaults** (`normalizeDocumentMetadata`): every chunk row carries the same column set regardless of source format.
3. **`Array.from()` at every read boundary** for vector columns (Arrow `Vector` → plain `number[]`).
4. **Crash-safe persistence**: `table.mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().whenNotMatchedBySourceDelete().execute(rows)` — one transactional reconcile, no drop/create window. Keys: `chunk_id` for topic tables (scoped delete by `document_id` on reingest), `id` for memory/KG tables.
5. **Connections memoized** per store (single `dbPromise`), disposed on `dispose()`.

An **ingestion journal** (recovered by `TopicManager.recoverIngestionJournal` on startup) finishes metadata bookkeeping if a crash lands between the vector commit and the index write, guarded by a journal mutex.

---

## 6. Concurrency Model

Three distinct layers, each solving a different interleaving:

| Layer                                               | Mechanism                                                                                                                                   | Protects against                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Async interleaving in one process                   | `async-mutex` in stores; **single-flight cache loaders** in `MemoryStore` (`entryLoads`/`graphLoads` maps); journal mutex in `TopicManager` | Two concurrent tool calls loading/mutating the same cached array and losing updates |
| Write vs write across sessions (one server process) | **`runMutation` promise-chain serializer** in `mcp-server/src/index.ts` — all 14+ mutating tool handlers enqueue; reads bypass              | Interleaved whole-table merges from concurrent MCP sessions                         |
| Second OS process on the same storage dir           | **`<storageDir>/.ragnarok.lock`** (`utils/storageLock.ts`)                                                                                  | Two VS Code windows or two stdio servers silently corrupting tables                 |

### The storage lock, precisely

- Atomic exclusive creation (`open "wx"`), content `{pid, hostname, acquiredAt}`.
- **Refcounted per resolved directory within a process** — `TopicManager` (acquired first thing in init, released on failed init and on dispose) and `MemoryStore` (acquired lazily on first data access) share one underlying lock.
- **Heartbeat**: the holder refreshes the file mtime every 30s (unref'd timer). Staleness: heartbeat older than 5 min, or same-host holder pid dead (`kill(pid, 0)`; `EPERM` counts as alive). Stale locks are reclaimed with a bounded retry loop; a _live_ holder produces a fail-fast `StorageLockHeldError` naming the pid and the `RAGNAROK_IGNORE_LOCK=1` override.
- **Release order matters**: unlink first, _then_ drop the exit-hook entry, so a process dying mid-release still gets cleaned by the synchronous `process.on("exit")` unlink. Release verifies the lock is still ours before unlinking (a reclaimed lock is never deleted from under its new owner).
- Corrupt lock file + fresh mtime ⇒ treated as held (fail safe).

The e2e gate for all of this spawns two real server processes against one directory (`packages/mcp-server/test/storageLockE2E.test.ts`).

---

## 7. Ingestion Pipeline

```
files / URLs / repos
  → Loader (format-specific)         loaders/*.ts
  → SemanticChunker                  heading-aware (md) | code-aware | recursive
  → metadata normalization           fixed typed columns, stable documentId/chunkId
  → EmbeddingService (batched)       §8
  → VectorStoreFactory.mergeInsert   idempotent on chunk_id
  → topics.json document index       atomic write (+ journal recovery)
  → (optional) KG extraction         §10 — never blocks the commit
```

**Loaders.** `TextDocumentLoader`, `MarkdownDocumentLoader` (structure flags), `HtmlDocumentLoader` (tag stripping + entity decode), `PdfDocumentLoader` (LangChain PDFLoader), `GithubDocumentLoader` (repo crawl, token via env), `WebDocumentLoader` (Cheerio; SSRF-hardened — §15). File-path ingestion is restricted to `RAGNAROK_ALLOWED_PATHS` roots (`assertPathAllowed` resolves symlinks before checking).

**Identity & idempotency.** Every document gets a stable `documentId` (`doc-<sha256>` of its source identity) and every chunk a stable `chunkId`; reingesting a source reconciles via `mergeInsert("chunk_id")` with `whenNotMatchedBySourceDelete` scoped to that `document_id` — re-adding a document **replaces** it, never duplicates it (asserted e2e).

**Partial-success semantics (C3).** The commit point is vector storage: `success = vectorStored && chunkCount > 0`. Knowledge-graph extraction failure demotes to `warnings` (`stage: "graph"`, `partial: true`, `graphExtracted: false`) — an LLM outage cannot fail or duplicate an ingestion.

**Export/import.** `rag_export_topic` produces a `.rag` v2 zip: manifest (format version, embedding fingerprint), `topic.json`, table data, per-entry SHA-256 checksums. Import validates checksums (tamper ⇒ `checksum mismatch`), rejects old format versions, guards against path traversal and zip bombs, and refuses fingerprint-incompatible archives.

---

## 8. Embedding Subsystem

`EmbeddingService` routes to registered backends:

| Backend                  | When                                         | Notes                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HuggingFaceBackend`     | default                                      | transformers.js v3 over bundled ONNX assets; **`dtype: "q8"`** must match the bundled `model_quantized.onnx` (the v2-era `quantized: true` option is silently ignored by v3 — the historical C1 bug class). Default model `Xenova/all-MiniLM-L6-v2`. |
| `RemoteEmbeddingBackend` | `RAGNAROK_EMBEDDING_PROVIDER=openai\|ollama` | OpenAI- or Ollama-format HTTP APIs; responses validated (count, index alignment, finite values, dimension consistency, empty batch).                                                                                                                 |
| VS Code LM backend       | extension only                               | Proposed `vscode.lm` embeddings API.                                                                                                                                                                                                                 |

**Embedding fingerprints** (`{backendKind, providerFormat, model, revision, dimension, endpointHash}`) are persisted per topic and in the memory manifest. A fingerprint mismatch is rejected **even when dimensions coincidentally match** — `remote:openai` and `remote:ollama` embeddings of the same dimension are not interchangeable. Memory offers an explicit escape hatch (`rag_reset_memory`, confirmed destructive) before switching embedding spaces; topic model switches probe the replacement pipeline before swapping global state and roll back on failure.

`ModelRegistry`/`RerankerModelRegistry` resolve model identifiers to bundled asset paths with path-traversal protection (block `..`, absolute paths, drive letters) and fall back to hub download when permitted.

---

## 9. Retrieval & Ranking

| Strategy       | Composition                                      | Score basis                         |
| -------------- | ------------------------------------------------ | ----------------------------------- |
| `vector`       | LanceDB cosine similarity                        | model space                         |
| `bm25`         | KeywordRetriever (BM25 + keyword boost)          | lexical                             |
| `hybrid`       | weighted fusion, **0.9 vector / 0.1 keyword**    | normalized blend                    |
| `ensemble`     | Reciprocal Rank Fusion of vector + keyword lists | rank-based (no shared scale needed) |
| `graph`        | entity match → graph traversal → source chunks   | graph relevance                     |
| `graph_hybrid` | graph candidates fused with semantic search      | blend                               |

Graph strategies require a populated knowledge graph (LLM-dependent at ingest time) and **fall back to hybrid** with an explicit `fallbackReason` rather than returning empty.

**Cross-encoder reranking** (`rerankers/crossEncoderReranker.ts`) applies to the candidate pool after retrieval, always-on by default (`rerankerEnabled`):

- Bundled `Xenova/ms-marco-MiniLM-L-6-v2` at `dtype: "q8"`; scores `(query, doc)` pairs jointly, sigmoid-normalized; `originalScore` preserved alongside.
- **Degradation boundary**: model load happens _inside_ the rerank try/catch — any init or scoring failure returns the original ranking and logs, it never fails the query. Cancellation (`AbortSignal`) is re-thrown, not swallowed, and is checked before/after scoring.
- **Warm-up**: the MCP host fires a non-blocking `initialize()` at startup so the first query skips the load stall and a broken model surfaces in startup logs.
- **Model switch is swap-after-success**: a replacement instance fully initializes before the live model/tokenizer are swapped and the old session disposed; a failed switch leaves the working model untouched.
- Candidate pool capped by `rerankerMaxCandidates` (default 20); documents truncated to ~1500 chars for the cross-encoder context window.

---

## 10. Knowledge Graph

Per-topic graph built at ingest time when an LLM is available: entity + relationship extraction → graphology graph → persisted in LanceDB (`KnowledgeGraphStore`, explicit schema, entity embeddings for semantic entity search). **Provenance is tracked per document/chunk** so reingestion or document removal updates shared entities without deleting references owned by other documents. Graph retrievers (§9) map matched entities back to source chunks via `sourceChunkIds`. Graph extraction is advisory: its failure never blocks ingestion (§7) and its absence downgrades graph strategies to hybrid.

---

## 11. Memory Subsystem

Standalone, host-independent memory (`memory/`), fully local (invariant P3).

**Scoping.** Two scopes: `workspace` and `branch` (git branch auto-detected by reading `.git/HEAD` asynchronously, worktree-aware, 5s cache; explicit `branch` overrides; branch scope with no detectable branch is a hard error at the tool layer — never a silent fall-back). Scope tables are base64url-encoded per scope+branch.

**Entry lifecycle.**

- **Store**: embed → near-duplicate detection (cosine ≥ threshold) → if duplicate, create a new **version** (old entry `isLatest=false`, `supersededBy` set; tags/entities carried forward) → optional LLM entity extraction into the per-scope `MemoryGraph` → persist entries + graph.
- **Recall**: vector search ×2 topK → filter expired + `auto:*`-tagged (unless `includeAuto`) → multiply by **decay-engine effective confidence** → slice topK → reinforcement (access counters bumped on the cached entries, persisted by a **debounced flush** — reads never rewrite whole tables synchronously; readers with `reinforce:false` cause zero writes).
- **Forget**: by id (with **version-chain repair** — removing the latest reinstates its predecessor), by age filter (guarded: refuses to delete everything without a filter), or by expiry (TTL `expiresAt` from `ttlDays`, plus decay-below-threshold purge).
- **Promote**: branch → workspace via the scope linker (specific ids or whole scope).

**Persistence discipline.** In-memory per-scope caches (entries + graph) are the write-through source; `persistScopeOrInvalidate` persists both and **drops the caches on failure before rethrowing** — a failed persist can never masquerade as in-session success (the cache-rollback fix). All LanceDB rules of §5 apply. A debounced exporter regenerates `memories.md` for human inspection.

**Decay engine** is a pure evaluator: effective confidence decays with age/access patterns and graph connectivity; `runDecay` reports, `forget(expired:true)` purges. Auto-decay can run on a timer (opt-in).

---

## 12. Query Execution

Two paths share the same tool surface and `RAGQueryService` entry point:

**Legacy path (default).** Topic resolution (exact → fuzzy → semantic) → per-topic `RAGAgent` (cached; invalidated via `TopicManager.onAgentCacheCleanup`) → `QueryPlannerAgent` decomposes (heuristic for simple, LLM-refined with Zod-validated output for moderate/complex, heuristic fallback without LLM) → sub-queries execute against the chosen strategy → optional iterative refinement (gap analysis → LLM follow-up queries → merge/dedupe → convergence check against `confidenceThreshold`/`maxIterations`) → dedupe by content key → rerank (§9) → topK → `RAGQueryResult` with `agenticMetadata`.

**LangGraph path (opt-in, `RAGNAROK_LANGGRAPH_ENABLED`).** `agents/queryGraph.ts` builds a StateGraph: `recallMemory` (skips without a MemoryStore) → `planQuery` → `retrieve` (strategy-dispatched, per-sub-query) → `rerank` → `evaluate` → conditional `refine` loop → `formatResult` → optional `memorize`. Cancellation propagates: the MCP `extra.signal` threads through recall, planning, retrieval, reranking, and embedding; reranker aborts re-throw rather than degrade.

- `QueryPipelineOptions.allowMemoryWrites` is **required state**: reader sessions run with `allowMemoryWrites:false`, which no-ops `memorize` and disables recall reinforcement — "readers cause zero durable writes" holds inside the graph too.
- The `memorize` node is double-gated: `queryMemoryEnabled` (default false) and a 0.7 confidence floor; stored entries carry the reserved `auto:query-insight` tag and are excluded from recall by default (§4 decision).
- **Indexing graph** (`agents/indexingGraph.ts`): load → chunk → embed → store → extract-entities → store-graph, with per-stage state and a deterministic `thread_id` so a `LanceDBCheckpointSaver`-backed run can resume past completed stages. The checkpointer is constructed by hosts only when the flag is on (`database/checkpoints-lancedb/`).
- Known parity gaps vs the legacy path (refinement is a simpler heuristic in-graph; confidence evaluation nuances) are tracked in `CONSOLIDATED-FIX-PLAN.md` Phase 6.

---

## 13. MCP Server

### Process shape

`mcp-server/src/index.ts` builds the singleton services once (embedding service + backends, `TopicManager`, `RAGQueryService`, reranker with warm-up, `MemoryStore` — the latter only in local deployments), then serves them through per-session `McpServer` instances:

- **stdio** (default): one server + `StdioServerTransport`; EOF on stdin triggers the same graceful shutdown as SIGINT/SIGTERM.
- **Streamable HTTP** (`--http`): Express app (`httpServer.ts`) with one `McpServer`+`StreamableHTTPServerTransport` pair **per client session**, keyed by the SDK-issued `mcp-session-id`. Sessions carry `{role, authorization, lastSeen}`; idle sessions are reaped on a TTL sweep (`sessionIdleTtlMs`, default 30 min); `maxSessions` caps concurrency (503 beyond); rate limiting and CORS wrap the app; `/health` and `/ready` endpoints serve probes.

### Authentication & roles

- `RAGNAROK_API_KEY` = **read** token, `RAGNAROK_WRITE_API_KEY` = **write** token; both compared timing-safe; config validation (zod `superRefine`) rejects identical tokens, non-loopback binds without a key, and non-loopback + CORS `*` — the server **fails closed at startup**, not at request time.
- The session role is **pinned at initialize**: subsequent requests must present the same authorization or 401. No tokens configured (loopback dev) ⇒ writer.
- **Structural default-deny**: `registerTools(server, …, role, …, deployment)` registers write tools through `registerWriteTool`, which is a **no-op for reader roles** — for a reader session the 12 write tools do not exist in `tools/list`, they are not merely guarded. The mixed `rag_memory` tool keeps per-action `writerOnly()` guards as defense-in-depth. Reader recall passes `reinforce:false`; reader queries pass `readOnly` into the query service (§12).

### Tool surface (23 tools in local writer mode)

| Group               | Tools                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Query               | `rag_query`                                                                                                            |
| Topics              | `rag_list_topics`, `rag_topic_stats`, `rag_create_topic`, `rag_delete_topic`, `rag_rename_topic`, `rag_storage_status` |
| Documents           | `rag_add_documents`, `rag_list_documents`, `rag_remove_document`, `rag_add_url`, `rag_add_github_repo`                 |
| Archives            | `rag_export_topic`, `rag_import_topic`                                                                                 |
| Embeddings          | `rag_list_embedding_models`, `rag_embedding_info`, `rag_switch_embedding_model`                                        |
| LLM / Reranker      | `rag_llm_status`, `rag_list_reranker_models`, `rag_reranker_info`, `rag_switch_reranker_model`                         |
| Memory (local only) | `rag_memory` (store/recall/forget/stats/list/decay/history/promote/links), `rag_reset_memory`                          |

Every tool carries MCP annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`); destructive operations require `confirm: true` literals. All mutating handlers run inside `runMutation` (§6). In shared deployments the memory tools are absent for every role and descriptions carry the `[Team shared KB] ` prefix; the server's MCP `instructions` describe its deployment role (§2).

### Lifecycle

Graceful shutdown (signal or stdio EOF): close transports → dispose memory store (flushes reinforcement + markdown) → dispose query service/reranker → dispose topic manager (releases storage lock) → dispose embedding service → dispose checkpointer → set `process.exitCode = 0` and drain naturally. A 10-second hard-exit timer is the watchdog. Forced `process.exit()` after ONNX use is banned (§4). Docker runs as `USER node`, prunes dev deps, healthchecks `/ready`, and its CI smoke validates auth, persistence across restart, and exit-code-0 stops.

---

## 14. VS Code Extension

The extension host wires the same core: activation creates the storage under `context.globalStorageUri`, a `TopicManager` (with a back-up-and-reset UX when the v2 gate rejects legacy storage), an `EmbeddingService` (background-initialized), a `MemoryStore` scoped to the first workspace folder, and registers commands (topic/document management, model switching, GitHub token management) plus the Copilot LM tool that fronts `RAGQueryService`. Settings under `ragnarok.*` mirror the env config (§18). The in-process concurrency story is the same as the MCP server's; the storage lock (§6) protects against a second window or a concurrently running stdio server on the same storage dir.

---

## 15. Security Model

| Surface              | Control                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP exposure        | Fail-closed config: non-loopback requires a token; CORS `*` forbidden off-loopback; rate limiting; session TTL + cap                                                                                           |
| Tokens               | Read/write split, timing-safe compare, role pinned per session, structural default-deny registration (§13)                                                                                                     |
| Web ingestion (SSRF) | DNS resolution with private/loopback/link-local blocking (IPv4 + IPv6 ULA/link-local), **DNS pinning** for the actual fetch (defeats rebinding TOCTOU), per-redirect re-validation, redirect cap, http(s) only |
| File ingestion       | `RAGNAROK_ALLOWED_PATHS` allowlist; symlinks resolved before checking; GitHub host allowlist for repo ingestion                                                                                                |
| Archives             | SHA-256 per entry, manifest version gate, path-traversal and zip-bomb guards, fingerprint compatibility check                                                                                                  |
| Model assets         | SHA-256 manifest verified at build/pack time; registry blocks path traversal in model identifiers                                                                                                              |
| Container            | Non-root `USER node`, prod-only deps, no secrets in logs                                                                                                                                                       |
| Memory privacy       | P3: never on shared hosts — no store constructed, no tools registered                                                                                                                                          |

The threat model is a **trusted local machine + semi-trusted team network**: static shared tokens are accepted for team infra (rotation is a manual op); per-client identity/audit is deferred (§17).

---

## 16. Testing & Release Gates

**Pyramid.** Unit + integration suites per package run against **real LanceDB in temp dirs** (no storage mocks): core ≈ 730 tests, mcp-server ≈ 168. On top sit real-binary e2e specs (`packages/mcp-server/test/*E2E*.test.ts`) that spawn the built `dist/index.js` through a shared `StdioHarness` which **scrubs inherited `RAGNAROK_*` env** (a developer shell's remote-provider exports silently reconfigure the server otherwise — this is a hard rule for every spawned server).

**Named release gates** (each locks a reproduced production failure):

| Gate | Spec                                                                                   | Locked regression                                                               |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| C1   | stdio E2E all-6-strategies loops (legacy + LangGraph)                                  | bundled reranker model failing to load ⇒ every query failed                     |
| C2   | `memoryPersistenceE2E` (store → restart → mutate → restart, exact id set)              | Arrow-vector persistence destroying all memories on first mutation after reload |
| MB-1 | `mixedFormatE2E` (txt/md/html in opposite orders, per-format sentinels both topics)    | first-file schema inference breaking later formats                              |
| AA-1 | `storageLockE2E` (two real processes, fail-fast + release)                             | silent cross-process table corruption                                           |
| MB-2 | `shutdown-soak.mjs` 20× (ONNX load/dispose every iteration) + HTTP SIGTERM exit-0 spec | native SIGABRT on shutdown                                                      |

**CI** (`.github/workflows/release.yml`): `quality` (lint, format, model manifest, test:fast on Node 20/22), `native-process` (3 OS × Node 20/22 running compiled suites + the soak — win32 uses the stdio-EOF shutdown path since SIGTERM is not emulatable there), `vscode` (xvfb), `packages` (pack smoke, audit, VSIX), `docker` (build, non-root, auth, persistence, clean-stop). Known issue: `npm run lint` OOMs at the 2GB default heap (recorded; per-package split planned) — and the workflow needs its first real push/PR run to validate the matrix.

---

## 17. Roadmap: Federated Shared Knowledge Bases

Design settled in `docs/superpowers/specs/2026-07-12-federated-shared-kb-design.md`; implementation targeted at 0.5.0:

- **`SharedSource` abstraction** with two implementations: `FolderSharedSource` (generalizing today's `commonDatabasePath` — shared tables on a synced/mounted filesystem, all compute local using each topic's recorded model) and `RemoteSharedSource` (an MCP _client_ inside the local engine pointed at the shared host with a read token; the host embeds/retrieves/reranks server-side per P4).
- **Per-topic federation** in `RAGQueryService`: a topic resolves local-only, shared-only, or both; "both" retrieves each side concurrently and fuses with **RRF** (rank-based — no cross-model score comparison), tagging result origins; a slow/down remote degrades to local-only with a surfaced note, never a hard failure.
- **No combined cross-encoder across sources** (decision record, §4).
- Deferred with rationale: federation write-through for curators (direct writer sessions instead), OAuth/mTLS/per-client audit (static team tokens now), npm model download-on-demand (bundling now).

---

## 18. Appendix: Configuration & Storage Reference

### Environment variables (MCP server; VS Code settings mirror under `ragnarok.*`)

| Variable                                                                                    | Default                   | Purpose                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `RAGNAROK_STORAGE_DIR`                                                                      | `~/.ragnarok`             | Storage root (format-gated, lock-guarded)                                    |
| `RAGNAROK_WORKING_DIR`                                                                      | `process.cwd()`           | Project root for git-branch memory scoping                                   |
| `RAGNAROK_ALLOWED_PATHS`                                                                    | working dir               | Ingestion path allowlist (delimiter-separated)                               |
| `RAGNAROK_EMBEDDING_PROVIDER`                                                               | `huggingface`             | `huggingface` \| `openai` \| `ollama`                                        |
| `RAGNAROK_EMBEDDING_MODEL`                                                                  | `Xenova/all-MiniLM-L6-v2` | Embedding model id                                                           |
| `RAGNAROK_EMBEDDING_BASE_URL` / `_API_KEY`                                                  | —                         | Remote embedding endpoint (required for non-HF providers)                    |
| `RAGNAROK_LLM_PROVIDER`                                                                     | `none`                    | `openai` \| `anthropic` \| `ollama` \| `none`                                |
| `RAGNAROK_LLM_MODEL` / `_API_KEY` / `_BASE_URL`                                             | provider defaults         | LLM wiring                                                                   |
| `RAGNAROK_RERANKER_ENABLED`                                                                 | `true`                    | Cross-encoder reranking toggle                                               |
| `RAGNAROK_LANGGRAPH_ENABLED`                                                                | `false`                   | LangGraph pipelines (adds checkpointer)                                      |
| `RAGNAROK_QUERY_MEMORY_ENABLED`                                                             | `false`                   | Opt-in query-time auto-memory (§12)                                          |
| `RAGNAROK_API_KEY` / `RAGNAROK_WRITE_API_KEY`                                               | —                         | Read / write tokens; both present + `--http` ⇒ shared deployment             |
| `RAGNAROK_PORT` / `RAGNAROK_HTTP_HOST`                                                      | `3000` / loopback         | HTTP bind (non-loopback requires a token)                                    |
| `RAGNAROK_CORS_ORIGIN`                                                                      | restricted                | `*` forbidden off-loopback                                                   |
| `RAGNAROK_SESSION_IDLE_TTL_MS` / `RAGNAROK_MAX_SESSIONS` / `RAGNAROK_RATE_LIMIT_PER_MINUTE` | 1800000 / 100 / 100       | HTTP session hygiene                                                         |
| `RAGNAROK_RESET_STORAGE` (or `--reset-storage`)                                             | —                         | Back up legacy storage and initialize v2                                     |
| `RAGNAROK_IGNORE_LOCK`                                                                      | —                         | Bypass the storage lock (unsafe with concurrent writers)                     |
| `RAGNAROK_LOG_LEVEL`                                                                        | `info`                    | debug/info/warn/error (stderr only — stdout is protocol-clean in stdio mode) |

### Storage file map

See §5. Rule of thumb: JSON indexes are atomic-write, LanceDB tables are mergeInsert-reconciled, `storage-format.json`/`.ragnarok.lock`/`backup-v1-*` are infrastructure (excluded from the data gate), and everything else under the storage dir is owned by exactly one store class.
