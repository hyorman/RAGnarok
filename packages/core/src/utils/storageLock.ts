/**
 * Cross-process storage lock.
 *
 * LanceDB tables are rewritten wholesale and in-process mutexes cannot see a
 * second OS process (two VS Code windows, or two stdio MCP servers, on one
 * storage dir). The lock coordinates writers only: reads take no lease, so any
 * number of processes may read one storage root. A mutation takes an
 * operation-scoped lease ({@link acquireOperationLease}) that waits a bounded
 * time for a live foreign holder, then throws {@link StorageBusyError}.
 *
 * - One lock file per storage directory, `<storageDir>/.ragnarok.lock`, created
 *   with an exclusive open ("wx") and holding pid/hostname and a random owner id.
 * - Within a process the lock is refcounted per resolved directory, so a lease
 *   joins one this process already holds instead of contending with itself.
 * - The holder refreshes its originally-opened file descriptor, never the
 *   pathname, so a displaced holder cannot touch a replacement lock. On the
 *   same host a live pid stays authoritative even if the machine slept past
 *   `staleMs`; foreign-host leases use heartbeat age.
 * - Release writes an owner-tokened marker through that descriptor, then
 *   unlinks the file once the refcount reaches zero (verified by inode, so a
 *   reclaimer that won the race is never deleted). A crash between marker and
 *   unlink leaves a marker that is immediately reclaimable.
 * - `RAGNAROK_IGNORE_LOCK=1|true` bypasses locking (unsafe with concurrent writers).
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

export interface LockFileInfo {
  version?: number;
  ownerId?: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  releasedAt?: number;
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
        // Last holder for this lock: unlink now that the marker is durable, but
        // only if the path still resolves to this handle's inode (a reclaimer
        // may have renamed a fresh lease over it in the meantime).
        try {
          const [fdStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)]);
          if (fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
        } catch {
          // Path already vanished: nothing to clean up.
        }
      }
      await handle.close().catch(() => undefined);
    },
  };
}

/**
 * Replace one exact stale generation without ever making the canonical path
 * absent: a deterministic claim path admits one reclaimer per owner+inode
 * generation, which atomically renames a fully initialized candidate over the
 * revalidated stale file.
 *
 * An interrupted claim before replacement fails closed (the claim remains, so
 * no contender becomes a second owner); after replacement the fresh lease is
 * authoritative and the old claim is harmless.
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
    // Revalidate only after taking the exclusive claim, so a stale observer
    // can never replace a fresh generation.
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
    // This process held the claim path from creation through this unlink, so
    // it cannot delete another's claim. A crash leaves a fail-closed claim.
    await fs.unlink(claimPath).catch(() => undefined);
    await claimHandle.close().catch(() => undefined);
  }
}

type AcquireAttemptResult =
  | { status: "acquired"; lock: InternalLock }
  | { status: "retry" } // vanished/raced with a reclaimer — retry immediately, counts toward the churn budget
  | { status: "busy"; holder: LockFileInfo | null }; // a live foreign holder currently owns the lease

/** One attempt at acquiring `lockPath`: create it, reclaim an abandoned or released holder, or report a live one as busy. Never waits. */
async function tryAcquireOnce(lockPath: string, staleMs: number, heartbeatMs: number): Promise<AcquireAttemptResult> {
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
 * Acquire the on-disk lease at `storageDir`. Reclaim/vanish races are retried
 * up to `MAX_ACQUIRE_ATTEMPTS`; a live foreign holder is polled for up to
 * `wait.waitMs` (0 = single try-lock) before {@link StorageBusyError}.
 */
async function acquireFileLock(
  storageDir: string,
  options: OperationLeaseOptions,
  wait: WaitPolicy,
): Promise<InternalLock> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const lockPath = path.join(storageDir, STORAGE_LOCK_FILENAME);
  await fs.mkdir(storageDir, { recursive: true });

  const deadline = Date.now() + wait.waitMs;
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
    if (Date.now() >= deadline) {
      throw new StorageBusyError(lockPath, result.holder);
    }
    const sleepMs = Math.max(0, Math.min(wait.pollIntervalMs, deadline - Date.now()));
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
 * Shared acquisition core for {@link acquireOperationLease}: every lease in
 * this process for one resolved directory joins one refcount (the lock file is
 * unlinked at zero). Each call returns its own handle: `release()` is
 * idempotent per handle and `assertOwned()` also fences on that release.
 */
async function acquireLease(
  storageDir: string,
  options: OperationLeaseOptions,
  wait: WaitPolicy,
): Promise<StorageLockHandle> {
  const key = path.resolve(storageDir);
  const lockPath = path.join(key, STORAGE_LOCK_FILENAME);

  if (lockIgnored()) {
    return { ...NO_OP_HANDLE, lockPath };
  }

  // A caller joining another's pending acquisition would inherit that
  // caller's wait budget on failure. The rejection handler below removes the
  // failed entry first, so a joiner retries exactly once under its own budget.
  let acquired: InternalLock | undefined;
  let entry: ProcessLockEntry | undefined;
  let retriedAfterForeignPolicyFailure = false;
  for (;;) {
    entry = processLocks.get(key);
    const joinedPending = entry !== undefined;
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

    try {
      acquired = await entry.acquisition;
      break;
    } catch (error) {
      entry.refs -= 1;
      if (joinedPending && !retriedAfterForeignPolicyFailure) {
        retriedAfterForeignPolicyFailure = true;
        continue;
      }
      throw error;
    }
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
 * Acquire an exclusive, operation-scoped write lease on a storage directory.
 *
 * Joining a lease this process already holds succeeds immediately. Otherwise a
 * live foreign holder is polled every `pollIntervalMs` (default 100) up to
 * `waitMs` (default 5000; 0 = single try-lock) before {@link StorageBusyError};
 * a reclaimable holder (released, dead same-host pid, stale foreign heartbeat)
 * is reclaimed immediately.
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
