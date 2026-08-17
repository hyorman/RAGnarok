# Embedding Tools Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `rag_list_embedding_models`, `rag_embedding_info`, and `rag_switch_embedding_model` from the MCP server, shrinking the surface from 11 to 8 tools, and move the docker gate's config-read proof onto `rag_topic` export.

**Architecture:** Pure deletion in `packages/mcp-server` plus verification-infrastructure and docs updates. `packages/core` is untouched. Spec: `docs/superpowers/specs/2026-08-17-embedding-tools-removal-design.md`.

**Tech Stack:** TypeScript, zod, mocha/chai/sinon, MCP stdio server.

## Global Constraints

- **NEVER add attribution trailers to commits.** No `Co-Authored-By`, no `Generated with`, no `Claude-Session`, nothing similar. Commit messages are subject-only (verify with `git log -1 --format=%B`).
- **Never `git add -A` or `git add .`** — stage explicit paths only, verify with `git diff --cached --name-only`.
- **`packages/core` must not change.** The 2026-08-17 pre-init `listAvailableModels` fix stays; the VS Code host consumes it.
- **Do NOT implement any `rag_embeddings` tool.** That direction is superseded by the spec (§2).
- Historical docs (`docs/superpowers/plans/**`, `docs/superpowers/specs/**` other than this plan's spec, root-level `*-FOLLOWUPS.md`, `MCP-INTEGRATION-TEST-*.md`) are not edited.
- Never verify with `command | tail` — the pipe masks exit codes. Redirect to a file or use `; echo "exit=$?"` on the command itself.
- The final 8-tool surface, exactly: `rag_query`, `rag_ingest`, `rag_topic`, `rag_delete_topic`, `rag_remove_document`, `rag_memory`, `rag_reset_memory`, `rag_memory_visualize`.

---

### Task 1: Remove the three tools, narrow the registerTools signature, update unit tests

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/index.ts` (the `registerTools(...)` call, currently at ~line 227)
- Test: `packages/mcp-server/test/tools.test.ts`
- Test: `packages/mcp-server/test/memoryTool.test.ts`
- Test: `packages/mcp-server/test/graphVisualize.test.ts`

**Interfaces:**
- Produces: the narrowed export consumed by every later task:

```ts
export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  ragQueryService: RAGQueryService,
  memoryService?: MemoryService,
  graphVisualizationService?: GraphVisualizationService,
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
  runMutation: MutationRunner = (operation) => operation(),
  runtime: ToolRuntime = { run: (operation) => operation() },
): void
```

- [ ] **Step 1: Flip the surface pins in `tools.test.ts` first (failing tests)**

In `describe("MCP Tools (registerTools)")`:

1. In `it("registers the complete release tool surface")` replace the `expected` array and length pin with:

```ts
    const expected = [
      "rag_query",
      "rag_ingest",
      "rag_topic",
      "rag_delete_topic",
      "rag_remove_document",
      "rag_memory",
      "rag_reset_memory",
      "rag_memory_visualize",
    ];
    expect(Object.keys(fullHandlers)).to.have.lengthOf(8);
```

2. In `it("registers no removed or upload tools")` append to the loop's name array:

```ts
      "rag_list_embedding_models",
      "rag_embedding_info",
      "rag_switch_embedding_model",
```

- [ ] **Step 2: Run the surface tests to verify they fail**

Run (from repo root):
```bash
npm run compile:tests --workspace=@ragnarok/mcp-server && cd packages/mcp-server && npx mocha --grep "registers the complete release tool surface|registers no removed or upload tools"; echo "exit=$?"
```
Expected: FAIL (surface still has 11 tools and still includes the three embedding names).

- [ ] **Step 3: Delete the three tool registrations from `tools.ts`**

Delete these three complete `registerTool(...)` blocks (they sit together under the
`// Embedding management tools` banner, after the `rag_ingest` registration):
`"rag_list_embedding_models"`, `"rag_embedding_info"`, `"rag_switch_embedding_model"`.
Delete the `// Embedding management tools` section banner with them. The deletion
includes the `remoteListingFailed`/`configuredModel` logic added on 2026-08-17 —
it lives entirely inside these handlers.

- [ ] **Step 4: Narrow the signature and clean imports in `tools.ts`**

1. Replace the parameter list of `registerTools` with the signature from **Interfaces** above (removing `embeddingService: EmbeddingService`, `memoryStore?: MemoryStore`, and `runMemoryMutation: MutationRunner = ...`; every use of all three was inside the deleted handlers).
2. Remove `EmbeddingService` from the `@ragnarok/core` value-import list and delete the whole `import type { AvailableModel } from "@ragnarok/core";` line. Keep `MemoryStore` (used by the `memoryBranchProvider` parameter type).
3. In `MCP_LIMITS`, delete the `modelName: 255,` entry (its only consumer was the deleted switch schema).
4. Update the file-header comment block: delete the three `Embedding management tools` lines and change the trailing note to say embedding models, the reranker, and the LLM are configured exclusively through config.json with no tools.

