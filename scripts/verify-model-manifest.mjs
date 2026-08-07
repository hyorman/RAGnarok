import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "packages/core/assets/models");
const manifest = JSON.parse(await readFile(path.join(modelsDir, "manifest.json"), "utf8"));
const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));

if (manifest.version !== 2 || !Array.isArray(manifest.models) || !Array.isArray(manifest.artifacts)) {
  throw new Error("Model manifest must use schema version 2 with models and artifacts arrays");
}

const modelIds = new Set();
for (const model of manifest.models) {
  for (const field of ["id", "source", "revision", "upstreamModel", "license", "licenseUrl", "modifications"]) {
    if (typeof model[field] !== "string" || !model[field].trim()) {
      throw new Error(`Model ${model.id ?? "<unknown>"} is missing ${field}`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(model.revision)) {
    throw new Error(`Model ${model.id} revision must be a full immutable 40-character commit`);
  }
  if (!model.source.startsWith("https://") || !model.licenseUrl.startsWith("https://")) {
    throw new Error(`Model ${model.id} provenance URLs must use HTTPS`);
  }
  if (modelIds.has(model.id)) throw new Error(`Duplicate model provenance entry: ${model.id}`);
  modelIds.add(model.id);
}

const declared = new Set();
let totalBytes = 0;
for (const artifact of manifest.artifacts) {
  if (!modelIds.has(artifact.model)) throw new Error(`Unknown model for ${artifact.filename}: ${artifact.model}`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid SHA-256 for ${artifact.filename}`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1)
    throw new Error(`Invalid size for ${artifact.filename}`);
  const filePath = path.resolve(modelsDir, artifact.filename);
  if (!filePath.startsWith(modelsDir + path.sep)) throw new Error(`Invalid model manifest path: ${artifact.filename}`);
  if (declared.has(filePath)) throw new Error(`Duplicate model artifact: ${artifact.filename}`);
  declared.add(filePath);
  const contents = await readFile(filePath);
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== artifact.sha256) throw new Error(`Model artifact checksum mismatch: ${artifact.filename}`);
  if (contents.byteLength !== artifact.size) throw new Error(`Model artifact size mismatch: ${artifact.filename}`);
  totalBytes += contents.byteLength;
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in bundled models: ${target}`);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.name !== "manifest.json") files.push(target);
  }
  return files;
}

for (const file of await walk(modelsDir)) {
  if (!declared.has(file)) throw new Error(`Bundled model file is not declared: ${path.relative(modelsDir, file)}`);
  if (!(await stat(file)).isFile()) throw new Error(`Bundled model artifact is not a regular file: ${file}`);
}

if (totalBytes > policy.budgets.bundledModelsUnpackedBytes) {
  throw new Error(`Bundled models use ${totalBytes} bytes; budget is ${policy.budgets.bundledModelsUnpackedBytes}`);
}
console.log(
  `Verified ${manifest.models.length} models / ${manifest.artifacts.length} artifacts (${totalBytes} bytes).`,
);
