/**
 * Cross-process storage lock (AA-1).
 *
 * LanceDB tables are rewritten wholesale by this codebase's persistence
 * layer, and the in-process mutexes/write serializers cannot see a second
 * OS process (two VS Code windows on one global storage dir, or two stdio
 * MCP servers on ~/.ragnarok). This lock makes the single-writer constraint
 * explicit: the second process fails fast with a message naming the holder
 * instead of silently corrupting or losing writes.
 *
 * Semantics:
 * - One lock file per storage directory: `<storageDir>/.ragnarok.lock`,
 *   created with an atomic exclusive open ("wx") and containing the holder's
 *   pid/hostname plus a cryptographically random owner id.
 * - Within one process the lock is refcounted per resolved directory, so
 *   TopicManager and MemoryStore sharing a storage dir share one lock — and
 *   so do full-exclusion session leases (`acquireStorageLock`) and
 *   operation-scoped leases (`acquireOperationLease`): both draw from the
 *   same refcount, so an op lease joins a session (or another op) this
 *   process already holds instead of contending with itself.
 * - The holder refreshes its originally-opened file descriptor, never the
 *   pathname. A displaced holder therefore cannot touch a replacement lock.
 *   On the same host, a live pid remains authoritative even if the machine
 *   slept beyond `staleMs`. Foreign-host leases use heartbeat age.
 * - A graceful release first writes an owner-tokened release marker through
 *   that same file descriptor, then — once the process's refcount reaches
 *   zero — unlinks the lock file (verified by inode so a reclaimer that won
 *   the race in between is never deleted). A concurrent acquirer racing the
 *   unlink simply retries and creates a fresh lock file. This still avoids
 *   the unsafe read-check-unlink race where an old owner could unlink a new
 *   owner's lock: an exit crash between the marker write and the unlink
 *   deliberately leaves the marker in place, immediately reclaimable, never
 *   unlinked, never live-looking stale.
 * - `acquireOperationLease` waits (bounded by `waitMs`/`pollIntervalMs`,
 *   default 5000/100ms) against a live foreign holder before throwing
 *   {@link StorageBusyError}; `acquireStorageLock` fails fast instead with
 *   {@link StorageLockHeldError}. Both reclaim an abandoned/released holder
 *   immediately, without waiting.
 * - `RAGNAROK_IGNORE_LOCK=1|true` bypasses locking entirely for both lease
 *   kinds (escape hatch for advanced setups; documented as unsafe for
 *   concurrent writers).
 * - Locks release on dispose and, as a backstop, via a process exit hook.
 */

import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

export const STORAGE_LOCK_FILENAME = ".ragnarok.lock";

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 20;
const RECLAIM_RETRY_MS = 5;

export interface StorageLockOptions {
  /** Heartbeat age after which a lock counts as abandoned. Default 5 minutes. */
  staleMs?: number;
  /** How often the holder refreshes the lock file mtime. Default 30 seconds. */
  heartbeatMs?: number;
}

export interface StorageLockHandle {
  /** Absolute path of the lock file (informational). */
  readonly lockPath: string;
  /** Opaque fencing token for the lease generation. */
  readonly ownerId: string;
  /** Fail if this handle no longer owns the lock pathname generation. */
  assertOwned(): Promise<void>;
  /** Decrement this process's hold; the lease is marked released when the last holder releases. */
  release(): Promise<void>;
}

interface LockFileInfo {
  version?: number;
  ownerId?: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  releasedAt?: number;
}

export class StorageLockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: LockFileInfo | null,
  ) {
    const who = holder
      ? `pid ${holder.pid}${holder.hostname === os.hostname() ? "" : ` on ${holder.hostname}`}`
      : "an unknown process";
    super(
      `Storage directory is locked by another RAGnarōk process (${who}). ` +
        `A full-exclusion storage operation (migration, reset, or rollback) is in progress in another process. ` +
        `Retry when it completes, or set RAGNAROK_IGNORE_LOCK=1 to override (unsafe with concurrent writers). Lock file: ${lockPath}`,
    );
    this.name = "StorageLockHeldError";
  }
}

