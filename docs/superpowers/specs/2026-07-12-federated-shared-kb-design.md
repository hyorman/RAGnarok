# Design: Federated Shared Knowledge Bases, Access Model & Concurrency

**Date:** 2026-07-12
**Status:** Design (brainstormed, pending review)
**Scope:** RAGnarok topology across VS Code, local stdio MCP, and HTTP MCP — how personal vs shared knowledge bases are stored, served, queried, secured, and concurrency-controlled.

---

## 1. Context

The `mcp-server` branch adds an HTTP transport and a two-token (read/write) auth model. Working through the intended deployments surfaced that this is not merely an "HTTP auth" question — it is a **storage-locality + federation + concurrency** design that spans all three transports. This spec captures the model we converged on so implementation (and the consolidated fix plan) can proceed against a single, explicit target.

The load-bearing realization: **where data physically lives dictates where its compute must run**, because a query vector is only valid against the exact embedding model that built a table. Everything below follows from that plus one networked-process fact: a server process cannot read or write files on a different machine's disk.

## 2. The three scenarios (requirements)

1. **VS Code extension.** One extension host, but multiple chat sessions may hit the same storage → needs read/write serialization. Storage may be partitioned per workspace.
2. **Local stdio MCP server.** Multiple clients/sessions (e.g., Claude Desktop + Cursor) may use the same tool against the same storage dir concurrently → needs cross-process serialization.
3. **HTTP MCP server (most important).** A **shared/common KB** hosted centrally, writable only by authorized curators and read-only to everyone else; **plus** each developer's **personal KBs and memory**, which live in the developer's own environment (never on the server), read/write, behaving exactly like scenarios 1–2. A query should transparently combine the two. Users split into two profiles: **consumer-only** (wants the shared KB, has no local KBs/memory — should need nothing installed) and **power user** (local KBs/memory plus the shared KB). The sharpest form of consumer-only is a **sandboxed agent** with no persistent local environment: it *cannot* run a local engine, so if the shared KB were not itself an MCP server, that user could not use any KB at all. The remote is therefore a **first-class MCP server for agents**, with read vs write decided per session by the token presented — not merely a federation backend.

## 3. Core principles (invariants)

- **P1 — Personal data is always local.** Personal KBs and *all* memory live in the developer's environment, read/write. They are never stored on a shared server.
- **P2 — The engine that owns local data runs locally.** A remote HTTP server cannot create/modify a KB on the developer's disk (networked-process physics; MCP has no primitive for a server to write client-side files). Therefore any user who wants local KBs/memory runs a **local engine** (stdio / VS Code / local process), and the shared KB is a *configured source* of that engine — not a second MCP server the agent wires up. A user with **no** local data needs no local engine at all: their agent connects straight to the shared host (§4.2).
- **P3 — Memory is always personal → always local.** Only KBs (topics) are ever shared. Memory never sits behind the shared host's tokens.
- **P4 — Data locality dictates compute locality.** A query vector only matches the model that built the table. You cannot embed a query with model Y and search a table built with model X. So:
  - shared table stored **locally** (synced folder) → the local engine queries it with **that topic's own model** (per-topic model metadata already routes this) — all compute local.
  - shared table served **remotely** (HTTP) → the **remote** host embeds+retrieves+reranks with its own model and returns ranked results — the local engine does no embedding for that topic.
- **P5 — Auth lives only where parties share data.** Read/write tokens are a property of the **shared-KB host** (the only place multiple parties touch the same data). The local engine needs no per-user auth — it is the developer's own machine, guarded by OS file permissions + a local lock.

## 4. Architecture

### 4.1 Serving decision — retrieval-serving, not data-serving

Two ways to serve a centrally curated KB were considered:

- **Data-serving:** an instance publishes the KB *data* (synced folder, object storage, export bundles); every consumer's local engine pulls it and runs retrieval locally.
- **Retrieval-serving:** a remote MCP host runs embed→retrieve→rerank itself per query and returns ranked results.

**Decision: retrieval-serving (the remote MCP host) is the primary shared-KB channel**, for two reasons:

1. **Zero-install consumers.** Data-serving makes a local engine mandatory for *every* user — someone has to embed the query and search the tables, and with data-serving that someone is always local. Retrieval-serving lets a consumer-only user point their agent at the host's URL with a read token and use the shared KB with **nothing installed** — no models, no sync, always-fresh data, instant revocation.
2. **No embedding-model pinning (P4).** Data-serving requires every consumer to embed queries with the exact model that built the shared tables, effectively restricting the shared KB to the bundled portable model. With retrieval-serving the host embeds queries itself, so curators may build the shared KB with **any** model, including remote ones.

