import path from "path";
import fs from "fs";

/**
 * Walk up from __dirname looking for the bundled models directory.
 *
 * Checks `assets/models` at each level (installed package layout, VSIX
 * staging layout) and `packages/core/assets/models` (monorepo layout when
 * running from a bundle outside packages/core, e.g. the root dev extension).
 * Returns the absolute path if found, null otherwise.
 */
export function findAssetsModelsDir(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidates = [path.join(dir, "assets", "models"), path.join(dir, "packages", "core", "assets", "models")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Check if a directory contains model files (config.json or tokenizer.json).
 */
export function isModelDirectory(dirPath: string): boolean {
  try {
    const files = fs.readdirSync(dirPath);
    return files.includes("config.json") || files.includes("tokenizer.json");
  } catch {
    return false;
  }
}
