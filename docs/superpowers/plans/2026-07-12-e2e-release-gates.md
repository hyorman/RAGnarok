# E2E Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Phase-4 release gates from `CONSOLIDATED-FIX-PLAN.md` with real-binary e2e tests: memory restart persistence (C2), mixed-format ingestion (MB-1), cross-process lock fail-fast (AA-1), shared-mode HTTP surface (Phase 10/0.4.0), and an ONNX-exercising shutdown soak (MB-2).

**Architecture:** All new specs live in `packages/mcp-server/test/*.test.ts` and spawn the **built server binary** (`packages/mcp-server/dist/index.js`) as a real child process, following the existing `stdioTransport.test.ts` pattern. They are picked up automatically by the package mocha config, `npm run test:fast`, and the existing CI jobs (`quality` + `native-process` in `.github/workflows/release.yml`) — **no CI changes are needed**. Task 1 extracts the existing inline `StdioHarness` into a shared helper; every later task consumes it.

**Tech Stack:** TypeScript, mocha + chai (compiled via `tsconfig.test.json` to `dist-test/`), MCP TS SDK (`Client` + `StreamableHTTPClientTransport`, already a dependency), Node ≥20 (global `fetch`).

## Global Constraints

- **Commit hold:** the working tree currently contains uncommitted branch work (Codex's implementation + the 2026-07-12 session fixes). The user has said "do not commit yet" — **before executing Task 1's commit step, ask the user to lift the hold.** Every commit in this plan stages explicit file paths only; never `git add -A`.
- Node 20 and 22 must both pass (CI matrix).
- **No new dependencies** — everything needed (`@modelcontextprotocol/sdk`, `adm-zip`, mocha, chai) is already installed.
- Every spawned server env **must scrub inherited `RAGNAROK_*` variables** (the developer's shell exports remote-provider config that silently reconfigures the server). The `StdioHarness` does this; never spawn the binary without it or an equivalent filter.
- Every spawned server must exit with code 0 on clean shutdown; any `SIGABRT`, `mutex lock failed`, or `libc++abi` text on stderr is a failure.
- The server binary must be built before running specs: `npm run compile` at the repo root. Specs skip (not fail) when `dist/index.js` is absent, matching the existing pattern.
- Run commands below from `packages/mcp-server/` unless stated otherwise. Mocha is invoked as `node ../../node_modules/mocha/bin/mocha.js` (the repo's rtk shell hook mangles `npx mocha`).

**Companion plans (separate documents, in build order after this one):** LangGraph checkpointer wiring + refinement parity (Phase 6) · retrieval-quality misc + VS Code memory wiring (Phases 7–8) · packaging/lint/docs + CF-1 backup verification (Phase 9) · federation `SharedSource`/`RemoteSharedSource` (Phase 10, 0.5.0).

---

### Task 1: Extract the StdioHarness into a shared test helper

The harness class currently lives inline in `test/stdioTransport.test.ts` (lines 19–129). Later tasks need it plus two additions: captured stderr text and a `waitForExit()` for processes that terminate on their own, plus extra CLI args (for `--http`).

**Files:**
- Create: `packages/mcp-server/test/helpers/stdioHarness.ts`
- Modify: `packages/mcp-server/test/stdioTransport.test.ts` (delete the inline class/consts, import from the helper)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `class StdioHarness`, `interface JsonRpcMessage`, `const SERVER_ENTRY: string` — imported by Tasks 2–5 as `import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";`. Key members: `constructor(storageDir: string, allowedDir: string, overrides?: Record<string, string>, extraArgs?: string[])`, `send(msg: object): void`, `waitFor(predicate, timeoutMs): Promise<JsonRpcMessage>`, `callTool(id, name, args, timeoutMs?): Promise<JsonRpcMessage>`, `initialize(id?: number): Promise<JsonRpcMessage>` (new convenience: initialize + initialized handshake), `waitForExit(timeoutMs): Promise<number | null>` (new), `close(): Promise<number | null>`, `readonly stderrText: string` (new), `readonly nonProtocolLines: string[]`, `proc: ChildProcess`.

- [ ] **Step 1: Create the helper**

`packages/mcp-server/test/helpers/stdioHarness.ts` — note the path constants use THREE `..` segments because this file compiles to `dist-test/test/helpers/`:

```typescript
/**
 * Shared harness for real-binary e2e tests: spawns the built server
 * (dist/index.js) with a scrubbed RAGNAROK_* environment and provides
 * JSON-RPC framing over stdio plus process-lifecycle helpers.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

export const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
export const SERVER_ENTRY = path.join(PACKAGE_ROOT, "dist", "index.js");

export interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: any;
  error?: any;
}

export class StdioHarness {
  proc: ChildProcess;
  private buffer = "";
  readonly messages: JsonRpcMessage[] = [];
  readonly nonProtocolLines: string[] = [];
  stderrText = "";
  private waiters: Array<{ predicate: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];

  constructor(
    storageDir: string,
    allowedDir: string,
    overrides: Record<string, string> = {},
    extraArgs: string[] = [],
  ) {
    // Scrub developer RAGNAROK_* config so the test is deterministic.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));
    this.proc = spawn(process.execPath, [SERVER_ENTRY, ...extraArgs], {
      env: {
        ...env,
        RAGNAROK_STORAGE_DIR: storageDir,
        RAGNAROK_WORKING_DIR: allowedDir,
        RAGNAROK_ALLOWED_PATHS: allowedDir,
        ...overrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // stderr is the designated diagnostics channel; keep it for assertions.
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (w.predicate(msg)) {
            w.resolve(msg);
            return false;
          }
          return true;
        });
      } catch {
        this.nonProtocolLines.push(line);
      }
    }
  }

  send(msg: object): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  waitFor(predicate: (m: JsonRpcMessage) => boolean, timeoutMs: number): Promise<JsonRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for message`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** initialize → wait for response → notifications/initialized. */
  async initialize(id = 1): Promise<JsonRpcMessage> {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-harness", version: "1.0.0" },
      },
    });
    const response = await this.waitFor((m) => m.id === id, 30000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
  }

  async callTool(id: number, name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<JsonRpcMessage> {
    this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return this.waitFor((message) => message.id === id, timeoutMs);
  }

  /** Wait for a process that terminates on its own (no stdin close). */
  waitForExit(timeoutMs: number): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return Promise.resolve(this.proc.exitCode);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  dispose(): void {
    this.proc.stdin?.end();
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return this.proc.exitCode;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.proc.kill();
        reject(new Error("Timed out waiting for the stdio server to shut down"));
      }, 15000);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.stdin?.end();
    });
  }
}
```

- [ ] **Step 2: Rewire stdioTransport.test.ts**

Delete lines 19–129 of `packages/mcp-server/test/stdioTransport.test.ts` (the `PACKAGE_ROOT`/`SERVER_ENTRY` consts, `JsonRpcMessage` interface, and the whole inline `StdioHarness` class — keep the `import` block above them) and add to the imports:

```typescript
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";
```

Remove the now-unused `spawn, ChildProcess` import from `"child_process"` if nothing else in the file uses it.

- [ ] **Step 3: Compile and run the stdio suite to prove the extraction is behavior-neutral**

Run from `packages/mcp-server/`:
```bash
npm run compile:tests && node ../../node_modules/mocha/bin/mocha.js dist-test/test/stdioTransport.test.js
```
Expected: `2 passing` (same two tests as before), no failures.

- [ ] **Step 4: Commit** *(check the commit hold in Global Constraints first)*

```bash
git add packages/mcp-server/test/helpers/stdioHarness.ts packages/mcp-server/test/stdioTransport.test.ts
git commit -m "test(e2e): extract shared StdioHarness helper with stderr/exit capture"
```

---

### Task 2: Memory restart-persistence e2e (the C2 release gate)

Reproduces the exact data-loss scenario from the branch review over the real binary: store → restart → **mutate over reloaded rows** (the Arrow-vector trigger) → restart → assert nothing was lost.

**Files:**
- Create: `packages/mcp-server/test/memoryPersistenceE2E.test.ts`

**Interfaces:**
- Consumes: `StdioHarness`, `SERVER_ENTRY` from Task 1.
- Produces: nothing consumed by later tasks.

**Response shapes used (from `src/tools.ts` `rag_memory`):** `store` → `{action:"store", memory:{id, content, ...}}` · `list` → `{action:"list", memories:[{id, content, ...}], count}` · `recall` → `{action:"recall", memories:[{id, content, score, ...}], count}` · `forget` → `{action:"forget", forgottenCount}`.

- [ ] **Step 1: Write the spec**

`packages/mcp-server/test/memoryPersistenceE2E.test.ts`:

```typescript
/**
 * C2 release gate: memory must survive restart → mutate → restart.
 *
 * The 0.3.x data-loss bug: LanceDB returns Arrow Vector objects on read;
 * persisting a collection containing them destroyed every row. The fatal
 * sequence was exactly "restart (reload from disk), then mutate, then
 * restart" — so that is exactly what this spec does, over the real binary.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

function payload(message: { result?: any }): any {
  return JSON.parse(message.result?.content?.[0]?.text ?? "{}");
}

describe("memory restart persistence E2E (C2 gate)", function () {
  this.timeout(180000);

  let storageDir: string;
  let workDir: string;
  let harness: StdioHarness | undefined;

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping memory E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-memory-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-memory-work-"));
  });

  after(async function () {
    if (harness) {
      try {
        await harness.close();
      } catch {
        harness.proc.kill();
      }
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("memories survive restart → mutate → restart with zero loss", async function () {
    // ── Generation 1: store two memories ────────────────────────────
    harness = new StdioHarness(storageDir, workDir);
    expect((await harness.initialize()).error).to.equal(undefined);

    const store1 = await harness.callTool(2, "rag_memory", {
      action: "store",
      content: "The deploy pipeline requires a teal token for staging pushes.",
    });
    expect(store1.result?.isError, JSON.stringify(store1.result)).not.to.equal(true);
    const keptId = payload(store1).memory.id as string;

    const store2 = await harness.callTool(3, "rag_memory", {
      action: "store",
      content: "Weekly sync happens on Thursdays at noon in the atrium.",
    });
    expect(store2.result?.isError, JSON.stringify(store2.result)).not.to.equal(true);
    const doomedId = payload(store2).memory.id as string;

    const list1 = payload(await harness.callTool(4, "rag_memory", { action: "list" }));
    expect(list1.count, JSON.stringify(list1)).to.equal(2);

    expect(await harness.close(), "generation 1 did not exit cleanly").to.equal(0);

    // ── Generation 2: reload from disk, THEN mutate (the C2 trigger) ──
    harness = new StdioHarness(storageDir, workDir);
    expect((await harness.initialize()).error).to.equal(undefined);

    const list2 = payload(await harness.callTool(2, "rag_memory", { action: "list" }));
    expect(list2.count, `restart lost memories: ${JSON.stringify(list2)}`).to.equal(2);

    // Mutation 1: store a third entry over the reloaded (previously
    // Arrow-backed) collection — this write destroyed ALL rows in 0.3.x.
    const store3 = await harness.callTool(3, "rag_memory", {
      action: "store",
      content: "Rollbacks are triggered with the crimson lever in ops-console.",
    });
    expect(store3.result?.isError, JSON.stringify(store3.result)).not.to.equal(true);
    const crimsonId = payload(store3).memory.id as string;

    // Mutation 2: forget one of the originals.
    const forget = payload(await harness.callTool(4, "rag_memory", { action: "forget", id: doomedId }));
    expect(forget.forgottenCount).to.equal(1);

    expect(await harness.close(), "generation 2 did not exit cleanly").to.equal(0);

    // ── Generation 3: assert exact surviving set ─────────────────────
    harness = new StdioHarness(storageDir, workDir);
    expect((await harness.initialize()).error).to.equal(undefined);

    const list3 = payload(await harness.callTool(2, "rag_memory", { action: "list" }));
    const survivingIds = (list3.memories as Array<{ id: string }>).map((m) => m.id).sort();
    expect(survivingIds, JSON.stringify(list3)).to.deep.equal([keptId, crimsonId].sort());

    const recall = payload(
      await harness.callTool(3, "rag_memory", { action: "recall", query: "how do I trigger a rollback?" }),
    );
    expect(recall.count, JSON.stringify(recall)).to.be.greaterThan(0);
    const texts = (recall.memories as Array<{ content: string }>).map((m) => m.content.toLowerCase());
    expect(texts.some((t) => t.includes("crimson lever")), JSON.stringify(texts)).to.equal(true);

    expect(harness.nonProtocolLines, "diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close(), "generation 3 did not exit cleanly").to.equal(0);
    harness = undefined;
  });
});
```

- [ ] **Step 2: Build the server + tests, run the spec**

Run from the repo root once (server binary): `npm run compile`. Then from `packages/mcp-server/`:
```bash
npm run compile:tests && node ../../node_modules/mocha/bin/mocha.js dist-test/test/memoryPersistenceE2E.test.js
```
Expected: `1 passing`. If generation 3's list count is wrong, that is a real C2 regression — stop and fix the product, not the test.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/test/memoryPersistenceE2E.test.ts
git commit -m "test(e2e): C2 gate — memory survives restart, mutate, restart"
```

---

### Task 3: Mixed-format ingestion e2e (the MB-1 gate)

Schema inference used to diverge depending on which file format was ingested first. Two topics ingest the same three files in opposite orders; both must accept every document and answer queries from each format.

**Files:**
- Create: `packages/mcp-server/test/mixedFormatE2E.test.ts`

**Interfaces:**
- Consumes: `StdioHarness`, `SERVER_ENTRY` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the spec**

`packages/mcp-server/test/mixedFormatE2E.test.ts`:

```typescript
/**
 * MB-1 release gate: mixed-format corpora must ingest regardless of order.
 *
 * 0.3.x inferred each topic's LanceDB schema from the FIRST file's chunk
 * metadata (markdown headings/loc vs plain text), so a txt-first topic
 * rejected md chunks and vice versa. Chunk columns are now normalized to a
 * fixed typed set; this spec locks that in over the real binary.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

function payload(message: { result?: any }): any {
  return JSON.parse(message.result?.content?.[0]?.text ?? "{}");
}

describe("mixed-format ingestion E2E (MB-1 gate)", function () {
  this.timeout(180000);

  let storageDir: string;
  let sourceDir: string;
  let harness: StdioHarness | undefined;
  let files: { txt: string; md: string; html: string };

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping mixed-format E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-mixed-e2e-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-mixed-src-"));
    files = {
      txt: path.join(sourceDir, "plain-notes.txt"),
      md: path.join(sourceDir, "structured-guide.md"),
      html: path.join(sourceDir, "rendered-page.html"),
    };
    fs.writeFileSync(files.txt, "The backup rotation keeps seven nightly copper snapshots.\n", "utf8");
    fs.writeFileSync(
      files.md,
      "# Operations Guide\n\n## Alerting\n\nPager escalation goes through the silver relay first.\n",
      "utf8",
    );
    fs.writeFileSync(
      files.html,
      "<html><body><h1>Runbook</h1><p>Cache invalidation is performed by the golden broom job.</p></body></html>",
      "utf8",
    );
  });

  after(async function () {
    if (harness) {
      try {
        await harness.close();
      } catch {
        harness.proc.kill();
      }
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  async function ingestInOrder(topic: string, order: string[], firstId: number): Promise<void> {
    const create = await harness!.callTool(firstId, "rag_create_topic", { name: topic });
    expect(create.result?.isError, JSON.stringify(create.result)).not.to.equal(true);
    // One call per file so ingestion order is deterministic.
    for (const [index, filePath] of order.entries()) {
      const ingest = await harness!.callTool(
        firstId + 1 + index,
        "rag_add_documents",
        { topic, filePaths: [filePath] },
        60000,
      );
      expect(ingest.result?.isError, `${topic} ← ${path.basename(filePath)}: ${JSON.stringify(ingest.result)}`).not.to.equal(true);
      expect(payload(ingest).documentsAdded, `${topic} ← ${path.basename(filePath)}`).to.equal(1);
    }
    const stats = payload(await harness!.callTool(firstId + 10, "rag_topic_stats", { topic }));
    expect(stats.documentCount, JSON.stringify(stats)).to.equal(3);
    expect(stats.chunkCount, JSON.stringify(stats)).to.be.greaterThan(0);
  }

  async function expectAnswer(topic: string, query: string, needle: string, id: number): Promise<void> {
    const response = await harness!.callTool(id, "rag_query", { topic, query, topK: 3 }, 60000);
    expect(response.result?.isError, `${topic}: ${JSON.stringify(response.result)}`).not.to.equal(true);
    const text = (response.result?.content?.[0]?.text ?? "").toLowerCase();
    expect(text, `${topic} / "${query}"`).to.include(needle);
  }

  it("ingests txt→md→html and html→md→txt identically", async function () {
    harness = new StdioHarness(storageDir, sourceDir);
    expect((await harness.initialize()).error).to.equal(undefined);

    await ingestInOrder("mixed-a", [files.txt, files.md, files.html], 10);
    await ingestInOrder("mixed-b", [files.html, files.md, files.txt], 30);

    // Every format must be retrievable from BOTH topics.
    await expectAnswer("mixed-a", "How many nightly snapshots are kept?", "copper", 50);
    await expectAnswer("mixed-a", "What does pager escalation go through?", "silver relay", 51);
    await expectAnswer("mixed-a", "What performs cache invalidation?", "golden broom", 52);
    await expectAnswer("mixed-b", "How many nightly snapshots are kept?", "copper", 53);
    await expectAnswer("mixed-b", "What performs cache invalidation?", "golden broom", 54);

    expect(harness.nonProtocolLines, "diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close()).to.equal(0);
    harness = undefined;
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run compile:tests && node ../../node_modules/mocha/bin/mocha.js dist-test/test/mixedFormatE2E.test.js
```
Expected: `1 passing`. If `rag_add_documents` rejects the `.html` file (loader gap rather than schema bug), record it as a product finding and fix the loader — do not silently drop the format from the spec.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/test/mixedFormatE2E.test.ts
git commit -m "test(e2e): MB-1 gate — order-independent mixed-format ingestion"
```

---

### Task 4: Cross-process lock e2e (the AA-1 gate)

Unit tests simulate foreign holders by writing lock files; only a real second OS process proves the end-to-end fail-fast path (`TopicManager.create` → `acquireStorageLock` → fatal startup error, exit code 1).

**Files:**
- Create: `packages/mcp-server/test/storageLockE2E.test.ts`

**Interfaces:**
- Consumes: `StdioHarness`, `SERVER_ENTRY` from Task 1 (specifically `waitForExit` and `stderrText`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the spec**

`packages/mcp-server/test/storageLockE2E.test.ts`:

```typescript
/**
 * AA-1 release gate: two real server processes on one storage directory.
 *
 * The second process must fail fast at startup with a message naming the
 * holder (exit code 1), the first must stay fully functional, and after the
 * first exits cleanly a new process must acquire the directory again.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

describe("cross-process storage lock E2E (AA-1 gate)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;
  const running: StdioHarness[] = [];

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping lock E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-lock-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-lock-work-"));
  });

  after(async function () {
    for (const harness of running) {
      try {
        await harness.close();
      } catch {
        harness.proc.kill();
      }
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("second process fails fast; lock releases on clean exit", async function () {
    // First process: fully started (initialize response ⇒ TopicManager
    // created ⇒ lock held).
    const first = new StdioHarness(storageDir, workDir);
    running.push(first);
    expect((await first.initialize()).error).to.equal(undefined);
    expect(fs.existsSync(path.join(storageDir, ".ragnarok.lock")), "lock file missing").to.equal(true);

    // Second process on the SAME storage dir: must exit 1, naming the holder.
    const second = new StdioHarness(storageDir, workDir);
    running.push(second);
    const secondExit = await second.waitForExit(30000);
    expect(secondExit, `expected startup failure; stderr: ${second.stderrText.slice(0, 500)}`).to.equal(1);
    expect(second.stderrText).to.include("locked by another RAGnarōk process");
    expect(second.stderrText).to.include(String(first.proc.pid));

    // First process is unharmed by the rejected intruder.
    first.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    const tools = await first.waitFor((m) => m.id === 5, 15000);
    expect(tools.error).to.equal(undefined);
    expect(tools.result?.tools).to.be.an("array").with.length.greaterThan(0);

    // Clean exit releases the lock…
    expect(await first.close(), "first server did not exit cleanly").to.equal(0);
    expect(fs.existsSync(path.join(storageDir, ".ragnarok.lock")), "lock not released on exit").to.equal(false);

    // …so a third process acquires the directory normally.
    const third = new StdioHarness(storageDir, workDir);
    running.push(third);
    expect((await third.initialize()).error).to.equal(undefined);
    expect(await third.close(), "third server did not exit cleanly").to.equal(0);
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run compile:tests && node ../../node_modules/mocha/bin/mocha.js dist-test/test/storageLockE2E.test.js
```
Expected: `1 passing`. Failure modes worth distinguishing: second process hangs instead of exiting ⇒ something keeps the event loop alive after the fatal error (fix in `index.ts`/`main().catch`); lock file still present after clean close ⇒ release/exit-hook bug in `storageLock.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/test/storageLockE2E.test.ts
git commit -m "test(e2e): AA-1 gate — second process fails fast on locked storage dir"
```

---

### Task 5: Shared-mode HTTP e2e over the real binary

The in-process `httpTransport.test.ts` covers auth/session mechanics. This spec covers what only the real binary shows: shared-deployment detection (`--http` + tokens), the memory-tool-free surface for **both** roles, `[Team shared KB]` descriptions, server instructions, and a clean SIGTERM (HTTP-mode MB-2).

**Files:**
- Create: `packages/mcp-server/test/httpBinaryE2E.test.ts`

**Interfaces:**
- Consumes: `StdioHarness`, `SERVER_ENTRY` from Task 1 (spawn with `extraArgs: ["--http"]`; stdout carries no JSON-RPC in HTTP mode).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the spec**

`packages/mcp-server/test/httpBinaryE2E.test.ts`:

```typescript
/**
 * Shared-deployment e2e over the real binary (`--http` + auth tokens):
 * - unauthenticated requests are rejected;
 * - memory tools are structurally absent for reader AND writer sessions;
 * - write tools are absent for readers, present for writers;
 * - every tool description carries the "[Team shared KB]" prefix and the
 *   server advertises shared-KB instructions;
 * - SIGTERM produces exit code 0 with no native-abort traces (MB-2, HTTP path).
 */
