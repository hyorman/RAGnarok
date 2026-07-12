# RAGnarok 0.4.0 Full Functional Release Plan

## Summary and locked decisions

Deliver every item from the existing comprehensive plan plus the newly reproduced failures. Release only when there are no known open correctness, durability, security, packaging, or lifecycle defects.

Locked decisions:

- Keep release version `0.4.0`; both npm package names are currently unpublished.
- Use a clean storage-format reset instead of migrating current branch data.
- Keep embedding and reranker models bundled for offline use.
- Complete stabilization, missing MCP features, checkpointing, LangGraph parity, VS Code memory wiring, hardening, and documentation in one release train.
- VS Code and stdio MCP are trusted read/write owners.
- HTTP supports parallel readers and serialized writers through separate read/write tokens.
- Remote providers require deterministic contract tests, but live paid-provider calls are not release gates.
- `langGraphEnabled` and automatic query memory remain disabled by default.

## Implementation changes

### 1. Storage v2 and durable persistence

- Introduce `storage-format.json` with format version `2`. Empty installations initialize it automatically; non-empty unversioned storage fails closed.
- Add `--reset-storage` and `RAGNAROK_RESET_STORAGE=1`. Reset first moves managed data into a timestamped backup, rolls back moves on failure, then initializes v2. VS Code presents an explicit confirmation dialog.
- Replace direct JSON writes for topic/document indexes with temporary-file, fsync, and atomic rename.
- Create LanceDB tables with explicit Arrow schemas rather than inferring schema from the first row.
- Give every indexed source a stable `documentId`, every chunk a stable `chunkId`, and persist a normalized source descriptor.
- Normalize every chunk row to the same typed columns, including defaults for Markdown, location, heading, file, and source fields. Mixed TXT/Markdown/HTML/PDF ingestion must work in any order.
- Reingesting a source reconciles chunks through `mergeInsert(chunkId)` and removes obsolete chunks for that document instead of duplicating them.
- Add a small ingestion journal so startup can finish metadata bookkeeping after a crash between vector and index commits.
- Convert all LanceDB/Arrow vectors with `Array.from()` at read boundaries.
- Replace memory and knowledge-graph drop/recreate saves with explicit-schema row-level insert, update, merge, and delete operations. Empty collections retain empty tables.
- Add `dispose()` to every LanceDB-backed store and close tables/connections deterministically.

### 2. Embeddings, reranking, and document correctness

- Load the bundled cross-encoder with Transformers.js v3 `dtype: "q8"`.
- Catch reranker initialization and scoring failures inside the degradation boundary; queries retain first-stage results if reranking fails.
- Add `rerankerEnabled` configuration, defaulting to true, with MCP env and VS Code settings.
- Make reranker switches transactional: initialize a replacement instance first, swap only after success, and retain the previous working model on failure.
- Define `EmbeddingFingerprint` containing backend kind, provider format, model, revision, dimension, and a non-secret normalized endpoint hash.
- Persist the fingerprint per topic and in the standalone memory manifest. Distinguish `remote:openai` from `remote:ollama`.
- Reject every memory embedding change when stored memories use a different fingerprint—even when dimensions match. Provide a confirmed `rag_reset_memory` operation.
- Make embedding switches transactional using a temporary backend/model probe before changing global state or rebuilding topic services.
- Validate remote embedding responses: exact result count, indices, finite numeric values, non-empty vectors, consistent dimensions, and correct empty-batch behavior.
- Treat vector commit as successful ingestion even if optional graph extraction fails. Return `graphExtracted:false` and warnings without retrying or duplicating vectors.
- Track graph provenance by document/chunk so reingestion and document removal update shared entities without deleting references owned by other documents.

### 3. MCP transport, access, and lifecycle

- Preserve `RAGNAROK_API_KEY` as the HTTP read token and add `RAGNAROK_WRITE_API_KEY` as the write token. Tokens must differ.
- On non-loopback binds, require at least a read token. With no write token, the server is intentionally read-only. Loopback without tokens remains read/write for local development.
- Fix an HTTP session’s role at initialization:
  - Read-token sessions receive read capabilities.
  - Write-token sessions receive read/write capabilities.
  - Later requests must match the initialized session’s token role.
