import * as fs from "fs/promises";
import * as path from "path";
import { STORAGE_LOCK_FILENAME } from "./storageLock";

export const STORAGE_FORMAT_VERSION = 2 as const;
export const STORAGE_FORMAT_FILENAME = "storage-format.json";
/**
 * The optional user-facing settings file (@ragnarok/mcp-server's CONFIG_FILE_NAME).
 * Settings, not corpus data — see isInfrastructureEntry for why that distinction
 * has to be made here, in the storage layer.
 */
export const STORAGE_CONFIG_FILENAME = "config.json";
/** Marks an in-flight `resetStorage` so a crash mid-reset fails closed instead of reading as unversioned data. */
export const STORAGE_RESET_JOURNAL_FILENAME = ".ragnarok-reset.journal";
/**
 * Derived, content-addressed unpacks of shared `.rag` archives. Infrastructure,
 * not corpus data: it must not make an otherwise-empty store read as an
 * unsupported storage, and a reset must not sweep it into a backup.
 */
export const SHARED_TOPIC_CACHE_DIRNAME = ".ragnarok-shared-cache";

export class StorageFormatVersionError extends Error {
  readonly name = "StorageFormatVersionError";
  constructor(
    public readonly foundVersion: unknown,
    public readonly expectedVersion: number,
  ) {
    super(`Unsupported RAGnarōk storage format ${String(foundVersion)}. Expected ${expectedVersion}.`);
  }
}

/**
 * The directory holds RAGnarōk data but no format marker: content from an
 * unversioned pre-0.4 build. v2 is the only supported format and there is no
 * converter. It is refused rather than read because v0.3 and v2 share file
 * paths, so stamping a marker beside it would silently adopt it.
 */
export class UnsupportedStorageError extends Error {
  readonly name = "UnsupportedStorageError";
  constructor(public readonly storageDir: string) {
    super(
      `RAGnarōk storage at ${storageDir} holds data from an unsupported pre-0.4 build. ` +
        `Move or delete that folder to start a new store.`,
    );
  }
}

/**
 * A reset (`resetStorage`) started and never finished -- most likely the
 * process died mid-move, between renaming managed entries into the backup
 * directory and re-marking the storage as v2. Data may now be split between
 * the storage dir and a partial backup, so this must never read as plain
 * unversioned 0.3 data: it fails closed until an operator inspects and
 * clears the journal by hand.
 */
export class StorageResetInterruptedError extends Error {
  readonly name = "StorageResetInterruptedError";
  constructor(
    public readonly storageDir: string,
    public readonly backupDir: string | null,
  ) {
    super(
      `A RAGnarōk storage reset at ${storageDir} was interrupted before completing` +
        `${backupDir ? `, possibly mid-move into ${backupDir}` : ""}. ` +
        `Inspect the directory manually before retrying; data may be split between it and the backup.`,
    );
  }
}

/**
 * Files that are infrastructure, not managed data — never version-gated, never backed up.
 *
 * config.json earns its place on both counts. The MCP server generates it on
 * first run, before storage format validation, so version-gating it would make
 * every fresh install look like unsupported pre-0.4 storage and refuse to start.
 * And it holds the operator's settings rather than their corpus, so resetting
 * *data* must leave it exactly where it is instead of sweeping it into a backup.
 */
function isInfrastructureEntry(entry: string): boolean {
  return (
    entry === STORAGE_FORMAT_FILENAME ||
    entry === STORAGE_LOCK_FILENAME ||
    entry === STORAGE_CONFIG_FILENAME ||
    entry === STORAGE_RESET_JOURNAL_FILENAME ||
    entry === SHARED_TOPIC_CACHE_DIRNAME ||
    entry.startsWith("backup-v1-")
  );
}

export interface StorageFormatMarker {
  formatVersion: typeof STORAGE_FORMAT_VERSION;
  initializedAt: number;
}

export type StorageInspection =
  | { status: "current" | "empty" | "unsupported" }
  | { status: "future-version"; foundVersion: unknown }
  | { status: "reset-interrupted" };

/**
 * Read-only, lock-free classification of a storage directory: nothing here
 * writes, creates the directory, or takes a lock. An interrupted reset is
 * reported ahead of the files it left behind, because it describes the
 * directory more truthfully than they do.
 */
export async function inspectStorage(storageDir: string): Promise<StorageInspection> {
  // Existence only. A corrupt journal still proves a reset was interrupted,
  // and inspection has no use for the backup path it would have named.
  try {
    await fs.access(resetJournalPath(storageDir));
    return { status: "reset-interrupted" };
  } catch {
    // No journal: a completed or never-started reset.
  }

  try {
    const parsed = JSON.parse(await fs.readFile(markerPath(storageDir), "utf8")) as Partial<StorageFormatMarker>;
    return parsed.formatVersion === STORAGE_FORMAT_VERSION
      ? { status: "current" }
      : { status: "future-version", foundVersion: parsed.formatVersion };
  } catch (error: any) {
    // A present-but-unreadable marker is not "no marker": fail closed the same
    // way ensureStorageFormat does rather than classifying it as legacy.
    if (error?.code !== "ENOENT") {
      throw error instanceof SyntaxError
        ? new Error(`Invalid ${STORAGE_FORMAT_FILENAME}; storage initialization aborted.`)
        : error;
    }
  }

  return (await hasManagedData(storageDir)) ? { status: "unsupported" } : { status: "empty" };
}

