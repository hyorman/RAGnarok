# RAGnarōk architecture

This document describes the v0.4 implementation. Future work is identified as
such; passing unit tests is not presented as release evidence.

## Surfaces

`@ragnarok/core` owns ingestion, embedding, retrieval, reranking, topic
knowledge graphs, memory, archives, migration, and LanceDB persistence.
`@ragnarok/vscode` adapts the core to VS Code. `@ragnarok/mcp-server` exposes
the same core through local stdio or Streamable HTTP.

| Surface               | Intended topology                          | Authority                                               |
| --------------------- | ------------------------------------------ | ------------------------------------------------------- |
| VS Code extension     | One user and workspace                     | Local OS user                                           |
| MCP stdio             | Local child process                        | Local owner/admin                                       |
| MCP HTTP, local mode  | Loopback personal service                  | Reader/curator/admin tokens; tokenless only on loopback |
| MCP HTTP, shared mode | Private backend behind a trusted TLS proxy | Reader, curator, and admin are structurally distinct    |

The HTTP listener supports native TLS when certificate and key paths are
configured. It also supports cleartext only as a private backend behind an
explicitly trusted TLS-terminating proxy. A remote deployment must expose only
the verified TLS endpoint and configure an exact browser origin.

## Storage

The configured storage root has one v2 marker and one lease:

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
  checkpoints-lancedb/
  exports/
  .transfers/
```

Some directories are created only when their feature is used. Shared/common
legacy stores may instead begin with a flat `topics.json`/`lancedb` layout;
the offline migrator converts that layout. See [MIGRATION.md](MIGRATION.md).

The storage lease uses an owner token, PID/host identity, heartbeat, and
generation-scoped stale reclamation. Same-host live PIDs are never reclaimed
merely for age. Storage v2 readers fail closed on corrupt or unsupported
metadata.

Topic ingestion stages data and metadata under a durable journal. Archive
import validates the central directory, normalized paths, duplicates,
case-collisions, sizes, compression ratio, manifest coverage, schemas, and
checksums before publication. Memory entry/graph views and topic graph
entity/edge views use feature-local recovery journals. Those journals are
before-image based and can be expensive for very large scopes; a unified WAL
is future optimization.

## Retrieval and graph semantics

- `vector`: LanceDB squared-L2 is converted to the unit-vector cosine score
  contract.
- `bm25`: lexical BM25 retrieval.
- `hybrid`: weighted vector and lexical evidence.
- `ensemble`: reciprocal-rank fusion.
- `graph`: entity matching plus graph traversal and chunk provenance.
- `graph_hybrid`: graph and vector fusion.

Results expose `scoreKind`, component scores, effective strategy, matched
entities, hop depth, and fallback reason. A graph request that falls back to
vector is labeled vector; graph failure is not disguised as graph evidence.
Dimension mismatch and orthogonal entity vectors are not matches.

Knowledge-graph metadata stores the embedding fingerprint. A fingerprint
mismatch is a hard reindex error and is not swallowed by hybrid fallback.
Indexing with an LLM builds entity/relationship provenance; without an LLM,
graph extraction is skipped rather than fabricated.

Cross-encoder reranking leases the active model generation so in-flight work
can drain during a model switch. Cancellation propagates rather than returning
stale first-stage results.

## Memory

Memory is personal and absent from shared deployments. Workspace and explicit
branch scopes are separate; detached HEAD never silently becomes workspace.
Recall excludes superseded, expired, below-confidence, and reserved automatic
entries unless explicitly requested. Only memories whose referenced entities
are all facts receive fact immunity. The graph is a directed multigraph, so
different relationship types may connect the same ordered pair.

## MCP protocol, authorization, and transfer

Readers receive query/list/status tools. Curators add and remove topic content
but cannot perform administrative model/storage/import/export operations.
Admins receive the complete non-memory shared surface. Memory tools exist only
in local mode.

RAGnarok 0.5.0 serves only MCP `2026-07-28`. Modern clients begin with
`server/discover`; legacy `initialize` is rejected. HTTP MCP traffic is
request-scoped and POST-only, while `GET /mcp` and `DELETE /mcp` return `405`.
There is no `Mcp-Session-Id`.

Shared bearer credentials are evaluated on every request. Rotation therefore
affects the next request and has no sessions to invalidate. Cacheable discovery,
list, and resource-read results advertise `ttlMs=0` and `cacheScope=private`.
MCP request audit records contain a hashed principal, role, method, name, outcome, and correlation
identifier. Transfer and operator token-rotation records retain action, object, outcome, and correlation
identifier. These are operational logs, not a tamper-proof human identity system.

Remote files use bounded, checksum-declared, principal-bound, expiring upload
and download handles. Server-mounted paths remain restricted to configured
roots and are not client-local paths.

## Build and release

Package creation starts from a clean build and exact lockfile. Native
artifacts are verified before extraction. NOTICE, model provenance,
CycloneDX/SPDX SBOMs, budgets, artifact digests, and SLSA-compatible
provenance are release inputs.

The release manifest binds source commit, lockfile, policy, artifacts, gate
runs, and attestation. Publish commands never rebuild. Docker and six installed
VSIX gates remain required even when local development cannot execute them.
See [docs/RELEASE.md](docs/RELEASE.md) and
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).