export class StorageBusyError extends Error {
  readonly name = "StorageBusyError";
  constructor(
    public readonly lockPath: string,
    public readonly holder: LockFileInfo | null,
  ) {
    const who = holder
      ? `pid ${holder.pid}${holder.hostname === os.hostname() ? "" : ` on ${holder.hostname}`}`
      : "another process";
    super(
      `Storage is busy: a write is in progress by ${who}. ` +
        `Reads are unaffected; retry the operation when the current write finishes. Lock file: ${lockPath}`,
    );
  }
}

export interface OperationLeaseOptions {
  /** How long to wait for a live foreign holder before throwing StorageBusyError. Default 5000. */
  waitMs?: number;
  /** Poll interval while waiting. Default 100. */
  pollIntervalMs?: number;
  /** Passed through to the underlying lock (staleness/heartbeat). */
  staleMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;

interface InternalLock {
  lockPath: string;
  heartbeat: ReturnType<typeof setInterval>;
  handle: fs.FileHandle;
  info: LockFileInfo;
  release(): Promise<void>;
}

interface ProcessLockEntry {
  refs: number;
  acquisition: Promise<InternalLock>;
}

// Refcounted per resolved storage dir so co-located stores share one lock.
const processLocks = new Map<string, ProcessLockEntry>();

// Backstop cleanup for holders that never dispose (crash-adjacent paths).
interface HeldLockFile {
  handle: fs.FileHandle;
  info: LockFileInfo;
}

const heldLockFiles = new Map<string, HeldLockFile>();
let exitHookInstalled = false;

function serializeLockInfo(info: LockFileInfo): string {
  return JSON.stringify(info);
}

function ownerMatches(actual: LockFileInfo | null, expected: LockFileInfo): boolean {
  if (!actual) {
    return false;
  }
  // v2 leases are identified by their random token. The pid/host fallback is
  // only for reading legacy locks created before owner ids were introduced.
  return expected.ownerId
    ? actual.ownerId === expected.ownerId
    : actual.pid === expected.pid && actual.hostname === expected.hostname;
}

function markReleasedSync(lockPath: string, held: HeldLockFile): void {
  try {
    const current = JSON.parse(fsSync.readFileSync(lockPath, "utf8")) as LockFileInfo;
    if (!ownerMatches(current, held.info)) {
      return;
    }
    const released = { ...held.info, releasedAt: Date.now() };
    fsSync.ftruncateSync(held.handle.fd, 0);
    fsSync.writeSync(held.handle.fd, serializeLockInfo(released), 0, "utf8");
    fsSync.fsyncSync(held.handle.fd);
  } catch {
    // The pathname vanished or was replaced. Because writes target the held
    // descriptor, never fall back to unlinking/touching the pathname.
  }
}

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [lockPath, held] of heldLockFiles) {
      markReleasedSync(lockPath, held);
    }
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function lockIgnored(): boolean {
  const value = (process.env.RAGNAROK_IGNORE_LOCK || "").toLowerCase();
  return value === "1" || value === "true";
}

async function readLockInfo(lockPath: string): Promise<LockFileInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (typeof parsed?.pid === "number" && typeof parsed?.hostname === "string") {
      return parsed as LockFileInfo;
    }
    return null;
  } catch {
    // Vanished, empty (mid-write), or corrupt — caller falls back to mtime age.
    return null;
  }
}

function isReclaimable(holder: LockFileInfo | null, heartbeatAge: number, staleMs: number): boolean {
  if (holder?.releasedAt !== undefined) {
    return true;
  }

  const sameHost = holder !== null && holder.hostname === os.hostname();
  if (sameHost) {
    // A live local process may have slept or paused for longer than staleMs.
    // Heartbeat age must never steal its lease.
    return !pidAlive(holder.pid);
  }

  // Liveness cannot be established across hosts. A corrupt legacy file also
  // follows the conservative heartbeat lease policy.
  return heartbeatAge > staleMs;
}

