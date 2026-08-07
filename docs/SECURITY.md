# Security and shared MCP deployment

RAGnarōk has two trust models: a local owner process and an authenticated
shared service. Shared mode is designed for a private service behind a trusted
TLS boundary; it is not a multi-tenant isolation or billing system.

## Transport boundary

Set `RAGNAROK_DEPLOYMENT_MODE=shared` for every shared deployment. Shared or
non-loopback HTTP refuses to start unless one of these topologies is explicit:

- native TLS with both `RAGNAROK_TLS_CERT_PATH` and
  `RAGNAROK_TLS_KEY_PATH`; or
- a TLS-terminating reverse proxy whose exact IP addresses are listed in
  `RAGNAROK_TRUSTED_PROXIES`.

Only a configured trusted peer may establish HTTPS through
`X-Forwarded-Proto: https` or supply the forwarded client IP. Never trust a
CIDR, wildcard, or arbitrary forwarded header. Keep an unencrypted backend
listener private. Set `RAGNAROK_CORS_ORIGIN` to the one browser origin that
needs access. Requests without `Origin` still require authentication.

Set `RAGNAROK_ALLOWED_HOSTS` to the exact public DNS names or IP addresses that
clients use, without ports or wildcards. The HTTP server validates the native
`Host` header. It accepts `X-Forwarded-Host` only from the directly connected
trusted proxy, so that proxy must overwrite the forwarded value rather than
passing arbitrary client input. The server also rejects unverified cleartext
shared traffic, rate-limits health separately from user routes, bounds JSON
bodies and tool responses, and closes admission during shutdown.

## Roles and capabilities

Use three distinct, randomly generated bearer tokens in shared mode:

| Role    | Environment variable     | Capability                                                                                      |
| ------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| Reader  | `RAGNAROK_API_KEY`       | Query, list, status, and storage inspection                                                     |
| Curator | `RAGNAROK_WRITE_API_KEY` | Reader operations plus topic/document creation and mutation and document uploads                |
| Admin   | `RAGNAROK_ADMIN_API_KEY` | Complete shared surface, including models, export/import, archive uploads, and reset operations |

Shared mode enforces a minimum encoded length of 32 bytes and requires all
configured role tokens to differ. Length validation cannot measure entropy:
generate at least 32 random bytes with a secret manager or CSPRNG; do not pad a
human password to satisfy the check. Each MCP request validates its configured
opaque bearer string and receives the corresponding role and hashed principal
identifier. There is no `Mcp-Session-Id`.

Rotate a compromised token, update clients, and verify rejected use of the old
token. The runtime rotation API affects the next request; there are no sessions
to invalidate. Environment changes take effect after process restart.

Local stdio has owner/admin authority. Explicit local HTTP with no tokens is
allowed only on loopback and also has owner/admin authority. Do not use that
mode on a shared workstation. Memory is deliberately absent from shared
deployments because its workspace/branch scopes are personal.

## Graph visualization exposure

`rag_graph_visualize` is a full-detail data export, not a topology-only view.
Local owners and shared curators/admins authorized to invoke it can receive
complete persisted knowledge node and edge descriptions, source chunk IDs,
confidence/strength values, timestamps, provenance, and arbitrary metadata.
Local workspace/branch memory visualization additionally exposes memory scope,
branch, source memory IDs, and memory metadata. Embedding vectors are always
excluded.

Shared readers cannot list or invoke the tool. Shared curators/admins may
visualize knowledge topics; the standard shared sanitizer removes
server-managed path fields and redacts path-like values before the final
response is measured. Both shared memory inputs fail with
`GRAPH_MEMORY_UNAVAILABLE`, because personal workspace and branch memory never
crosses the shared boundary. The server does not substitute fallback or sample
graph records. Treat graph authorization as authorization to read all of the
non-vector details above.

The associated `ui://ragnarok/graph` MCP App is self-contained and loads no
external scripts. It renders user-controlled strings through text DOM APIs,
not HTML interpolation. The tool uses only modern `_meta.ui.resourceUri`, and
both resource catalog and resource content declare
`text/html;profile=mcp-app`.

## Authentication protocol scope

RAGnarok validates configured opaque bearer strings. It does not implement an
OAuth authorization-code flow, dynamic client registration (DCR), credential
persistence, or client ID metadata documents (CIMD). The 2026 OAuth/DCR
hardening items are therefore not applicable to this server. Deploy an identity
provider at the trusted proxy when OAuth or attributable user identity is
required.

## File and network boundaries

`rag_add_documents` and local archive import accept only server paths under
canonical `RAGNAROK_ALLOWED_PATHS` or the configured export root. They never
mean a remote client's local path. Shared clients transfer content through
bounded, checksum-declared, principal-bound upload handles. Archive upload and
import are admin-only.

URL ingestion rejects unsafe targets and GitHub ingestion is restricted to
`RAGNAROK_GITHUB_HOSTS`. Credentials come from service configuration and are
never accepted as tool arguments. Review DNS/proxy policy and outbound network
egress independently; application validation is not a substitute for an
egress firewall.

Archive import rejects traversal, absolute paths, duplicates, case collisions,
unmanifested entries, checksum failures, excessive sizes, and excessive
compression ratios before publication. Treat all imported content as
untrusted text that may contain prompt injection.

## Audit and secret handling

HTTP operations emit structured audit log events with a hashed principal,
action, object category, outcome, and correlation ID. Logs deliberately do not
contain bearer tokens. Send logs to access-controlled, append-oriented storage
and set a retention policy.

The built-in log is operational evidence, not a tamper-proof audit ledger:
token holders are pseudonymous, local operators can alter the process or
filesystem, and no end-user identity provider is included. Put authentication
at the proxy if attributable human identity is required and correlate its logs
with the application correlation ID.

Keep bearer tokens, LLM keys, GitHub tokens, and TLS private keys in an
orchestrator secret store. Do not put them in Compose files, command history,
archives, benchmark results, VSIX files, npm tarballs, or source control.

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

The service protects role separation, bounded parsing and transfer, canonical
paths, per-request bearer validation, and storage integrity checks. It does not
provide:

- hostile-tenant process or filesystem isolation;
- per-topic authorization within one server;
- malware scanning or content moderation;
- tamper-proof audit retention;
- denial-of-service protection beyond local limits and rate limiting;
- protection from a compromised host, reverse proxy, admin token, or LLM
  provider.

Run separate service instances and storage roots when those boundaries differ.
Use a reverse proxy/WAF, egress controls, malware scanning, and centralized
identity/audit systems when the risk model requires them.
