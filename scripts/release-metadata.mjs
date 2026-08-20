import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW } from "./release-attestation.mjs";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const VSCODE_MARKETPLACE = "https://marketplace.visualstudio.com";
export const DOCKER_REPOSITORY = "ghcr.io/hyorman/ragnarok-mcp";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

export async function expectedReleaseIdentity(root) {
  const [extension, core, mcp] = await Promise.all([
    readJson(path.join(root, "package.json")),
    readJson(path.join(root, "packages/core/package.json")),
    readJson(path.join(root, "packages/mcp-server/package.json")),
  ]);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(extension.version ?? "")) {
    throw new Error(`Root package version is not releaseable: ${extension.version ?? "(missing)"}`);
  }
  if (core.version !== extension.version || mcp.version !== extension.version) {
    throw new Error("Root, core, and MCP package versions must match before release");
  }
  if (core.name !== "@ragnarok/core" || mcp.name !== "@ragnarok/mcp-server") {
    throw new Error("Release npm package coordinates do not match the approved packages");
  }
  if (!extension.publisher || !extension.name) throw new Error("VS Code extension identity is incomplete");
  return {
    version: extension.version,
    tag: `v${extension.version}`,
    sourceRef: `refs/tags/v${extension.version}`,
    repository: RELEASE_REPOSITORY,
    workflow: RELEASE_WORKFLOW,
    npm: [
      { name: core.name, version: core.version, registry: NPM_REGISTRY },
      { name: mcp.name, version: mcp.version, registry: NPM_REGISTRY },
    ],
    vscode: {
      extensionId: `${extension.publisher}.${extension.name}`,
      publisher: extension.publisher,
      name: extension.name,
      version: extension.version,
      marketplace: VSCODE_MARKETPLACE,
    },
    docker: { repository: DOCKER_REPOSITORY },
  };
}

export function requireProtectedReleaseTag(identity, environment = process.env) {
  if (
    environment.GITHUB_REPOSITORY !== identity.repository ||
    environment.GITHUB_REF_TYPE !== "tag" ||
    environment.GITHUB_REF !== identity.sourceRef ||
    environment.GITHUB_REF_NAME !== identity.tag ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    environment.GITHUB_WORKFLOW_REF !== `${identity.workflow}@${identity.sourceRef}`
  ) {
    throw new Error(
      `Release manifest creation requires protected ${identity.sourceRef} in ${identity.repository}; environment identity did not match`,
    );
  }
}

function extract(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    throw new Error(`Unable to inspect release artifact with ${command}: ${args.at(-1) ?? ""}`);
  }
}

export function inspectNpmArtifact(file) {
  const metadata = JSON.parse(extract("tar", ["-xOf", file, "package/package.json"]));
  return { name: metadata.name, version: metadata.version };
}

export function inspectVsixArtifact(file) {
  const metadata = JSON.parse(extract("unzip", ["-p", file, "extension/package.json"]));
  const manifest = extract("unzip", ["-p", file, "extension.vsixmanifest"]);
  const target = manifest.match(/\bTargetPlatform="([^"]+)"/)?.[1];
  return {
    extensionId: `${metadata.publisher}.${metadata.name}`,
    publisher: metadata.publisher,
    name: metadata.name,
    version: metadata.version,
    target,
  };
}

export function assertReleaseIdentity(actual, expected) {
  const stable = (value) => JSON.stringify(value);
  if (
    actual?.version !== expected.version ||
    actual?.tag !== expected.tag ||
    actual?.sourceRef !== expected.sourceRef ||
    actual?.repository !== expected.repository ||
    actual?.workflow !== expected.workflow ||
    stable(actual?.npm) !== stable(expected.npm) ||
    stable(actual?.vscode) !== stable(expected.vscode) ||
    stable(actual?.docker) !== stable(expected.docker)
  ) {
    throw new Error("Release manifest tag/package/registry coordinates do not match the checked-out source");
  }
}

export function assertBenchmarkPackageArtifacts(benchmark, npmArtifacts) {
  const measured = benchmark?.packageArtifacts;
  if (!Array.isArray(measured) || measured.length !== 2 || npmArtifacts.length !== 2) {
    throw new Error("Benchmark evidence must identify exactly both measured npm tarballs");
  }
  const measuredNames = new Set(measured.map((item) => item.filename));
  if (measuredNames.size !== measured.length) {
    throw new Error("Benchmark evidence contains duplicate package artifact identities");
  }
  for (const artifact of npmArtifacts) {
    const expectedMeasurement =
      artifact.packageName === "@ragnarok/core"
        ? "coreTarballBytes"
        : artifact.packageName === "@ragnarok/mcp-server"
          ? "mcpTarballBytes"
          : "";
    const record = measured.find((item) => item.filename === path.basename(artifact.path));
    if (
      !expectedMeasurement ||
      record?.measurement !== expectedMeasurement ||
      record?.sha256 !== artifact.sha256 ||
      record?.size !== artifact.size ||
      benchmark.packageSizes?.[expectedMeasurement] !== artifact.size
    ) {
      throw new Error(`Benchmark package measurement is not bound to artifact: ${artifact.path}`);
    }
  }
}