function sameGeneration(
  actualInfo: LockFileInfo | null,
  actualStats: { dev: number; ino: number },
  expectedInfo: LockFileInfo | null,
  expectedStats: { dev: number; ino: number },
): boolean {
  const sameFile = actualStats.dev === expectedStats.dev && actualStats.ino === expectedStats.ino;
  if (!sameFile) {
    return false;
  }
  if (expectedInfo?.ownerId !== undefined) {
    return actualInfo?.ownerId === expectedInfo.ownerId;
  }
  return actualInfo?.pid === expectedInfo?.pid && actualInfo?.hostname === expectedInfo?.hostname;
}

function reclaimClaimPath(
  lockPath: string,
  expectedInfo: LockFileInfo | null,
  expectedStats: { dev: number; ino: number },
): string {
  const identity = JSON.stringify({
    dev: expectedStats.dev,
    ino: expectedStats.ino,
    ownerId: expectedInfo?.ownerId ?? null,
    pid: expectedInfo?.pid ?? null,
    hostname: expectedInfo?.hostname ?? null,
    acquiredAt: expectedInfo?.acquiredAt ?? null,
  });
  const generation = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `${lockPath}.reclaim-${generation}`;
}

async function initializeLeaseHandle(handle: fs.FileHandle, info: LockFileInfo): Promise<void> {
  await handle.writeFile(serializeLockInfo(info), "utf8");
  await handle.sync();
}

function activateOwnedLock(
  lockPath: string,
  handle: fs.FileHandle,
  info: LockFileInfo,
  heartbeatMs: number,
): InternalLock {
  heldLockFiles.set(lockPath, { handle, info });
  installExitHook();

  const heartbeat = setInterval(() => {
    void (async () => {
      const current = await readLockInfo(lockPath);
      if (!ownerMatches(current, info) || current?.releasedAt !== undefined) {
        clearInterval(heartbeat);
        return;
      }
      // FileHandle.utimes targets the inode opened by this owner. Even if
      // the path is replaced after the owner check, the replacement is never
      // touched.
      const now = new Date();
      await handle.utimes(now, now);
    })().catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    lockPath,
    heartbeat,
    handle,
    info,
    release: async () => {
      clearInterval(heartbeat);
      const current = await readLockInfo(lockPath);
      const stillOwned = ownerMatches(current, info);
      if (stillOwned) {
        const released = { ...info, releasedAt: Date.now() };
        await handle.truncate(0);
        await handle.write(serializeLockInfo(released), 0, "utf8");
        await handle.sync();
      }
      heldLockFiles.delete(lockPath);
      if (stillOwned) {
        // This is the process's last holder of any kind (session or
        // operation) for this lock: remove the lock file now that the
        // releasedAt marker is durably written. Guard with an inode check so
        // a reclaimer that already renamed a fresh lease over this pathname
        // — in the narrow window between the marker write above and this
        // unlink — is never deleted: the path would then resolve to a
        // different inode than the one this handle opened, so we leave it
        // alone (matching the file's fd-vs-pathname discipline elsewhere).
        try {
          const [fdStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)]);
          if (fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
        } catch {
          // Path already vanished (e.g. a concurrent reclaimer's rename beat
          // us here, or another unlink already ran) — nothing to clean up.
        }
      }
      await handle.close().catch(() => undefined);
    },
  };
}

/**
 * Replace one exact stale generation without ever making the canonical path
 * absent. The deterministic claim path admits one reclaimer for that
 * owner+inode generation. A fully initialized candidate is then atomically
 * renamed over the revalidated stale file.
 *
 * An interrupted claim before replacement deliberately fails closed: the
 * claim remains and no contender can become a second owner. If interruption
 * happens after replacement, the fresh canonical lease remains authoritative
 * and the old-generation claim is harmless.
 */
