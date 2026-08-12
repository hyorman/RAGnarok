# Per-topic embedding models — design

**Status:** approved for planning
**Date:** 2026-08-11
**Applies to:** `packages/core` (the registry and its consumers). No MCP tool surface changes.

Lands **before** the read-only shared knowledge base, which depends on it: without per-topic
resolution, mounting a KB built with a different embedding model returns silent garbage.

---

## 1. This is a bug fix, not a feature

Per-topic embedding models are **already wired**, and **already broken by shared mutable state.**

The chain:

1. `loadStore` resolves the topic's own model — `modelToUse = metadata?.embeddingModel || this.embeddingModel` (`vectorStoreFactory.ts:250`) — and builds `createEmbeddings(modelToUse, backendToUse)`.
2. `createEmbeddings` returns `new TransformersEmbeddings({ modelName, backendType, embeddingService: this.embeddingService })` (`:836`) — passing the **shared** service.
3. `TransformersEmbeddings` calls `this.embeddingService.initialize(this.modelName)` **once**, guarded by an `initialized` flag (`langchainEmbeddings.ts:47-55`).
4. `initialize(modelName)` **mutates that shared service** to the named model, via `selectBackendTransactional`.
5. `embedQuery` then calls `this.embeddingService.embed(query)` on the shared, now-mutated service (`:90`).

**Consequence — last loaded wins.** Load topic A (model X): the service becomes X. Load topic B
(model Y): the service becomes Y. Query A again: its cached store's wrapper is already `initialized`,
so it never re-initialises, and embeds A's query with **model Y**.

Two models of equal dimension produce **plausible garbage rather than an error**.

**It already reaches memory.** `MemoryStore` receives the *same* `EmbeddingService` instance
(`memoryStore.ts:115`) and embeds through it at `:141` (store) and `:235` (recall). So loading a topic
built with another model silently changes the model memory uses — including for **writes**, which
persist wrong-space vectors.

**Reproducible today**, without any shared KB: change `embedding.model` in config, create a topic,
then query an older one.

## 2. The model-resolution rule

| Operation | Model used |
| --- | --- |
| Create a **new** topic | the configured `embedding.model`, recorded into metadata at creation |
| **Query** any topic | that topic's recorded model |
| **Add documents to an existing** topic | that topic's recorded model |
| Memory (store and recall) | always the configured model, never per-topic |

The user never tracks which model is "active" — the topic remembers for it.

This table governs the **model**. For topics recorded against a *remote* backend the **endpoint** is
not resolved per-topic and a foreign endpoint is refused rather than substituted — see §3.1.

Two consequences to document rather than hide:

- Documents added to an existing topic use **that topic's original model**, not a newly configured
  one. Changing a topic's embedding space remains a reindex, which it must be — mixing two spaces in
  one LanceDB table silently corrupts retrieval for that topic.
- Row 3 is an **improvement** over today, where `validateEmbeddingModel` (`vectorStoreFactory.ts:322`,
  called from `documentPipeline.ts:497`) *throws* on mismatch. Adding to an older topic starts working
  instead of failing, and stays coherent.

## 3. Architecture

One new unit: an **`EmbeddingServiceRegistry`** owning `EmbeddingService` instances keyed by
`(model, backend)`.

- Each instance is initialised to exactly **one** model and **never mutated afterwards**. That is the
  whole fix: the defect is not the per-topic lookup, it is the shared mutable service beneath it.
- `createEmbeddings(model, backend)` obtains its service from the registry instead of closing over
  `this.embeddingService`.
- **Bounded at 2 by default**, LRU, configurable via a new `embedding.maxResidentModels` config key
  (minimum 1). Eviction calls `EmbeddingService.dispose()` (`embeddingService.ts:608`), which releases
  native/ONNX resources.
