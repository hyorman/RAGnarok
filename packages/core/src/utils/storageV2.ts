import * as fs from "fs/promises";
import * as path from "path";
import { STORAGE_LOCK_FILENAME } from "./storageLock";

export const STORAGE_FORMAT_VERSION = 2 as const;
export const STORAGE_FORMAT_FILENAME = "storage-format.json";

/** Files that are infrastructure, not managed data — never version-gated, never backed up. */
function isInfrastructureEntry(entry: string): boolean {
  return entry === STORAGE_FORMAT_FILENAME || entry === STORAGE_LOCK_FILENAME || entry.startsWith("backup-v1-");
}

export interface StorageFormatMarker {
  formatVersion: typeof STORAGE_FORMAT_VERSION;
  initializedAt: number;
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
export async function ensureStorageFormatV2(storageDir: string): Promise<StorageFormatMarker> {
  await fs.mkdir(storageDir, { recursive: true });
  const formatPath = markerPath(storageDir);
  try {
    const parsed = JSON.parse(await fs.readFile(formatPath, "utf8")) as Partial<StorageFormatMarker>;
    if (parsed.formatVersion !== STORAGE_FORMAT_VERSION) {
      throw new Error(
        `Unsupported RAGnarōk storage format ${String(parsed.formatVersion)}. Expected ${STORAGE_FORMAT_VERSION}.`,
      );
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
    throw new Error(
      `Existing unversioned RAGnarōk storage was found at ${storageDir}. ` +
        `Start with --reset-storage or RAGNAROK_RESET_STORAGE=1 to back it up and initialize storage format v2.`,
    );
  }

  const marker: StorageFormatMarker = { formatVersion: STORAGE_FORMAT_VERSION, initializedAt: Date.now() };
  await atomicWriteJson(formatPath, marker);
  return marker;
}

/** Move managed content to a timestamped backup, rolling back partial moves. */
export async function resetStorageToV2(storageDir: string): Promise<string | null> {
  await fs.mkdir(storageDir, { recursive: true });
  const entries = (await fs.readdir(storageDir)).filter((entry) => !isInfrastructureEntry(entry));
  await fs.unlink(markerPath(storageDir)).catch(() => undefined);

  if (entries.length === 0) {
    await ensureStorageFormatV2(storageDir);
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(storageDir, `backup-v1-${stamp}`);
  await fs.mkdir(backupDir);
  const moved: string[] = [];
  try {
    for (const entry of entries) {
      await fs.rename(path.join(storageDir, entry), path.join(backupDir, entry));
      moved.push(entry);
    }
    await ensureStorageFormatV2(storageDir);
    return backupDir;
  } catch (error) {
    for (const entry of moved.reverse()) {
      await fs.rename(path.join(backupDir, entry), path.join(storageDir, entry)).catch(() => undefined);
    }
    await fs.rmdir(backupDir).catch(() => undefined);
    throw error;
  }
}
