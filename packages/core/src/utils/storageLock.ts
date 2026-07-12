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
 *   pid/hostname.
 * - Within one process the lock is refcounted per resolved directory, so
 *   TopicManager and MemoryStore sharing a storage dir share one lock.
 * - The holder refreshes the lock file's mtime on an unref'd heartbeat.
 *   A lock is considered stale — and is reclaimed — when its holder pid is
 *   dead (same host) or its heartbeat is older than `staleMs` (crashed
 *   holders, foreign hosts on shared filesystems, pid reuse).
 * - `RAGNAROK_IGNORE_LOCK=1|true` bypasses locking entirely (escape hatch
 *   for advanced setups; documented as unsafe for concurrent writers).
 * - Locks release on dispose and, as a backstop, via a process exit hook.
 */

import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export const STORAGE_LOCK_FILENAME = ".ragnarok.lock";

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 5;

export interface StorageLockOptions {
  /** Heartbeat age after which a lock counts as abandoned. Default 5 minutes. */
  staleMs?: number;
  /** How often the holder refreshes the lock file mtime. Default 30 seconds. */
  heartbeatMs?: number;
}

export interface StorageLockHandle {
  /** Absolute path of the lock file (informational). */
  readonly lockPath: string;
  /** Decrement this process's hold; the file is removed when the last holder releases. */
  release(): Promise<void>;
}

interface LockFileInfo {
  pid: number;
  hostname: string;
  acquiredAt: number;
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
        `Each storage directory supports one process at a time — close the other instance, ` +
        `or set RAGNAROK_IGNORE_LOCK=1 to override (unsafe with concurrent writers). Lock file: ${lockPath}`,
    );
    this.name = "StorageLockHeldError";
  }
}

interface InternalLock {
  lockPath: string;
  heartbeat: ReturnType<typeof setInterval>;
  release(): Promise<void>;
}

interface ProcessLockEntry {
  refs: number;
  acquisition: Promise<InternalLock>;
}

// Refcounted per resolved storage dir so co-located stores share one lock.
const processLocks = new Map<string, ProcessLockEntry>();

// Backstop cleanup for holders that never dispose (crash-adjacent paths).
const heldLockFiles = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lockPath of heldLockFiles) {
      try {
        fsSync.unlinkSync(lockPath);
      } catch {
        // Lock already gone or stolen after staleness — nothing to clean.
      }
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

async function acquireFileLock(storageDir: string, options?: StorageLockOptions): Promise<InternalLock> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const lockPath = path.join(storageDir, STORAGE_LOCK_FILENAME);
  await fs.mkdir(storageDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        const info: LockFileInfo = { pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() };
        await handle.writeFile(JSON.stringify(info), "utf8");
      } finally {
        await handle.close();
      }

      heldLockFiles.add(lockPath);
      installExitHook();

      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();

      return {
        lockPath,
        heartbeat,
        release: async () => {
          clearInterval(heartbeat);
          // Only remove the file if it is still OURS — after a staleness
          // reclaim it may already belong to another process.
          const current = await readLockInfo(lockPath);
          if (current?.pid === process.pid && current.hostname === os.hostname()) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
          // Drop the exit-hook entry only AFTER the unlink: releases can be
          // fire-and-forget during shutdown, and if the process exits
          // mid-release the hook must still clean the file (unlinking an
          // already-removed file is a caught no-op).
          heldLockFiles.delete(lockPath);
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const holder = await readLockInfo(lockPath);
      const stats = await fs.stat(lockPath).catch(() => null);
      if (!stats) {
        continue; // Lock vanished between open and stat — retry.
      }

      const heartbeatAge = Date.now() - stats.mtimeMs;
      const sameHost = holder !== null && holder.hostname === os.hostname();
      // Dead-pid detection only works on the same host; everywhere else
      // (foreign hosts, corrupt lock files, recycled pids) the heartbeat
      // age is the arbiter.
      const stale = heartbeatAge > staleMs || (sameHost && !pidAlive(holder.pid));

      if (stale) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }

      throw new StorageLockHeldError(lockPath, holder);
    }
  }

  throw new Error(
    `Unable to acquire storage lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts (high lock contention).`,
  );
}

/**
 * Acquire the cross-process lock for a storage directory.
 *
 * Reentrant within a process (refcounted per resolved directory). Throws
 * {@link StorageLockHeldError} when another live process holds the lock.
 */
export async function acquireStorageLock(
  storageDir: string,
  options?: StorageLockOptions,
): Promise<StorageLockHandle> {
  const key = path.resolve(storageDir);
  const lockPath = path.join(key, STORAGE_LOCK_FILENAME);

  if (lockIgnored()) {
    return { lockPath, release: async () => undefined };
  }

  let entry = processLocks.get(key);
  if (!entry) {
    const acquisition = acquireFileLock(key, options);
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
    await entry.acquisition;
  } catch (error) {
    entry.refs -= 1;
    throw error;
  }

  let released = false;
  return {
    lockPath,
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
