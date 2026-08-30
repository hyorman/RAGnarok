# RAGnarōk architecture

This document describes the v0.7 implementation. Future work is identified as
such; passing unit tests is not presented as release evidence.

## Surfaces

`@ragnarok/core` owns ingestion, embedding, retrieval, reranking, memory,
archives, migration, and LanceDB persistence.
`@ragnarok/vscode` adapts the core to VS Code. `@ragnarok/mcp-server` exposes
the same core through a stdio child process. Both hosts delegate memory behavior
to core `MemoryService` and graph projection to `GraphVisualizationService`, but
they intentionally use separate storage roots: VS Code uses its extension
`globalStorageUri`, while MCP uses configured `RAGNAROK_STORAGE_DIR`. There is
no cross-host data sharing or automatic migration.

| Surface           | Intended topology      | Authority     |
| ----------------- | ---------------------- | ------------- |
| VS Code extension | One user and workspace | Local OS user |
| MCP stdio         | Local child process    | Local OS user |

The MCP server serves stdio only. It opens no socket, so there is no listener,
no TLS configuration, no browser origin policy, no bearer token, and no
network-reachable surface to harden. Its trust boundary is the operating-system
user who spawned it, exactly like the VS Code extension's.

## Storage

The configured storage root has one v2 marker and one lease file:

```text
<storage>/
  storage-format.json
  .ragnarok.lock
  database/
    topics.json
    topic-<id>-documents.json
    lancedb/
  memory-lancedb/
  memory-manifest.json
  exports/
```

Some directories are created only when their feature is used. Shared/common
legacy stores may instead begin with a flat `topics.json`/`lancedb` layout;
the offline migrator converts that layout. See [MIGRATION.md](MIGRATION.md).

`.ragnarok.lock` is present only while a lease is held; a graceful release
marks it released and unlinks it.

Reads take no lease at all, so any number of processes — VS Code windows, MCP
servers, the migration CLI's read-only paths — may open and read one storage
root concurrently. Coordination is on the write side:

- **Operation leases.** Each mutation acquires the lease, runs WAL recovery,
  reloads canonical state from disk, applies its change, and releases. The
  acquisition waits (about five seconds by default, polling) for a live
  foreign holder and then throws a typed `StorageBusyError`; the caller
  reports it as a retryable "storage is busy" condition rather than a failure
  of the operation itself. An ingestion holds one lease for the whole call,
  kept alive by the heartbeat.
- **Full exclusion.** Migration and rollback take a session lease for their
  entire duration. That acquisition fails fast with `StorageLockHeldError`,
  which is what other processes report as "another window is migrating".
  Reset holds exclusion for its whole operation too, but through an operation
  lease: it waits the bounded time and reports `StorageBusyError` rather than
  failing fast.
- **Recovery is writer-only.** Journal and WAL rollback happen under a lease,
  so a reader serves the previous consistent snapshot instead of rolling back
  a foreign writer's in-flight transaction. Readers revalidate through a
  storage-directory watcher that emits external-change events.

The lease itself uses an owner token, PID/host identity, heartbeat, and
generation-scoped stale reclamation. Same-host live PIDs are never reclaimed
merely for age. Storage v2 readers fail closed on corrupt or unsupported
metadata. `RAGNAROK_IGNORE_LOCK=1` bypasses both lease kinds entirely and is
unsafe with concurrent writers.

Topic ingestion stages data and metadata under a durable journal. Archive
import validates the central directory, normalized paths, duplicates,
case-collisions, sizes, compression ratio, manifest coverage, schemas, and
checksums before publication. Memory entry and memory-graph views use
feature-local recovery journals. Those journals are before-image based and can
be expensive for very large scopes; a unified WAL is future optimization.

## Retrieval semantics

- `vector`: LanceDB squared-L2 is converted to the unit-vector cosine score
  contract.
- `bm25`: lexical BM25 retrieval.
- `hybrid`: weighted vector and lexical evidence.

These are the only strategies. There is no document knowledge graph, no
document entity extraction, and therefore no graph-derived retrieval.

