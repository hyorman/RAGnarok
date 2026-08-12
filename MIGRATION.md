# Migration guide

## Per-topic embedding models

**No action is required.** Existing topics keep working with the model they were
built with, nothing is re-embedded, and no stored data changes shape.

`embedding.model` (`RAGNAROK_EMBEDDING_MODEL`) is, as before, **the default model
for newly created topics**. What changed is that the setting is now honoured per
topic on every path rather than only at creation:

| Operation                              | Model used                                                   |
| -------------------------------------- | ------------------------------------------------------------ |
| Create a **new** topic                 | the configured `embedding.model`, recorded into its metadata |
| **Query** any topic                    | that topic's recorded model                                  |
| **Add documents to an existing** topic | that topic's recorded model                                  |
| Memory (store and recall)              | the **currently configured** model                           |

One behaviour that used to fail now succeeds: **adding documents to a topic whose
recorded model differs from the configured one.** It previously returned an
"Embedding model mismatch" error and refused the ingest. It now embeds the new
chunks with the topic's own recorded model, which keeps the topic in a single
embedding space — the topic's recorded model and fingerprint are left unchanged.
If you were working around this by switching the configured model back before
every ingest, you can stop.

Changing a topic's model is still a delete-and-recreate.
`rag_switch_embedding_model` changes the default for topics created afterwards
and re-points memory, which always uses the currently configured model; it
migrates nothing already indexed. A dimension mismatch or a missing embedding
fingerprint remains a hard reindex error.

Remote endpoints are the one thing not resolved per topic. A knowledge base built
against a remote embedding endpoint is readable only by a deployment configured
with that same endpoint; a topic recorded against a foreign endpoint is refused
rather than served from a substitute, because an endpoint carries credentials and
may serve a different model under the same name. Knowledge bases meant to move
between machines should be built with the bundled local model.

The new optional setting `RAGNAROK_MAX_RESIDENT_MODELS` /
`embedding.maxResidentModels` (default `2`, minimum `1`) bounds how many
weight-bearing embedding models stay loaded at once; `remote` and `vscodeLM`
hold no weights and never occupy a slot. Leaving it unset is correct for almost
everyone.

## Optional `config.json` for the MCP server

**No action is required.** Environment variables continue to work exactly as
before and continue to take precedence. If you change nothing, nothing changes.

24 of the MCP server's 31 settings can now also be written to a JSON file at
`<storageDir>/config.json`, so that configuration can live once beside the store
instead of being repeated in every MCP client's server entry. The resolution
order is **environment variable → `config.json` → built-in default**, one
directional and with no write-back, so an exported variable always wins over the
file.

The file is optional and is generated on the first run that finds it absent. The
generated file contains no live settings — only a `$defaults` block documenting
the current defaults and an `$envOnly` block listing what cannot go in it.
Neither block is ever read as configuration. A key absent from the file uses the
current built-in default, so settings you never touch keep picking up improved
defaults on upgrade; a key you write pins that value until you delete it.

Seven settings stay environment-only, and writing one as a key in the file is a
startup error naming the variable to use instead: `RAGNAROK_STORAGE_DIR` and
`RAGNAROK_WORKING_DIR` (bootstrap — the file's own location derives from the
first), `RAGNAROK_LLM_API_KEY`, `RAGNAROK_EMBEDDING_API_KEY` and
`RAGNAROK_GITHUB_TOKEN` (secrets, which do not belong in a file that is copied
with backups), and `RAGNAROK_RESET_STORAGE` and `RAGNAROK_IGNORE_LOCK` (one-shot
switches that would be ruinous if persisted).

