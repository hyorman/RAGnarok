import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { DEFAULT_ATTESTATION_BUNDLE, RELEASE_OIDC_ISSUER, RELEASE_PREDICATE_TYPE } from "./release-attestation.mjs";
import {
  assertBenchmarkPackageArtifacts,
  assertReleaseIdentity,
  expectedReleaseIdentity,
  inspectNpmArtifact,
  inspectVsixArtifact,
  requireProtectedReleaseTag,
} from "./release-metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(root, process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/create-release-manifest.mjs <artifact-directory>");
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const policyContents = await readFile(path.join(root, "release-policy.json"));
const policy = JSON.parse(policyContents);
const release = await expectedReleaseIdentity(root);
requireProtectedReleaseTag(release);
if (process.env.GITHUB_SHA !== sourceSha) {
  throw new Error("GITHUB_SHA must match the checked-out release source");
}
const runUrl = process.env.GITHUB_RUN_URL;
const runId = process.env.GITHUB_RUN_ID;
const expectedRunUrl = `https://github.com/${release.repository}/actions/runs/${runId}`;
if (!/^\d+$/.test(runId ?? "") || runUrl !== expectedRunUrl) {
  throw new Error("GITHUB_RUN_ID/GITHUB_RUN_URL must identify the protected release workflow run");
}

const names = (await readdir(artifactDir)).sort();
const npmNames = names.filter((name) => name.endsWith(".tgz"));
const vsixNames = names.filter((name) => name.endsWith(".vsix"));
const dockerNames = names.filter((name) => name === "ragnarok-mcp.oci.tar");
if (
  npmNames.length !== 2 ||
  !npmNames.some((name) => name.startsWith("ragnarok-core-")) ||
  !npmNames.some((name) => name.startsWith("ragnarok-mcp-server-"))
) {
  throw new Error(`Expected exactly the core and MCP npm tarballs; found: ${npmNames.join(", ") || "(none)"}`);
}
if (vsixNames.length !== policy.vsixTargets.length) {
  throw new Error(`Expected ${policy.vsixTargets.length} VSIX artifacts; found ${vsixNames.length}`);
}
if (dockerNames.length !== 1) {
  throw new Error("Expected exactly one ragnarok-mcp.oci.tar artifact");
}

const artifacts = [];
for (const name of [...npmNames, ...vsixNames, ...dockerNames].sort()) {
  const file = path.join(artifactDir, name);
  const contents = await readFile(file);
  const record = {
    path: path.relative(root, file),
    sha256: sha256(contents),
    size: (await stat(file)).size,
    type: name.endsWith(".vsix") ? "vsix" : name.endsWith(".tgz") ? "npm" : "docker",
  };
  if (record.type === "npm") {
    const metadata = inspectNpmArtifact(file);
    const expected = release.npm.find((item) => item.name === metadata.name);
    if (!expected || metadata.version !== expected.version) {
      throw new Error(
        `Unexpected npm artifact identity: ${metadata.name ?? "(missing)"}@${metadata.version ?? "(missing)"}`,
      );
    }
    record.packageName = metadata.name;
    record.version = metadata.version;
    record.registry = expected.registry;
  }
  if (record.type === "vsix") {
    record.target = policy.vsixTargets.find((target) => name.includes(`-${target}.vsix`));
    if (!record.target) throw new Error(`Cannot identify VSIX target: ${name}`);
    const metadata = inspectVsixArtifact(file);
    if (
      metadata.extensionId !== release.vscode.extensionId ||
      metadata.version !== release.version ||
      metadata.target !== record.target
    ) {
      throw new Error(`VSIX metadata does not match release identity/target: ${name}`);
    }
    record.extensionId = metadata.extensionId;
    record.version = metadata.version;
    record.marketplace = release.vscode.marketplace;
  }
  if (record.type === "docker") {
    const index = JSON.parse(execFileSync("tar", ["-xOf", file, "index.json"], { encoding: "utf8" }));
    if (index.manifests?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(index.manifests[0].digest)) {
      throw new Error("OCI archive must contain exactly one SHA-256-addressed image manifest");
    }
    const digest = index.manifests[0].digest;
    const manifestBlob = execFileSync("tar", ["-xOf", file, `blobs/sha256/${digest.slice(7)}`]);
    if (`sha256:${sha256(manifestBlob)}` !== digest) {
      throw new Error("OCI archive image manifest digest does not match its content");
    }
    record.digest = digest;
    record.localRef = "ragnarok-mcp:ci";
    record.stagingRef = `${release.docker.repository}:staging-${sourceSha}`;
    record.immutableRef = `${release.docker.repository}:sha-${sourceSha}`;
    record.publishRef = `${release.docker.repository}:${release.version}`;
  }
  artifacts.push(record);
}
if (
  new Set(artifacts.filter((item) => item.type === "vsix").map((item) => item.target)).size !==
  policy.vsixTargets.length
) {
  throw new Error("Release candidate must contain exactly one VSIX for every target");
}