- **The cap applies to local (huggingface) backends only.** `RemoteEmbeddingBackend.dispose()` states
  it holds nothing — *"Stateless HTTP client — nothing to release"* — and an OpenAI-compatible
  endpoint takes the model name per request, so one endpoint serves any number of models at zero
  resident cost. Remote entries are never counted against the cap and never evicted. Counting them
  would evict a real local model to make room for a URL and an API key.
- ~~**Memory holds its own dedicated service**, pinned to the configured model, outside the registry's
  eviction. Memory must never be evicted mid-operation and never re-pointed.~~

  > **SUPERSEDED during implementation (Task 7) — the pinned memory service was WITHDRAWN, not deferred.**
  >
  > **The rule that shipped:** memory keeps using the **currently configured** model, sharing the
  > deployment's embedding service, and **follows an explicit model switch**. It is not pinned and it
  > holds no dedicated service.
  >
  > **Why:** a pinned service would break `rag_switch_embedding_model`
  > (`packages/mcp-server/src/tools.ts:724-782`) and the VS Code switch
  > (`packages/vscode/src/commands.ts:173`). Both deliberately re-point the *shared* service and then
  > validate memory's dimension **after** applying the candidate model
  > (`memoryStore.validateEmbeddingFingerprint()` inside the transactional switch). Pinning memory to a
  > service the switch never touches would make that guard vacuous — it would keep re-validating the old
  > model, always agree with itself, and never refuse an incompatible switch — and memory would silently
  > ignore a model change the user asked for explicitly. What §3 was actually protecting against is
  > *implicit* re-pointing by a per-topic load; that protection is preserved, and is tested by "memory
  > keeps the configured model after a topic with a different model is loaded" (§6).

### 3.1 Remote backends — resolve the model, refuse a foreign endpoint

An embedding endpoint carries credentials and is a deployment-level setting. A topic must not be able
to make the server authenticate to an endpoint of the topic's choosing, so the endpoint is **never**
resolved per-topic.

`endpointHash` is `sha256(baseUrl.toLowerCase())` (`remoteEmbeddingBackend.ts:132`), and it is already
part of `EmbeddingFingerprint` (`embeddingBackend.ts:18-25`). Local backends report the literal
`"local"` (`huggingFaceBackend.ts:282`).

| Backend | Model | Endpoint | Behaviour |
| --- | --- | --- | --- |
| local | per-topic | n/a | Resolve from the registry. Counts against the LRU cap. |
| remote | per-topic | **matching** `endpointHash` | Resolve. Free — no cap slot, never evicted. |
| remote | any | **differing** `endpointHash` | **Refuse**, naming the topic and both hashes. |

`loadStore` currently resolves on `metadata.embeddingModel` and `metadata.embeddingBackend` only, and
never consults `endpointHash`. That is the gap: a topic built against endpoint A, read on a machine
configured with endpoint B, embeds against B — and if B serves a different model under the same name,
the result is silent cross-endpoint garbage. Unlike the local case this **cannot** be fixed by
resolution, only by detection and refusal.

Consequence to document: **a knowledge base built against a remote endpoint is readable only by a
deployment configured with that same endpoint.** Publishers of shared KBs should prefer the bundled
local model.

### 3.2 Reachability is already probed

No new health-check machinery is needed. Two probes exist:

- `RemoteEmbeddingBackend.isAvailable()` (`remoteEmbeddingBackend.ts:73-84`) GETs `${baseUrl}/models`
  (OpenAI format) or `${baseUrl}/api/tags` (Ollama) with a timeout, returning `response.ok`. It gates
  backend selection at `embeddingService.ts:121`.
- `getFingerprint()` discovers `dimension` by performing a **real embed call**
  (`embeddingService.ts:357`). For a remote backend that is a live round-trip against the named model,
  so it confirms the model answers and what dimension it returns — not merely that the host is up.

The registry inherits both by constructing ordinary `EmbeddingService` instances. What §5 adds is that
a failure of either must surface as a clear error naming the topic, rather than a silent fallback.

