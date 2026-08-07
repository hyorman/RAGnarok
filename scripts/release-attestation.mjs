import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const RELEASE_REPOSITORY = "hyorman/ragnarok";
export const RELEASE_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/release.yml`;
export const RELEASE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const RELEASE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const DEFAULT_ATTESTATION_BUNDLE = "release-manifest.attestation.jsonl";

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

export function buildAttestationVerificationArgs({
  manifestPath,
  bundlePath,
  repository,
  workflow,
  sourceSha,
  sourceRef,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("Attestation source SHA is invalid");
  if (!/^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(sourceRef ?? "")) {
    throw new Error("Attestation source ref must be a version tag");
  }
  if (repository !== RELEASE_REPOSITORY || workflow !== RELEASE_WORKFLOW) {
    throw new Error("Attestation repository/workflow identity is not approved");
  }
  return [
    "attestation",
    "verify",
    manifestPath,
    "--bundle",
    bundlePath,
    "--repo",
    repository,
    "--signer-workflow",
    workflow,
    "--signer-digest",
    sourceSha,
    "--source-digest",
    sourceSha,
    "--source-ref",
    sourceRef,
    "--cert-oidc-issuer",
    RELEASE_OIDC_ISSUER,
    "--predicate-type",
    RELEASE_PREDICATE_TYPE,
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ];
}

export async function verifyReleaseAttestation({
  manifestPath,
  bundlePath,
  repository,
  workflow,
  sourceSha,
  sourceRef,
  execute = execFileSync,
}) {
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedBundle = path.resolve(bundlePath);
  for (const [label, file] of [
    ["release manifest", resolvedManifest],
    ["release attestation bundle", resolvedBundle],
  ]) {
    const details = await stat(file).catch(() => null);
    if (!details?.isFile() || details.size < 1) throw new Error(`${label} is missing or empty: ${file}`);
  }
  const args = buildAttestationVerificationArgs({
    manifestPath: resolvedManifest,
    bundlePath: resolvedBundle,
    repository,
    workflow,
    sourceSha,
    sourceRef,
  });
  let output;
  try {
    output = execute("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(`Release manifest attestation verification failed${detail ? `: ${detail}` : ""}`);
  }
  let results;
  try {
    results = JSON.parse(String(output));
  } catch {
    throw new Error("GitHub attestation verification did not return valid JSON");
  }
  if (
    !Array.isArray(results) ||
    results.length < 1 ||
    results.some(
      (result) =>
        !result?.verificationResult?.signature?.certificate ||
        !Array.isArray(result?.verificationResult?.statement?.subject) ||
        result.verificationResult.statement.subject.length < 1,
    )
  ) {
    throw new Error("GitHub attestation verification returned no complete verified attestation");
  }
  const manifestBytes = await readFile(resolvedManifest);
  const expectedDigest = sha256(manifestBytes);
  if (
    !results.some((result) =>
      result.verificationResult.statement.subject.some((subject) => subject?.digest?.sha256 === expectedDigest),
    )
  ) {
    throw new Error("Verified attestation is not bound to the release manifest digest");
  }
  return {
    manifestSha256: expectedDigest,
    bundleSha256: sha256(await readFile(resolvedBundle)),
    verifiedAttestations: results.length,
  };
}