/** Durably replace a UTF-8 file using a same-directory atomic rename. */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);

    try {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is unsupported on Windows.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function markerPath(storageDir: string): string {
  return path.join(storageDir, STORAGE_FORMAT_FILENAME);
}

function resetJournalPath(storageDir: string): string {
  return path.join(storageDir, STORAGE_RESET_JOURNAL_FILENAME);
}

/** Throws StorageResetInterruptedError if a reset journal is present; a no-op otherwise. */
async function checkResetJournal(storageDir: string): Promise<void> {
  const journalPath = resetJournalPath(storageDir);
  let journal: { backupDir?: string | null } = {};
  try {
    journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as { backupDir?: string | null };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return;
    }
    // A corrupt journal still proves a reset was interrupted; fail closed
    // even though the intended backup directory cannot be recovered from it.
    throw new StorageResetInterruptedError(storageDir, null);
  }
  throw new StorageResetInterruptedError(storageDir, journal.backupDir ?? null);
}

async function hasManagedData(storageDir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(storageDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return entries.some((entry) => !isInfrastructureEntry(entry));
}

/** Validate storage format v2, initializing only a genuinely empty directory. */
export async function ensureStorageFormat(storageDir: string): Promise<StorageFormatMarker> {
  await checkResetJournal(storageDir);
  return ensureStorageFormatUnjournaled(storageDir);
}

/**
 * The actual v2 validation/initialization, without the reset-journal check.
 * `resetStorage` calls this directly -- it writes the journal itself and
 * must not immediately trip over it via the public entry point above.
 */
async function ensureStorageFormatUnjournaled(storageDir: string): Promise<StorageFormatMarker> {
  await fs.mkdir(storageDir, { recursive: true });
  const formatPath = markerPath(storageDir);
  try {
    const parsed = JSON.parse(await fs.readFile(formatPath, "utf8")) as Partial<StorageFormatMarker>;
    if (parsed.formatVersion !== STORAGE_FORMAT_VERSION) {
      throw new StorageFormatVersionError(parsed.formatVersion, STORAGE_FORMAT_VERSION);
    }
    return parsed as StorageFormatMarker;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid ${STORAGE_FORMAT_FILENAME}; storage initialization aborted.`);
      }
      throw error;
    }
  }

  if (await hasManagedData(storageDir)) {
    throw new UnsupportedStorageError(storageDir);
  }

  const marker: StorageFormatMarker = { formatVersion: STORAGE_FORMAT_VERSION, initializedAt: Date.now() };
  await atomicWriteJson(formatPath, marker);
  return marker;
}

/** Move managed content to a timestamped backup, rolling back partial moves. */
export async function resetStorage(storageDir: string): Promise<string | null> {
  await fs.mkdir(storageDir, { recursive: true });
  const entries = (await fs.readdir(storageDir)).filter((entry) => !isInfrastructureEntry(entry));
  const journalPath = resetJournalPath(storageDir);
  const backupDir =
    entries.length === 0 ? null : path.join(storageDir, `backup-v1-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  // Preserve the current marker (if it is a genuinely valid v2 marker) in the
  // journal. A rollback that restores every moved entry can then reinstate
  // this exact marker and clear the journal -- proving the transient failure
  // never actually left the store unversioned -- instead of leaving a
  // perfectly healthy store permanently fail-closed.
  let priorMarker: StorageFormatMarker | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath(storageDir), "utf8")) as Partial<StorageFormatMarker>;
    if (parsed.formatVersion === STORAGE_FORMAT_VERSION && typeof parsed.initializedAt === "number") {
      priorMarker = parsed as StorageFormatMarker;
    }
  } catch {
    // No marker, or unreadable/invalid -- nothing to preserve.
  }

  // Journaled before the marker is unlinked: a crash from here on must fail
  // closed as an interrupted reset, never be mistaken for unversioned data.
  await atomicWriteJson(journalPath, { startedAt: Date.now(), backupDir, marker: priorMarker });
  await fs.unlink(markerPath(storageDir)).catch(() => undefined);

  if (entries.length === 0) {
    await ensureStorageFormatUnjournaled(storageDir);
    await fs.unlink(journalPath).catch(() => undefined);
    return null;
  }

  const moved: string[] = [];
  try {
    await fs.mkdir(backupDir!);
    for (const entry of entries) {
      await fs.rename(path.join(storageDir, entry), path.join(backupDir!, entry));
      moved.push(entry);
    }
    await ensureStorageFormatUnjournaled(storageDir);
    await fs.unlink(journalPath).catch(() => undefined);
    return backupDir;
  } catch (error) {
    // Best-effort restore, but its completeness is tracked explicitly: only a
    // *fully* successful rollback proves the directory is genuinely back to
    // its pre-reset state.
    let fullyRestored = true;
    for (const entry of moved.reverse()) {
      try {
        await fs.rename(path.join(backupDir!, entry), path.join(storageDir, entry));
      } catch {
        fullyRestored = false;
      }
    }
    await fs.rmdir(backupDir!).catch(() => undefined);
    if (fullyRestored && priorMarker) {
      // A provably complete rollback with a known-good prior marker means
      // this was a transient failure, not real data loss: restore the exact
      // marker and clear the journal rather than leaving the store
      // permanently misclassified as an interrupted reset.
      await atomicWriteJson(markerPath(storageDir), priorMarker);
      await fs.unlink(journalPath).catch(() => undefined);
    }
    // Otherwise -- an incomplete restore, or no valid prior marker was ever
    // recorded -- the journal (and any leftover partial backup dir) are left
    // in place on purpose: fail closed until an operator inspects it.
    throw error;
  }
}