**Why 2 and not 1:** a resident model costs RAM, not CPU — an idle model consumes no cycles. With one
slot, alternating between a local topic and a mounted shared KB evicts and reloads on every switch,
paying full model initialisation each time. Two covers the realistic case (local plus one shared KB).
The config key lets a RAM-constrained deployment choose 1 deliberately.

**Why not re-initialise per query:** it makes every query pay a model switch, and concurrent queries
against different topics still interleave and corrupt each other. The shared-state coupling has to go,
not be re-timed.

## 4. What changes

| File | Change |
| --- | --- |
| `packages/core/src/embeddings/embeddingServiceRegistry.ts` (new) | The registry: `get(model, backend)`, LRU bound, dispose-on-evict, `disposeAll()`. |
| `packages/core/src/stores/vectorStoreFactory.ts:836` | `createEmbeddings` resolves its service from the registry. |
| `packages/core/src/stores/vectorStoreFactory.ts:322` | `validateEmbeddingModel` no longer throws on a model *difference*; it resolves. It must still throw on a **dimension** mismatch and on migrated vectors with no verifiable fingerprint (`:57`), which remain genuine reindex conditions. |
| `packages/core/src/managers/documentPipeline.ts:497` | Consumes the relaxed validation. |
| `packages/mcp-server/src/configFile.ts` | New `FILE_KEYS` entry for `embedding.maxResidentModels`, default 2. |
| `packages/mcp-server/src/config.ts` | New `maxResidentModels` field, env `RAGNAROK_MAX_RESIDENT_MODELS`. |
| Wiring (`index.ts`, `extension.ts`) | Construct the registry. ~~Give `MemoryStore` its own pinned service.~~ **SUPERSEDED (Task 7)** — see §3: the pinned service was **withdrawn**, not deferred. `MemoryStore` keeps the **currently configured** model via the shared service and **follows an explicit switch**, because `rag_switch_embedding_model` (`tools.ts:724-782`) and `commands.ts:173` re-point the shared service and validate memory's dimension *after* applying the candidate; a pinned service would make that guard vacuous and make memory silently ignore an explicit user switch. |

The `embedding.model` config key keeps the meaning already documented for it — **"the default model
for newly created topics"** — so no documentation has to be redefined.

## 5. Error handling

| Condition | Behaviour |
| --- | --- |
| Topic metadata names a model that cannot be loaded (absent, no network) | Throw a clear error naming the topic, the required model, and that only the bundled model works offline. Do **not** silently fall back to the configured model — that is the silent-garbage failure this design exists to remove. |
| Topic records a **remote** backend whose `endpointHash` differs from the configured endpoint | Throw, naming the topic, both hashes, and that a remote-built KB needs the endpoint it was built against. Never substitute the configured endpoint (§3.1). |
| Topic records a remote backend and that endpoint is unreachable | Throw naming the topic and the endpoint. `isAvailable()` and the fingerprint probe already detect this (§3.2); the requirement here is that neither degrades into a fallback. |
| Topic metadata absent | Fall back to the configured model, as today (`vectorStoreFactory.ts:250`), and keep the existing warning. |
| Dimension mismatch between a topic's vectors and its resolved model | Throw, as today. This is corruption, not configuration. |
| Registry at capacity | Evict least-recently-used **local** service and dispose it. Remote entries do not count toward capacity and are never evicted. ~~Never evict the memory service.~~ **SUPERSEDED (Task 7)** — see §3: there is no dedicated memory service to exempt, because the pinned design was **withdrawn**, not deferred. Memory uses the **currently configured** model through the shared service and **follows an explicit switch**; the shared configured service is not a registry entry, so nothing about eviction reaches it. Pinning was withdrawn because `rag_switch_embedding_model` (`tools.ts:724-782`) and `commands.ts:173` validate memory's dimension *after* re-pointing the shared service, so a pinned service would make that guard vacuous. |
| `maxResidentModels` below 1 | Rejected by the config schema at startup. |