- [ ] **Step 5: Update the call site in `index.ts`**

The current call passes (in order): `server, topicManager, embeddingService, ragQueryService, memoryStore, memoryService, graphVisualizationService, memoryStore, config, runMutation, toolRuntime, (operation) => memoryCoordinator.runMutation(operation)`. Replace with:

```ts
    registerTools(
      server,
      topicManager,
      ragQueryService,
      memoryService,
      graphVisualizationService,
      memoryStore,
      config,
      runMutation,
      toolRuntime,
    );
```

(The surviving `memoryStore` argument is the `memoryBranchProvider`.) Do NOT remove `memoryCoordinator` itself — `MemoryService` construction and `drainToolRuntimeThenMemory` still use it. Do not touch the embedding-service wiring; only its path into `registerTools` disappears.

- [ ] **Step 6: Update `tools.test.ts` harness and delete the embedding describes**

1. In `captureHandlers`: delete `embeddingService`, `memoryStore`, and `runMemoryMutation` from the `deps` type, and rewrite the inner `registerTools(...)` call to the new order:

```ts
  registerTools(
    server,
    deps.topicManager as unknown as TopicManager,
    deps.ragQueryService as unknown as RAGQueryService,
    deps.memoryService as MemoryService | undefined,
    deps.graphVisualizationService as GraphVisualizationService | undefined,
    deps.memoryBranchProvider,
    deps.mcpConfig,
  );
```

2. Remove `embeddingService`/`memoryStore`/`runMemoryMutation` properties from every `captureHandlers({...})` call site in the file, and delete the `embeddingService` stub block plus its `let` declaration from the outer `beforeEach`.
3. Delete these describes entirely: `describe("rag_list_embedding_models")`, `describe("rag_embedding_info")`, `describe("rag_switch_embedding_model")` (the switch describe includes the two coordination tests "waits for an active memory mutation before switching" and "blocks a later memory mutation until switching completes" — they are switch-specific, delete them).
4. Clean now-unused code: the `MemoryOperationCoordinator` import, and the `deferred()`/`tick()` helper functions at the bottom of the file if nothing references them after the deletions (verify with a search before deleting).
5. In the read-only inertness test, change the membership assertion to `expect(Object.keys(handlers)).to.include.members(["rag_query"]);` (rag_query is the only read-only tool registered without a graph service).
6. In `captureDescriptions` and `captureReadOnlyHandlers`, rewrite their `registerTools(...)` calls to the new signature (drop the `embeddingService` argument; `captureReadOnlyHandlers` passes `cfg` as the 7th argument: `server, topicManager, ragQueryService, undefined, undefined, undefined, cfg`).

- [ ] **Step 7: Update `memoryTool.test.ts` harness**

Both `registerTools(...)` calls drop the `embeddingService` argument and the leading `undefined` (old `memoryStore`) argument. New shape for the main harness:

```ts
  registerTools(
    server,
    topicManager,
    {} as RAGQueryService,
    options.memoryService as MemoryService | undefined,
    undefined,
    options.branchProvider,
    { workingDir: options.workingDir ?? "/workspace" } as any,
  );
```

Delete the now-unused `embeddingService` stub object and the `EmbeddingService` type import if unused.

- [ ] **Step 8: Update `graphVisualize.test.ts` harness**

In `register(...)`, the `registerTools` call becomes:

```ts
  registerTools(
    server,
    topicManager,
    {} as any,
    undefined,
    options.graphService as GraphVisualizationService | undefined,
    options.graphService ? ({ getCurrentBranch: sinon.stub().resolves(null) } as any) : undefined,
    { maxResponseBytes: options.maxResponseBytes ?? MCP_LIMITS.responseBytes } as any,
    undefined,
    options.runtime,
  );
```

Remove the `sinon.createStubInstance(EmbeddingService)` argument and the `EmbeddingService` import if unused.

- [ ] **Step 9: Compile and run the unit suites**