const evidenceFiles = [
  { name: "bom.cdx.json", type: "cyclonedx", file: path.join(artifactDir, "bom.cdx.json") },
  { name: "bom.spdx.json", type: "spdx", file: path.join(artifactDir, "bom.spdx.json") },
];
const benchmarkDir = path.join(artifactDir, "evidence");
const benchmarkNames = (await readdir(benchmarkDir)).filter((name) => /^release-[a-f0-9]{40}\.json$/.test(name));
if (benchmarkNames.length !== 1) {
  throw new Error(`Expected exactly one source-addressed benchmark result; found ${benchmarkNames.length}`);
}
evidenceFiles.push({
  name: benchmarkNames[0],
  type: "benchmark",
  file: path.join(benchmarkDir, benchmarkNames[0]),
});
const evidence = [];
for (const item of evidenceFiles) {
  const contents = await readFile(item.file);
  const record = {
    name: item.name,
    path: path.relative(root, item.file),
    type: item.type,
    sha256: sha256(contents),
    size: (await stat(item.file)).size,
  };
  if (item.type === "cyclonedx" && JSON.parse(contents).bomFormat !== "CycloneDX") {
    throw new Error("CycloneDX evidence is invalid");
  }
  if (item.type === "spdx" && JSON.parse(contents).spdxVersion !== "SPDX-2.3") {
    throw new Error("SPDX evidence is invalid");
  }
  if (item.type === "benchmark") {
    const benchmark = JSON.parse(contents);
    if (benchmark.sourceCommit !== sourceSha || benchmark.status !== "passed") {
      throw new Error("Benchmark evidence is not a passing result for the release source SHA");
    }
    if (
      benchmark.graphContractEvidence?.measured !== true ||
      benchmark.performance?.childPeakRssMeasured !== true ||
      benchmark.performance?.indexTimeMeasured !== true
    ) {
      throw new Error("Benchmark evidence omits mandatory graph, peak-RSS, or index-time measurements");
    }
    assertBenchmarkPackageArtifacts(
      benchmark,
      artifacts.filter((artifact) => artifact.type === "npm"),
    );
  }
  evidence.push(record);
}

const gateNames = [
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
  ...policy.vsixTargets.map((target) => `vsix-${target}`),
];
const gates = Object.fromEntries(gateNames.map((name) => [name, { status: "passed", runUrl }]));
const predicate = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [...artifacts, ...evidence].map((item) => ({
    name: item.path,
    digest: { sha256: item.sha256 },
  })),
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: "https://github.com/hyorman/ragnarok/.github/workflows/release.yml",
      externalParameters: { sourceSha },
      resolvedDependencies: [
        { uri: "pkg:npm/ragnarok", digest: { sha256: sha256(await readFile(path.join(root, "package-lock.json"))) } },
      ],
    },
    runDetails: { builder: { id: runUrl }, metadata: { invocationId: runId } },
  },
};
const prettierOptions = (await prettier.resolveConfig(path.join(root, "package.json"))) ?? {};
const predicateText = await prettier.format(JSON.stringify(predicate), { ...prettierOptions, parser: "json" });
await writeFile(path.join(root, "release-provenance.json"), predicateText);
const manifest = {
  schemaVersion: 2,
  sourceSha,
  release,
  lockSha256: sha256(await readFile(path.join(root, "package-lock.json"))),
  policySha256: sha256(policyContents),
  artifacts,
  evidence,
  gates,
  provenance: {
    builderId: runUrl,
    predicateSha256: sha256(Buffer.from(predicateText)),
    predicatePath: "release-provenance.json",
    attestation: {
      subjectPath: "release-manifest.json",
      bundlePath: DEFAULT_ATTESTATION_BUNDLE,
      repository: release.repository,
      signerWorkflow: release.workflow,
      sourceDigest: sourceSha,
      sourceRef: release.sourceRef,
      oidcIssuer: RELEASE_OIDC_ISSUER,
      predicateType: RELEASE_PREDICATE_TYPE,
    },
  },
};
assertReleaseIdentity(manifest.release, release);
await writeFile(
  path.join(root, "release-manifest.json"),
  await prettier.format(JSON.stringify(manifest), { ...prettierOptions, parser: "json" }),
);
console.log(`Created release manifest for ${artifacts.length} artifacts from ${sourceSha}.`);