import { expect } from "chai";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

const READ_TOKEN = "e2e-read-token";
const WRITE_TOKEN = "e2e-write-token";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`/ready did not come up on port ${port} within ${timeoutMs}ms`);
}

function authedClient(port: number, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-e2e", version: "1.0.0" });
  return { client, transport };
}

describe("shared-mode HTTP E2E (real binary)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;
  let harness: StdioHarness | undefined;
  let port: number;

  before(async function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping HTTP binary E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-work-"));
    port = await getFreePort();
    harness = new StdioHarness(
      storageDir,
      workDir,
      {
        RAGNAROK_PORT: String(port),
        RAGNAROK_API_KEY: READ_TOKEN,
        RAGNAROK_WRITE_API_KEY: WRITE_TOKEN,
      },
      ["--http"],
    );
    await waitForReady(port, 60000);
  });

  after(async function () {
    if (harness && harness.proc.exitCode === null) {
      harness.proc.kill("SIGTERM");
      await harness.waitForExit(20000).catch(() => harness!.proc.kill("SIGKILL"));
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated requests", async function () {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).to.equal(401);
  });

  it("serves a memory-free, prefixed, role-scoped tool surface", async function () {
    const reader = authedClient(port, READ_TOKEN);
    await reader.client.connect(reader.transport);
    const readerTools = (await reader.client.listTools()).tools;
    const readerNames = readerTools.map((t) => t.name);

    expect(readerNames).to.include("rag_query");
    expect(readerNames, "memory tools must be absent in shared mode").to.not.include("rag_memory");
    expect(readerNames).to.not.include("rag_reset_memory");
    expect(readerNames, "write tools must be absent for readers").to.not.include("rag_create_topic");
    for (const tool of readerTools) {
      expect(tool.description ?? "", `description of ${tool.name}`).to.match(/^\[Team shared KB\] /);
    }
    const instructions = reader.client.getInstructions() ?? "";
    expect(instructions.toLowerCase()).to.include("team shared knowledge base");
    await reader.client.close();

    const writer = authedClient(port, WRITE_TOKEN);
    await writer.client.connect(writer.transport);
    const writerNames = (await writer.client.listTools()).tools.map((t) => t.name);
    expect(writerNames, "writers get write tools").to.include("rag_create_topic");
    expect(writerNames, "memory tools are absent for EVERY role in shared mode").to.not.include("rag_memory");
    expect(writerNames).to.not.include("rag_reset_memory");
    await writer.client.close();
  });

  it("exits 0 on SIGTERM with no native-abort traces (MB-2, HTTP path)", async function () {
    harness!.proc.kill("SIGTERM");
    const exitCode = await harness!.waitForExit(20000);
    expect(exitCode, `stderr: ${harness!.stderrText.slice(-500)}`).to.equal(0);
    expect(harness!.stderrText).to.not.match(/SIGABRT|mutex lock failed|libc\+\+abi/);
    harness = undefined;
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run compile:tests && node ../../node_modules/mocha/bin/mocha.js dist-test/test/httpBinaryE2E.test.js
```
Expected: `3 passing`. Note the tests are order-dependent by design (the SIGTERM test terminates the shared server last); mocha runs them in declaration order.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/test/httpBinaryE2E.test.ts
git commit -m "test(e2e): shared-mode HTTP gates — auth, memory-free surface, clean SIGTERM"
```

---

### Task 6: Harden the shutdown soak (real MB-2 path: ONNX + env hygiene)

The soak currently runs with `RAGNAROK_RERANKER_ENABLED: "false"` — but the native abort (`mutex lock failed`) came from ONNX sessions, so the soak never exercises the risky path. The reranker warm-up added on 2026-07-12 loads the ONNX session at startup, so enabling the reranker makes every iteration load **and** dispose it. Also scrub inherited `RAGNAROK_*` (AA-2 hygiene — the developer's shell exports remote-provider config).

**Files:**
- Modify: `scripts/shutdown-soak.mjs`

**Interfaces:**
- Consumes: `dist/index.js` (built binary), `npm run test:shutdown-soak` (already wired in `release.yml` `native-process` job — no CI change needed).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Apply the changes**

In `scripts/shutdown-soak.mjs`, replace the `env` block of the `spawn` call:

```javascript
      const child = spawn(process.execPath, [entry], {
        cwd: root,
        env: {
          // Scrub developer RAGNAROK_* config so the soak is deterministic.
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_"))),
          RAGNAROK_STORAGE_DIR: storageDir,
          RAGNAROK_LOG_LEVEL: "error",
          // Exercise the ONNX-session lifecycle — the historical SIGABRT
          // source. Startup warm-up loads the model; shutdown disposes it.
          RAGNAROK_RERANKER_ENABLED: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
```

And raise the per-iteration timeout from `20_000` to `45_000` (model load adds 1–3s per iteration; CI machines are slower):

```javascript
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`shutdown iteration ${iteration} timed out`));
      }, 45_000);
```

- [ ] **Step 2: Run the soak locally**

From the repo root (binary must be built):
```bash
npm run compile && node scripts/shutdown-soak.mjs
```
Expected output: `20/20 stdio shutdown iterations exited cleanly.` A nonzero exit or any `SIGABRT`/`mutex lock failed` line is a real MB-2 regression — the SIGTERM can land mid-model-load, which is exactly the race this soaks for.

- [ ] **Step 3: Commit**

```bash
git add scripts/shutdown-soak.mjs
git commit -m "test(soak): exercise ONNX lifecycle and scrub RAGNAROK_* env in shutdown soak"
```

---

### Task 7: Full verification + status bookkeeping

**Files:**
- Modify: `CONSOLIDATED-FIX-PLAN.md` (Phase 4 statuses)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: the updated tracking document.

- [ ] **Step 1: Run the complete gate set locally**

From the repo root:
```bash
npm run test:fast && node scripts/shutdown-soak.mjs
```
Expected: core suite passing (728+ tests), mcp suite passing (existing 162 + the 6 new e2e specs), soak `20/20`. The new specs run inside `test:mcp:compiled`, so the CI `quality` and `native-process` jobs pick them up with **zero workflow changes**.

- [ ] **Step 2: Verify the lint gate is actually runnable** (it OOM'd at 2GB earlier in review; CI runs it in the `quality` job)

```bash
npm run lint
```
Expected: completes without heap exhaustion. If it OOMs, record the finding in `CONSOLIDATED-FIX-PLAN.md` Phase 9 (per-package lint split) — do NOT fix it in this plan.

- [ ] **Step 3: Update `CONSOLIDATED-FIX-PLAN.md` Phase 4**

Mark: e2e harness `[impl]` (list the five gates: C1 via existing stdio strategies loop, C2 via `memoryPersistenceE2E`, MB-1 via `mixedFormatE2E`, AA-1 via `storageLockE2E`, MB-2 via hardened soak + `httpBinaryE2E` SIGTERM); AA-2 `[impl]` (harness scrubbing + soak scrubbing); note the Phase 2 `documentId`/`chunkId` verification item is closed by the existing stdio E2E assertions (`doc-<sha256>` pattern + reingest-no-duplicate).

- [ ] **Step 4: Commit**

```bash
git add CONSOLIDATED-FIX-PLAN.md
git commit -m "docs: mark Phase 4 e2e gates implemented in consolidated plan"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 4 matrix — C1 all-strategies (already in-repo, both legacy + LangGraph paths), C2 (Task 2), MB-1 (Task 3), MB-2 (Task 6 soak + Task 5 SIGTERM + existing docker job exit-code checks), AA-1 (Task 4), AA-2 (Task 1 harness + Task 6 soak), HTTP roles/401/session (in-process suite + Task 5 real-binary), shared-mode surface (Task 5). CI wiring: intentional no-op — specs land inside suites CI already runs.
- **Deliberately out of scope:** checkpointer wiring, retrieval quality, VS Code memory, lint burn-down, docs reconciliation, federation — companion plans.
- **Type consistency:** all specs consume only `StdioHarness`/`SERVER_ENTRY`/`JsonRpcMessage` exactly as defined in Task 1; `rag_memory` payload shapes copied verbatim from `src/tools.ts`.
