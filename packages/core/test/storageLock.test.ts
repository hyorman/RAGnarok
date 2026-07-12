/**
 * Tests for the cross-process storage lock (AA-1).
 *
 * "Another process" is simulated by writing lock files with foreign
 * pid/hostname values — the acquisition path only inspects the file, so the
 * simulation exercises the same code a real second process would.
 */

import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { acquireStorageLock, StorageLockHeldError, STORAGE_LOCK_FILENAME } from "../src/utils/storageLock";
import { MemoryStore } from "../src/memory/memoryStore";
import { EmbeddingService } from "../src/embeddings/embeddingService";

function createMockEmbeddingService(): EmbeddingService {
  const embed = async (text: string) => {
    // Deterministic pseudo-embedding: hash characters into a small vector.
    const vector = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % 8] += text.charCodeAt(i) / 1000;
    }
    return vector;
  };
  return { embed, initialize: async () => undefined } as unknown as EmbeddingService;
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

/** A pid that cannot belong to a live process on macOS/Linux test hosts. */
const DEAD_PID = 998877;

describe("acquireStorageLock", function () {
  this.timeout(15000);

  let tempDir: string;
  let lockPath: string;

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-lock-test-"));
    lockPath = path.join(tempDir, STORAGE_LOCK_FILENAME);
  });

  afterEach(async function () {
    delete process.env.RAGNAROK_IGNORE_LOCK;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates the lock file on acquire and removes it on release", async function () {
    const lock = await acquireStorageLock(tempDir);
    expect(await exists(lockPath)).to.equal(true);

    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(process.pid);
    expect(written.hostname).to.equal(os.hostname());

    await lock.release();
    expect(await exists(lockPath)).to.equal(false);
  });

  it("is refcounted within one process: the file survives until the last holder releases", async function () {
    const first = await acquireStorageLock(tempDir);
    const second = await acquireStorageLock(tempDir);

    await first.release();
    expect(await exists(lockPath), "released too early — second holder still active").to.equal(true);

    await second.release();
    expect(await exists(lockPath)).to.equal(false);
  });

  it("release is idempotent per handle", async function () {
    const first = await acquireStorageLock(tempDir);
    const second = await acquireStorageLock(tempDir);

    await first.release();
    await first.release(); // must not decrement the refcount twice
    expect(await exists(lockPath)).to.equal(true);

    await second.release();
    expect(await exists(lockPath)).to.equal(false);
  });

  it("fails fast naming the holder when a live same-host process owns the lock", async function () {
    // pid 1 (launchd/init) is always alive; kill(1, 0) yields EPERM = alive.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }),
      "utf8",
    );

    let caught: unknown;
    try {
      await acquireStorageLock(tempDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(StorageLockHeldError);
    expect((caught as Error).message).to.include("pid 1");
    expect((caught as Error).message).to.include("RAGNAROK_IGNORE_LOCK");
  });

  it("reclaims a lock whose same-host holder pid is dead", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, hostname: os.hostname(), acquiredAt: Date.now() }),
      "utf8",
    );

    const lock = await acquireStorageLock(tempDir);
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(process.pid);
    await lock.release();
  });

  it("reclaims a foreign-host lock with a stale heartbeat", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, hostname: "some-other-machine", acquiredAt: Date.now() }),
      "utf8",
    );
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);

    const lock = await acquireStorageLock(tempDir, { staleMs: 10_000 });
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(process.pid);
    await lock.release();
  });

  it("respects a foreign-host lock with a fresh heartbeat", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, hostname: "some-other-machine", acquiredAt: Date.now() }),
      "utf8",
    );

    let caught: unknown;
    try {
      await acquireStorageLock(tempDir, { staleMs: 60_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(StorageLockHeldError);
    expect((caught as Error).message).to.include("some-other-machine");
  });

  it("treats a corrupt lock file with a fresh mtime as held (fail safe)", async function () {
    await fs.writeFile(lockPath, "not json at all", "utf8");

    let caught: unknown;
    try {
      await acquireStorageLock(tempDir, { staleMs: 60_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(StorageLockHeldError);
  });

  it("RAGNAROK_IGNORE_LOCK bypasses locking entirely", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }),
      "utf8",
    );
    process.env.RAGNAROK_IGNORE_LOCK = "1";

    const lock = await acquireStorageLock(tempDir);
    await lock.release();
    // The foreign lock file is untouched by the bypass.
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(1);
  });

  it("release leaves a lock alone if another process reclaimed it meanwhile", async function () {
    const lock = await acquireStorageLock(tempDir);
    // Simulate another process stealing after our staleness (e.g., long GC pause).
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }),
      "utf8",
    );

    await lock.release();
    expect(await exists(lockPath), "release must not remove a lock it no longer owns").to.equal(true);
  });
});

describe("MemoryStore storage lock integration", function () {
  this.timeout(30000);

  let tempDir: string;

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lock-test-"));
  });

  afterEach(async function () {
    delete process.env.RAGNAROK_IGNORE_LOCK;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("acquires the storage-dir lock on first data access and releases it on dispose", async function () {
    const store = new MemoryStore({
      storageDir: tempDir,
      embeddingService: createMockEmbeddingService(),
      workingDir: tempDir,
      markdownPath: null,
    });
    const lockPath = path.join(tempDir, STORAGE_LOCK_FILENAME);
    expect(await exists(lockPath), "constructor must not touch the disk").to.equal(false);

    await store.store({ content: "a memory that forces a data access" });
    expect(await exists(lockPath)).to.equal(true);

    await store.dispose();
    expect(await exists(lockPath)).to.equal(false);
  });

  it("fails fast when another live process holds the storage dir", async function () {
    await fs.writeFile(
      path.join(tempDir, STORAGE_LOCK_FILENAME),
      JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }),
      "utf8",
    );
    const store = new MemoryStore({
      storageDir: tempDir,
      embeddingService: createMockEmbeddingService(),
      workingDir: tempDir,
      markdownPath: null,
    });

    let caught: unknown;
    try {
      await store.store({ content: "should never persist" });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(StorageLockHeldError);
  });
});