async function replaceReclaimableGeneration(
  lockPath: string,
  expectedInfo: LockFileInfo | null,
  expectedStats: { dev: number; ino: number },
  staleMs: number,
  heartbeatMs: number,
): Promise<InternalLock | null> {
  const claimPath = reclaimClaimPath(lockPath, expectedInfo, expectedStats);
  let claimHandle: fs.FileHandle;
  try {
    claimHandle = await fs.open(claimPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      // Another process owns the claim for this exact generation. Give it a
      // bounded opportunity to publish its atomic replacement, then reread.
      await new Promise((resolve) => setTimeout(resolve, RECLAIM_RETRY_MS));
      return null;
    }
    throw error;
  }

  const claimInfo = {
    version: 1,
    claimantOwnerId: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    claimedAt: Date.now(),
    expectedOwnerId: expectedInfo?.ownerId ?? null,
    expectedDev: expectedStats.dev,
    expectedIno: expectedStats.ino,
  };
  try {
    await claimHandle.writeFile(JSON.stringify(claimInfo), "utf8");
    await claimHandle.sync();
  } catch (error) {
    await claimHandle.close().catch(() => undefined);
    // We exclusively created this pathname and never relinquished it, so
    // removing this incomplete claim cannot affect another claimant.
    await fs.unlink(claimPath).catch(() => undefined);
    throw error;
  }

  const candidatePath = `${lockPath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  let candidateHandle: fs.FileHandle | null = null;
  let candidateTransferred = false;

  try {
    // Revalidate owner, inode, and expiry only after acquiring this
    // generation's exclusive claim. A stale observer can never replace a
    // fresh generation.
    const currentInfo = await readLockInfo(lockPath);
    const currentStats = await fs.stat(lockPath).catch(() => null);
    if (
      !currentStats ||
      !sameGeneration(currentInfo, currentStats, expectedInfo, expectedStats) ||
      !isReclaimable(currentInfo, Date.now() - currentStats.mtimeMs, staleMs)
    ) {
      return null;
    }

    const newInfo: LockFileInfo = {
      version: 2,
      ownerId: crypto.randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    };
    candidateHandle = await fs.open(candidatePath, "wx", 0o600);
    await initializeLeaseHandle(candidateHandle, newInfo);

    // Atomic replacement is the only point at which ownership changes. Do
    // not fall back to unlink+rename on platforms/filesystems that reject
    // replacement: that would recreate the multiple-owner gap.
    try {
      await fs.rename(candidatePath, lockPath);
    } catch (error: any) {
      throw new Error(
        `Atomic storage lock replacement failed at ${lockPath} (${error?.code ?? "unknown"}). ` +
          "The existing lease was left untouched; this filesystem/platform must support atomic file replacement.",
      );
    }
    candidateTransferred = true;
    return activateOwnedLock(lockPath, candidateHandle, newInfo, heartbeatMs);
  } finally {
    if (!candidateTransferred && candidateHandle) {
      await candidateHandle.close().catch(() => undefined);
      await fs.unlink(candidatePath).catch(() => undefined);
    }
    // This process held the claim pathname continuously from its exclusive
    // creation through this unlink, so cleanup cannot delete a replacement
    // claim. A crash skips cleanup and intentionally leaves a fail-closed
    // claim artifact for the stale generation.
    await fs.unlink(claimPath).catch(() => undefined);
    await claimHandle.close().catch(() => undefined);
  }
}

type AcquireAttemptResult =
  | { status: "acquired"; lock: InternalLock }
  | { status: "retry" } // vanished/raced with a reclaimer — retry immediately, counts toward the churn budget
  | { status: "busy"; holder: LockFileInfo | null }; // a live foreign holder currently owns the lease

/**
 * One attempt at acquiring `lockPath`: creates it if absent, reclaims it if
 * the current holder is abandoned/released, or reports that a live foreign
 * holder currently owns it. Never waits — callers decide what to do with a
 * "busy" result.
 */
async function tryAcquireOnce(
  lockPath: string,
  staleMs: number,
  heartbeatMs: number,
): Promise<AcquireAttemptResult> {
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    const info: LockFileInfo = {
      version: 2,
      ownerId: crypto.randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    };
    try {
      await initializeLeaseHandle(handle, info);
    } catch (error) {
      // Never unlink by pathname here: even this short initialization
      // window must not be able to remove a replacement. Best-effort mark
      // the originally opened inode released so a later acquisition can
      // reclaim it without waiting for staleness.
      const released = { ...info, releasedAt: Date.now() };
      await handle
        .truncate(0)
        .then(() => handle.write(serializeLockInfo(released), 0, "utf8"))
        .then(() => handle.sync())
        .catch(() => undefined);
      await handle.close().catch(() => undefined);
      throw error;
    }

    return { status: "acquired", lock: activateOwnedLock(lockPath, handle, info, heartbeatMs) };
  } catch (error: any) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const holder = await readLockInfo(lockPath);
    const stats = await fs.stat(lockPath).catch(() => null);
    if (!stats) {
      return { status: "retry" }; // Lock vanished between open and stat — retry.
    }

    const heartbeatAge = Date.now() - stats.mtimeMs;
    if (isReclaimable(holder, heartbeatAge, staleMs)) {
      const replacement = await replaceReclaimableGeneration(lockPath, holder, stats, staleMs, heartbeatMs);
      if (!replacement) {
        return { status: "retry" };
      }
      return { status: "acquired", lock: replacement };
    }

    return { status: "busy", holder };
  }
}

interface WaitPolicy {
  waitMs: number;
  pollIntervalMs: number;
}

/**
 * Acquire the on-disk lease at `storageDir`, retrying reclaim/vanish races
 * up to `MAX_ACQUIRE_ATTEMPTS` (unrelated to contention — a symptom of a
 * crashed reclaimer or heavy churn) and, when `wait` is given, additionally
 * polling a live foreign holder up to `wait.waitMs` before giving up.
 *
 * `wait` undefined reproduces the legacy fail-fast behavior: a live foreign
 * holder throws {@link StorageLockHeldError} immediately. `wait` present
 * throws {@link StorageBusyError} once `wait.waitMs` has elapsed (0 = a
 * single try-lock attempt).
 */
async function acquireFileLock(
  storageDir: string,
  options: StorageLockOptions | undefined,
  wait: WaitPolicy | undefined,
): Promise<InternalLock> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const lockPath = path.join(storageDir, STORAGE_LOCK_FILENAME);
  await fs.mkdir(storageDir, { recursive: true });

  const deadline = wait ? Date.now() + wait.waitMs : undefined;
  let churnAttempts = 0;

  for (;;) {
    const result = await tryAcquireOnce(lockPath, staleMs, heartbeatMs);

    if (result.status === "acquired") {
      return result.lock;
    }

    if (result.status === "retry") {
      churnAttempts += 1;
      if (churnAttempts >= MAX_ACQUIRE_ATTEMPTS) {
        throw new Error(
          `Unable to acquire storage lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts (high lock contention).`,
        );
      }
      continue;
    }

    // result.status === "busy": a live foreign holder currently owns the lease.
    if (!wait) {
      throw new StorageLockHeldError(lockPath, result.holder);
    }
    if (Date.now() >= deadline!) {
      throw new StorageBusyError(lockPath, result.holder);
    }
    const sleepMs = Math.max(0, Math.min(wait.pollIntervalMs, deadline! - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    // Waiting on genuine contention never counts against the churn budget.
  }
}

const NO_OP_HANDLE: StorageLockHandle = {
  lockPath: "",
  ownerId: "lock-ignored",
  assertOwned: async () => undefined,
  release: async () => undefined,
};

/**
 * Shared acquisition core for both {@link acquireStorageLock} and
 * {@link acquireOperationLease}. Both lease kinds join the SAME
 * process-wide refcount per resolved storage directory: whichever kind
 * acquires first creates the on-disk lease, and every later call in this
 * process — session or operation — simply increments the refcount and
 * shares it. The lock file is unlinked only when that refcount reaches
 * zero (see `activateOwnedLock`'s `release`), regardless of which kinds of
 * holders contributed to it.
 *
 * Each call returns its OWN handle: `release()` decrements the shared
 * refcount exactly once (idempotent per handle), and `assertOwned()` fences
 * on THIS handle's own release in addition to the underlying lease's
 * ownership — a handle that has released must never be trusted again even
 * while other holders keep the lease alive.
 */
async function acquireLease(
  storageDir: string,
  options: StorageLockOptions | undefined,
  wait: WaitPolicy | undefined,
): Promise<StorageLockHandle> {
  const key = path.resolve(storageDir);
  const lockPath = path.join(key, STORAGE_LOCK_FILENAME);

  if (lockIgnored()) {
    return { ...NO_OP_HANDLE, lockPath };
  }

  let entry = processLocks.get(key);
  if (!entry) {
    const acquisition = acquireFileLock(key, options, wait);
    entry = { refs: 0, acquisition };
    processLocks.set(key, entry);
    // A failed acquisition must not poison later attempts.
    acquisition.catch(() => {
      if (processLocks.get(key) === entry) {
        processLocks.delete(key);
      }
    });
  }
  entry.refs += 1;

  let acquired: InternalLock;
  try {
    acquired = await entry.acquisition;
  } catch (error) {
    entry.refs -= 1;
    throw error;
  }

  let released = false;
  return {
    lockPath,
    ownerId: acquired.info.ownerId ?? `${acquired.info.hostname}:${acquired.info.pid}`,
    assertOwned: async () => {
      if (released) {
        throw new Error(
          `Storage lease ownership was lost for ${lockPath}; this handle already released its hold and cannot be used to fence a commit`,
        );
      }
      const current = await readLockInfo(lockPath);
      if (!ownerMatches(current, acquired.info) || current?.releasedAt !== undefined) {
        throw new Error(
          `Storage lease ownership was lost for ${lockPath}; refusing to commit with fenced owner ${acquired.info.ownerId ?? acquired.info.pid}`,
        );
      }
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0 && processLocks.get(key) === entry) {
        processLocks.delete(key);
        const lock = await entry.acquisition.catch(() => null);
        await lock?.release();
      }
    },
  };
}

/**
 * Acquire the cross-process lock for a storage directory.
 *
 * Reentrant within a process (refcounted per resolved directory, shared
 * with any operation leases the process also holds). Throws
 * {@link StorageLockHeldError} when another live process holds the lock.
 */
export async function acquireStorageLock(storageDir: string, options?: StorageLockOptions): Promise<StorageLockHandle> {
  return acquireLease(storageDir, options, undefined);
}

/**
 * Acquire an exclusive, operation-scoped write lease on a storage
 * directory.
 *
 * Shares the process-wide refcount with {@link acquireStorageLock}: joining
 * a lease this process already holds (session or operation) succeeds
 * immediately, and the lock file is unlinked when the process's last
 * holder of any kind releases. When this process does not already hold the
 * lease and a live foreign process does, retries every `pollIntervalMs`
 * (default 100) up to `waitMs` (default 5000; 0 = single try-lock attempt)
 * before throwing {@link StorageBusyError}. A reclaimable holder (released,
 * dead same-host pid, or stale foreign heartbeat) is reclaimed immediately
 * and never waited on.
 */
export async function acquireOperationLease(
  storageDir: string,
  options?: OperationLeaseOptions,
): Promise<StorageLockHandle> {
  const wait: WaitPolicy = {
    waitMs: options?.waitMs ?? DEFAULT_WAIT_MS,
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
  return acquireLease(storageDir, { staleMs: options?.staleMs, heartbeatMs: options?.heartbeatMs }, wait);
}
