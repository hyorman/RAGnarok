import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { connect } from "@lancedb/lancedb";
import { Field, Float64, Schema, Utf8 } from "apache-arrow";
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
    await saver.dispose();
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

  it("round-trips values through the LangGraph typed serializer", async function () {
    const checkpoint = makeCheckpoint({
      channel_values: {
        bytes: new Uint8Array([1, 2, 255]),
        map: new Map([["answer", 42]]),
        set: new Set(["alpha", "beta"]),
      },
    });
    const saved = await saver.put(makeConfig("thread-typed"), checkpoint, makeMetadata(0), {});
    await saver.putWrites(saved, [["typed-write", new Uint8Array([9, 8, 7])]], "typed-task");

    const tuple = await saver.getTuple(saved);
    expect(tuple!.checkpoint.channel_values.bytes).to.deep.equal(new Uint8Array([1, 2, 255]));
    expect(tuple!.checkpoint.channel_values.map).to.deep.equal(new Map([["answer", 42]]));
    expect(tuple!.checkpoint.channel_values.set).to.deep.equal(new Set(["alpha", "beta"]));
    expect(tuple!.pendingWrites![0][2]).to.deep.equal(new Uint8Array([9, 8, 7]));
  });

  it("orders same-millisecond checkpoints deterministically without sleeps", async function () {
    const originalNow = Date.now;
    Date.now = () => 1_750_000_000_000;
    try {
      const threadId = "thread-same-ms";
      const checkpoints = [makeCheckpoint(), makeCheckpoint(), makeCheckpoint()];
      let config = makeConfig(threadId);
      for (const [step, checkpoint] of checkpoints.entries()) {
        config = await saver.put(config, checkpoint, makeMetadata(step), {});
      }

      const listed: string[] = [];
      for await (const tuple of saver.list(makeConfig(threadId))) {
        listed.push(tuple.checkpoint.id);
      }
      expect(listed).to.deep.equal(checkpoints.map((checkpoint) => checkpoint.id).reverse());
      expect((await saver.getTuple(makeConfig(threadId)))!.checkpoint.id).to.equal(checkpoints[2].id);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps checkpoint order immutable when an ancestor put is retried", async function () {
    const threadId = "thread-idempotent-retry";
    const first = makeCheckpoint({ id: "00000000-0000-6000-8000-000000000001" });
    const second = makeCheckpoint({ id: "00000000-0000-6000-8000-000000000002" });
    await saver.put(makeConfig(threadId), first, makeMetadata(1), {});
    await saver.put(makeConfig(threadId, first.id), second, makeMetadata(2), {});

    await saver.put(makeConfig(threadId), first, makeMetadata(1), {});

    expect((await saver.getTuple(makeConfig(threadId)))!.checkpoint.id).to.equal(second.id);
    const listed: string[] = [];
    for await (const tuple of saver.list(makeConfig(threadId))) {
      listed.push(tuple.checkpoint.id);
    }
    expect(listed).to.deep.equal([second.id, first.id]);
  });

  it("returns pending writes in stable task and write-index order", async function () {
    const saved = await saver.put(makeConfig("thread-write-order"), makeCheckpoint(), makeMetadata(0), {});
    await saver.putWrites(
      saved,
      [
        ["z0", 0],
        ["z1", 1],
      ],
      "task-z",
    );
    await saver.putWrites(
      saved,
      [
        ["a0", 2],
        ["a1", 3],
      ],
      "task-a",
    );

    expect((await saver.getTuple(saved))!.pendingWrites).to.deep.equal([
      ["task-a", "a0", 2],
      ["task-a", "a1", 3],
      ["task-z", "z0", 0],
      ["task-z", "z1", 1],
    ]);
  });

  it("allows 20 concurrent cold first puts and reads every checkpoint", async function () {
    const coldDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-cold-"));
    const coldSaver = new LanceDBCheckpointSaver(coldDir);
    try {
      const checkpoints = Array.from({ length: 20 }, () => makeCheckpoint());
      const configs = await Promise.all(
        checkpoints.map((checkpoint, index) =>
          coldSaver.put(makeConfig(`cold:${index}`), checkpoint, makeMetadata(index), {}),
        ),
      );
      const tuples = await Promise.all(configs.map((config) => coldSaver.getTuple(config)));
      expect(tuples.map((tuple) => tuple?.checkpoint.id)).to.deep.equal(checkpoints.map((checkpoint) => checkpoint.id));
    } finally {
      await coldSaver.dispose();
      await fs.rm(coldDir, { recursive: true, force: true });
    }
  });

  it("orders same-millisecond commits globally across saver instances and retains by the shared latest row", async function () {
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-shared-order-"));
    const firstSaver = new LanceDBCheckpointSaver(sharedDir);
    const secondSaver = new LanceDBCheckpointSaver(sharedDir);
    const originalNow = Date.now;
    try {
      Date.now = () => 4_000;
      const first = makeCheckpoint({ id: "z-first" });
      const second = makeCheckpoint({ id: "a-second" });
      await firstSaver.put(makeConfig("shared-order"), first, makeMetadata(1), {});
      await secondSaver.put(makeConfig("shared-order", first.id), second, makeMetadata(2), {});

      expect((await firstSaver.getTuple(makeConfig("shared-order")))!.checkpoint.id).to.equal(second.id);
      expect(await secondSaver.deleteOlderThan(4_000, "shared-")).to.equal(0);
      expect(await secondSaver.deleteOlderThan(4_001, "shared-")).to.equal(1);
      expect(await firstSaver.getTuple(makeConfig("shared-order"))).to.be.undefined;
    } finally {
      Date.now = originalNow;
      await firstSaver.dispose();
      await secondSaver.dispose();
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("survives repeated concurrent put stress", async function () {
    const stressDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-stress-"));
    const stressSaver = new LanceDBCheckpointSaver(stressDir);
    try {
      for (let round = 0; round < 10; round += 1) {
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            stressSaver.put(makeConfig(`stress:${round}:${index}`), makeCheckpoint(), makeMetadata(round), {}),
          ),
        );
      }
      let count = 0;
      for (let round = 0; round < 10; round += 1) {
        for (let index = 0; index < 20; index += 1) {
          if (await stressSaver.getTuple(makeConfig(`stress:${round}:${index}`))) {
            count += 1;
          }
        }
      }
      expect(count).to.equal(200);
    } finally {
      await stressSaver.dispose();
      await fs.rm(stressDir, { recursive: true, force: true });
    }
  });

  it("deletes only threads whose latest checkpoint is strictly before the cutoff", async function () {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      await saver.put(makeConfig("retention:expired"), makeCheckpoint(), makeMetadata(0), {});
      const activeFirst = makeCheckpoint();
      await saver.put(makeConfig("retention:active"), activeFirst, makeMetadata(0), {});

      Date.now = () => 2_000;
      await saver.put(makeConfig("retention:active", activeFirst.id), makeCheckpoint(), makeMetadata(1), {});
      await saver.put(makeConfig("retention:boundary"), makeCheckpoint(), makeMetadata(0), {});
      await saver.put(makeConfig("other:expired"), makeCheckpoint(), makeMetadata(0), {});

      expect(await saver.deleteOlderThan(2_000, "retention:")).to.equal(1);
      expect(await saver.getTuple(makeConfig("retention:expired"))).to.be.undefined;
      expect(await saver.getTuple(makeConfig("retention:active"))).to.not.be.undefined;
      expect(await saver.getTuple(makeConfig("retention:boundary"))).to.not.be.undefined;
      expect(await saver.getTuple(makeConfig("other:expired"))).to.not.be.undefined;
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not let an old delayed deletion remove a reused thread", async function () {
    const threadId = "query:reused";
    await saver.put(makeConfig(threadId), makeCheckpoint(), makeMetadata(0), {});
    saver.deleteThreadAfter(threadId, 20);
    await saver.put(makeConfig(threadId), makeCheckpoint(), makeMetadata(1), {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await saver.getTuple(makeConfig(threadId))).to.not.be.undefined;
  });

  it("cancels delayed deletion and leaves no live timer after awaited dispose", async function () {
    const disposeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-dispose-"));
    const disposingSaver = new LanceDBCheckpointSaver(disposeDir);
    const checkpoint = makeCheckpoint();
    await disposingSaver.put(makeConfig("query:dispose"), checkpoint, makeMetadata(0), {});
    disposingSaver.deleteThreadAfter("query:dispose", 10);
    await disposingSaver.dispose();

    await new Promise((resolve) => setTimeout(resolve, 30));
    const reopened = new LanceDBCheckpointSaver(disposeDir);
    try {
      expect((await reopened.getTuple(makeConfig("query:dispose")))!.checkpoint.id).to.equal(checkpoint.id);
    } finally {
      await reopened.dispose();
      await fs.rm(disposeDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy JSON tables into typed v2 tables without deleting the originals", async function () {
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-legacy-"));
    const db = await connect(legacyDir);
    const checkpoint = makeCheckpoint({ channel_values: { legacy: "preserved" } });
    const legacyTable = await db.createEmptyTable(
      "_lg_checkpoints",
      new Schema([
        new Field("thread_id", new Utf8(), false),
        new Field("checkpoint_ns", new Utf8(), false),
        new Field("checkpoint_id", new Utf8(), false),
        new Field("parent_checkpoint_id", new Utf8(), false),
        new Field("data", new Utf8(), false),
        new Field("metadata", new Utf8(), false),
        new Field("created_at", new Float64(), false),
      ]),
    );
    await legacyTable.add([
      {
        thread_id: "legacy-thread",
        checkpoint_ns: "",
        checkpoint_id: checkpoint.id,
        parent_checkpoint_id: "",
        data: JSON.stringify(checkpoint),
        metadata: JSON.stringify(makeMetadata(7)),
        created_at: 1234,
      },
    ]);
    legacyTable.close();
    db.close();

    const migratedSaver = new LanceDBCheckpointSaver(legacyDir);
    try {
      const tuple = await migratedSaver.getTuple(makeConfig("legacy-thread"));
      expect(tuple!.checkpoint.channel_values.legacy).to.equal("preserved");
      expect(tuple!.metadata).to.deep.include({ step: 7 });
      const reopenedDb = await connect(legacyDir);
      expect(await reopenedDb.tableNames()).to.include("_lg_checkpoints");
      reopenedDb.close();
    } finally {
      await migratedSaver.dispose();
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("does not promote an older legacy checkpoint above an existing newer v2 checkpoint", async function () {
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-cp-legacy-order-"));
    const threadId = "legacy-order-thread";
    const legacySchema = new Schema([
      new Field("thread_id", new Utf8(), false),
      new Field("checkpoint_ns", new Utf8(), false),
      new Field("checkpoint_id", new Utf8(), false),
      new Field("parent_checkpoint_id", new Utf8(), false),
      new Field("data", new Utf8(), false),
      new Field("metadata", new Utf8(), false),
      new Field("created_at", new Float64(), false),
    ]);

    const firstLegacy = makeCheckpoint({ id: "legacy-old-1", channel_values: { source: "legacy-1" } });
    const initialDb = await connect(legacyDir);
    const initialLegacyTable = await initialDb.createEmptyTable("_lg_checkpoints", legacySchema);
    await initialLegacyTable.add([
      {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: firstLegacy.id,
        parent_checkpoint_id: "",
        data: JSON.stringify(firstLegacy),
        metadata: JSON.stringify(makeMetadata(1)),
        created_at: 1000,
      },
    ]);
    initialLegacyTable.close();
    initialDb.close();

    const firstSaver = new LanceDBCheckpointSaver(legacyDir);
    const newerV2 = makeCheckpoint({ id: "newer-v2", channel_values: { source: "v2" } });
    try {
      await firstSaver.getTuple(makeConfig(threadId));
      await firstSaver.put(makeConfig(threadId, firstLegacy.id), newerV2, makeMetadata(2), {});
    } finally {
      await firstSaver.dispose();
    }

    // Simulate a retained legacy table receiving another historical row before
    // the next startup. Migration must not assign it a sequence above newerV2.
    const legacyDb = await connect(legacyDir);
    const legacyTable = await legacyDb.openTable("_lg_checkpoints");
    const secondLegacy = makeCheckpoint({ id: "legacy-old-2", channel_values: { source: "legacy-2" } });
    await legacyTable.add([
      {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: secondLegacy.id,
        parent_checkpoint_id: firstLegacy.id,
        data: JSON.stringify(secondLegacy),
        metadata: JSON.stringify(makeMetadata(1)),
        created_at: 1001,
      },
    ]);
    legacyTable.close();
    legacyDb.close();

    const reopened = new LanceDBCheckpointSaver(legacyDir);
    try {
      const latest = await reopened.getTuple(makeConfig(threadId));
      expect(latest!.checkpoint.id).to.equal(newerV2.id);
      const listed: string[] = [];
      for await (const tuple of reopened.list(makeConfig(threadId))) {
        listed.push(tuple.checkpoint.id);
      }
      expect(listed[0]).to.equal(newerV2.id);
      expect(listed).to.include.members([firstLegacy.id, secondLegacy.id]);
    } finally {
      await reopened.dispose();
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
  });
});
