import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_ATTESTATION_BUNDLE,
  RELEASE_OIDC_ISSUER,
  RELEASE_PREDICATE_TYPE,
  verifyReleaseAttestation,
} from "./release-attestation.mjs";
import {
  assertBenchmarkPackageArtifacts,
  assertReleaseIdentity,
  expectedReleaseIdentity,
  inspectNpmArtifact,
  inspectVsixArtifact,
} from "./release-metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(root, process.env.RAGNAROK_RELEASE_MANIFEST ?? "release-manifest.json");
const requiredGates = [
  "quality-node20",
  "quality-node22",
  "native-linux",
  "native-macos",
  "native-windows",
  "pack-smoke",
  "models",
  "licenses",
  "sbom",
  "secrets",
  "benchmarks",
  "docker-smoke",
  "vsix-win32-x64",
  "vsix-win32-arm64",
  "vsix-darwin-x64",
  "vsix-darwin-arm64",
  "vsix-linux-x64",
  "vsix-linux-arm64",
];
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

export async function verifyReleaseManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`Release manifest is missing or invalid: ${manifestPath}`);
  }
  if (manifest.schemaVersion !== 2 || manifest.sourceSha !== head) {
    throw new Error(`Release manifest is not bound to HEAD ${head}`);
  }
  const expectedRelease = await expectedReleaseIdentity(root);
  assertReleaseIdentity(manifest.release, expectedRelease);
  const lock = await readFile(path.join(root, "package-lock.json"));
  if (manifest.lockSha256 !== sha256(lock)) throw new Error("Release manifest lockfile digest mismatch");
  const policy = await readFile(path.join(root, "release-policy.json"));
  if (manifest.policySha256 !== sha256(policy)) throw new Error("Release manifest policy digest mismatch");
  for (const gate of requiredGates) {
    if (manifest.gates?.[gate]?.status !== "passed" || !manifest.gates[gate].runUrl) {
      throw new Error(`Release gate is absent or not passed: ${gate}`);
    }
  }
  try {
    execFileSync("git", ["diff", "--quiet"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error("Release source has tracked working-tree changes");
  }
  const targets = new Set(
    (manifest.artifacts ?? []).filter((artifact) => artifact.type === "vsix").map((artifact) => artifact.target),
  );
  const policyJson = JSON.parse(policy);
  for (const [name, evidence] of Object.entries(policyJson.budgetEvidence ?? {})) {
    if (evidence.measured !== true) throw new Error(`Release size budget has no audited baseline: ${name}`);
  }
  for (const target of policyJson.vsixTargets) {
    if (!targets.has(target)) throw new Error(`Release manifest has no VSIX for ${target}`);
  }
  const groupByType = (items) =>
    items.reduce((groups, item) => {
      (groups[item.type] ??= []).push(item);
      return groups;
    }, {});
  const artifactsByType = groupByType(manifest.artifacts ?? []);
  if (
    artifactsByType.npm?.length !== 2 ||
    artifactsByType.vsix?.length !== policyJson.vsixTargets.length ||
    artifactsByType.docker?.length !== 1
  ) {
    throw new Error("Release manifest must contain exactly two npm, six VSIX, and one Docker artifact");
  }
  const docker = artifactsByType.docker[0];
  if (
    !/^sha256:[a-f0-9]{64}$/.test(docker.digest ?? "") ||
    docker.localRef !== "ragnarok-mcp:ci" ||
    docker.stagingRef !== `${expectedRelease.docker.repository}:staging-${head}` ||
    docker.immutableRef !== `${expectedRelease.docker.repository}:sha-${head}` ||
    docker.publishRef !== `${expectedRelease.docker.repository}:${expectedRelease.version}` ||
    docker.sourceRef
  ) {
    throw new Error("Release manifest has invalid Docker OCI identity");
  }
  for (const artifact of manifest.artifacts ?? []) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new Error(`Invalid artifact record: ${artifact.path ?? artifact.type}`);
    }
    if (artifact.path) {
      const file = path.resolve(root, artifact.path);
      if (!file.startsWith(`${root}${path.sep}`))
        throw new Error(`Artifact path escapes release root: ${artifact.path}`);
      const contents = await readFile(file);
      if (sha256(contents) !== artifact.sha256 || (await stat(file)).size !== artifact.size) {
        throw new Error(`Artifact digest/size mismatch: ${artifact.path}`);
      }
      if (artifact.type === "npm") {
        const metadata = inspectNpmArtifact(file);
        const expected = expectedRelease.npm.find((item) => item.name === metadata.name);
        if (
          !expected ||
          metadata.version !== expected.version ||
          artifact.packageName !== expected.name ||
          artifact.version !== expected.version ||
          artifact.registry !== expected.registry
        ) {
          throw new Error(`npm artifact metadata/coordinate mismatch: ${artifact.path}`);
        }
      }
      if (artifact.type === "vsix") {
        const metadata = inspectVsixArtifact(file);
        if (
          metadata.extensionId !== expectedRelease.vscode.extensionId ||
          metadata.version !== expectedRelease.version ||
          metadata.target !== artifact.target ||
          artifact.extensionId !== expectedRelease.vscode.extensionId ||
          artifact.version !== expectedRelease.version ||
          artifact.marketplace !== expectedRelease.vscode.marketplace
        ) {
          throw new Error(`VSIX artifact metadata/coordinate mismatch: ${artifact.path}`);
        }
      }
    }
  }
  if (new Set(artifactsByType.npm.map((artifact) => artifact.packageName)).size !== expectedRelease.npm.length) {
    throw new Error("Release manifest must contain each approved npm package exactly once");
  }
  if (targets.size !== policyJson.vsixTargets.length) {
    throw new Error("Release manifest must contain each VSIX target exactly once");
  }
  const evidenceByType = groupByType(manifest.evidence ?? []);
  for (const type of ["benchmark", "cyclonedx", "spdx"]) {
    if (evidenceByType[type]?.length !== 1)
      throw new Error(`Release manifest requires exactly one ${type} evidence file`);
  }
  for (const item of manifest.evidence ?? []) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1) {
      throw new Error(`Invalid release evidence record: ${item.path ?? item.type}`);
    }
    const file = path.resolve(root, item.path);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`Evidence path escapes release root: ${item.path}`);
    const contents = await readFile(file);
    if (sha256(contents) !== item.sha256 || (await stat(file)).size !== item.size) {
      throw new Error(`Release evidence digest/size mismatch: ${item.path}`);
    }
    if (item.type === "benchmark") {
      const benchmark = JSON.parse(contents);
      if (
        benchmark.sourceCommit !== head ||
        benchmark.status !== "passed" ||
        benchmark.graphContractEvidence?.measured !== true ||
        benchmark.performance?.childPeakRssMeasured !== true ||
        benchmark.performance?.indexTimeMeasured !== true
      ) {
        throw new Error("Benchmark evidence is incomplete or not bound to HEAD");
      }
      assertBenchmarkPackageArtifacts(benchmark, artifactsByType.npm);
    }
  }
  if (!manifest.provenance?.builderId || !manifest.provenance?.predicateSha256) {
    throw new Error("Release manifest lacks builder provenance/predicate identity");
  }
  const predicatePath = path.resolve(root, manifest.provenance.predicatePath ?? "");
  if (!predicatePath.startsWith(`${root}${path.sep}`))
    throw new Error("Provenance predicate path escapes release root");
  const predicateContents = await readFile(predicatePath);
  if (sha256(predicateContents) !== manifest.provenance.predicateSha256) {
    throw new Error("Release provenance predicate digest mismatch");
  }
  const attestation = manifest.provenance.attestation;
  if (
    attestation?.subjectPath !== "release-manifest.json" ||
    attestation?.bundlePath !== DEFAULT_ATTESTATION_BUNDLE ||
    attestation?.repository !== expectedRelease.repository ||
    attestation?.signerWorkflow !== expectedRelease.workflow ||
    attestation?.sourceDigest !== head ||
    attestation?.sourceRef !== expectedRelease.sourceRef ||
    attestation?.oidcIssuer !== RELEASE_OIDC_ISSUER ||
    attestation?.predicateType !== RELEASE_PREDICATE_TYPE
  ) {
    throw new Error("Release attestation policy does not match the approved repository/workflow/source identity");
  }
  const bundlePath = path.resolve(root, attestation.bundlePath);
  if (!bundlePath.startsWith(`${root}${path.sep}`)) throw new Error("Release attestation bundle path escapes root");
  const verification = await verifyReleaseAttestation({
    manifestPath,
    bundlePath,
    repository: attestation.repository,
    workflow: attestation.signerWorkflow,
    sourceSha: head,
    sourceRef: attestation.sourceRef,
  });
  console.log(`Verified protected release manifest for ${head}.`);
  console.log(
    `Cryptographically verified ${verification.verifiedAttestations} release attestation(s); bundle sha256=${verification.bundleSha256}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== "verify") throw new Error("Usage: node scripts/release-manifest.mjs verify");
  await verifyReleaseManifest();
}
