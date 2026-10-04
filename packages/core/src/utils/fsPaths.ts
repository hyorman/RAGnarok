import * as fs from "fs/promises";
import * as path from "path";

/** The Node errno code (`"ENOENT"`, ...) carried by a failed filesystem call, if any. */
export function errnoCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

export async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.lstat(candidatePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function listFilesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to export symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
