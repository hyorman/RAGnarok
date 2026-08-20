# Migration guide

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
