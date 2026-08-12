# Security

RAGnarōk has one trust model. Both the VS Code extension and the MCP server run
as the local operating-system user, on that user's data, at that user's
authority. It is not a multi-tenant service, and it is not designed to be
exposed to a network.

## Process boundary

The MCP server speaks stdio only. It binds no address, accepts no connection,
and terminates when its client closes the pipe. Its attacker model is therefore
whatever can already run code as that user — not a remote caller. There is no
transport to configure and nothing to authenticate.

The variables that once configured a network listener (TLS paths, bind host,
allowed hosts, CORS origin, bearer tokens, rate limit, trusted proxies,
transfer limits) are **rejected at startup**. Setting one aborts the process
with an error naming every offender, so a configuration that promises a
hardened network service can never quietly become a local pipe.

Do not attempt to re-expose the server by wrapping stdio in a network relay. A
relay would grant every caller the spawning user's full authority — including
memory, model switching, storage reset, and read access to every path under
`security.allowedPaths` — with no role, quota, or credential in between. Run a
separate instance per user and per storage root instead.

## Capabilities

There are no roles. All 24 tools are registered unconditionally, and the client
that spawned the process may call any of them, including destructive ones
(`rag_delete_topic`, `rag_remove_document`, `rag_reset_memory`) and
configuration ones (`rag_switch_embedding_model`, `rag_switch_reranker_model`).
Each destructive tool requires an explicit `confirm: true` argument; that is a
guard against an agent's mistake, not an authorization boundary.

Treat the decision to add this server to an MCP client as the security
decision. The meaningful controls are which storage root it uses, which paths
`security.allowedPaths` in `<storageRoot>/config.json` exposes, and which
credentials (`RAGNAROK_LLM_API_KEY`, `RAGNAROK_GITHUB_TOKEN`) its environment
carries. Credentials remain environment-only and cannot be set in the file.

## Memory graph visualization exposure

`rag_graph_visualize` serves memory graphs only; the document knowledge graph
no longer exists. It is a full-detail data export, not a topology-only view.
A caller authorized to invoke it receives complete persisted memory node and
edge descriptions, memory scope, branch, source memory IDs, confidence/strength
values, timestamps, provenance, and arbitrary metadata. Embedding vectors are
always excluded.

Memory is personal, and the tool that exports it is always registered, so the
protection is the process boundary rather than a capability check: anything
able to call this server can read the user's complete memory graph. The server
does not substitute fallback or sample graph records; a scope with no stored
entities returns an empty document.

The associated `ui://ragnarok/graph` MCP App is self-contained and loads no
external scripts. It renders user-controlled strings through text DOM APIs,
not HTML interpolation. The tool uses only modern `_meta.ui.resourceUri`, and
both resource catalog and resource content declare
`text/html;profile=mcp-app`.

## Authentication protocol scope

RAGnarok implements no authentication at all: authority comes from the OS user
who spawned the process. It does not implement an OAuth authorization-code
flow, dynamic client registration (DCR), credential persistence, or client ID
metadata documents (CIMD), and it no longer validates bearer strings. The 2026
OAuth/DCR hardening items are therefore not applicable to this server.

## File and network boundaries

`rag_add_documents` and archive import accept only paths under canonical
`security.allowedPaths` or the configured export root, resolved on the machine
running the server. There is no upload handle; content is indexed from the
filesystem the server can already see. That allowlist therefore defines what an
agent driving this server can read: default it to the project root rather than
a home directory.

All three allowlists live **only** in `<storageRoot>/config.json`:
`security.allowedPaths` for ingest roots, `storage.exportDir` for the export
root — which is joined into the same ingest allowlist, so widening it widens
what can be read — and `security.githubHosts` for GitHub ingestion. There is no
environment variable for any of them.

