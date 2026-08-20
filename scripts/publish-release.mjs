import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyReleaseManifest } from "./release-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsce = path.join(root, "node_modules/.bin/vsce");
const sha1 = (contents) => createHash("sha1").update(contents).digest("hex");
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

const recoveryInstructions = [
  "Do not rebuild or substitute artifacts. Preserve this journal, manifest, attestation bundle, and registry output.",
  "If a Docker staging tag exists but no intended tag was recorded, inspect its digest and remove the disposable staging tag after recovery.",
  "If any intended Docker, npm, or Marketplace channel is recorded complete, treat the release as partially public and resume only with the same manifest.",
  "npm and Marketplace publication cannot be made atomic with GHCR. Follow each registry's withdrawal/deprecation process; never reuse the version with different bytes.",
  "After recovery, attach the journal and immutable artifact digests to the release incident record.",
];

function defaultExecute(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, ...options });
}

function commandExists(execute, command, args = ["--version"]) {
  try {
    execute(command, args, { stdio: "ignore" });
  } catch {
    throw new Error(`Required publication command is unavailable or unusable: ${command}`);
  }
}

function capture(execute, command, args) {
  return String(execute(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function captureOptional(execute, command, args) {
  try {
    return { found: true, output: capture(execute, command, args) };
  } catch (error) {
    const detail = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/\bE404\b|404 Not Found|manifest unknown|not found/i.test(detail)) return { found: false, output: "" };
    throw new Error(`Publication preflight failed for ${command} ${args[0]}: ${detail.trim() || "command failed"}`);
  }
}

function collectVersions(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectVersions(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "version" || key === "versionName") && typeof item === "string") output.add(item);
      collectVersions(item, output);
    }
  }
  return output;
}