Data-serving needs are already covered by existing machinery — `commonDatabasePath` (FolderSharedSource) for same-host/shared-filesystem setups, and `rag_export_topic`/`rag_import_topic` for offline snapshots. **No new sync/object-storage pipeline is built.**

### 4.2 Two roles ("remote vs local" = configuration, not process location)

| Component | Runs where | Owns | Access control |
|---|---|---|---|
| **Local engine** (stdio / VS Code / local HTTP) | Developer's machine | Local KBs + all memory | Full read/write, always. OS perms + in-process mutex + cross-process lock. |
| **Shared-KB host** (`ragnarok-mcp --http`) | Central team infra | The curated shared KB (topics only) | Read with read token; write with write token. |

Which server the agent talks to depends on the user's profile — the rule is **exactly one RAGnarok MCP entry per agent context**:

- **Consumer-only / sandbox** (no local KBs, no memory): the agent is configured with the **shared host directly** (URL + read token). Zero local install; every tool call is served remotely; write tools are structurally absent from the session (default-deny, §4.5).
- **Power user** (local KBs and/or memory): the agent is configured with the **local engine only**; the shared KB is a *setting* of that engine (a `RemoteSharedSource` holding a token for the host). Shared topics are reachable through the local `rag_query` — no second entry needed.
- **Curator** (write-token holder): writes to the shared KB happen through a **direct writer session** — the remote entry (with write token) added to the agent in a dedicated curation context/workspace. Writes use the host's existing tools (`rag_add_url`, `rag_add_github_repo`, `rag_import_topic`, server-side-path `rag_add_documents`). Ingesting files from the curator's own disk goes via export/import or URL, since the host cannot read their filesystem. (Federation write-through — a write token on `RemoteSharedSource` plus a content-push ingest tool — was considered and rejected for now: YAGNI; see §10.)

The central host is team infrastructure stood up once; **one deployment serves all profiles** — consumer agents, curators' writer sessions, and power users' local engines are all just authenticated clients of it.

**Agent tool routing when both entries are configured anyway.** The recommended setups make the choice moot (routing is the *engine's* job, per topic — deterministic — not the LLM's job, per tool). But nothing stops a user (or a curator, by design) from having both entries, so the degradation is layered:

1. **No hard collision:** MCP clients namespace tools per server entry (`mcp__ragnarok-local__rag_query` vs `mcp__ragnarok-team__rag_query`); the LLM chooses by name + description.
2. **Self-describing servers:** the host advertises MCP server `instructions` and tool descriptions saying what it is — *"Team shared knowledge base (central, curated); read-only unless your token grants write; no personal memory"* — while the local engine says *"Personal local KBs and memory; also federates the team shared KB when configured — prefer this server when both are present."* Since agents now connect to the host directly, these strings are part of the design surface, not cosmetics.
3. **Minimal overlap:** the host registers **no memory tools at all** (P3 — memory never lives there), and reader sessions see no write tools (default-deny). For a reader with both entries, overlap is a handful of read tools.
4. **Benign worst case:** a wrong pick costs a duplicate or suboptimal retrieval, never a misplaced write — the host refuses writes without the write token, and the local engine only ever writes local data.

### 4.3 Shared source abstraction

Generalize today's `commonDatabasePath` from "a local folder" to a pluggable **SharedSource** that surfaces read-only topics alongside local read/write topics under one UX. Two implementations:

- **`FolderSharedSource`** (exists as `commonDatabasePath`): shared tables are files on local disk (synced via network drive / git / object storage / read-only mount). Data local ⇒ **all compute local**, using each shared topic's stored embedding model. Access control = filesystem/sync permissions. Best when the curated KB changes occasionally.
- **`RemoteSharedSource`** (new): an MCP **client** (`@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`) pointed at a `ragnarok-mcp --http` host, holding a read (or write) token. Uses two remote tools:
  - `rag_list_topics` → remote-topic registry (cached, periodically refreshed), surfaced locally as `source: "shared"`, read-only.
  - `rag_query` → full retrieval against a shared topic; the host embeds+retrieves+reranks server-side and returns ranked results.

