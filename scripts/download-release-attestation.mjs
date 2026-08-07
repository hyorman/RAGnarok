import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PREDICATE_TYPE, RELEASE_REPOSITORY } from "./release-attestation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(root, process.argv[2] ?? "release-manifest.json");
const outputPath = path.resolve(root, process.argv[3] ?? "release-manifest.attestation.jsonl");
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "ragnarok-attestation-"));

try {
  execFileSync(
    "gh",
    ["attestation", "download", manifestPath, "--repo", RELEASE_REPOSITORY, "--predicate-type", RELEASE_PREDICATE_TYPE],
    { cwd: temporaryDir, stdio: "inherit" },
  );
  const digest = createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  const candidates = new Set([`sha256:${digest}.jsonl`, `sha256-${digest}.jsonl`]);
  const downloadedName = (await readdir(temporaryDir)).find((name) => candidates.has(name));
  if (!downloadedName) throw new Error(`GitHub CLI did not download the expected manifest bundle for sha256:${digest}`);
  const downloaded = path.join(temporaryDir, downloadedName);
  await copyFile(downloaded, outputPath);
  console.log(`Downloaded release-manifest attestation bundle to ${outputPath}.`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