The full key table is in
[the MCP server guide](packages/mcp-server/README.md#configuration).

### One behavior change: an empty `RAGNAROK_GITHUB_HOSTS`

Setting `RAGNAROK_GITHUB_HOSTS=""` previously fell back to `github.com`. It now
aborts startup, because the host list must resolve to at least one entry.

This is deliberate. `RAGNAROK_GITHUB_HOSTS` is a security allowlist, and an
operator who deliberately empties one is telling the server something; silently
restoring the default would grant access to a host they had just tried to
remove. Failing loudly is the safer reading of an ambiguous instruction. If you
were relying on the old fallback, set `RAGNAROK_GITHUB_HOSTS=github.com`
explicitly or unset the variable.

The asymmetry with `RAGNAROK_ALLOWED_PATHS` is intentional:
`RAGNAROK_ALLOWED_PATHS=""` is still accepted. Clearing that list narrows the
ingest roots to the working directory — its documented default — rather than
widening anything, so there is no dangerous reading to protect against.

## 0.7.0 stdio-only MCP server

**The HTTP transport is removed.** `@ragnarok/mcp-server` serves stdio and
nothing else. There is no `--http` flag, no listener, no `/health` or `/ready`
endpoint, no TLS or trusted-proxy configuration, no CORS/Origin policy, no
bearer tokens, and no rate limiting. Removed with it:

- **Shared deployment mode.** `RAGNAROK_DEPLOYMENT_MODE` no longer exists;
  there is one mode, a local child process owned by the user who spawned it.
- **Role-based access.** Reader, curator, and admin are gone. All 24 tools are
  registered unconditionally, including memory and `rag_graph_visualize`.
- **Streamed upload and download handles.** `rag_create_document_upload`,
  `rag_ingest_upload`, `rag_create_archive_upload`, and `rag_import_upload` are
  deleted. Use `rag_add_documents` and `rag_import_topic` with paths under
  `RAGNAROK_ALLOWED_PATHS`; the tool count therefore falls from 28 to 24.

### Removed environment variables (startup fails if any is set)

Setting any of these aborts startup with an error naming every offender. That
is deliberate: someone who configured TLS certificates and API keys believes
they are running a hardened network service, and silently starting a stdio
server would leave that belief intact.

| Removed variable                        | What it used to do                |
| --------------------------------------- | --------------------------------- |
| `RAGNAROK_DEPLOYMENT_MODE`              | Selected local or shared mode     |
| `RAGNAROK_PORT`                         | HTTP listener port                |
| `RAGNAROK_HTTP_HOST`                    | HTTP bind address                 |
| `RAGNAROK_ALLOWED_HOSTS`                | Accepted HTTP `Host` values       |
| `RAGNAROK_CORS_ORIGIN`                  | Browser Origin policy             |
| `RAGNAROK_TLS_CERT_PATH`                | Native TLS certificate            |
| `RAGNAROK_TLS_KEY_PATH`                 | Native TLS private key            |
| `RAGNAROK_API_KEY`                      | Reader bearer token               |
| `RAGNAROK_WRITE_API_KEY`                | Curator bearer token              |
| `RAGNAROK_ADMIN_API_KEY`                | Admin bearer token                |
| `RAGNAROK_RATE_LIMIT_PER_MINUTE`        | Per-client HTTP request limit     |
| `RAGNAROK_TRUSTED_PROXIES`              | Proxies allowed to assert HTTPS   |
| `RAGNAROK_TRANSFER_TTL_MS`              | Transfer handle lifetime          |
| `RAGNAROK_TRANSFER_MAX_FILE_BYTES`      | Maximum transferred file size     |
| `RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES` | Active upload bytes per principal |
| `RAGNAROK_TRANSFER_MAX_SESSIONS`        | Active uploads per principal      |

To migrate, delete these from your MCP client configuration, `.env` files, and
container environment. Every other `RAGNAROK_*` variable is unchanged; the
surviving set is documented in
[the MCP server guide](packages/mcp-server/README.md#configuration).

One variable is **silently ignored** rather than rejected:
`RAGNAROK_MAX_REQUEST_BYTES` bounded the HTTP JSON request body, and stdio
frames are not bounded that way. It is deliberately absent from the rejection
list above, so setting it produces neither an effect nor an error. Remove it;
nothing reads it.

### Container migration

`docker-compose.yml`, the container health check, and the Docker smoke script
are deleted — a stdio server has no port to publish and no endpoint to probe.
Run the image as an interactive child process instead, with storage on a
mounted volume:

```sh
docker run -i --rm --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:size=256m \
  -v ragnarok-data:/data/ragnarok ragnarok-mcp
```

That invocation is kept in the root `package.json` as `npm run docker:run`.
Point the MCP client's `command`/`args` at it; the container's stdin and stdout
are the transport.

## 0.6.0 MCP client migration

RAGnarok 0.6.0 serves MCP protocol `2026-07-28` only. MCP clients must use
`server/discover` or modern version negotiation. Legacy `initialize` is
rejected; there is no compatibility mode.

The server does not issue `Mcp-Session-Id`. Cacheable discovery, list, and
resource-read results advertise `ttlMs=0` and `cacheScope=private`.

This release also shipped an HTTP transport with bearer roles and transfer
handles. All of it was removed in 0.7.0 above; the HTTP notes that were here
described a surface that no longer exists and have been dropped rather than
preserved as advice.

## 0.4.0 storage migration

RAGnarōk 0.4 uses storage format v2. Existing 0.3 data must be migrated offline; startup never silently
rewrites, resets, or discards an unversioned store.

## Supported source layouts

The migrator deliberately supports only layouts emitted by the 0.3 release:

- VS Code/local storage: `<storage>/database/topics.json`, per-topic document/vector metadata, and
  `<storage>/database/lancedb/<topic-id>.lance`.
- Flat shared/common databases: `<shared>/topics.json`, per-topic metadata, and
  `<shared>/lancedb/<topic-id>.lance`.

The flat common layout is converted to the v2 `database/` layout. Its topic IDs are deterministically
namespaced and every remap is recorded, preventing the known local/common ID collision.

Version 0.3 did not persist memory stores. An unversioned store containing unknown tables/files is
therefore rejected instead of guessed at. Some 0.3-era stores contain `kg-*` tables from the document
knowledge graph, a subsystem that no longer exists. Those tables are recognized so that they do not
count as unknown structure, but they are never copied: vectors and documents are migrated and the
`kg-*` tables are dropped. The report still marks such topics `graphRebuildRequired` and warns that
the legacy graph was not copied; that flag is vestigial, because document knowledge graphs no longer
exist and graphs now live only in the memory subsystem. Ignore it — there is nothing to rebuild and
no strategy that would consume the result. Legacy vector model names are preserved, but no backend
fingerprint is invented; reindexing is required before adding vectors under a new embedding
configuration.

## CLI

Build the core package first, then preview:

```sh
npm run build --workspace=packages/core
npm run migrate:storage -- --storage /absolute/path --dry-run --json
```

Dry-run performs no writes, including lock files, and reports the source inventory/digest, file mtimes,
topic/document/chunk counts, remaps, unsupported structures, required/free disk, and exact backup/staging
paths.

Apply is intentionally non-interactive and requires the exact backup path returned by dry-run:

```sh
npm run migrate:storage -- --storage /absolute/path --apply --non-interactive \
  --accept-backup-path /exact/path/from/dry-run --json
```

Other operations:

```sh
npm run migrate:storage -- --storage /absolute/path --status --json
npm run migrate:storage -- --storage /absolute/path --resume <migration-id> --json
npm run migrate:storage -- --storage /absolute/path --rollback <migration-id> --json
```

Exit codes distinguish already-v2/empty input (10–11), corrupt/unsupported/collision input (20–22),
space/change/lease/confirmation failures (30–33), validation failure (40), cutover failure (50), missing
state (60), and unexpected internal failure (70).

## Safety and rollback

Apply acquires the normal storage lease plus a same-parent migration lease. Conversion occurs in a
same-filesystem staging directory. It validates schemas, counts, content/vector digests, dimensions,
document references, and native table queries before cutover. The cutover atomically renames the original
directory to an immutable, checksummed backup and publishes the staged v2 directory.

Migration state is stored beside the storage directory and is resumable by its deterministic migration ID.
Rollback never merges silently: it retains the immutable legacy backup, copies it into a restore stage,
and first moves the current v2 directory—including any post-migration data—to a new `backup-v2-*` path.

Current limits:

- maximum 1,000,000 chunks per topic;
- same-filesystem directory rename semantics are required;
- semantic query validation is not possible without loading the original embedding backend, so migration
  validates native scans and exact text/vector digests; normal querying remains subject to model availability;
- hard power loss durability ultimately depends on filesystem and LanceDB guarantees despite file/directory
  fsync and resumable state.