**Write access to the storage root is therefore write access to these
allowlists**, with no way to pin one from outside the store. Whoever can write
`config.json` decides what the server may read. Keep the storage root under at
least the same protection as the paths it grants: if the store is on a shared
volume, a network mount, or a directory another process can write, treat its
allowlists as controlled by that writer rather than by the MCP client.

An empty value is meaningful rather than absent. An empty `security.allowedPaths`
narrows the ingest roots to the working directory — its documented default — so
it widens nothing. An empty `security.githubHosts` is rejected at startup rather
than falling back to `github.com`: emptying a security allowlist is a deliberate
instruction, and silently restoring the default would grant back access that had
just been revoked.

URL ingestion rejects unsafe targets. Credentials come from service
configuration and are never accepted as tool arguments. Review DNS/proxy policy
and outbound network egress independently; application validation is not a
substitute for an egress firewall.

Archive import rejects traversal, absolute paths, duplicates, case collisions,
unmanifested entries, checksum failures, excessive sizes, and excessive
compression ratios before publication. Treat all imported content as
untrusted text that may contain prompt injection.

## Logging and secret handling

The server emits no audit ledger, and there is nothing meaningful to audit: one
local user issues every request. Its stderr log is operational evidence for
that user, is bounded by `logging.level`, and must not be relied on as a
tamper-proof or attributable record — a local operator can alter the process,
its environment, and the storage root.

Keep LLM keys and GitHub tokens in the OS keychain or a secret manager and
inject them into the MCP client's server environment. Do not put them in
committed client configuration, command history, archives, benchmark results,
VSIX files, npm tarballs, or source control. `RAGNAROK_GITHUB_TOKEN` is read
from configuration only and is never accepted as a tool argument.

## Release audit exceptions

The clean-consumer production audit permits only the following exact,
time-limited findings. `scripts/audit-policy.mjs` rejects changed advisory IDs,
dependencies, affected ranges, malformed reports or policy, and expired
entries. Release maintainers must remove an exception as soon as its
invalidation condition becomes true.

### Hono serve-static

- Advisory: `GHSA-frvp-7c67-39w9`
- Dependency: `@hono/node-server`, affected range `<2.0.5`
- Path: `@modelcontextprotocol/node@2.0.0`
- Reason: RAGnarok uses MCP request conversion; neither MCP Node nor RAGnarok imports Hono serve-static.
- Invalidation condition: Any serve-static import/use or an MCP Node release compatible with patched Hono.
- Owner: `release-maintainers`
- Expiry: `2026-08-31`

### Sharp image decoding

- Advisory: `GHSA-f88m-g3jw-g9cj`
- Dependency: `sharp`, affected range `<0.35.0`
- Path: `@huggingface/transformers@3.8.1`
- Reason: RAGnarok invokes only text feature-extraction, tokenization, and sequence-classification pipelines; no image input reaches Sharp.
- Invalidation condition: Any image pipeline/input support or a Transformers release compatible with patched Sharp.
- Owner: `release-maintainers`
- Expiry: `2026-08-31`

The Sharp exception is content-addressed by the exact integration paths and
SHA-256 values in its `sourceGuards` policy entries. Changing a guarded
integration file or adding a new Transformers source requires security review
and an explicit `sourceGuards` path/hash update. Release-static rejects direct
Sharp references, unguarded Transformers references, missing or extra guarded
files, and any guarded-file content hash mismatch.

## Threat boundaries and non-goals

The server protects canonical path resolution, bounded archive and response
handling, GitHub/URL ingestion allowlists, and storage integrity checks. It does
not provide:

- any authentication, authorization, or multi-user separation;
- isolation from the user who spawned it, or from another process running as
  that user;
- per-topic authorization within one server;
- malware scanning or content moderation;
- tamper-proof audit retention;
- protection from a compromised host or LLM provider.

Run separate instances and storage roots when those boundaries differ. Use OS
user accounts, egress controls, malware scanning, and centralized identity
systems when the risk model requires them — none of those belong inside a stdio
child process.