- Register write tools only for writer sessions where possible; guard mixed tools such as `rag_memory` per action.
- Ensure reader queries cause zero durable writes: disable recall reinforcement, automatic memorization, decay mutation, and other hidden write paths.
- Serialize HTTP mutations through one process-level write coordinator while allowing queries, lists, stats, and other reads to run concurrently.
- Pass MCP handler `extra.signal` through `RAGQueryService`, embeddings, reranking, LLM calls, LangGraph, and ingestion. Cancellation must stop follow-up work and prevent post-cancel writes.
- Add session idle TTL, maximum session count, configurable rate limit, and direct `cors`/`express-rate-limit` dependencies.
- Make shutdown idempotent: stop admission, abort active work, close sessions, flush memory, close stores/checkpointers/models, set `process.exitCode`, and let Node drain naturally. Use a bounded hard-exit timer only as a final fallback.
- Handle stdio EOF through the same shutdown path.
- Remove the native `SIGABRT` by closing LanceDB connections and ONNX sessions before process termination; require repeated clean exit-code-zero tests.
- Harden Docker: non-root runtime, production-only dependencies, required auth for published binds, restricted CORS, writable volume ownership, health/readiness endpoints, and no secrets in logs.

### 4. LangGraph, memory, common databases, and retrieval quality

- Wire `LanceDBCheckpointSaver` into MCP and VS Code when LangGraph is enabled.
- Use deterministic ingestion thread IDs from topic, normalized source, and source revision. Resume incomplete ingestion and delete checkpoints after successful completion plus retention expiry.
- Keep checkpoint state bounded: clear loaded documents after chunking, avoid serializing model/store objects, and enforce checkpoint-size tests.
- Use per-query thread IDs; clean successful query checkpoints immediately unless debugging retention is enabled.
- Make automatic query memory opt-in (`queryMemoryEnabled=false`), require confidence ≥0.7, tag entries `auto:query-insight`, and exclude reserved `auto:` entries from normal recall/list unless `includeAuto=true`.
- Add memory TTL through `ttlDays`, persist `expiresAt`, incorporate effective confidence into recall, and normalize memory/entity score scales.
- Persist graph cleanup after every forget operation and repair version chains by reinstating the previous version when the latest entry is removed.
- Resolve branch scope consistently for links, accept `ids:string[]` for promotion, and retain the comma-separated `id` form for this release only.
- Replace LangGraph’s string-appending refinement with the shared legacy gap-analysis/follow-up implementation.
- Evaluate confidence on deduplicated results using one consistent score domain; prevent accumulated or reranked results from forcing unnecessary iterations.
- Track real result counts per sub-query and normalize chunk identifiers across vector, graph, hybrid, and LangGraph paths.
- Make graph fallback explicit in responses with `graphUsed`, `fallbackReason`, matched entities, and hop depth.
- Route common/read-only topic vector metadata, embeddings, documents, caches, and knowledge graphs through the common database location. Cache keys include both location and topic ID.
- Validate common topics with intentionally different embedding fingerprints and enforce read-only behavior.
- Cache LLM availability briefly, use consistent provider checks, validate streaming payloads, and refresh provider defaults.
- Replace synchronous Git branch detection with asynchronous `.git/HEAD`/worktree resolution.
- Dispose ONNX sessions explicitly and align reranker over-fetch with its actual candidate limit.

### 5. Product/API completeness

Add MCP operations with validation, access annotations, and per-item outcomes:

- `rag_list_documents`
- `rag_delete_topic`
- `rag_remove_document`
- `rag_rename_topic`
- `rag_add_url`
- `rag_add_github_repo`
- `rag_export_topic`
- `rag_import_topic`
- `rag_reset_memory`
- `rag_storage_status`

Behavior:

- Destructive operations require writer access and explicit confirmation fields.
- Web ingestion permits HTTP(S), resolves and validates every redirect, blocks loopback/private/link-local destinations, limits response size/time, and parses the already-fetched content instead of fetching twice.
- GitHub ingestion accepts only configured GitHub/GHES hosts; credentials come from environment/secret storage, never tool arguments or logs.
- Export writes v2 archives under a configured export directory and returns path, size, and SHA-256. Archives include topic metadata, documents, vectors, graph data, fingerprints, and checksums.
- Import enforces allowlisted paths, archive/version/checksum validation, decompression limits, and traversal protection.
- Document removal deletes its vector rows, graph provenance, document metadata, and cached agents, then reconciles counts.
- Wire `MemoryStore` into VS Code’s LangGraph dependencies using extension storage and the current workspace. Add settings for reranking, query memory, and automatic-memory visibility; a full memory UI remains outside this release.
- Keep bundled models but add a manifest containing filenames, SHA-256, role, dtype, and expected dimension. Packaging fails when any required artifact is missing or renamed.

