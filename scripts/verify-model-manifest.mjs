import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "packages/core/assets/models");
const manifest = JSON.parse(await readFile(path.join(modelsDir, "manifest.json"), "utf8"));

for (const artifact of manifest.artifacts) {
  const filePath = path.resolve(modelsDir, artifact.filename);
  if (!filePath.startsWith(modelsDir + path.sep)) throw new Error(`Invalid model manifest path: ${artifact.filename}`);
  const contents = await readFile(filePath);
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`Model artifact checksum mismatch: ${artifact.filename}`);
  }
}
console.log(`Verified ${manifest.artifacts.length} bundled model artifacts.`);
