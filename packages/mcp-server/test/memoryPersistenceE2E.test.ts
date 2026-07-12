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
