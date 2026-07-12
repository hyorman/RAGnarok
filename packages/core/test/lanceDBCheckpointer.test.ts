import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { LanceDBCheckpointSaver } from "../src/stores/lanceDBCheckpointer";

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(threadId: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
  };
}

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  const cp = emptyCheckpoint();
  return { ...cp, ...overrides };
}

function makeMetadata(step: number): CheckpointMetadata {
  return { source: "input", step, writes: null } as unknown as CheckpointMetadata;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("LanceDBCheckpointSaver", function () {
  this.timeout(30000);

  let saver: LanceDBCheckpointSaver;
  let tempDir: string;

  before(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-test-"));
    saver = new LanceDBCheckpointSaver(tempDir);
  });

  after(async function () {
    saver.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── 1. put → getTuple round-trip ───────────────────────────────────

  it("round-trips a checkpoint through put and getTuple", async function () {
    const checkpoint = makeCheckpoint();
    const config = makeConfig("thread-rt");
    const metadata = makeMetadata(0);

    const savedConfig = await saver.put(config, checkpoint, metadata, {});

    const tuple = await saver.getTuple(savedConfig);
    expect(tuple).to.not.be.undefined;
    expect(tuple!.checkpoint.id).to.equal(checkpoint.id);
    expect(tuple!.metadata).to.deep.include({ source: "input", step: 0 });
    expect(tuple!.config.configurable!.thread_id).to.equal("thread-rt");
  });

  // ── 2. Multiple checkpoints → list newest first ────────────────────

  it("lists multiple checkpoints in newest-first order", async function () {
    const threadId = "thread-order";

    const cp1 = makeCheckpoint();
    await saver.put(makeConfig(threadId), cp1, makeMetadata(1), {});

    // Small delay to ensure different created_at timestamps
    await new Promise((r) => setTimeout(r, 10));

    const cp2 = makeCheckpoint();
    const config2 = makeConfig(threadId, cp1.id);
    await saver.put(config2, cp2, makeMetadata(2), {});

    const results: string[] = [];
    for await (const tuple of saver.list(makeConfig(threadId))) {
      results.push(tuple.checkpoint.id);
    }

    expect(results).to.have.lengthOf(2);
    // Newest first
    expect(results[0]).to.equal(cp2.id);
    expect(results[1]).to.equal(cp1.id);
  });

  // ── 3. Thread isolation ────────────────────────────────────────────

  it("isolates checkpoints by thread_id", async function () {
    const cpA = makeCheckpoint();
    const cpB = makeCheckpoint();

    await saver.put(makeConfig("thread-A"), cpA, makeMetadata(0), {});
    await saver.put(makeConfig("thread-B"), cpB, makeMetadata(0), {});

    const tupleA = await saver.getTuple(makeConfig("thread-A"));
    const tupleB = await saver.getTuple(makeConfig("thread-B"));

    expect(tupleA).to.not.be.undefined;
    expect(tupleB).to.not.be.undefined;
    expect(tupleA!.checkpoint.id).to.equal(cpA.id);
    expect(tupleB!.checkpoint.id).to.equal(cpB.id);
  });

  // ── 4. putWrites stores pending writes ─────────────────────────────

  it("stores and retrieves pending writes via putWrites", async function () {
    const checkpoint = makeCheckpoint();
    const threadId = "thread-writes";
    const config = makeConfig(threadId);
    const savedConfig = await saver.put(config, checkpoint, makeMetadata(0), {});

    const writeConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: checkpoint.id,
      },
    };
    await saver.putWrites(writeConfig, [["channel1", "value1"]], "task-1");

    const tuple = await saver.getTuple(savedConfig);
    expect(tuple).to.not.be.undefined;
    const writes = tuple!.pendingWrites ?? [];
    expect(writes).to.be.an("array");
    expect(writes.length).to.be.greaterThanOrEqual(1);

    const write = writes.find((w) => w[0] === "task-1" && w[1] === "channel1");
    expect(write).to.not.be.undefined;
    expect(write![2]).to.equal("value1");
  });

  // ── 5. getTuple returns undefined for nonexistent thread ───────────

  it("returns undefined for nonexistent thread", async function () {
    const tuple = await saver.getTuple(makeConfig("nonexistent-thread"));
    expect(tuple).to.be.undefined;
  });

  // ── 6. Parent checkpoint chaining ──────────────────────────────────

  it("chains parent checkpoint via parentConfig", async function () {
    const threadId = "thread-parent";
    const cp1 = makeCheckpoint();
    await saver.put(makeConfig(threadId), cp1, makeMetadata(0), {});

    await new Promise((r) => setTimeout(r, 10));

    const cp2 = makeCheckpoint();
    // Pass cp1.id as the current checkpoint_id → becomes parent_checkpoint_id in put()
    const config2 = makeConfig(threadId, cp1.id);
    await saver.put(config2, cp2, makeMetadata(1), {});

    const tuple = await saver.getTuple(makeConfig(threadId));
    expect(tuple).to.not.be.undefined;
    expect(tuple!.checkpoint.id).to.equal(cp2.id);
    expect(tuple!.parentConfig).to.not.be.undefined;
    expect(tuple!.parentConfig!.configurable!.checkpoint_id).to.equal(cp1.id);
  });

  it("purges retained checkpoints by age and thread prefix", async function () {
    await saver.put(makeConfig("query:expired"), makeCheckpoint(), makeMetadata(0), {});
    await saver.put(makeConfig("ingest:retained"), makeCheckpoint(), makeMetadata(0), {});

    expect(await saver.deleteOlderThan(Date.now() + 1, "query:")).to.equal(1);
    expect(await saver.getTuple(makeConfig("query:expired"))).to.be.undefined;
    expect(await saver.getTuple(makeConfig("ingest:retained"))).to.not.be.undefined;
  });

  it("deletes a completed thread after its retention window", async function () {
    const threadId = "query:scheduled";
    await saver.put(makeConfig(threadId), makeCheckpoint(), makeMetadata(0), {});
    saver.deleteThreadAfter(threadId, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await saver.getTuple(makeConfig(threadId))).to.be.undefined;
  });
});
