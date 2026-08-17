# Operations guide

The MCP server is a stdio child process spawned by one MCP client on one
machine. It opens no socket, so this guide has no listener, certificate, token,
or endpoint sections — operating it means operating its storage directory and
its model configuration. Read [SECURITY.md](SECURITY.md) for the trust boundary
and [MIGRATION.md](../MIGRATION.md) before opening a pre-v0.4 store.

The VS Code extension uses its own `globalStorageUri`; it does not use
`RAGNAROK_STORAGE_DIR`. The hosts share core implementation but there is no
cross-host data sharing. Back up and operate the two roots independently.

## Storage layout and ownership

The configured `RAGNAROK_STORAGE_DIR` is one atomic administrative unit:

```text
<storage>/
  storage-format.json
  config.json
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

`config.json` is the optional settings file described under
[model configuration](#model-configuration). It is part of the administrative
unit: back it up with the store, and treat it as readable by anything that can
read the store — which is why no credential is ever kept in it.

## The single-writer lock

Do not share one MCP storage root between concurrent MCP servers or migration
CLI processes. They take the same lease. VS Code uses a separate extension
storage root and takes its own lease there. `.ragnarok.lock` records the holder's
PID and host and is refreshed by heartbeat; a second process fails fast with a
message naming the holder rather than corrupting the store. A crashed holder's
lease goes stale after roughly five minutes and is then reclaimable, but a live
same-host PID is never reclaimed merely for age.

Do not set `RAGNAROK_IGNORE_LOCK=1` unless a separate, tested single-writer
mechanism protects the entire root.

The most common operational surprise is a second MCP client pointed at the same
`RAGNAROK_STORAGE_DIR`. Give each client its own root, or accept that only one
may run at a time.

## Backup and recovery

Stop the server and let in-flight tool calls drain before copying storage
(`limits.shutdownDrainMs`, 10 seconds by default, bounds the drain on
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
6. Start one server, then verify through the client: `rag_topic` (`list`),
   representative vector and hybrid `rag_query` calls, and a
   `rag_memory` recall.

Archive export/import is for moving individual topics, not for backing up the
complete service. `rag_topic` (`export`) writes a checksummed `.rag` archive into
`storage.exportDir` (`<storage>/exports` by default). `rag_topic` (`import`)
reads an archive from a canonical `security.allowedPaths` root and validates
archive paths, limits, schemas, and checksums before publication.

For a legacy store, first run the dry-run migration and retain its immutable
backup. The exact commands, rollback behavior, and exit codes are in
[MIGRATION.md](../MIGRATION.md).

## Model configuration

Embedding, reranker, and LLM settings are resolved once at startup, in this
order: **`<storage>/config.json` → built-in default**. Anything absent from the
file falls through to the built-in default. A change takes effect on the next
start, not during a run — restart the process.

The file is the only place these are set; there is no environment variable for
any of them, and one named after a setting is not read. The environment carries
only credentials, the two bootstrap paths, and the two one-shot switches.
Configuration therefore holds for whichever client opens this store rather than
being repeated per client entry. Deleting a key from the file returns that
setting to the current built-in default, which is also how an untouched setting
picks up an improved default on upgrade. An unknown or mistyped key is a startup
error, never a silent default.
The complete key table is in
[the MCP server guide](../packages/mcp-server/README.md#configuration).

- `embedding.model` and `embedding.provider` select the
  embedding backend. `embedding.model` is the default model for newly
  created topics, not a global switch. Each topic records the model it was
  indexed under and is served with that model afterwards: a query against it
  uses the recorded model, and adding documents to it embeds the new chunks with
  the recorded model, so the topic stays one coherent embedding space. Changing
  this setting — or calling `rag_switch_embedding_model` — changes the default
  for topics created afterwards and re-points memory, which always uses the
  currently configured model and follows an explicit switch. It migrates nothing
  already indexed; changing a topic's model is a delete-and-recreate. A
  dimension mismatch or a missing fingerprint is still a hard reindex error
  rather than a silently degraded result.
- `embedding.maxResidentModels` (default `2`, minimum `1`) bounds how many
  embedding models stay loaded at once. It counts weight-bearing models only —
  `remote` and `vscodeLM` backends hold no weights and never occupy a slot. A
  resident model costs RAM, not CPU, so this is a memory budget and not a
  throughput knob; a cap of `1` makes alternating between two topics with
  different models reload a model on every switch.
- A remote embedding endpoint is **not** resolved per topic the way the model
  is. A knowledge base built against a remote endpoint is readable only by a
  deployment configured with that same endpoint; a topic naming a foreign
  endpoint is refused rather than served from whatever endpoint is configured,
  because an endpoint carries credentials and may serve a different model under
  the same name. Point the deployment at the original endpoint or rebuild the
  topic. Knowledge bases meant to move between machines should be built with the
  bundled local model.
- Cross-encoder reranking is **unconditional** — there is no switch to turn it
  off. The ONNX model ships inside the package, so there is nothing to download
  and nothing to opt out of, and a model that fails to load degrades queries to
  first-stage ranking rather than failing them. `reranker.model` selects which
  model; a switch leases the active generation so in-flight work drains rather
  than returning stale first-stage results.
- `llm.provider` gates agentic query planning, memory entity
  extraction, and `rag_memory` community clustering. With `none`, those degrade
  to documented empty or explanatory results — not failures.
  `llm.requestTimeoutMs` (30 seconds by default) bounds one request.

`limits.maxResponseBytes` (1 MiB by default) caps one serialized tool
response. A result that cannot be reduced below it returns a stable error
rather than a truncated document.

## Memory graph visualization operations

Graphs exist only in the memory subsystem. `rag_memory_visualize` is registered
like every other tool and returns a deterministic
`ragnarok.graph.visualization.v1` document.

The graph MCP App is registered at `ui://ragnarok/graph`. Verify that both
`resources/list` and `resources/read` report
`text/html;profile=mcp-app`, and that `rag_memory_visualize` advertises only
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

The inline MCP App visibly transitions through loading, ready, empty, and accessible error
states. Keyboard operators can traverse graph items with arrows, open details
with Enter/Space, close with Escape, and reset the fitted viewport. A missing
or malformed result must show an alert rather than stale graph content. The VS
Code instead provides **RAGnarok: Show Memory Graph**, a local command webview
over the extension's separate memory root. Neither UI reads the other host's
data.

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

`--read-only` covers the image's root filesystem, not the data volume, so
`config.json` is generated and refreshed normally under `/data/ragnarok` and
persists across `--rm`. If the storage root is genuinely read-only the server
still starts — a convenience file must never be the reason a server fails to
boot. A file that could not be created is reported as a warning on stderr;
that warning is informational, not an incident. An existing file whose
`$defaults` block could not be refreshed is left stale **without** a warning,
and the settings in it still apply — so do not read a current `$defaults` block
as evidence that the store is writable.

## Routine checks

Monitor process restarts, storage free space, and stderr for lock contention
and provider errors. Treat corruption, unsupported storage markers, fingerprint
mismatches, and failed migration validation as hard operator incidents; do not
reset storage until its backup and recovery path have been reviewed.
