/**
 * Cross-process storage E2E: lock-free reads + operation-scoped write leases.
 *
 * TopicManager.create no longer takes a session lease, so two real server
 * processes can share one storage directory from startup through reads.
 * Only a MUTATION takes a bounded, operation-scoped lease: when a foreign
 * process already holds a live one, the waiting mutation reports
 * StorageBusyError as a tool error instead of failing the server or hanging
 * forever. (StorageLockHeldError — a hard startup refusal — is reserved for
 * a full-exclusion migration/reset/rollback in another process; that is not
 * what this suite exercises.)
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { STORAGE_LOCK_FILENAME } from "@ragnarok/core";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

describe("cross-process storage E2E (lock-free reads / busy-error mutations)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;
  const running: StdioHarness[] = [];

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping storage E2E: ${SERVER_ENTRY} not built`);
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

  it("two server processes on one storage dir both start and answer a read tool", async function () {
    const first = new StdioHarness(storageDir, workDir);
    running.push(first);
    expect((await first.discover()).error, "first process failed to start").to.equal(undefined);

    // The second process on the SAME storage dir must ALSO start: reads are
    // lock-free everywhere, and TopicManager.create takes no session lease.
    const second = new StdioHarness(storageDir, workDir);
    running.push(second);
    expect((await second.discover()).error, "second process failed to start").to.equal(undefined);

    const firstList = await first.callTool(2, "rag_topic", { action: "list" });
    expect(firstList.error, `first read errored: ${JSON.stringify(firstList.error)}`).to.equal(undefined);
    expect(firstList.result?.isError, `first read: ${JSON.stringify(firstList.result)}`).to.not.equal(true);

    const secondList = await second.callTool(2, "rag_topic", { action: "list" });
    expect(secondList.error, `second read errored: ${JSON.stringify(secondList.error)}`).to.equal(undefined);
    expect(secondList.result?.isError, `second read: ${JSON.stringify(secondList.result)}`).to.not.equal(true);

    expect(await first.close(), "first server did not exit cleanly").to.equal(0);
    expect(await second.close(), "second server did not exit cleanly").to.equal(0);
  });

  it("a mutation returns the busy tool error while a foreign process holds a live lock", async function () {
    const server = new StdioHarness(storageDir, workDir);
    running.push(server);
    expect((await server.discover()).error, "server failed to start").to.equal(undefined);

    // Plant a live-looking foreign holder directly (no real second process):
    // a different host and a fresh acquiredAt means the bounded wait in
    // acquireOperationLease treats it as a live writer, never reclaims it as
    // abandoned, and — after the wait expires — throws StorageBusyError.
    const lockPath = path.join(storageDir, STORAGE_LOCK_FILENAME);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ version: 2, ownerId: "x", pid: 99999, hostname: "other-host", acquiredAt: Date.now() }),
    );

    try {
      const created = await server.callTool(2, "rag_topic", { action: "create", name: "busy-topic" }, 15_000);
      expect(created.error, `tool call transport error: ${JSON.stringify(created.error)}`).to.equal(undefined);
      expect(created.result?.isError, `expected a busy tool error, got: ${JSON.stringify(created.result)}`).to.equal(
        true,
      );
      const body = JSON.parse(created.result.content[0].text);
      expect(body.error).to.equal("Storage is busy: another RAGnarōk process is writing. Retry shortly.");
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    // The server itself never acquired the lease (it lost the race to the
    // foreign holder), so it stays fully functional and exits cleanly.
    const tools = await server.listTools(3);
    expect(tools.error).to.equal(undefined);
    expect(tools.result?.tools).to.be.an("array").with.length.greaterThan(0);
    expect(await server.close(), "server did not exit cleanly").to.equal(0);
  });
});
