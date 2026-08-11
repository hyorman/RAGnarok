# Operations guide

The MCP server is a stdio child process spawned by one MCP client on one
machine. It opens no socket, so this guide has no listener, certificate, token,
or endpoint sections — operating it means operating its storage directory and
its model configuration. Read [SECURITY.md](SECURITY.md) for the trust boundary
and [MIGRATION.md](../MIGRATION.md) before opening a pre-v0.4 store.

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
```

Feature-specific directories are created lazily. Give the account that spawns
the server read and write access to the storage root.

## The single-writer lock

Do not share one storage root between concurrent processes — a VS Code window,
an MCP server, and the migration CLI all take the same lease. `.ragnarok.lock`
records the holder's PID and host and is refreshed by heartbeat; a second
process fails fast with a message naming the holder rather than corrupting the
store. A crashed holder's lease goes stale after roughly five minutes and is
then reclaimable, but a live same-host PID is never reclaimed merely for age.

Do not set `RAGNAROK_IGNORE_LOCK=1` unless a separate, tested single-writer
mechanism protects the entire root.

The most common operational surprise is a second MCP client — or a VS Code
window left open — pointed at the same `RAGNAROK_STORAGE_DIR`. Give each client
its own root, or accept that only one may run at a time.

## Backup and recovery

Stop the server and let in-flight tool calls drain before copying storage
(`RAGNAROK_SHUTDOWN_DRAIN_MS`, 10 seconds by default, bounds the drain on
SIGINT/SIGTERM; the process then exits). Back up the complete storage root,
including its version marker and feature stores. Filesystem snapshots are
preferred. A file-by-file copy while the process is writing is not a supported
consistency boundary.

To restore:

1. Stop every process using the storage root.
2. Preserve the failed/current root separately.
3. Restore the complete snapshot to a same-filesystem staging directory.
4. Verify `storage-format.json`, file ownership, and free space.
5. Atomically rename the restored directory into place.
6. Start one server, then verify through the client: `rag_storage_status`,
   `rag_list_topics`, representative vector and hybrid `rag_query` calls, and a
   `rag_memory` recall.

Archive export/import is for moving individual topics, not for backing up the
complete service. `rag_export_topic` writes a checksummed `.rag` archive into
`RAGNAROK_EXPORT_DIR` (`<storage>/exports` by default). `rag_import_topic`
reads an archive from a canonical `RAGNAROK_ALLOWED_PATHS` root and validates
archive paths, limits, schemas, and checksums before publication.

For a legacy store, first run the dry-run migration and retain its immutable
backup. The exact commands, rollback behavior, and exit codes are in
[MIGRATION.md](../MIGRATION.md).

## Model configuration

Embedding, reranker, and LLM settings are read from the environment at startup;
the MCP client that spawns the server owns them. Changing one means editing the
client's server entry and restarting the process.

- `RAGNAROK_EMBEDDING_MODEL` and `RAGNAROK_EMBEDDING_PROVIDER` select the
  embedding backend. Each topic persists its embedding fingerprint, so a
  mismatch is a hard reindex error rather than a silently degraded result.
  Switching models at runtime with `rag_switch_embedding_model` has the same
  consequence: topics indexed under the old model need reindexing.
- `RAGNAROK_RERANKER_ENABLED` and `RAGNAROK_RERANKER_MODEL` control the bundled
  cross-encoder. A model switch leases the active generation so in-flight work
  drains rather than returning stale first-stage results.
- `RAGNAROK_LLM_PROVIDER` gates agentic query planning, memory entity
  extraction, and `rag_memory` community clustering. With `none`, those degrade
  to documented empty or explanatory results — not failures.
  `RAGNAROK_LLM_REQUEST_TIMEOUT_MS` (30 seconds by default) bounds one request.

`RAGNAROK_MAX_RESPONSE_BYTES` (1 MiB by default) caps one serialized tool
response. A result that cannot be reduced below it returns a stable error
rather than a truncated document.

## Memory graph visualization operations

Graphs exist only in the memory subsystem. `rag_graph_visualize` is registered
like every other tool and returns a deterministic
`ragnarok.graph.visualization.v1` document.

The graph MCP App is registered at `ui://ragnarok/graph`. Verify that both
`resources/list` and `resources/read` report
`text/html;profile=mcp-app`, and that `rag_graph_visualize` advertises only
`_meta.ui.resourceUri`. The generated response is one self-contained HTML shell
with inline code, an SVG, and reset control; it must not load external scripts.

The tool accepts only the two documented workspace-memory and branch-memory
discriminated inputs. `maxNodes` defaults to 500 and is bounded at 2,000; edge
work is bounded at 10,000, followed by response-byte reduction. Scopes and
branches without stored memory entities are healthy empty results, not
incidents. `GRAPH_VISUALIZATION_RECORD_TOO_LARGE` and
`GRAPH_VISUALIZATION_FAILED` are the stable error codes to monitor.

The memory graph is populated by memory entity extraction, which requires a
configured LLM provider. Without one the graph stays empty and every
visualization is an empty document — that is expected, not a failure. Successful
graph data contains full node/edge details; embedding vectors must never appear.

The app visibly transitions through loading, ready, empty, and accessible error
states. Keyboard operators can traverse graph items with arrows, open details
with Enter/Space, close with Escape, and reset the fitted viewport. A missing
or malformed result must show an alert rather than stale graph content. The VS
Code webview remains deferred and is not an operational surface in this release.

## Containers

The supplied image runs the same stdio server as a non-root user with a
read-only root filesystem, `no-new-privileges`, a bounded `/tmp` tmpfs, and one
writable data volume at `/data/ragnarok`. It publishes no port and exposes no
health endpoint, because a stdio process has neither. Keep storage and exports
under the data volume. Do not mount the Docker socket or broad host
directories.

```sh
npm run docker:build
docker run -i --rm --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:size=256m \
  -v ragnarok-data:/data/ragnarok ragnarok-mcp
```

`npm run docker:run` carries that exact invocation. The container is a child of
the MCP client: `-i` keeps stdin open as the transport, `--rm` discards the
container while the volume keeps the store, and liveness is the client's
connection, not a probe. Use a host directory (`-v /path/on/host:/data/ragnarok`)
when the store must be visible outside Docker.

## Routine checks

Monitor process restarts, storage free space, and stderr for lock contention
and provider errors. Treat corruption, unsupported storage markers, fingerprint
mismatches, and failed migration validation as hard operator incidents; do not
reset storage until its backup and recovery path have been reviewed.