```bash
npx tsc --build --force packages/mcp-server; echo "tsc=$?"
npm run compile:tests --workspace=@ragnarok/mcp-server; echo "compile-tests=$?"
cd packages/mcp-server && npx mocha --grep "MCP Tools|MCP memory tools|rag_memory_visualize|common tool response wrapper"; echo "exit=$?"
```
Expected: all PASS, including the two surface pins from Step 1.

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/index.ts packages/mcp-server/test/tools.test.ts packages/mcp-server/test/memoryTool.test.ts packages/mcp-server/test/graphVisualize.test.ts
git diff --cached --name-only
git commit -m "feat(mcp): remove the embedding management tools"
git log -1 --format=%B
```
The log output must be the subject line only.

---

### Task 2: Update the stdio E2E to the 8-tool surface

**Files:**
- Test: `packages/mcp-server/test/stdioTransport.test.ts`

**Interfaces:**
- Consumes: the 8-tool surface from Task 1 (served by `dist/index.js`, rebuilt by the package `pretest`).

- [ ] **Step 1: Shrink `LOCAL_ADMIN_TOOLS`**

Replace the array with exactly:

```ts
const LOCAL_ADMIN_TOOLS = [
  "rag_delete_topic",
  "rag_ingest",
  "rag_memory",
  "rag_memory_visualize",
  "rag_query",
  "rag_remove_document",
  "rag_reset_memory",
  "rag_topic",
];
```

- [ ] **Step 2: Delete the embedding tool calls and extend the removed-tools loop**

1. Delete the block of calls with ids 50–52 (`rag_list_embedding_models`, `rag_embedding_info`, `rag_switch_embedding_model` and their assertions, including the `activeEmbedding` variable).
2. Extend the existing removed-tools rejection loop with three entries (keep ids unique on the connection — 63, 64, 65 are free):

```ts
        [63, "rag_list_embedding_models"],
        [64, "rag_embedding_info"],
        [65, "rag_switch_embedding_model"],
```

3. The tool-annotation spot-check currently reads `rag_list_embedding_models`' `readOnlyHint`; change it to assert `rag_query`'s `readOnlyHint` is `true` instead.

- [ ] **Step 3: Run the E2E**

```bash
npm run compile:tests --workspace=@ragnarok/mcp-server; echo "compile=$?"
npm run build --workspace=@ragnarok/mcp-server; echo "build=$?"
cd packages/mcp-server && npx mocha --grep "stdio transport"; echo "exit=$?"
```
Expected: 2 passing (the catalog-determinism test and the main protocol test, now asserting the exact 8-name catalog).

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/test/stdioTransport.test.ts
git diff --cached --name-only
git commit -m "test(mcp): pin the stdio catalog to the 8-tool surface"
git log -1 --format=%B
```

---

### Task 3: Move the docker gate's config proof to rag_topic export

**Files:**
- Modify: `scripts/docker-gate.mjs`
- Modify: `scripts/test-release-static.mjs` (one pin, at ~line 1523)

**Interfaces:**
- Consumes: `rag_topic` `export` returning `{ path, size, sha256 }`; exporting a zero-document topic succeeds (verified empirically on 2026-08-17 against the built server).

- [ ] **Step 1: Update the tool-surface assertions in `docker-gate.mjs`**

1. `const expectedToolCount = 11;` → `const expectedToolCount = 8;`
2. Append to the removed-names list inside `assertToolSurface` (after `"rag_graph_visualize"`):

```js
    "rag_list_embedding_models",
    "rag_embedding_info",
    "rag_switch_embedding_model",
```

The required-names list (`rag_query`, `rag_ingest`, `rag_topic`, `rag_memory`) is already correct — do not change it.

- [ ] **Step 2: Replace the config-read proof**

1. Change the seed call to:

```js
  seedConfigFile({ storage: { exportDir: "/data/ragnarok/gate-exports" } });
```

2. Replace the `rag_embedding_info` proof block (the `embeddingInfo`/`configuredModel` check) with an export-path proof placed AFTER the existing `rag_topic` create call in session 1:

```js
  // config.json on the volume is the only way to configure a container, so the
  // gate must prove the container actually reads it. exportDir defaults to
  // <storage>/exports; only the seeded file produces the gate-exports prefix.
  // A zero-document topic exports successfully, so no model ever loads here.
  const exported = await session.callTool("rag_topic", { action: "export", topic: topicName });
  if (typeof exported.path !== "string" || !exported.path.startsWith("/data/ragnarok/gate-exports/")) {
    throw new Error(`Container ignored the seeded config.json: ${JSON.stringify(exported)}`);
  }
```

(Adjust ordering: the old proof ran before the create; the new one must run after it. Keep the create call itself unchanged.)

- [ ] **Step 3: Update the release-static pin**

In `scripts/test-release-static.mjs`, change the docker-gate contract regex `/expectedToolCount = 11/` to `/expectedToolCount = 8/`.

- [ ] **Step 4: Validate**