Both plug into the same "read-only shared topics" model, so `rag_query`, topic resolution, and listing are transport-agnostic.

### 4.4 Query flow — per-topic federation

`rag_query` targets **one topic** (no cross-topic combined reranker). Resolution:

| Topic "X" resolves… | Behavior |
|---|---|
| **Local only** | Local retrieval (unchanged). |
| **Shared only** | Fetch from the shared source. Folder source → query the local shared table with its own model. Remote source → call remote `rag_query`. Results tagged `source: "shared"`. |
| **Both (same name)** | Retrieve **each side independently and concurrently** (each with its own embedding model / reranker), then **fuse the two ranked lists with Reciprocal Rank Fusion (RRF)** and slice to `topK`. Each result carries its origin. |

RRF (already implemented in `retrievers/ensembleRetriever.ts`) is the correct fuser because remote and local scores are **not comparable** across different models/rerankers — RRF fuses by rank position, needing no shared score scale and **no combined cross-encoder** (matching the "no combined reranker" requirement). Request `topK` (or slightly more) from each side, RRF, slice.

### 4.5 Access model (auth) — on the shared host only

Keep the two-token split already implemented, scoped to the shared host, with hardening:

- `RAGNAROK_API_KEY` = **read** token; `RAGNAROK_WRITE_API_KEY` = **write** token (must differ). Read token only (no write token) ⇒ intentionally read-only server. No tokens ⇒ loopback-dev only (config already rejects non-loopback binds without a key and forbids `corsOrigin: "*"`).
- Session role is fixed at initialize; later requests must present the same authorization or 401 (already implemented).
- **Harden (change from current):** replace guard-by-omission (`writerOnly()` sprinkled per handler — default-*open*, a forgotten guard leaks write to readers) with **default-deny**: `createMcpServer(role)` registers **only reader tools** for reader sessions; pure-write tools are never registered for readers. Genuinely mixed tools (`rag_memory`) keep per-action guards where registered — but in **shared deployments the memory tools are not registered at all** (P3: memory never lives on the shared host). Concrete rule: auth tokens configured ⇒ multi-party/shared semantics ⇒ no memory tools; stdio and token-less loopback HTTP (personal dev) keep them. Back this with a **read-only facade** over `TopicManager`/`MemoryStore` for reader sessions, so "readers cause zero durable writes" (no reinforcement, memorize, or decay mutation) holds by construction, not vigilance.
- The **local engine needs no per-user auth**. It holds a read (or write, if the developer is a curator) token *for the remote source*; that token gates only what the local engine may do against the host.

### 4.6 Concurrency & locking

Local storage (scenarios 1, 2, and the local half of 3):

- **In-process** concurrency: the existing `async-mutex` in `MemoryVectorStore` (and equivalent serialization for topic writes) covers concurrent async calls within one process — multiple VS Code chat sessions in one extension host, concurrent tool calls in one stdio server.
- **Cross-process** concurrency (new — the AA-1 gap): a lock at `<storageDir>/.ragnarok.lock` (pid + stale detection via liveness/heartbeat; `RAGNAROK_IGNORE_LOCK` override) acquired in `MemoryStore`/`TopicManager.create`, released on `dispose()`/exit. Prevents two OS processes (two VS Code windows on shared global storage, or two stdio servers on `~/.ragnarok`) doing concurrent whole-table rewrites. Fail fast naming the holder pid.
- **Contention avoidance**: optional **per-workspace storage locations** so different workspaces map to different storage dirs and mostly never contend.

Shared host: writes among curators serialize through the host's process-level write coordinator + write token (already planned). Cross-locality is clean — local locking and host serialization never overlap.

## 5. Configuration surface

- Local engine: `RAGNAROK_SHARED_SOURCE` = `folder` | `remote` (or infer from which of the below is set); `RAGNAROK_COMMON_DATABASE_PATH` (folder) / `RAGNAROK_REMOTE_URL` + `RAGNAROK_REMOTE_TOKEN` (remote); `RAGNAROK_IGNORE_LOCK`; workspace-scoped storage toggle. VS Code equivalents under `ragnarok.*`.
- Shared host: `RAGNAROK_API_KEY`, `RAGNAROK_WRITE_API_KEY`, `RAGNAROK_HTTP_HOST`, `RAGNAROK_CORS_ORIGIN`, session TTL / max-sessions / rate-limit (already present).
- Consumer-only users and curators: **no RAGnarok config at all** — just an MCP entry in their agent (host URL + read token for consumers, write token for curators).

