/**
 * Tests for the cross-process storage lock (AA-1).
 *
 * "Another process" is simulated by writing lock files with foreign
 * pid/hostname values — the acquisition path only inspects the file, so the
 * simulation exercises the same code a real second process would.
 */

import { expect } from "chai";
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  acquireStorageLock,
  acquireOperationLease,
  StorageLockHeldError,
  StorageBusyError,
  STORAGE_LOCK_FILENAME,
} from "../src/utils/storageLock";
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

async function runLockChild(
  modulePath: string,
  storageDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = `
    const { acquireStorageLock } = require(process.argv[1]);
    (async () => {
      try {
        const lock = await acquireStorageLock(process.argv[2], { staleMs: 5, heartbeatMs: 20 });
        process.stdout.write("ACQUIRED\\n");
        process.exit(0);
      } catch (error) {
        process.stdout.write("HELD\\n");
      }
    })().catch(error => { process.stderr.write(String(error)); process.exit(2); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, modulePath, storageDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface LockContender {
  ready: Promise<void>;
  outcome: Promise<"ACQUIRED" | "HELD">;
  completion: Promise<{ code: number | null; stderr: string }>;
  start(): void;
  release(): void;
}

function createLockContender(modulePath: string, storageDir: string): LockContender {
  const script = `
    const { acquireStorageLock } = require(process.argv[1]);
    let heldLock;
    let started = false;

    process.on("message", async message => {
      if (message === "START" && !started) {
        started = true;
        try {
          heldLock = await acquireStorageLock(process.argv[2], { staleMs: 5, heartbeatMs: 20 });
          process.send("ACQUIRED");
        } catch (error) {
          process.send("HELD", () => process.exit(0));
        }
      } else if (message === "RELEASE" && heldLock) {
        await heldLock.release();
        process.exit(0);
      }
    });

    process.send("READY");
  `;
  const child = spawn(process.execPath, ["-e", script, modulePath, storageDir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  let rejectReady!: (error: Error) => void;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let rejectOutcome!: (error: Error) => void;
  let resolveOutcome!: (outcome: "ACQUIRED" | "HELD") => void;
  const outcome = new Promise<"ACQUIRED" | "HELD">((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });

  child.on("message", (message) => {
    if (message === "READY") {
      resolveReady();
    } else if (message === "ACQUIRED" || message === "HELD") {
      resolveOutcome(message);
    }
  });

  const completion = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady(error);
      rejectOutcome(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        const error = new Error(`Lock contender exited ${code}: ${stderr}`);
        rejectReady(error);
        rejectOutcome(error);
      }
      resolve({ code, stderr });
    });
  });

  return {
    ready,
    outcome,
    completion,
    start: () => child.send("START"),
    release: () => child.send("RELEASE"),
  };
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

  it("creates the lock file on acquire and unlinks it when the last holder releases", async function () {
    const lock = await acquireStorageLock(tempDir);
    expect(await exists(lockPath)).to.equal(true);

    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(process.pid);
    expect(written.hostname).to.equal(os.hostname());
    expect(written.ownerId).to.match(/^[0-9a-f-]{36}$/);

    await lock.release();
    // The last holder in the process unlinks the lock file (unlink-at-zero).
    expect(await exists(lockPath)).to.equal(false);

    // The next acquirer simply creates a fresh lock file.
    const next = await acquireStorageLock(tempDir);
    const replacement = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(replacement.ownerId).to.not.equal(written.ownerId);
    await next.release();
  });

  it("is refcounted within one process: the file survives until the last holder releases", async function () {
    const first = await acquireStorageLock(tempDir);
    const second = await acquireStorageLock(tempDir);

    await first.release();
    expect(await exists(lockPath), "released too early — second holder still active").to.equal(true);

    await second.release();
    // The last holder in the process unlinks the lock file (unlink-at-zero).
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
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }), "utf8");

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

  it("never reclaims a live same-host pid solely because its heartbeat is old", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerId: "live-owner",
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now() - 120_000,
      }),
      "utf8",
    );
    const past = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, past, past);

    let caught: unknown;
    try {
      await acquireStorageLock(tempDir, { staleMs: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(StorageLockHeldError);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerId).to.equal("live-owner");
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
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: Date.now() }), "utf8");
    process.env.RAGNAROK_IGNORE_LOCK = "1";

    const lock = await acquireStorageLock(tempDir);
    await lock.release();
    // The foreign lock file is untouched by the bypass.
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).to.equal(1);
  });

  it("release leaves a lock alone if another process reclaimed it meanwhile", async function () {
    const lock = await acquireStorageLock(tempDir);
    const displacedPath = `${lockPath}.displaced`;
    await fs.rename(lockPath, displacedPath);
    // Use the same pid/host to prove that identity is the random owner token,
    // not a pid that could have been reused.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerId: "replacement-owner",
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
      }),
      "utf8",
    );

    let fenceError: Error | undefined;
    try {
      await lock.assertOwned();
    } catch (error) {
      fenceError = error as Error;
    }
    expect(fenceError?.message).to.include("ownership was lost");

    await lock.release();
    const replacement = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(replacement.ownerId, "release must not alter a lock it no longer owns").to.equal("replacement-owner");
    expect(replacement.releasedAt).to.equal(undefined);
  });

  it("heartbeat never touches a replacement lock pathname", async function () {
    const lock = await acquireStorageLock(tempDir, { heartbeatMs: 10 });
    await fs.rename(lockPath, `${lockPath}.displaced`);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerId: "heartbeat-replacement",
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
      }),
      "utf8",
    );
    const fixedTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, fixedTime, fixedTime);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const stats = await fs.stat(lockPath);
    expect(Math.abs(stats.mtimeMs - fixedTime.getTime())).to.be.lessThan(2);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerId).to.equal("heartbeat-replacement");
    await lock.release();
  });

  it("allows only one contender to reclaim a stale lease", async function () {
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerId: "stale-owner",
        pid: DEAD_PID,
        hostname: os.hostname(),
        acquiredAt: Date.now() - 60_000,
      }),
      "utf8",
    );
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);

    const modulePath = path.resolve(__dirname, "../src/utils/storageLock.js");
    const contenders = Array.from({ length: 6 }, () => createLockContender(modulePath, tempDir));

    // Process startup is outside the contention window. No child attempts
    // acquisition until all six have established their IPC channel.
    await Promise.all(contenders.map((contender) => contender.ready));
    contenders.forEach((contender) => contender.start());
    const outcomes = await Promise.all(contenders.map((contender) => contender.outcome));

    // Keep the winner locked until every loser has completed its attempt,
    // then release it so all child processes can exit cleanly.
    const winners = contenders.filter((_, index) => outcomes[index] === "ACQUIRED");
    winners.forEach((winner) => winner.release());
    const completions = await Promise.all(contenders.map((contender) => contender.completion));

    expect(
      completions.every((result) => result.code === 0),
      completions.map((result) => result.stderr).join("\n"),
    ).to.equal(true);
    expect(outcomes.filter((outcome) => outcome === "ACQUIRED")).to.have.lengthOf(1);
    expect(outcomes.filter((outcome) => outcome === "HELD")).to.have.lengthOf(5);
  });

  it("fails closed when a reclaimer crashes before publishing its replacement", async function () {
    const staleInfo = {
      version: 2,
      ownerId: "interrupted-generation",
      pid: DEAD_PID,
      hostname: os.hostname(),
      acquiredAt: Date.now() - 60_000,
    };
    await fs.writeFile(lockPath, JSON.stringify(staleInfo), "utf8");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);
    const stats = await fs.stat(lockPath);
    const identity = JSON.stringify({
      dev: stats.dev,
      ino: stats.ino,
      ownerId: staleInfo.ownerId,
      pid: staleInfo.pid,
      hostname: staleInfo.hostname,
      acquiredAt: staleInfo.acquiredAt,
    });
    const generation = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
    const claimPath = `${lockPath}.reclaim-${generation}`;
    await fs.writeFile(claimPath, JSON.stringify({ claimantOwnerId: "crashed-reclaimer", pid: DEAD_PID }), "utf8");

    let caught: unknown;
    try {
      await acquireStorageLock(tempDir, { staleMs: 5 });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include("Unable to acquire storage lock");
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerId).to.equal(staleInfo.ownerId);

    // Explicit operator recovery of the orphaned generation claim restores
    // acquisition without modifying the stale canonical lease.
    await fs.unlink(claimPath);
    const recovered = await acquireStorageLock(tempDir, { staleMs: 5 });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerId).to.not.equal(staleInfo.ownerId);
    await recovered.release();
  });

  it("exit cleanup owner-marks the lease so the next process can acquire immediately", async function () {
    const modulePath = path.resolve(__dirname, "../src/utils/storageLock.js");
    const child = await runLockChild(modulePath, tempDir);
    expect(child.code, child.stderr).to.equal(0);
    expect(child.stdout).to.include("ACQUIRED");

    const released = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(released.ownerId).to.be.a("string");
    expect(released.releasedAt).to.be.a("number");

    const replacement = await acquireStorageLock(tempDir, { staleMs: 60_000 });
    const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(current.ownerId).to.not.equal(released.ownerId);
    await replacement.release();
  });
});

describe("operation leases", function () {
  this.timeout(15000);

  let dir: string;

  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-lease-test-"));
  });

  afterEach(async function () {
    delete process.env.RAGNAROK_IGNORE_LOCK;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("unlinks the lock file when the last holder releases", async () => {
    const a = await acquireOperationLease(dir);
    const b = await acquireOperationLease(dir); // same process: joins, no wait
    await a.release();
    expect(await exists(path.join(dir, STORAGE_LOCK_FILENAME)), "still held by b").to.equal(true);
    await b.release();
    expect(await exists(path.join(dir, STORAGE_LOCK_FILENAME))).to.equal(false);
  });

  it("a released handle's assertOwned throws while another holder remains", async () => {
    const a = await acquireOperationLease(dir);
    const b = await acquireOperationLease(dir);
    await a.release();
    let threw = false;
    try {
      await a.assertOwned();
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    await b.assertOwned(); // still fine
    await b.release();
  });

  it("joins a session lease held by the same process", async () => {
    const session = await acquireStorageLock(dir);
    const op = await acquireOperationLease(dir, { waitMs: 0 }); // must NOT throw StorageBusyError
    await op.release();
    await session.release();
  });

  it("throws StorageBusyError with holder info after waitMs against a live foreign holder", async () => {
    // Simulate a foreign holder: write a live lock file with a different pid
    // (this process's pid + 1 is unreliable; use pid: process.pid and hostname: "other-host"
    // with a fresh mtime so it reads as a live foreign holder).
    await fs.writeFile(
      path.join(dir, STORAGE_LOCK_FILENAME),
      JSON.stringify({ version: 2, ownerId: "x", pid: 99999, hostname: "other-host", acquiredAt: Date.now() }),
    );
    const started = Date.now();
    try {
      await acquireOperationLease(dir, { waitMs: 300, pollIntervalMs: 50 });
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error).to.be.instanceOf(StorageBusyError);
      expect(error.name).to.equal("StorageBusyError");
      expect(error.holder?.hostname).to.equal("other-host");
      expect(Date.now() - started).to.be.greaterThanOrEqual(250);
    }
  });

  it("a session join of a pending operation-lease wait retries under its own (fail-fast) policy on failure", async () => {
    await fs.writeFile(
      path.join(dir, STORAGE_LOCK_FILENAME),
      JSON.stringify({ version: 2, ownerId: "x", pid: 99999, hostname: "other-host", acquiredAt: Date.now() }),
    );

    // Synchronously start both: the op lease creates the pending entry, and
    // the session call joins it before either has awaited anything.
    const opPromise = acquireOperationLease(dir, { waitMs: 300, pollIntervalMs: 50 });
    const sessionPromise = acquireStorageLock(dir);

    let opError: any;
    try {
      await opPromise;
      expect.fail("op lease should have thrown");
    } catch (error) {
      opError = error;
    }
    expect(opError.name).to.equal("StorageBusyError");

    let sessionError: any;
    try {
      await sessionPromise;
      expect.fail("session acquire should have thrown");
    } catch (error) {
      sessionError = error;
    }
    // The session joiner must retry under ITS OWN (fail-fast) policy, not
    // inherit the operation lease's bounded-wait policy or error type.
    expect(sessionError).to.be.instanceOf(StorageLockHeldError);
  });

  it("an operation-lease join of a pending session acquisition retries under its own wait policy on failure", async () => {
    await fs.writeFile(
      path.join(dir, STORAGE_LOCK_FILENAME),
      JSON.stringify({ version: 2, ownerId: "x", pid: 99999, hostname: "other-host", acquiredAt: Date.now() }),
    );

    const started = Date.now();
    // Synchronously start both: the session call creates the pending entry
    // and fails fast, and the op lease joins it before either has awaited
    // anything.
    const sessionPromise = acquireStorageLock(dir);
    const opPromise = acquireOperationLease(dir, { waitMs: 300, pollIntervalMs: 50 });

    let sessionError: any;
    try {
      await sessionPromise;
      expect.fail("session acquire should have thrown");
    } catch (error) {
      sessionError = error;
    }
    expect(sessionError).to.be.instanceOf(StorageLockHeldError);

    let opError: any;
    try {
      await opPromise;
      expect.fail("op lease should have thrown");
    } catch (error) {
      opError = error;
    }
    // The op-lease joiner must retry under ITS OWN bounded-wait policy, not
    // inherit the session's fail-fast policy or error type.
    expect(opError.name).to.equal("StorageBusyError");
    expect(Date.now() - started).to.be.greaterThanOrEqual(250);
  });

  it("acquire/release stays cheap", async function () {
    this.timeout(20_000);
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      const lease = await acquireOperationLease(dir);
      await lease.release();
    }
    const mean = (Date.now() - started) / 50;
    console.log(`operation lease acquire+release mean: ${mean.toFixed(1)}ms`);
    expect(mean).to.be.lessThan(50);
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
    // The last holder in the process unlinks the lock file (unlink-at-zero).
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