```bash
node --check scripts/docker-gate.mjs; echo "check=$?"
npm run test:release-static > /tmp/rs.log 2>&1; echo "rs=$?"; tail -4 /tmp/rs.log
```
Expected: both exit 0, "Release/package static contracts passed." The docker gate itself is NOT run (requires Docker; it runs in the release pipeline) — say so in the task report rather than implying it ran.

- [ ] **Step 5: Commit**

```bash
git add scripts/docker-gate.mjs scripts/test-release-static.mjs
git diff --cached --name-only
git commit -m "test(release): prove config reads through rag_topic export in the docker gate"
git log -1 --format=%B
```

---

### Task 4: Documentation sweep

**Files:**
- Modify: `README.md`
- Modify: `packages/mcp-server/README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`

- [ ] **Step 1: `README.md`**

1. In the "MCP Tools" table, delete the three rows `rag_list_embedding_models`, `rag_embedding_info`, `rag_switch_embedding_model`.
2. Change the paragraph below it: "complete surface: 11 tools" → "complete surface: 8 tools", and extend the config-only sentence: "The embedding model, the reranker, and the LLM provider are configured exclusively through `config.json` and expose no tools."

- [ ] **Step 2: `packages/mcp-server/README.md`**

1. "The server registers **11 tools**" → "**8 tools**"; extend the same sentence's config-only clause to include the embedding model.
2. Delete the three embedding rows from the tool table.
3. "to see all 11 tools." → "to see all 8 tools."
4. In the configuration-reference section (the table describing `embedding.model`), append this consequence sentence near the `embedding.model` row or as a short paragraph after the table: "Changing `embedding.model` takes effect on restart. Existing topics keep the model recorded at their creation; the new model applies to new topics and to standalone memory, whose fingerprint guard fails closed until `rag_reset_memory` is confirmed. A model that is neither bundled nor cached downloads on first use — expect first-use latency and a stderr log line rather than a pre-flight warning."

- [ ] **Step 3: `ARCHITECTURE.md` and `docs/SECURITY.md`**

1. `ARCHITECTURE.md`: "registers 11 tools unconditionally" → "registers 8 tools unconditionally".
2. `docs/SECURITY.md`: "All 11 tools are registered unconditionally" → "All 8 tools..."; in the same sentence delete the clause "and the configuration one (`rag_switch_embedding_model`)" so it names only the destructive tools.

- [ ] **Step 4: Verify no stale references and run the docs gate**

```bash
grep -rnE "rag_(list_embedding_models|embedding_info|switch_embedding_model)" README.md ARCHITECTURE.md MIGRATION.md docs/OPERATIONS.md docs/SECURITY.md docs/RETRIEVAL-PIPELINE.md packages/mcp-server/README.md packages/core/README.md packages/vscode/README.md; echo "grep=$? (1 = no matches = good)"
npm run test:docs; echo "docs=$?"
```
Expected: grep exit 1 (no matches), docs gate exit 0.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/mcp-server/README.md ARCHITECTURE.md docs/SECURITY.md
git diff --cached --name-only
git commit -m "docs: describe the 8-tool MCP surface"
git log -1 --format=%B
```

---

### Task 5: Full verification sweep

**Files:** none modified (verification only; fixes discovered here belong to the task that owns the file).

- [ ] **Step 1: Full build and every suite, with true exit codes**

```bash
npx tsc --build --force; echo "tsc=$?"
npm run compile; echo "compile=$?"
npm run bundle; echo "bundle=$?"
npm run compile:tests; echo "compile-tests=$?"
(cd packages/core && npx mocha > /tmp/core.log 2>&1); echo "core=$?"; grep -E "passing|failing" /tmp/core.log | tail -2
(cd packages/mcp-server && npx mocha > /tmp/mcp.log 2>&1); echo "mcp=$?"; grep -E "passing|failing" /tmp/mcp.log | tail -2
npm run test:vscode:compiled > /tmp/vsc.log 2>&1; echo "vscode=$?"; grep -E "passing|failing" /tmp/vsc.log | tail -2
npm run test:release-static > /tmp/rs.log 2>&1; echo "rs=$?"
npm run test:docs > /tmp/docs.log 2>&1; echo "docs=$?"
```
Expected: every echoed code 0; core ≈878 passing (unchanged — core untouched), MCP fewer than 215 (embedding tests deleted), zero failing anywhere.

- [ ] **Step 2: Trailer audit**

```bash
git log --format=%B origin/mcp-server..HEAD | grep -icE "co-authored|generated with|claude"; echo "grep=$? (1 = no matches = good)"
```
Expected: count 0, exit 1.

- [ ] **Step 3: Confirm core is untouched**

```bash
git diff origin/mcp-server..HEAD --name-only -- packages/core; echo "---"
```
Expected: empty output (the spec commit and this plan's commits touch no core file).