Results expose `scoreKind`, component scores, and effective strategy.

Topic metadata stores the embedding model and its fingerprint, and the topic is
both queried and extended with that recorded model — the configured model is the
default for newly created topics, not a global switch. A dimension mismatch or a
missing fingerprint is a hard reindex error and is not swallowed by a partial
result. A foreign remote embedding endpoint is refused rather than substituted.

Cross-encoder reranking leases the active model generation so in-flight work
can drain during a model switch. Cancellation propagates rather than returning
stale first-stage results.

## Memory

Memory is personal to the local user. Workspace and explicit
branch scopes are separate; detached HEAD never silently becomes workspace.
Recall excludes superseded, expired, below-confidence, and reserved automatic
entries unless explicitly requested. Only memories whose referenced entities
are all facts receive fact immunity. The memory graph is a directed multigraph,
so different relationship types may connect the same ordered pair. It is the
only graph in the system: it is populated by memory entity extraction, which
requires an LLM provider, and it is exposed read-only through
`rag_memory_visualize`. Memory is read and written only through explicit
`rag_memory` operations.

VS Code exposes the core services as exactly three native language-model tools:
read-only `ragQuery` and `ragTopic`, and `ragMemory` for scoped store, recall,
forget, list, and stats operations. There is no reset tool — an irreversible
wipe is **Reset Memory** in the sidebar's Memory section, behind a modal
confirmation. The three input schemas are generated from the canonical JSON
Schema contracts in `@ragnarok/core` and drift-checked by
`npm run tools:manifest:check`; the MCP server's Zod schemas are asserted
equivalent to the same contracts by a parity test. Both hosts run one
implementation per shared action: `executeQueryTool` for query, `executeTopicRead`
for topic `list` and `stats`, and `normalizeMemoryInput` plus the same
`MemoryService.execute` for memory. Its **RAGnarok: Show Memory Graph**
command opens a nonce-protected local webview. MCP retains `rag_memory`,
`rag_reset_memory` — still a tool, confirmed by `confirm: true`, because a
headless agent has no sidebar to click — and `rag_memory_visualize`, whose graph
appears as an inline MCP App. The private `@ragnarok/graph-ui` workspace supplies
shared renderer source with separate VS Code and MCP lifecycle bridges.

## MCP protocol surface

The MCP server registers 8 tools unconditionally. There are no roles, no
capability tiers, and no per-principal registration: the client that spawned
the process already has the owner's authority, so a second authorization model
inside the process would protect nothing.

RAGnarok serves only MCP `2026-07-28` over stdio. Modern clients begin with
`server/discover`; legacy `initialize` is rejected. There is no
`Mcp-Session-Id` and no request-scoped session state. Cacheable discovery,
list, and resource-read results advertise `ttlMs=0` and `cacheScope=private`.

The server emits no audit ledger. Its stderr log is operational evidence for the
local user, not an attributable identity record, because every request already
comes from that user.

File ingestion reads paths on the machine running the server, restricted to
canonical `security.allowedPaths` roots. There is no upload or download
handle: a client that needs to index a file places it somewhere the server may
read.

## Build and release

Package creation starts from a clean build and exact lockfile. Native
artifacts are verified before extraction. NOTICE, model provenance,
CycloneDX/SPDX SBOMs, budgets, artifact digests, and SLSA-compatible
provenance are release inputs.

The graph build emits three checked artifacts: the self-contained MCP HTML
bundle in MCP source and `media/memoryGraph.js` plus `media/memoryGraph.css` for
VS Code. A VSIX contains only the two generated VS assets, never graph-ui or MCP
source. Docker uses graph-ui source only while regenerating the MCP bundle and
does not copy that source or VS webview assets into the runtime image.

The release manifest binds source commit, lockfile, policy, artifacts, gate
runs, and attestation. Publish commands never rebuild. Docker and six installed
VSIX gates remain required even when local development cannot execute them.
See [docs/RELEASE.md](docs/RELEASE.md) and
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).
