# Release procedure

The release is deliverable only when the exact artifacts to be published have
passed their gates. Local success does not substitute for an unrun
platform-specific or container gate.

## Required inputs

- clean source commit and exact `package-lock.json`;
- Node versions and operating systems defined by the release workflow;
- bundled-model manifest, upstream revisions, licenses, and file digests;
- root/package NOTICE and third-party model notices;
- CycloneDX and SPDX SBOMs;
- `release-policy.json` budgets and audited baseline evidence;
- pinned benchmark manifest and benchmark result;
- six installed VSIX smoke results;
- Docker build/runtime/read-only-filesystem result;
- npm tarball smoke results;
- provenance attestation and final artifact digest manifest.

Graph delivery has three generated inputs that must be current: MCP's
self-contained TypeScript HTML bundle and VS Code's `media/memoryGraph.js` and
`media/memoryGraph.css`. The graph-ui `--check` build verifies all three.

## Gate sequence

1. Install with `npm ci` and run formatting, lint, compile, unit/integration,
   documentation, model-integrity, license, secret, and release-static checks.
2. Run native dependency checks on Linux, macOS, and Windows.
3. Run `npm run bench:release` on the audited benchmark runner.
4. Pack core and MCP with lifecycle scripts disabled, inspect contents, install
   them into clean consumers, and run their smoke tests.
5. Build the VSIX reproducibly. Install and activate it on Linux, macOS, and
   Windows for the minimum and current supported VS Code versions. Inspect each
   archive for `dist/extension.js`, `media/memoryGraph.js`, and
   `media/memoryGraph.css`; reject graph-ui source, MCP source/SDK/HTML, and any
   other graph-ui file.
6. Build the Docker image, start it with a read-only root filesystem, verify
   stdio discovery/tools, storage locking, removed-variable rejection, runtime
   hardening, graceful shutdown, and architecture. Graph-ui source is a build
   input only: the final image contains the compiled MCP bundle, not graph-ui
   source/dependencies or VS webview assets.
7. Generate SBOMs and NOTICE evidence from the exact artifact inputs.
8. Create the release manifest and SLSA-compatible provenance. Verify every
   artifact digest against that manifest.
9. Publish only those already-verified artifacts.

The workflow in `.github/workflows/release.yml` is the executable source for
the supported matrix. A failed, cancelled, skipped, or missing required job is
a release blocker.

The `npm audit` gates reject every moderate-or-higher advisory except
exact, unexpired entries in `release-policy.json`. They fail closed on unknown
findings, changed package names or ranges, malformed audit output, malformed
policy, and expired entries. Both evaluate the same policy through
`scripts/audit-policy.mjs`, so neither can pass a finding the other blocks:

- `npm run audit:policy` (`scripts/audit-gate.mjs`) audits the workspace's
  production dependencies. The `supply-chain` job runs it instead of a bare
  `npm audit --audit-level=moderate`, which has no way to express an approved
  advisory and so would fail on findings the policy has already accepted.
- `npm run test:pack` audits the clean consumer installed from the packed
  tarballs, then continues to packed core and MCP runtime checks.

Each gate prints every accepted finding with its advisory, dependency, and
range before continuing; an accepted finding is never silent.

## Artifact identity and budgets

`scripts/release-manifest.mjs` binds the protected version tag, source SHA,
root/core/MCP/VSIX versions, registry coordinates, lockfile digest, policy
digest, artifact digests, gate runs, and provenance predicate.
`release-manifest.attestation.jsonl` is the separately signed GitHub attestation
bundle for that manifest. The verifier cryptographically checks the bundle's
repository, signer workflow, source SHA, source tag, OIDC issuer, predicate
type, and manifest digest. A boolean environment flag is never attestation
evidence. `scripts/verify-artifact-digests.mjs` must succeed immediately before
publication. Do not rebuild, re-pack, rename without rehashing, or substitute
an artifact after verification.

Package, VSIX, Docker, native-binary, and benchmark budgets are read from
`release-policy.json`. A budget without measured audited evidence is a blocker,
not a pass. Update a budget only with an explicit reviewed baseline change.

## Publication fence

All package `publish` scripts delegate to `scripts/publish-release.mjs`.
Direct publication and `scripts/build-vsix.js --publish` are intentionally
refused. The publication command requires the release manifest, provenance,
successful required gates, exact artifact digests, a clean matching source
commit, and the cryptographically verified attestation bundle.

Never publish from a developer working tree or from artifacts rebuilt after CI.
Use the immutable artifacts downloaded from the successful release run.

Publication performs all credential, command, coordinate, and already-published
checks before mutation. Docker is first pushed to a disposable staging tag and
its registry digest must equal the OCI manifest digest before either the
immutable SHA tag or version tag is changed. Every completed channel is written
atomically to `release-publication-journal.json`, which CI preserves even when a
later channel fails.

GHCR, npm, and the VS Code Marketplace do not provide a cross-registry
transaction, so publication cannot be globally atomic. A later channel failure
can leave an earlier channel public. Resume only with the same signed manifest
and journal. Do not rebuild or reuse the version with different bytes; follow
the affected registry's withdrawal/deprecation procedure and attach the
journal to the incident record.

## Evidence status

Track each required gate as `passed`, `failed`, or `unrun` with its workflow
run, source SHA, platform, and artifact digest. Do not summarize `unrun` as
passing. In particular, Docker runtime and the six installed VSIX combinations
require environments that can actually execute those artifacts.

Release rollback is registry/marketplace-specific. Preserve the manifest,
provenance, attestation bundle, publication journal, SBOMs, notices, benchmark
result, smoke logs, and migration notes for every published version so a
withdrawn artifact remains attributable.
