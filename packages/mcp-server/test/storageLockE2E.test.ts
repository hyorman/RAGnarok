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
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
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