## 6. Testing

The decisive test — **it fails today**:

> Load topic A (model X), then topic B (model Y), then query A again, and assert A's query was
> embedded with **X**. Assert via the fingerprint or the resolved service identity, not by inspecting
> log output.

Others:

- Memory keeps the configured model after a topic with a different model is loaded — the write path
  specifically, since wrong-space vectors persist.
- Adding documents to an existing topic whose model differs from the configured one **succeeds** and
  writes vectors in that topic's space.
- Creating a new topic records the **configured** model in its metadata.
- LRU: with cap 2, loading a third distinct **local** model evicts the least-recently-used and calls
  `dispose`.
- Cap of 1 works without deadlock or use-after-dispose when alternating between two models.
- A topic naming an unloadable model throws an error naming the topic and the model.
- Registry identity: two topics recording the same `(model, backend, endpointHash)` share one service
  instance.
- **Remote entries do not consume cap slots**: with cap 2, holding two local models plus several
  remote ones evicts nothing, and no remote service is ever disposed by eviction. This is the test for
  §3.1's cap rule — without it, a remote entry could silently evict a real local model.
- A topic recording a remote backend whose `endpointHash` differs from the configured endpoint
  **throws**, naming the topic. Assert on the thrown error, not on a log line.
- A topic recording a remote backend whose endpoint matches but is **unreachable** throws rather than
  falling back to the configured model.

Validate with `npm run test:all`, plus `npm run test:release-static` and `node scripts/check-docs.mjs`.

## 7. Out of scope

- **Per-topic model *selection* at creation.** New topics use the configured model. A
  `rag_create_topic` parameter is not needed for the shared-KB goal and would add surface.
- **The shared knowledge base.** The next spec; this one only removes the mismatch problem that would
  otherwise force it to build degradation machinery.
- **Reranker models.** The cross-encoder scores text pairs and is embedding-space agnostic. Unaffected.
- **Reindexing tools.** Changing a topic's model remains a delete-and-recreate.

## 8. Risks

**Only one embedding model is bundled** (`Xenova/all-MiniLM-L6-v2`). Any topic recording a different
model needs that model present or reachable — so a fully offline deployment can read only KBs built
with the bundled model. Stated in the docs, and enforced by §5's loud error rather than a silent
fallback.

**Two resident models roughly double embedding RAM.** Mitigated by the cap and by `dispose()` on
eviction. Remote backends are exempt (§3.1) because they hold no weights.

**A KB built against a remote endpoint is portable only to deployments configured with that same
endpoint.** §3.1 refuses a foreign endpoint rather than substituting the configured one, so a shared
knowledge base intended to travel should be built with the bundled local model. This narrows the
shared-KB feature that follows this spec, and must be stated in its documentation rather than
discovered through a refusal.

**`validateEmbeddingModel` is being relaxed.** Its dimension and missing-fingerprint checks are
load-bearing and must survive; only the model-*name* difference stops being fatal. A test must pin
each surviving throw.

## 9. Global constraints

- Never add `Co-Authored-By`, `Generated with`, or any attribution trailer to a commit message.
- Never `git add -A` or `git add .` — the repository carries ~24 deliberately untracked working notes
  at its root. Stage explicit paths.
- Run `npm run build --workspace=packages/core` before typechecking `packages/mcp-server`.
- Validate with `npm run test:all`, and capture its true exit status — it chains three suites with
  `&&`, and piping it reports the pipe's status.
- **The `rtk` proxy has twice reported success for commands that exited non-zero**, and it filters
  `git add` output. Confirm every exit status through `rtk proxy` or a redirect, and confirm staging
  with `git diff --cached --name-only`.
- Two tests are known-flaky and unrelated: `packages/core/test/memoryStore.test.ts:140` and mcp-server
  `OpenAILLMProvider isAvailable`.
