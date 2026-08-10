# Operations guide

This guide covers the v0.4 storage surface and v0.5 MCP deployment surface. Read
[SECURITY.md](SECURITY.md) before exposing HTTP outside a developer machine and
[MIGRATION.md](../MIGRATION.md) before opening a pre-v0.4 store.

## Storage layout and ownership

The configured `RAGNAROK_STORAGE_DIR` is one atomic administrative unit:

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
  .transfers/
```

Feature-specific directories are created lazily. Give the service account read
and write access to the storage root; do not share one root between concurrent
processes. The storage lease intentionally fails a second process fast. Do not
set `RAGNAROK_IGNORE_LOCK=1` unless a separate, tested single-writer mechanism
protects the entire root.

Server-side file ingestion is limited to `RAGNAROK_ALLOWED_PATHS` (the working
directory by default). These paths are paths on the server, not paths on a
remote MCP client. Shared clients should use the binary transfer protocol.

## Backup and recovery

Stop admission and let in-flight requests drain before copying storage. Back up
the complete storage root, including its version marker and feature stores.
Filesystem snapshots are preferred. A file-by-file copy while the process is
writing is not a supported consistency boundary.

To restore:

1. Stop every process using the storage root.
2. Preserve the failed/current root separately.
3. Restore the complete snapshot to a same-filesystem staging directory.
4. Verify `storage-format.json`, file ownership, and free space.
5. Atomically rename the restored directory into place.
6. Start one process and verify `/ready`, topic listing, representative vector
   and hybrid queries, and memory recall when memory is enabled.

Archive export/import is for moving individual topics, not for backing up the
complete service. Imports validate archive paths, limits, schemas, and
checksums. Shared-mode archive import is admin-only and uses an uploaded handle.

For a legacy store, first run the dry-run migration and retain its immutable
backup. The exact commands, rollback behavior, and exit codes are in
[MIGRATION.md](../MIGRATION.md).

## HTTP lifecycle

- `GET /health` proves the process is alive.
- `GET /ready` proves it is accepting work and its dependencies are ready.
- `POST /mcp` implements stateless MCP `2026-07-28` requests.
- `GET /mcp` and `DELETE /mcp` return `405`.
- `POST /transfer/uploads`, `PUT /transfer/uploads/:id`, and
  `GET /transfer/downloads/:id` implement bounded binary transfer.

On shutdown, admission closes first, active work drains up to
`RAGNAROK_SHUTDOWN_DRAIN_MS` (10 seconds by default), and the listener stops.
Configure the orchestrator grace period above that value.

There is no `Mcp-Session-Id`; shared bearer credentials are evaluated on every
request. Token rotation is an in-process operator API, not an HTTP endpoint,
and affects the next request because there are no sessions to invalidate.
Environment changes take effect after process restart unless the embedding host
calls the rotation API directly.

Clients must use `server/discover` or modern version negotiation; legacy
`initialize` is rejected. Cacheable discovery, list, and resource-read results
advertise `ttlMs=0` and `cacheScope=private`.

## Memory graph visualization operations

Graphs exist only in the memory subsystem, and memory is always personal, so
`rag_graph_visualize` is **not registered at all in shared deployments** —
`tools/list` omits it and any call is an unknown-tool error. It is registered
for local stdio and local HTTP curators and admins whenever a memory store is
present. Do not monitor for an authorization error code here; absence of the
tool is the shared-mode contract.

The graph MCP App is registered at `ui://ragnarok/graph`. Verify that both
`resources/list` and `resources/read` report
`text/html;profile=mcp-app`, and that `rag_graph_visualize` advertises only
`_meta.ui.resourceUri`. The generated response is one self-contained HTML shell
with inline code, an SVG, and reset control; it must not load external scripts.

The tool accepts only the two documented workspace-memory and branch-memory
discriminated inputs and emits `ragnarok.graph.visualization.v1`. `maxNodes`
defaults to 500 and is bounded at 2,000; edge work is bounded at 10,000,
followed by response-byte reduction. Scopes and branches without stored memory
entities are healthy empty results, not incidents.
`GRAPH_VISUALIZATION_RECORD_TOO_LARGE` and `GRAPH_VISUALIZATION_FAILED` are the
stable error codes to monitor.

The memory graph is populated by memory entity extraction, which requires a
configured LLM provider. Without one the graph stays empty and every
visualization is an empty document — that is expected, not a failure. Successful
graph data contains full node/edge details; embedding vectors must never appear.

The app visibly transitions through loading, ready, empty, and accessible error
states. Keyboard operators can traverse graph items with arrows, open details
with Enter/Space, close with Escape, and reset the fitted viewport. A missing
or malformed result must show an alert rather than stale graph content. The VS
Code webview remains deferred and is not an operational surface in this release.

## Transfers and limits

An upload has two phases: create a handle by declaring basename, media type,
byte size, kind, and SHA-256; then PUT the exact body to the returned path.
Handles are principal-bound, non-resumable, single-consumer, and expire. A
topic export prepares a principal-bound, single-use download handle.

Defaults:

| Limit                             | Environment variable                    |    Default |
| --------------------------------- | --------------------------------------- | ---------: |
| JSON request                      | `RAGNAROK_MAX_REQUEST_BYTES`            |      1 MiB |
| Tool response                     | `RAGNAROK_MAX_RESPONSE_BYTES`           |      1 MiB |
| One transfer                      | `RAGNAROK_TRANSFER_MAX_FILE_BYTES`      |     64 MiB |
| Active upload bytes per principal | `RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES` |    256 MiB |
| Active uploads per principal      | `RAGNAROK_TRANSFER_MAX_SESSIONS`        |          8 |
| Transfer lifetime                 | `RAGNAROK_TRANSFER_TTL_MS`              | 15 minutes |

Document uploads accept `.md`, `.markdown`, `.txt`, `.html`, `.htm`, and
`.pdf` with an approved content type. Archive uploads require `.rag`. Size and
SHA-256 are checked while streaming; partial or invalid uploads are removed.

## Containers

The supplied container runs as a non-root user with a read-only root
filesystem, `no-new-privileges`, a bounded `/tmp` tmpfs, and one writable data
volume at `/data/ragnarok`. Place exports and transfer staging under that
volume. Do not mount the Docker socket or broad host directories.

Before deploying, set an explicit deployment mode, all required distinct
tokens, an exact browser origin, and either native TLS files or explicit trusted
proxy IP addresses. The supplied Compose file chooses native TLS: certificate,
private-key, and health-check CA files are mounted as read-only secrets, and
the certificate hostname is used for readiness verification. Only the TLS
endpoint should be reachable by clients. See [SECURITY.md](SECURITY.md).

For a custom trusted-proxy deployment, set `RAGNAROK_HEALTHCHECK_HOST` to one
exact entry in `RAGNAROK_ALLOWED_HOSTS` and include `127.0.0.1` in
`RAGNAROK_TRUSTED_PROXIES`. The container health check then sends an internal
readiness request with that Host and `X-Forwarded-Proto: https`; this loopback
exception is only for the in-container probe. Also list the proxy bridge/source
IP explicitly so real forwarded client requests pass transport enforcement.

## Routine checks

Monitor readiness, process restarts, storage free space, transfer quota
failures, rate limiting, and audit outcomes. Treat corruption, unsupported
storage markers, fingerprint mismatches, and failed migration validation as
hard operator incidents; do not reset storage until its backup and recovery
path have been reviewed.