## 6. Error handling & degradation

- **Remote source down / slow** → federation degrades to **local-only** results; the shared side is omitted with a surfaced note, never a hard failure. Remote calls run with a timeout, concurrently with local retrieval.
- **Model mismatch on a folder shared topic** → per-topic model metadata + existing dimension guards route correctly or reject with an actionable message (never silent garbage).
- **Cross-process lock held** → fail fast with the holder pid and the override hint.
- **Write attempted without write token** (shared topic) → refused; local topics remain writable.

## 7. Security considerations

- Read/write tokens are static shared secrets — acceptable for local/team infra (YAGNI on OAuth/mTLS for now); document rotation as a manual op. Timing-safe comparison already used.
- Non-loopback binds require a token and a restricted CORS origin (already enforced at config load).
- Reader sessions must be structurally incapable of writes (§4.5) — this is the key correctness property, not just a policy. For consumer-only users connecting directly, this is their *entire* security boundary — hence structural, not per-handler.
- `RemoteSharedSource` sends **query text** to the host; queries concern shared content and the host is trusted team infra — acceptable. (Sending vectors instead would not meaningfully hide intent and is blocked by the model-compatibility constraint anyway.)
- Memory never crosses to the shared host (P3), so no personal data leaves the developer's machine via the shared path.

## 8. New vs reused

**Reused:** the whole server as the shared host; the two-token auth (Codex); `commonDatabasePath`'s read-only-topics UX; per-topic embedding-model metadata + dimension guards; `async-mutex`; RRF from `ensembleRetriever`; the MCP SDK `Client`/`StreamableHTTPClientTransport` (already used by the review's integration harness).

**New:** `SharedSource` abstraction + `RemoteSharedSource` MCP client + remote-topic registry; per-topic federation + RRF merge in `RAGQueryService`/topic resolution; cross-process lock; auth hardening (default-deny tool registration + read-only facade); shared-mode tool surface (memory tools not registered when tokens are configured); self-describing MCP server `instructions` + differentiated tool descriptions on the host; optional per-workspace storage.

## 9. Testing strategy

- **Federation unit/integration:** local-only, shared-only, same-name RRF merge (assert both origins present, RRF ordering); remote-down → graceful local-only.
- **Model-locality:** folder shared topic queried with a different local model still resolves via per-topic metadata; remote shared topic returns host-computed results regardless of local model.
- **Auth (real process):** reader session cannot invoke any write tool (tools absent, not just guarded); reader causes zero durable writes (no reinforcement/memorize/decay mutation — assert on-disk unchanged); role-mismatch 401; read-only-server (no write token) rejects writes; non-loopback-without-token refused at startup. These reader-session tests double as coverage for the consumer-only profile (agent → host directly). Additionally: in token-configured (shared) mode, **memory tools are absent from every session's tool list** (reader *and* writer); writer sessions can invoke topic write tools end-to-end (curator path).
- **Concurrency:** two processes on one storage dir → second fails fast with pid; in-process concurrent mutations serialize without loss; per-workspace storage isolates.
- **Harness:** extend the real-binary e2e suite (spawn built server, clean `RAGNAROK_*` env) to spin up a shared host + a local engine configured with `RemoteSharedSource`, and exercise the combined query.

## 10. Open questions / future

- Remote-topic registry refresh cadence and cache invalidation semantics.
- ~~Curator write path~~ **Resolved:** curators use a direct writer session (remote entry + write token in a curation context). Federation write-through (write token on `RemoteSharedSource` + a content-push ingest tool) was considered and **rejected** — YAGNI; revisit only if curating via export/import/URL proves too clumsy in practice.
- Token rotation ergonomics; per-client identities/audit (deferred — YAGNI now).

## 11. Relationship to the consolidated fix plan

This design adds one workstream not present in either prior plan (`CONSOLIDATED-FIX-PLAN.md` / `-CODEX-PLAN.md`): **`SharedSource` federation over HTTP with per-topic RRF**. It also refines two items already in those plans: **auth hardening** (default-deny registration + read-only facade, beyond the token split Codex implemented) and **cross-process locking** (AA-1, absent from Codex's plan). Everything else here reuses existing or already-in-progress work. Fold these into the consolidated plan's Phase 5 (HTTP/access) and Phase 7 (common-database routing).