function releaseRootPath(relativePath, label) {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes the release root`);
  return resolved;
}

export function buildPublicationPlan(manifest, kind, target) {
  if (!["all", "npm", "vscode", "docker"].includes(kind)) {
    throw new Error("Usage: node scripts/publish-release.mjs <all|npm|vscode|docker>");
  }
  if (target && kind !== "vscode") throw new Error("--target is valid only for VS Code publication");
  const docker = manifest.artifacts.find((item) => item.type === "docker");
  const npm = manifest.artifacts.filter((item) => item.type === "npm");
  const vscode = manifest.artifacts.filter((item) => item.type === "vsix" && (!target || item.target === target));
  if ((kind === "all" || kind === "docker") && !docker) throw new Error("Release manifest has no Docker artifact");
  if ((kind === "all" || kind === "npm") && npm.length !== 2) {
    throw new Error("Release manifest does not contain both npm artifacts");
  }
  if ((kind === "all" || kind === "vscode") && vscode.length < 1) {
    throw new Error(
      target ? `Release manifest has no unique VSIX for ${target}` : "Release manifest has no VSIX artifacts",
    );
  }
  if (target && vscode.length !== 1) throw new Error(`Release manifest has no unique VSIX for ${target}`);
  // GHCR is first because its staging tag permits a digest-preserving preflight
  // and its tags are recoverable. npm and Marketplace publication are not
  // transactionally reversible across registries.
  return {
    docker: kind === "all" || kind === "docker" ? [docker] : [],
    npm: kind === "all" || kind === "npm" ? npm : [],
    vscode: kind === "all" || kind === "vscode" ? vscode : [],
  };
}

async function readJournal(file, manifest) {
  try {
    const journal = JSON.parse(await readFile(file, "utf8"));
    if (journal.sourceSha !== manifest.sourceSha || journal.manifestSha256 !== manifest.__sha256) {
      throw new Error("Existing publication journal belongs to a different release manifest");
    }
    return journal;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      sourceSha: manifest.sourceSha,
      release: manifest.release,
      manifestSha256: manifest.__sha256,
      attestationBundleSha256: manifest.__attestationBundleSha256,
      status: "preflight",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      channels: [],
      recoveryInstructions,
    };
  }
}

async function saveJournal(file, journal) {
  journal.updatedAt = new Date().toISOString();
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function completed(journal, channel, coordinate, artifactSha256) {
  return journal.channels.some(
    (entry) =>
      entry.channel === channel &&
      entry.coordinate === coordinate &&
      entry.artifactSha256 === artifactSha256 &&
      ["published", "already-present"].includes(entry.status),
  );
}

async function record(journalPath, journal, entry) {
  journal.channels.push({ ...entry, recordedAt: new Date().toISOString() });
  await saveJournal(journalPath, journal);
}

export async function preflightPublication({
  manifest,
  plan,
  journal,
  execute = defaultExecute,
  environment = process.env,
}) {
  if (plan.npm.length > 0) {
    if (!environment.NODE_AUTH_TOKEN && !environment.NPM_TOKEN) throw new Error("npm publication token is missing");
    commandExists(execute, "npm");
    capture(execute, "npm", ["whoami", "--registry", "https://registry.npmjs.org"]);
    for (const artifact of plan.npm) {
      const coordinate = `${artifact.packageName}@${artifact.version}`;
      const existing = captureOptional(execute, "npm", [
        "view",
        coordinate,
        "dist.shasum",
        "--json",
        "--registry",
        artifact.registry,
      ]);
      if (existing.found) {
        const publishedSha1 = JSON.parse(existing.output);
        const localSha1 = sha1(await readFile(path.resolve(root, artifact.path)));
        if (publishedSha1 !== localSha1) {
          throw new Error(`npm coordinate already exists with different bytes: ${coordinate}`);
        }
        if (!completed(journal, "npm", coordinate, artifact.sha256)) {
          throw new Error(`npm coordinate already exists but is not recorded in this journal: ${coordinate}`);
        }
      }
    }
  }
  if (plan.vscode.length > 0) {
    if (!environment.VSCE_PAT) throw new Error("VSCE_PAT is missing");
    commandExists(execute, vsce);
    capture(execute, vsce, ["verify-pat", manifest.release.vscode.publisher]);
    const existing = captureOptional(execute, vsce, ["show", manifest.release.vscode.extensionId, "--json"]);
    if (existing.found) {
      let versions;
      try {
        versions = collectVersions(JSON.parse(existing.output));
      } catch {
        throw new Error("VS Code Marketplace preflight returned invalid metadata");
      }
      if (versions.has(manifest.release.version)) {
        const hasRecordedVariant = journal.channels.some(
          (entry) =>
            entry.channel === "vscode" &&
            entry.coordinate.startsWith(`${manifest.release.vscode.extensionId}@${manifest.release.version}/`) &&
            entry.status === "published",
        );
        if (!hasRecordedVariant) {
          throw new Error(
            `VS Code Marketplace version already exists outside this journal: ${manifest.release.vscode.extensionId}@${manifest.release.version}`,
          );
        }
      }
    }
  }
  if (plan.docker.length > 0) {
    commandExists(execute, "docker", ["version"]);
    commandExists(execute, "docker", ["buildx", "version"]);
    const image = plan.docker[0];
    for (const coordinate of [image.immutableRef, image.publishRef]) {
      const existing = captureOptional(execute, "docker", ["buildx", "imagetools", "inspect", coordinate]);
      if (existing.found) {
        const digest = existing.output.match(/^Digest:\s*(sha256:[a-f0-9]{64})$/im)?.[1];
        if (digest !== image.digest)
          throw new Error(`Docker coordinate already exists with wrong digest: ${coordinate}`);
        if (!completed(journal, "docker", coordinate, artifactSha(image))) {
          throw new Error(`Docker coordinate already exists but is not recorded in this journal: ${coordinate}`);
        }
      }
    }
  }
}

const artifactSha = (artifact) => artifact.sha256;

export async function publishDocker({ image, journal, journalPath, execute }) {
  const inspectDigest = (coordinate) => {
    const output = capture(execute, "docker", ["buildx", "imagetools", "inspect", coordinate]);
    return output.match(/^Digest:\s*(sha256:[a-f0-9]{64})$/im)?.[1];
  };
  execute("docker", ["load", "--input", image.path], { stdio: "inherit" });
  execute("docker", ["tag", image.localRef, image.stagingRef], { stdio: "inherit" });
  execute("docker", ["push", image.stagingRef], { stdio: "inherit" });
  const stagingDigest = inspectDigest(image.stagingRef);
  if (stagingDigest !== image.digest) {
    throw new Error(
      `Docker staging digest ${stagingDigest ?? "(missing)"} did not match verified OCI digest ${image.digest}; intended tags were not changed`,
    );
  }
  await record(journalPath, journal, {
    channel: "docker-staging",
    coordinate: image.stagingRef,
    artifactSha256: artifactSha(image),
    contentDigest: image.digest,
    status: "verified",
    disposable: true,
  });
  for (const coordinate of [image.immutableRef, image.publishRef]) {
    if (completed(journal, "docker", coordinate, artifactSha(image))) continue;
    execute("docker", ["tag", image.localRef, coordinate], { stdio: "inherit" });
    execute("docker", ["push", coordinate], { stdio: "inherit" });
    const publishedDigest = inspectDigest(coordinate);
    if (publishedDigest !== image.digest) {
      throw new Error(
        `Published Docker digest ${publishedDigest ?? "(missing)"} did not match staged digest ${image.digest} at ${coordinate}`,
      );
    }
    await record(journalPath, journal, {
      channel: "docker",
      coordinate,
      artifactSha256: artifactSha(image),
      contentDigest: image.digest,
      status: "published",
    });
  }
}

async function publishNpm({ artifacts, journal, journalPath, execute }) {
  for (const artifact of artifacts) {
    const coordinate = `${artifact.packageName}@${artifact.version}`;
    if (completed(journal, "npm", coordinate, artifact.sha256)) continue;
    execute("npm", ["publish", artifact.path, "--access", "public", "--provenance"], { stdio: "inherit" });
    await record(journalPath, journal, {
      channel: "npm",
      coordinate,
      artifactSha256: artifact.sha256,
      status: "published",
    });
  }
}

async function publishVscode({ artifacts, journal, journalPath, execute }) {
  for (const artifact of artifacts) {
    const coordinate = `${artifact.extensionId}@${artifact.version}/${artifact.target}`;
    if (completed(journal, "vscode", coordinate, artifact.sha256)) continue;
    execute(vsce, ["publish", "--packagePath", artifact.path], { stdio: "inherit" });
    await record(journalPath, journal, {
      channel: "vscode",
      coordinate,
      artifactSha256: artifact.sha256,
      status: "published",
    });
  }
}

export async function main({ execute = defaultExecute, environment = process.env } = {}) {
  const kind = process.argv[2];
  const target = process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length);
  await verifyReleaseManifest();
  const manifestPath = releaseRootPath(
    environment.RAGNAROK_RELEASE_MANIFEST ?? "release-manifest.json",
    "Release manifest",
  );
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const bundlePath = releaseRootPath(
    manifest.provenance?.attestation?.bundlePath ?? "release-manifest.attestation.jsonl",
    "Release attestation bundle",
  );
  manifest.__sha256 = sha256(manifestBytes);
  manifest.__attestationBundleSha256 = sha256(await readFile(bundlePath));
  const plan = buildPublicationPlan(manifest, kind, target);
  const journalPath = releaseRootPath(
    environment.RAGNAROK_PUBLICATION_JOURNAL ?? "release-publication-journal.json",
    "Publication journal",
  );
  const journal = await readJournal(journalPath, manifest);
  try {
    await preflightPublication({ manifest, plan, journal, execute, environment });
    journal.status = "publishing";
    await saveJournal(journalPath, journal);
    if (plan.docker.length > 0) {
      await publishDocker({ image: plan.docker[0], journal, journalPath, execute });
    }
    await publishNpm({ artifacts: plan.npm, journal, journalPath, execute });
    await publishVscode({ artifacts: plan.vscode, journal, journalPath, execute });
    journal.status = "complete";
    journal.completedAt = new Date().toISOString();
    await saveJournal(journalPath, journal);
  } catch (error) {
    journal.status = "failed";
    journal.failure = {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    await saveJournal(journalPath, journal);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