## Public contracts and configuration

- Extend `VectorStoreMetadata` with `schemaVersion` and `embeddingFingerprint`.
- Add `DocumentSource` as a discriminated union for file, URL, and GitHub inputs; retain `addDocuments(string[])` as a compatibility wrapper over `addSources()`.
- Add `TopicManager.listDocuments()`, `removeDocument()`, and source-aware ingestion/reconciliation methods.
- Extend pipeline metadata with `graphExtracted`, `partial`, `documentId`, and structured warnings.
- Extend memory options with `ttlDays`, `includeAuto`, and `reinforce`; readers always force `reinforce=false`.
- Extend query results with graph participation/fallback fields and accurate per-sub-query counts.
- Add configuration for reranker enablement, query memory, read/write HTTP tokens, session TTL/cap, rate limit, export directory, GitHub hosts/token, checkpoint retention, and explicit storage reset.
- Keep package version `0.4.0`, but use storage format v2 and `.rag` export format 2.0. Older branch storage/archives are rejected with actionable reset messages rather than interpreted optimistically.
- Pin release-critical direct dependencies to the exact versions validated by CI and declare the supported Node engine range.

## Test and release gates

### Deterministic automated coverage

- Unit tests for every changed failure boundary, schema validator, role guard, migration/reset path, model transaction, and cache rollback.
- Real LanceDB tests for restart→mutate→restart, empty stores, forget/promote/history, injected write failures, concurrent reads, and no data loss.
- Mixed-format ingestion in every first-file ordering, including TXT, Markdown, HTML, and PDF; reingestion must replace rather than duplicate.
- Actual bundled-model tests—no symlink or model mocks—for all six retrieval strategies in legacy and LangGraph modes, asserting the expected top document.
- Deterministic local mock servers for OpenAI, Anthropic, Ollama, OpenAI-compatible embeddings, GitHub, and web redirects. No paid credentials are required.
- Fake-LLM graph tests proving entity extraction, persistence, multi-hop retrieval, graph-hybrid fusion, fallback reporting, and common-database graphs.
- Checkpoint crash/resume tests proving completed ingestion stages are not repeated.
- MCP real-process tests covering every tool, reader/write-token permissions, token-role mismatch, parallel readers, serialized mutations, cancellation, session expiry, and protocol-clean stdout.
- Repeat HTTP and stdio shutdown at least 20 times; every process must exit code 0 with no native abort or pending writes.
- Export/import round-trip tests with checksum corruption, traversal, zip-bomb, format-version, and embedding-fingerprint cases.
- Security tests for path symlinks, SSRF/DNS rebinding/redirects, auth timing, secrets in logs, malformed provider payloads, and unauthorized write attempts.

### CI and artifacts

Create CI jobs for:

- Format, zero-warning lint, TypeScript builds, and unit tests.
- Node 20 and 22 compatibility.
- Native real-process tests on Linux, macOS, and Windows.
- VS Code extension tests on Linux with the proposed API enabled.
- npm pack/install/require/stdio smoke tests.
- Docker build, non-root assertion, authenticated functional smoke, persistence, and clean shutdown.
- All six VSIX targets, with installed-content and model-manifest verification.
- Dependency/license audit and artifact-size regression reporting.

Release `0.4.0` only when:

- All CI jobs pass from a clean checkout.
- The four reproduced failures—reranker loading, mixed schemas, restart memory loss, and HTTP `SIGABRT`—have dedicated passing regressions.
- No finding in the comprehensive or functional review remains open without an explicit post-release classification.
- `npm run test:all`, e2e, package smoke, Docker smoke, lint, and format checks are green.
- Documentation matches actual tool counts, defaults, storage reset, graph prerequisites, access roles, checkpoint behavior, and provider support.

## Delivery order

1. Storage v2/reset foundation, explicit schemas, and atomic metadata writes.
2. Reranker, embedding fingerprints, transactional switches, and mixed-format/idempotent ingestion.
3. Memory row-level persistence and restart/data-loss regressions.
4. Real-process e2e harness and CI baseline.
5. HTTP access roles, cancellation, sessions, Docker hardening, and shutdown repair.
6. LangGraph atomicity, checkpointing, refinement parity, and opt-in memory.
7. Common-database routing and retrieval correctness.
8. MCP API completion and VS Code memory wiring.
9. Provider/web/GitHub security contracts, packaging manifests, and dependency pinning.
10. Full documentation reconciliation, cross-platform artifact build, release-candidate soak, and final 0.4.0 publication.
