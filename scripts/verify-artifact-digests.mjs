import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const digestFile = path.resolve(process.argv[2] ?? "");
const artifactDir = path.resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: node scripts/verify-artifact-digests.mjs <sha256-file> <artifact-dir>");
}
const records = (await readFile(digestFile, "utf8")).trim().split(/\r?\n/);
for (const record of records) {
  const match = record.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
  if (!match) throw new Error(`Invalid digest record: ${record}`);
  const file = path.resolve(artifactDir, path.basename(match[2]));
  if (!file.startsWith(`${artifactDir}${path.sep}`)) throw new Error(`Artifact path escaped directory: ${record}`);
  const actual = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  if (actual !== match[1]) throw new Error(`Artifact digest mismatch: ${path.basename(file)}`);
}
console.log(`Verified ${records.length} release artifact digests.`);
