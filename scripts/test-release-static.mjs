import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auditPolicyModule from "./audit-policy.mjs";
import { BENCHMARK_USER_AGENT, downloadWithRetry } from "./benchmark-download.mjs";
import * as releaseStaticPolicy from "./release-static-policy.mjs";
import { withContainerdSnapshotter } from "./use-containerd-image-store.mjs";

const { evaluateAuditReport, normalizeLocalTarballAuditRanges } = auditPolicyModule;
const { assertDevOnlyDependency } = releaseStaticPolicy;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (file) => readFile(path.join(root, file), "utf8");
const pkg = JSON.parse(await read("package.json"));
const policy = JSON.parse(await read("release-policy.json"));
const expectedAuditExceptions = [];
assert.deepEqual(policy.auditExceptions, expectedAuditExceptions);

const fixtureException = {
  advisory: "GHSA-1234-abcd-5678",
  dependency: "vulnerable-leaf",
  range: "<2.0.0",
  via: "fixture-parent@1.0.0",
  expires: "2026-08-31",
  owner: "release-maintainers",
  reason: "fixture",
  invalidatedBy: "fixture changes",
};
const auditPolicy = {
  auditExceptions: [fixtureException],
};
const installedTree = {
  name: "pack-smoke-consumer",
  version: "1.0.0",
  dependencies: {
    "fixture-parent": {
      version: "1.0.0",
      dependencies: {
        aggregate: {
          version: "1.0.0",
          dependencies: {
            "vulnerable-leaf": { version: "1.0.0" },
          },
        },
      },
    },
  },
};
const auditMetadataFor = (vulnerabilities) => {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const vulnerability of Object.values(vulnerabilities)) {
    counts[vulnerability.severity]++;
    counts.total++;
  }
  return { vulnerabilities: counts };
};
const completeAuditReport = (vulnerabilities) => {
  const completeVulnerabilities = Object.fromEntries(
    Object.entries(vulnerabilities).map(([name, vulnerability]) => [
      name,
      {
        name,
        severity: "high",
        isDirect: false,
        via: [],
        effects: [],
        range: "*",
        nodes: [`node_modules/${name}`],
        fixAvailable: false,
        ...vulnerability,
      },
    ]),
  );
  return {
    auditReportVersion: 2,
    vulnerabilities: completeVulnerabilities,
    metadata: auditMetadataFor(completeVulnerabilities),
  };
};
const refreshAuditMetadata = (report) => {
  report.metadata = auditMetadataFor(report.vulnerabilities);
  return report;
};
const cleanAuditReport = completeAuditReport({});
const auditReport = (url = "https://github.com/advisories/GHSA-1234-abcd-5678", range = "<2.0.0") =>
  completeAuditReport({
    "vulnerable-leaf": {
      via: [{ url, dependency: "vulnerable-leaf", range, severity: "high" }],
      range,
    },
    aggregate: { via: ["vulnerable-leaf"], effects: ["fixture-parent"] },
    "fixture-parent": { isDirect: true, via: ["aggregate"] },
  });
const auditNow = new Date("2026-07-30T00:00:00Z");
const malformedPolicyEvaluation = {
  allowed: [],
  rejected: [{ dependency: "<audit-policy>", reason: "Malformed audit policy" }],
};
assert.deepEqual(evaluateAuditReport(cleanAuditReport, auditPolicy, auditNow), {
  allowed: [],
  rejected: [],
});
assert.deepEqual(evaluateAuditReport(auditReport(), auditPolicy, auditNow, installedTree), {
  allowed: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "fixture",
    },
  ],
  rejected: [],
});

const productionAuditReport = completeAuditReport({
  "@hono/node-server": {
    severity: "high",
    via: [
      {
        url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
        dependency: "@hono/node-server",
        range: "<2.0.5",
        severity: "high",
      },
    ],
    effects: ["@modelcontextprotocol/node"],
    range: "<2.0.5",
  },
  "@modelcontextprotocol/node": {
    isDirect: true,
    via: ["@hono/node-server"],
  },
  "@ragnarok/mcp-server": {
    isDirect: true,
    via: ["@modelcontextprotocol/node"],
  },
  sharp: {
    via: [
      {
        url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
        dependency: "sharp",
        range: "<0.35.0",
        severity: "high",
      },
    ],
    effects: ["@huggingface/transformers"],
    range: "<0.35.0",
  },
  "@huggingface/transformers": {
    isDirect: true,
    via: ["sharp"],
  },
  "@ragnarok/core": {
    isDirect: true,
    via: ["@huggingface/transformers"],
  },
});
const productionInstalledTree = {
  name: "pack-smoke-consumer",
  version: "1.0.0",
  dependencies: {
    "@ragnarok/mcp-server": {
      version: "0.5.0",
      dependencies: {
        "@modelcontextprotocol/node": {
          version: "2.0.0",
          dependencies: { "@hono/node-server": { version: "1.19.9" } },
        },
        "@ragnarok/core": {
          version: "0.5.0",
          dependencies: {
            "@huggingface/transformers": {
              version: "3.8.1",
              dependencies: { sharp: { version: "0.34.5" } },
            },
          },
        },
      },
    },
  },
};
// The repository has no audit exceptions, so the findings that used to be excepted are rejected.
const retiredFindingsRejected = [
  { advisory: "GHSA-frvp-7c67-39w9", dependency: "@hono/node-server", range: "<2.0.5" },
  { advisory: "GHSA-f88m-g3jw-g9cj", dependency: "sharp", range: "<0.35.0" },
].map((finding) => ({ ...finding, reason: "No exact audit exception" }));
assert.deepEqual(evaluateAuditReport(productionAuditReport, policy, auditNow, productionInstalledTree), {
  allowed: [],
  rejected: retiredFindingsRejected,
});
// The two exceptions this repository carried until 0.4.1, as a fixture policy: with an exception
// in force, evaluation reaches the installed tree and must find the approved via version there.
const historicExceptionsPolicy = {
  auditExceptions: [
    {
      ...fixtureException,
      advisory: "GHSA-frvp-7c67-39w9",
      dependency: "@hono/node-server",
      range: "<2.0.5",
      via: "@modelcontextprotocol/node@2.0.0",
      reason: "fixture: MCP Node never imports Hono serve-static",
    },
    {
      ...fixtureException,
      advisory: "GHSA-f88m-g3jw-g9cj",
      dependency: "sharp",
      range: "<0.35.0",
      via: "@huggingface/transformers@3.8.1",
      reason: "fixture: no image input reaches Sharp",
    },
  ],
};
const historicAllowed = historicExceptionsPolicy.auditExceptions.map(({ advisory, dependency, range, reason }) => ({
  advisory,
  dependency,
  range,
  reason,
}));
assert.deepEqual(
  evaluateAuditReport(productionAuditReport, historicExceptionsPolicy, auditNow, productionInstalledTree),
  { allowed: historicAllowed, rejected: [] },
  "with each approved via version installed, both historic exceptions apply",
);
/** A copy of `tree` with every installed `name`, wherever it sits, at `version`. */
function withInstalledVersion(tree, name, version) {
  const copy = structuredClone(tree);
  let found = 0;
  const visit = (node) => {
    for (const [dependencyName, dependency] of Object.entries(node.dependencies ?? {})) {
      if (dependencyName === name) {
        dependency.version = version;
        found += 1;
      }
      visit(dependency);
    }
  };
  visit(copy);
  assert.ok(found > 0, `${name} is not in the fixture tree`);
  return copy;
}
const sharpExceptionVoided = {
  allowed: [historicAllowed[0]],
  rejected: [
    {
      advisory: "GHSA-f88m-g3jw-g9cj",
      dependency: "sharp",
      range: "<0.35.0",
      reason: "Approved via version is not installed",
    },
  ],
};
const upgradedViaTree = withInstalledVersion(productionInstalledTree, "@huggingface/transformers", "3.8.2");
assert.deepEqual(
  evaluateAuditReport(productionAuditReport, historicExceptionsPolicy, auditNow, upgradedViaTree),
  sharpExceptionVoided,
  "an upgraded via package voids the exception approved for its old version",
);
// The approved version must be installed as the via package itself: another package at that version proves nothing.
const viaVersionElsewhereTree = structuredClone(upgradedViaTree);
viaVersionElsewhereTree.dependencies["unrelated-package"] = { version: "3.8.1" };
assert.deepEqual(
  evaluateAuditReport(productionAuditReport, historicExceptionsPolicy, auditNow, viaVersionElsewhereTree),
  sharpExceptionVoided,
  "a via version installed under another package's name does not satisfy the exception",
);
// Without an installed tree no approved via version can be confirmed, so no exception applies.
assert.deepEqual(
  evaluateAuditReport(productionAuditReport, historicExceptionsPolicy, auditNow, undefined),
  {
    allowed: [],
    rejected: historicExceptionsPolicy.auditExceptions.map(({ advisory, dependency, range }) => ({
      advisory,
      dependency,
      range,
      reason: "Approved via version is not installed",
    })),
  },
  "an evaluation without an installed tree confirms no exception",
);

const localTarballAuditReport = structuredClone(productionAuditReport);
localTarballAuditReport.vulnerabilities["@ragnarok/core"].range = "";
localTarballAuditReport.vulnerabilities["@ragnarok/mcp-server"].range = "";
const localTarballVersions = {
  "@ragnarok/core": "0.5.0",
  "@ragnarok/mcp-server": "0.5.0",
};
assert.deepEqual(
  evaluateAuditReport(localTarballAuditReport, policy, auditNow, productionInstalledTree),
  {
    allowed: [],
    rejected: [{ dependency: "<audit-report>", reason: "Malformed npm audit report" }],
  },
  "raw npm local-tarball roots must not weaken audit node validation",
);
const normalizedLocalTarballReport = normalizeLocalTarballAuditRanges(localTarballAuditReport, localTarballVersions);
assert.deepEqual(
  ["@ragnarok/core", "@ragnarok/mcp-server"].map((name) => normalizedLocalTarballReport.vulnerabilities[name].range),
  ["0.5.0", "0.5.0"],
  "known direct local-tarball roots take their installed version as their audit range",
);
assert.deepEqual(
  evaluateAuditReport(normalizedLocalTarballReport, policy, auditNow, productionInstalledTree),
  { allowed: [], rejected: retiredFindingsRejected },
  "a normalized local-tarball report is well formed; with no exceptions every finding is rejected",
);
assert.deepEqual(
  evaluateAuditReport(normalizedLocalTarballReport, historicExceptionsPolicy, auditNow, productionInstalledTree),
  { allowed: historicAllowed, rejected: [] },
  "a normalized local-tarball report is evaluated against the installed tree",
);
for (const [name, mutate] of [
  ["unknown package", (report) => (report.vulnerabilities["@ragnarok/core"].name = "unknown-package")],
  ["indirect package", (report) => (report.vulnerabilities["@ragnarok/core"].isDirect = false)],
  ["unexpected node path", (report) => (report.vulnerabilities["@ragnarok/core"].nodes = ["node_modules/other"])],
]) {
  const report = structuredClone(localTarballAuditReport);
  report.vulnerabilities["@ragnarok/mcp-server"].range = "*";
  mutate(report);
  assert.deepEqual(
    normalizeLocalTarballAuditRanges(report, localTarballVersions),
    report,
    `local audit range normalization must ignore ${name}`,
  );
}
const populatedLocalRangeReport = structuredClone(localTarballAuditReport);
populatedLocalRangeReport.vulnerabilities["@ragnarok/core"].range = "*";
assert.equal(
  normalizeLocalTarballAuditRanges(populatedLocalRangeReport, localTarballVersions).vulnerabilities["@ragnarok/core"]
    .range,
  "*",
  "local audit range normalization must preserve npm-provided ranges",
);

const missingApprovedPathReport = structuredClone(auditReport());
delete missingApprovedPathReport.vulnerabilities["fixture-parent"];
refreshAuditMetadata(missingApprovedPathReport);
assert.deepEqual(evaluateAuditReport(missingApprovedPathReport, auditPolicy, auditNow, installedTree), {
  allowed: [],
  rejected: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "Approved via package is not in advisory chain",
    },
  ],
});
const wrongInstalledVersionTree = structuredClone(installedTree);
wrongInstalledVersionTree.dependencies["fixture-parent"].version = "1.0.1";
assert.deepEqual(evaluateAuditReport(auditReport(), auditPolicy, auditNow, wrongInstalledVersionTree), {
  allowed: [],
  rejected: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "Approved via version is not installed",
    },
  ],
});
const mixedInstalledVersionTree = structuredClone(installedTree);
mixedInstalledVersionTree.dependencies["other-consumer"] = {
  version: "1.0.0",
  dependencies: { "fixture-parent": { version: "1.0.1" } },
};
assert.deepEqual(evaluateAuditReport(auditReport(), auditPolicy, auditNow, mixedInstalledVersionTree), {
  allowed: [],
  rejected: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "Approved via version is not installed",
    },
  ],
});
assert.deepEqual(
  evaluateAuditReport(auditReport(), auditPolicy, auditNow, {
    name: "pack-smoke-consumer",
    version: "1.0.0",
    dependencies: {},
  }),
  {
    allowed: [],
    rejected: [
      {
        advisory: "GHSA-1234-abcd-5678",
        dependency: "vulnerable-leaf",
        range: "<2.0.0",
        reason: "Approved via version is not installed",
      },
    ],
  },
);

assert.deepEqual(
  evaluateAuditReport(auditReport("https://github.com/advisories/GHSA-zzzz-yyyy-xxxx"), auditPolicy, auditNow),
  {
    allowed: [],
    rejected: [
      {
        advisory: "GHSA-zzzz-yyyy-xxxx",
        dependency: "vulnerable-leaf",
        range: "<2.0.0",
        reason: "No exact audit exception",
      },
    ],
  },
);
assert.deepEqual(evaluateAuditReport(auditReport(undefined, "<3.0.0"), auditPolicy, auditNow), {
  allowed: [],
  rejected: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<3.0.0",
      reason: "No exact audit exception",
    },
  ],
});
assert.deepEqual(evaluateAuditReport(auditReport(), auditPolicy, new Date("2026-09-01T00:00:00Z")), {
  allowed: [],
  rejected: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "Audit exception expired",
    },
  ],
});

const requiredAuditMetadata = ["advisory", "dependency", "range", "via", "reason", "invalidatedBy", "owner", "expires"];
const invalidAuditRanges = [
  "x",
  "X",
  "1.x",
  "1.X",
  "1.*",
  ">=1.x",
  "<1.0.0 || 2.X",
  "1",
  "1.2",
  "~1",
  "^1.2",
  "1.2.x+meta",
  "not-semver",
  ">=1.0.0 <2.0.0",
];
const malformedGhsaException = { ...fixtureException, advisory: "GHSA-a" };
const malformedViaVersionException = { ...fixtureException, via: "fixture-parent@1x0x0" };
assert.deepEqual(
  {
    malformedGhsa: evaluateAuditReport(cleanAuditReport, { auditExceptions: [malformedGhsaException] }, auditNow),
    malformedViaVersion: evaluateAuditReport(
      cleanAuditReport,
      { auditExceptions: [malformedViaVersionException] },
      auditNow,
    ),
    malformedGhsaReportAndPolicy: evaluateAuditReport(
      auditReport("https://github.com/advisories/GHSA-a"),
      { auditExceptions: [malformedGhsaException] },
      auditNow,
    ),
    whitespaceMetadata: Object.fromEntries(
      requiredAuditMetadata.map((field) => [
        field,
        evaluateAuditReport(
          cleanAuditReport,
          { auditExceptions: [{ ...fixtureException, [field]: " \t " }] },
          auditNow,
        ),
      ]),
    ),
    invalidPolicyRanges: Object.fromEntries(
      invalidAuditRanges.map((range) => [
        range,
        evaluateAuditReport(cleanAuditReport, { auditExceptions: [{ ...fixtureException, range }] }, auditNow),
      ]),
    ),
    invalidReportRanges: Object.fromEntries(
      invalidAuditRanges.map((range) => [
        range,
        evaluateAuditReport(auditReport(undefined, range), auditPolicy, auditNow),
      ]),
    ),
  },
  {
    malformedGhsa: malformedPolicyEvaluation,
    malformedViaVersion: malformedPolicyEvaluation,
    malformedGhsaReportAndPolicy: malformedPolicyEvaluation,
    whitespaceMetadata: Object.fromEntries(requiredAuditMetadata.map((field) => [field, malformedPolicyEvaluation])),
    invalidPolicyRanges: Object.fromEntries(invalidAuditRanges.map((range) => [range, malformedPolicyEvaluation])),
    invalidReportRanges: Object.fromEntries(
      invalidAuditRanges.map((range) => [
        range,
        {
          allowed: [],
          rejected: [{ dependency: "vulnerable-leaf", reason: "Malformed advisory source" }],
        },
      ]),
    ),
  },
);

const prereleaseException = { ...fixtureException, range: ">=1.2.3-alpha.1" };
assert.deepEqual(
  evaluateAuditReport(
    auditReport(undefined, prereleaseException.range),
    { auditExceptions: [prereleaseException] },
    auditNow,
    installedTree,
  ),
  {
    allowed: [
      {
        advisory: "GHSA-1234-abcd-5678",
        dependency: "vulnerable-leaf",
        range: ">=1.2.3-alpha.1",
        reason: "fixture",
      },
    ],
    rejected: [],
  },
);

assert.deepEqual(
  evaluateAuditReport(cleanAuditReport, { auditExceptions: [fixtureException, { ...fixtureException }] }, auditNow),
  { allowed: [], rejected: [{ dependency: "<audit-policy>", reason: "Duplicate audit exception" }] },
);
assert.deepEqual(
  evaluateAuditReport(
    cleanAuditReport,
    { auditExceptions: [{ ...fixtureException, expires: "2026-02-30" }] },
    auditNow,
  ),
  malformedPolicyEvaluation,
);
assert.deepEqual(evaluateAuditReport(cleanAuditReport, auditPolicy, new Date("invalid")), {
  allowed: [],
  rejected: [{ dependency: "<audit-policy>", reason: "Malformed evaluation date" }],
});
assert.deepEqual(evaluateAuditReport({}, auditPolicy, auditNow), {
  allowed: [],
  rejected: [{ dependency: "<audit-report>", reason: "Malformed npm audit report" }],
});
const malformedAuditReportEvaluation = {
  allowed: [],
  rejected: [{ dependency: "<audit-report>", reason: "Malformed npm audit report" }],
};
for (const [name, malformedReport] of Object.entries({
  truncated: { auditReportVersion: 2, vulnerabilities: {} },
  missingCount: {
    ...cleanAuditReport,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  },
  malformedCount: {
    ...cleanAuditReport,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: 0 },
    },
  },
  fractionalCount: {
    ...cleanAuditReport,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0.5, critical: 0, total: 0.5 },
    },
  },
  severitySumMismatch: {
    ...cleanAuditReport,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 },
    },
  },
  vulnerabilityCountMismatch: {
    ...auditReport(),
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
    },
  },
  severityCountMismatch: {
    ...auditReport(),
    metadata: {
      vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 0, total: 3 },
    },
  },
})) {
  assert.deepEqual(evaluateAuditReport(malformedReport, auditPolicy, auditNow), malformedAuditReportEvaluation, name);
}

const malformedVulnerabilityNodeCases = [
  ["missing name", (node) => delete node.name],
  ["blank name", (node) => (node.name = " \t ")],
  ["wrong-type name", (node) => (node.name = 42)],
  ["mismatched name", (node) => (node.name = "another-package")],
  ["missing severity", (node) => delete node.severity],
  ["unknown severity", (node) => (node.severity = "urgent")],
  ["wrong-type severity", (node) => (node.severity = 3)],
  ["missing isDirect", (node) => delete node.isDirect],
  ["wrong-type isDirect", (node) => (node.isDirect = "false")],
  ["missing via", (node) => delete node.via],
  ["wrong-type via", (node) => (node.via = {})],
  ["missing effects", (node) => delete node.effects],
  ["wrong-type effects", (node) => (node.effects = "fixture-parent")],
  ["blank effect", (node) => (node.effects = [" "])],
  ["wrong-type effect", (node) => (node.effects = [42])],
  ["missing range", (node) => delete node.range],
  ["blank range", (node) => (node.range = " \t ")],
  ["wrong-type range", (node) => (node.range = 42)],
  ["missing nodes", (node) => delete node.nodes],
  ["wrong-type nodes", (node) => (node.nodes = "node_modules/vulnerable-leaf")],
  ["blank installed node", (node) => (node.nodes = [" "])],
  ["wrong-type installed node", (node) => (node.nodes = [42])],
  ["missing fixAvailable", (node) => delete node.fixAvailable],
  ["wrong-type fixAvailable", (node) => (node.fixAvailable = "false")],
  ["null fixAvailable", (node) => (node.fixAvailable = null)],
  ["fix object missing name", (node) => (node.fixAvailable = { version: "2.0.0", isSemVerMajor: true })],
  ["fix object blank name", (node) => (node.fixAvailable = { name: " ", version: "2.0.0", isSemVerMajor: true })],
  ["fix object wrong-type name", (node) => (node.fixAvailable = { name: 42, version: "2.0.0", isSemVerMajor: true })],
  ["fix object missing version", (node) => (node.fixAvailable = { name: "vulnerable-leaf", isSemVerMajor: true })],
  [
    "fix object blank version",
    (node) => (node.fixAvailable = { name: "vulnerable-leaf", version: " ", isSemVerMajor: true }),
  ],
  [
    "fix object wrong-type version",
    (node) => (node.fixAvailable = { name: "vulnerable-leaf", version: 2, isSemVerMajor: true }),
  ],
  ["fix object missing isSemVerMajor", (node) => (node.fixAvailable = { name: "vulnerable-leaf", version: "2.0.0" })],
  [
    "fix object wrong-type isSemVerMajor",
    (node) => (node.fixAvailable = { name: "vulnerable-leaf", version: "2.0.0", isSemVerMajor: "true" }),
  ],
  [
    "fix object unknown field",
    (node) => (node.fixAvailable = { name: "vulnerable-leaf", version: "2.0.0", isSemVerMajor: true, force: true }),
  ],
];
for (const [name, mutate] of malformedVulnerabilityNodeCases) {
  const malformedReport = auditReport();
  mutate(malformedReport.vulnerabilities["vulnerable-leaf"]);
  assert.deepEqual(evaluateAuditReport(malformedReport, auditPolicy, auditNow), malformedAuditReportEvaluation, name);
}
const objectFixAuditReport = auditReport();
objectFixAuditReport.vulnerabilities["vulnerable-leaf"].fixAvailable = {
  name: "vulnerable-leaf",
  version: "2.0.0",
  isSemVerMajor: true,
};
assert.deepEqual(evaluateAuditReport(objectFixAuditReport, auditPolicy, auditNow, installedTree), {
  allowed: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "fixture",
    },
  ],
  rejected: [],
});

const missingViaReferenceReport = completeAuditReport({
  aggregate: { name: "aggregate", severity: "high", via: ["missing-leaf"] },
});
assert.deepEqual(evaluateAuditReport(missingViaReferenceReport, auditPolicy, auditNow), {
  allowed: [],
  rejected: [{ dependency: "missing-leaf", reason: "Missing vulnerability reference" }],
});

const malformedViaCases = [
  {
    name: "malformed GHSA URL",
    via: [
      {
        url: "https://github.com/advisories/GHSA-a",
        dependency: "vulnerable-leaf",
        range: "<2.0.0",
      },
    ],
    reason: "Malformed advisory source",
  },
  {
    name: "whitespace dependency",
    via: [
      {
        url: "https://github.com/advisories/GHSA-1234-abcd-5678",
        dependency: " \t ",
        range: "<2.0.0",
      },
    ],
    reason: "Malformed advisory source",
  },
  {
    name: "whitespace range",
    via: [
      {
        url: "https://github.com/advisories/GHSA-1234-abcd-5678",
        dependency: "vulnerable-leaf",
        range: " \t ",
      },
    ],
    reason: "Malformed advisory source",
  },
  { name: "whitespace reference", via: [" \t "], reason: "Malformed vulnerability reference" },
  { name: "primitive reference", via: [42], reason: "Malformed vulnerability reference" },
  { name: "null reference", via: [null], reason: "Malformed vulnerability reference" },
];
for (const malformedVia of malformedViaCases) {
  const malformedReport = completeAuditReport({
    "vulnerable-leaf": { name: "vulnerable-leaf", severity: "high", via: malformedVia.via },
  });
  assert.deepEqual(
    evaluateAuditReport(malformedReport, auditPolicy, auditNow),
    {
      allowed: [],
      rejected: [{ dependency: "vulnerable-leaf", reason: malformedVia.reason }],
    },
    malformedVia.name,
  );
}

const malformedLowSeverityReport = completeAuditReport({
  "low-parent": { name: "low-parent", severity: "low", via: [42] },
});
assert.deepEqual(evaluateAuditReport(malformedLowSeverityReport, auditPolicy, auditNow, installedTree), {
  allowed: [],
  rejected: [{ dependency: "low-parent", reason: "Malformed vulnerability reference" }],
});

const advisoryUnderLowParent = completeAuditReport({
  "fixture-parent": {
    name: "fixture-parent",
    severity: "low",
    via: [
      {
        url: "https://github.com/advisories/GHSA-1234-abcd-5678",
        dependency: "vulnerable-leaf",
        range: "<2.0.0",
        severity: "critical",
      },
    ],
  },
});
assert.deepEqual(evaluateAuditReport(advisoryUnderLowParent, auditPolicy, auditNow, installedTree), {
  allowed: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "fixture",
    },
  ],
  rejected: [],
});

const legitimateLowOnlyReport = structuredClone(advisoryUnderLowParent);
legitimateLowOnlyReport.vulnerabilities["fixture-parent"].via[0].severity = "low";
assert.deepEqual(evaluateAuditReport(legitimateLowOnlyReport, auditPolicy, auditNow, installedTree), {
  allowed: [],
  rejected: [],
});
const lowWithoutAdvisoryReport = completeAuditReport({
  "low-empty": { name: "low-empty", severity: "low", via: [] },
});
assert.deepEqual(evaluateAuditReport(lowWithoutAdvisoryReport, auditPolicy, auditNow, installedTree), {
  allowed: [],
  rejected: [{ dependency: "low-empty", reason: "No advisory source" }],
});
const lowMissingReferenceReport = completeAuditReport({
  "low-parent": { name: "low-parent", severity: "low", via: ["missing-low-leaf"] },
});
assert.deepEqual(evaluateAuditReport(lowMissingReferenceReport, auditPolicy, auditNow, installedTree), {
  allowed: [],
  rejected: [{ dependency: "missing-low-leaf", reason: "Missing vulnerability reference" }],
});

const cyclicAuditReport = completeAuditReport({
  a: { name: "a", severity: "high", via: ["b"] },
  b: { name: "b", severity: "high", via: ["a"] },
});
assert.deepEqual(evaluateAuditReport(cyclicAuditReport, auditPolicy, auditNow), {
  allowed: [],
  rejected: [
    { dependency: "a", reason: "Cyclic vulnerability graph" },
    { dependency: "b", reason: "Cyclic vulnerability graph" },
  ],
});

const mixedCyclicAuditReport = auditReport();
mixedCyclicAuditReport.vulnerabilities.aggregate.via.push("cyclic-branch");
mixedCyclicAuditReport.vulnerabilities["cyclic-branch"] = completeAuditReport({
  "cyclic-branch": { via: ["aggregate"] },
}).vulnerabilities["cyclic-branch"];
refreshAuditMetadata(mixedCyclicAuditReport);
const mixedCyclicEvaluation = evaluateAuditReport(mixedCyclicAuditReport, auditPolicy, auditNow, installedTree);
assert.deepEqual(mixedCyclicEvaluation, {
  allowed: [
    {
      advisory: "GHSA-1234-abcd-5678",
      dependency: "vulnerable-leaf",
      range: "<2.0.0",
      reason: "fixture",
    },
  ],
  rejected: [
    { dependency: "aggregate", reason: "Cyclic vulnerability graph" },
    { dependency: "cyclic-branch", reason: "Cyclic vulnerability graph" },
  ],
});

const packSmoke = await read("scripts/pack-smoke.mjs");
assert.match(packSmoke, /spawnSync\("npm", \["audit", "--omit=dev", "--json"\]/);
assert.match(packSmoke, /const localRoots = \["@ragnarok\/core", "@ragnarok\/mcp-server"\];/);
assert.match(packSmoke, /new Set\(\[\s*\.\.\.localRoots,/);
assert.match(packSmoke, /spawnSync\("npm", \["ls", \.\.\.auditViaPackages, "--omit=dev", "--all", "--json"\]/);
assert.match(packSmoke, /normalizeLocalTarballAuditRanges\(auditReport, localTarballVersions\)/);
assert.match(packSmoke, /evaluateAuditReport\(normalizedAuditReport, releasePolicy, new Date\(\), installedTree\)/);
assert.match(packSmoke, /auditRun\.error/);
assert.match(packSmoke, /auditRun\.signal/);
assert.match(packSmoke, /!\[0, 1\]\.includes\(auditRun\.status\)/);
assert.match(packSmoke, /Allowed until policy expiry:/);
assert.doesNotMatch(packSmoke, /npm audit --omit=dev --audit-level=moderate/);
// Every @langchain/community release declares @huggingface/transformers ^3.8.1 as an optional
// peer while the tree carries 4.x. The root override lets that edge accept the installed version,
// so `npm ls` through Transformers (which both audit gates run for an exception approved via
// Transformers, and vsce runs in VSIX staging) does not exit 1.
assert.equal(pkg.overrides["@langchain/community"]["@huggingface/transformers"], "$@huggingface/transformers");
/** npm's result, run from the repository root. npm that cannot start, or is killed, fails here with the reason. */
function npmSync(args, options = {}) {
  const run = spawnSync("npm", args, { cwd: root, encoding: "utf8", ...options });
  if (run.error) throw new Error(`npm ${args.join(" ")} could not start: ${run.error.message}`, { cause: run.error });
  if (run.signal) throw new Error(`npm ${args.join(" ")} was killed by ${run.signal}`);
  return run;
}
// npm that cannot start (no npm on PATH) must fail with that reason, not a TypeError on a missing stderr.
const pathWithoutNpm = await mkdtemp(path.join(os.tmpdir(), "ragnarok-no-npm-"));
try {
  assert.throws(
    () => npmSync(["--version"], { env: { ...process.env, PATH: pathWithoutNpm } }),
    /npm --version could not start: spawnSync npm ENOENT/,
  );
} finally {
  await rm(pathWithoutNpm, { recursive: true, force: true });
}
// vsce's `npm list` in VSIX staging fails on any invalid optional peer of @langchain/community the tree
// installs, not only Transformers, so `npm ls` covers each of them.
const lockForPeers = JSON.parse(await read("package-lock.json"));
const communityPeerMeta = lockForPeers.packages["node_modules/@langchain/community"].peerDependenciesMeta ?? {};
const installedCommunityOptionalPeers = Object.entries(communityPeerMeta)
  .filter(([name, meta]) => meta.optional && lockForPeers.packages[`node_modules/${name}`])
  .map(([name]) => name)
  .sort();
assert.deepEqual(
  installedCommunityOptionalPeers,
  ["@huggingface/transformers", "@lancedb/lancedb", "cheerio", "ignore", "pdf-parse"],
  "the installed optional peers of @langchain/community changed: confirm npm ls still covers each",
);
const optionalPeersLs = npmSync(["ls", ...installedCommunityOptionalPeers, "--omit=dev", "--all", "--json"]);
assert.equal(
  optionalPeersLs.status,
  0,
  `npm ls of @langchain/community's installed optional peers must be valid: ${optionalPeersLs.stderr.trim()}`,
);
assert.match(
  packSmoke,
  /overrides: \{\s*"@langchain\/community": \{ "@huggingface\/transformers": coreTransformers \}/,
  "the pack-smoke consumer must carry the root's Transformers peer override",
);
// JSON.stringify drops an undefined value, so a missing core dependency would silently become `{}`.
assert.match(
  packSmoke,
  /const coreTransformers = coreManifest\.dependencies\?\.\["@huggingface\/transformers"\];\s*if \(!coreTransformers\) \{\s*fail\(/,
  "pack-smoke must refuse a core manifest without its Transformers dependency",
);
assert.match(packSmoke, /proc\.stdin\.end\(\)/, "packed stdio smoke must request graceful EOF shutdown");
assert.match(
  packSmoke,
  /stderr = \(stderr \+ chunk\.toString\(\)\)\.slice\(-64 \* 1024\)/,
  "packed stdio smoke must retain the final stderr tail",
);
assert.doesNotMatch(
  packSmoke,
  /stderr\.length < 64 \* 1024/,
  "packed stdio smoke must not retain only the first stderr bytes",
);
assert.match(packSmoke, /const gracefulClose = waitForChildClose\(/, "packed stdio smoke must arm a close timeout");
assert.match(
  packSmoke,
  /const childClose = observeChildClose\(proc\)/,
  "packed stdio smoke must observe close at spawn",
);
assert.match(packSmoke, /child\.once\("close"/, "packed stdio smoke must await the close event after stdio drains");
assert.doesNotMatch(
  packSmoke,
  /child\.exitCode !== null|child\.signalCode !== null/,
  "packed stdio smoke must not treat exit as equivalent to drained stdio",
);
assert.match(packSmoke, /exit = await gracefulClose/, "packed stdio smoke must await child close");
assert.match(packSmoke, /code !== 0/, "packed stdio smoke must reject a nonzero child exit");
assert.match(
  packSmoke,
  /SIGABRT\|mutex lock failed\|libc\\\+\\\+abi/,
  "packed stdio smoke must reject native abort traces",
);
const securityDocumentation = await read("docs/SECURITY.md");
for (const exception of policy.auditExceptions) {
  for (const field of ["advisory", "dependency", "range", "via", "reason", "invalidatedBy", "expires", "owner"]) {
    assert.ok(
      securityDocumentation.includes(exception[field]),
      `Security documentation must include audit exception ${field}: ${exception.advisory}`,
    );
  }
}
const releaseDocumentation = await read("docs/RELEASE.md");
assert.match(releaseDocumentation, /moderate-or-higher/);
assert.match(releaseDocumentation, /exact, unexpired entries in `release-policy\.json`/);
assert.match(releaseDocumentation, /prints every accepted\s+finding/);
for (const [runtimeDependency, version] of Object.entries({ "adm-zip": "0.6.1", yazl: "3.3.1" })) {
  assert.equal(
    pkg.dependencies[runtimeDependency],
    version,
    `Externalized VSIX archive dependency must use the audited exact version: ${runtimeDependency}`,
  );
}
for (const obsoleteDependency of ["archiver", "glob"]) {
  assert.equal(
    pkg.dependencies[obsoleteDependency],
    undefined,
    `Obsolete VSIX archive dependency must be absent: ${obsoleteDependency}`,
  );
}
assert.equal(pkg.devDependencies.glob, "10.5.0", "Root test Glob dependency must use the audited exact version");
assert.equal(pkg.devDependencies["@types/glob"], undefined, "Glob's bundled types must be used directly");
for (const runtimeDependency of ["binary-extensions"]) {
  assert.ok(
    pkg.dependencies[runtimeDependency],
    `Externalized VSIX runtime dependency must be declared: ${runtimeDependency}`,
  );
}
assert.equal(pkg.engines.vscode.replace(/^\D+/, ""), policy.minimumVscodeVersion);
assert.deepEqual(
  Object.keys(pkg.scripts)
    .filter((name) => /^package:(?:win32|darwin|linux)-/.test(name))
    .sort(),
  policy.vsixTargets.map((target) => `package:${target}`).sort(),
);
// darwin-x64 is not shipped: ONNX Runtime no longer publishes macOS x64 binaries.
// Every list of VSIX targets must match these five exactly.
const supportedVsixTargets = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
assert.deepEqual([...policy.vsixTargets].sort(), supportedVsixTargets);
assert.deepEqual(
  Object.keys(pkg.scripts)
    .filter((name) => /^publish:(?:win32|darwin|linux)-/.test(name))
    .sort(),
  supportedVsixTargets.map((target) => `publish:${target}`),
);
assert.deepEqual(
  [...pkg.scripts.package.matchAll(/npm run package:([a-z0-9-]+)/g)].map((match) => match[1]).sort(),
  supportedVsixTargets,
);
assert.deepEqual(
  Object.keys(pkg.optionalDependencies).filter((name) => name.includes("darwin-x64")),
  [],
  "No darwin-x64 native package may be installed for a VSIX",
);
assert.ok(policy.dependencyExceptions.some((item) => item.package === "@langchain/community"));
for (const [name, evidence] of Object.entries(policy.budgetEvidence)) {
  assert.equal(evidence.measured, true, `Release size budget must have measured evidence: ${name}`);
}
// Artifact sizes move with Transformers (its natives, ONNX Runtime and Sharp ship inside them):
// evidence measured on another Transformers version is stale.
for (const name of ["coreTarball", "mcpTarball", "vsix", "dockerImage"]) {
  assert.equal(
    policy.budgetEvidence[name].transformers,
    pkg.dependencies["@huggingface/transformers"],
    `${name} size evidence must be re-measured when @huggingface/transformers changes`,
  );
}
const overBudget = (what, measured, budgetName) =>
  `${what} evidence (${measured} bytes) exceeds ${budgetName} (${policy.budgets[budgetName]} bytes)`;
assert.ok(
  policy.budgetEvidence.coreTarball.bytes <= policy.budgets.coreTarballCompressedBytes,
  overBudget("core tarball", policy.budgetEvidence.coreTarball.bytes, "coreTarballCompressedBytes"),
);
assert.ok(
  policy.budgetEvidence.mcpTarball.bytes <= policy.budgets.mcpTarballCompressedBytes,
  overBudget("MCP tarball", policy.budgetEvidence.mcpTarball.bytes, "mcpTarballCompressedBytes"),
);
assert.ok(
  policy.budgetEvidence.vsix.maximumCompressedBytes <= policy.budgets.vsixCompressedBytes,
  overBudget("largest packed VSIX", policy.budgetEvidence.vsix.maximumCompressedBytes, "vsixCompressedBytes"),
);
assert.ok(
  policy.budgetEvidence.vsix.maximumUnpackedBytes <= policy.budgets.vsixUnpackedBytes,
  overBudget("largest unpacked VSIX", policy.budgetEvidence.vsix.maximumUnpackedBytes, "vsixUnpackedBytes"),
);
assert.ok(
  policy.vsixTargets.includes(policy.budgetEvidence.vsix.maximumTarget),
  `the largest VSIX's target ${policy.budgetEvidence.vsix.maximumTarget} is not one of vsixTargets`,
);
assert.ok(
  policy.budgetEvidence.dockerImage.bytes <= policy.budgets.dockerImageBytes,
  overBudget("Docker image", policy.budgetEvidence.dockerImage.bytes, "dockerImageBytes"),
);
// The release image is built and published from the amd64 CI runner.
assert.equal(policy.budgetEvidence.dockerImage.architecture, "amd64");
for (const [name, command] of Object.entries(pkg.scripts).filter(([name]) => name.startsWith("publish:"))) {
  assert.doesNotMatch(command, /build-vsix|npm pack|docker build/, `${name} must publish prebuilt manifest artifacts`);
}
assert.match(pkg.scripts["docker:build"], /-t ragnarok-mcp:ci(?:\s|$)/);
const mcpPackage = JSON.parse(await read("packages/mcp-server/package.json"));
const graphUiPackage = JSON.parse(await read("packages/graph-ui/package.json"));
const extApps = "@modelcontextprotocol/ext-apps";
const extAppsDevVersion = "^1.7.5";
assert.doesNotThrow(() => assertDevOnlyDependency(graphUiPackage, extApps, extAppsDevVersion));
for (const surface of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]) {
  const value =
    surface === "bundledDependencies" || surface === "bundleDependencies" ? [extApps] : { [extApps]: "1.7.5" };
  assert.throws(
    () => assertDevOnlyDependency({ ...graphUiPackage, [surface]: value }, extApps, extAppsDevVersion),
    /must be absent/,
    surface,
  );
}
assert.throws(
  () =>
    assertDevOnlyDependency(
      { ...graphUiPackage, devDependencies: { ...graphUiPackage.devDependencies, [extApps]: " " } },
      extApps,
      extAppsDevVersion,
    ),
  /must have exact development dependency/,
);
assert.throws(
  () =>
    assertDevOnlyDependency(
      { ...graphUiPackage, devDependencies: { ...graphUiPackage.devDependencies, [extApps]: "1.7.5" } },
      extApps,
      extAppsDevVersion,
    ),
  /must have exact development dependency/,
);
assert.equal(mcpPackage.dependencies["@modelcontextprotocol/server"], "2.0.0");
for (const [scope, manifest] of [
  ["mcp-server dependencies", mcpPackage.dependencies],
  ["mcp-server devDependencies", mcpPackage.devDependencies],
  ["root devDependencies", pkg.devDependencies],
]) {
  for (const unused of ["@modelcontextprotocol/node", "@modelcontextprotocol/sdk", "@modelcontextprotocol/client"]) {
    assert.equal(manifest?.[unused], undefined, `${scope} must not declare the unused ${unused}`);
  }
}
assert.match(mcpPackage.dependencies.zod, /^\^4\.2\.0$/);
const generatedGraphBundle = "packages/mcp-server/src/ui/graphAppBundle.ts";
const productionSourceFiles = [
  ...(await executableFiles("packages/core/src")),
  ...(await executableFiles("packages/mcp-server/src")),
  ...(await executableFiles("packages/vscode/src")),
];
assert.ok(
  productionSourceFiles.includes(generatedGraphBundle),
  "production source listing must include the generated graph bundle",
);
const productionSources = await Promise.all(
  productionSourceFiles.map(async (file) => ({ file, source: await read(file) })),
);
assert.match(await read("packages/core/src/embeddings/huggingFaceBackend.ts"), /pipeline\("feature-extraction"/);
const crossEncoderSource = await read("packages/core/src/rerankers/crossEncoderReranker.ts");
assert.match(crossEncoderSource, /AutoModelForSequenceClassification/);
assert.match(crossEncoderSource, /AutoTokenizer/);
const graphAppBuilder = await read("packages/graph-ui/build.mjs");
assert.match(
  graphAppBuilder,
  /"\/\/ prettier-ignore\\n"\s*\+\s*`export const GRAPH_APP_HTML = /,
  "Graph UI generator must make its generated export stable under Prettier",
);
assert.match(
  graphAppBuilder,
  /await mkdir\(path\.dirname\(outputPath\), \{ recursive: true \}\)/,
  "Graph UI generator must create its output directories (the Docker build stage has no media/)",
);
const graphResourceSource = await read("packages/mcp-server/src/uiResource.ts");
const graphBundleSource = await read(generatedGraphBundle);
const vscodeGraphScript = await read("media/memoryGraph.js");
const vscodeGraphStyles = await read("media/memoryGraph.css");
const assertSingleGraphAppShell = (source) => {
  for (const [marker, pattern] of [
    ["opening html", /<html\b/g],
    ["closing html", /<\/html>/g],
    ["opening body", /<body\b/g],
    ["closing body", /<\/body>/g],
    ["app shell", /<main\s+id=\\?"app\\?"\s+data-ragnarok-graph-app/g],
  ]) {
    assert.equal(source.match(pattern)?.length, 1, `Generated graph app must contain one ${marker}`);
  }
};
assert.equal(
  mcpPackage.scripts["build:ui"],
  "npm run build --workspace=@ragnarok/graph-ui",
  "MCP graph UI compatibility script must forward to the shared workspace",
);
assert.equal(
  mcpPackage.scripts.pretest,
  "npm run build && npm run compile:tests",
  "MCP tests must rebuild production before compiling tests",
);
assert.equal(
  graphResourceSource.match(/text\/html;profile=mcp-app/g)?.length,
  1,
  "Graph resource module must define the modern MCP Apps MIME literal exactly once",
);
assert.match(graphBundleSource, /data-ragnarok-graph-app/, "Generated graph app must retain its app marker");
assert.match(graphBundleSource, /RAGnarok Graph/, "Generated graph app must retain the MCP app name marker");
// Tracks the manifest rather than a literal: the previous hardcoded version
// silently outlived two bumps, so the contract asserted a version the
// repository no longer used anywhere.
assert.match(
  graphBundleSource,
  new RegExp(graphUiPackage.version.replace(/\./g, "\\.")),
  `Generated graph app must declare the graph UI package version (${graphUiPackage.version}) as its MCP app version marker`,
);
assertSingleGraphAppShell(graphBundleSource);
for (const [name, mutated] of [
  ["duplicate html", `${graphBundleSource}<html>`],
  ["duplicate body", `${graphBundleSource}<body>`],
  ["duplicate app", `${graphBundleSource}<main id=\"app\" data-ragnarok-graph-app>`],
  ["missing closing body", graphBundleSource.replace("</body>", "")],
]) {
  assert.throws(() => assertSingleGraphAppShell(mutated), /must contain one/, name);
}
assert.doesNotMatch(graphBundleSource, /<script\s+[^>]*src\s*=/i, "Generated graph app must not load external scripts");
for (const [file, source] of [
  ["media/memoryGraph.js", vscodeGraphScript],
  ["media/memoryGraph.css", vscodeGraphStyles],
]) {
  assert.ok(source.length > 0, `Generated VS Code graph asset must not be empty: ${file}`);
  const withoutXmlNamespaces = source.replace(
    /http:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg|1999\/xlink|XML\/1998\/namespace|2000\/xmlns\/)/g,
    "",
  );
  assert.doesNotMatch(
    withoutXmlNamespaces,
    /https?:\/\//i,
    `VS Code graph asset must not load remote content: ${file}`,
  );
  assert.doesNotMatch(
    source,
    /ontoolresult|ui\/initialize|@modelcontextprotocol\/ext-apps/i,
    `VS Code graph asset must not contain MCP Apps markers: ${file}`,
  );
}
assert.match(vscodeGraphScript, /graphDocument/, "VS Code graph asset must receive graph documents from the host");
assert.match(vscodeGraphScript, /ready/, "VS Code graph asset must announce readiness to the host");
execFileSync(process.execPath, ["packages/graph-ui/build.mjs", "--check"], {
  cwd: root,
  stdio: "pipe",
});
// Stdio is the only transport, so its binary E2E suite carries the whole
// end-to-end contract and must fail closed rather than skip.
const stdioTransportSource = await read("packages/mcp-server/test/stdioTransport.test.ts");
assert.doesNotMatch(
  stdioTransportSource,
  /existsSync\(SERVER_ENTRY\)|Skipping stdio binary E2E|Skipping stdio E2E/,
  "stdio binary tests must fail closed",
);
assert.match(
  stdioTransportSource,
  /graph visualization protocol/,
  "stdio binary graph test must execute in the focused suite",
);
const mcpReadme = await read("packages/mcp-server/README.md");
// Stdio is the only transport, so the guide must not describe an HTTP adapter.
assert.match(mcpReadme, /Stdio is the only transport/);
assert.match(mcpReadme, /serveStdio/);
assert.doesNotMatch(mcpReadme, /createMcpHandler/);
assert.doesNotMatch(mcpReadme, /toNodeHandler/);
assert.doesNotMatch(mcpReadme, /request-scoped HTTP/);
assert.doesNotMatch(mcpReadme, /StreamableHTTPServerTransport/);
for (const [dependency, version] of [
  ["jsdom", "26.1.0"],
  ["@types/jsdom", "21.1.7"],
]) {
  assert.doesNotThrow(() => assertDevOnlyDependency(graphUiPackage, dependency, version));
}
const obsoleteGraphProductionContracts = [
  "ragnarok.graph.layout.v1",
  "LayoutJSON",
  "LayoutNode",
  "LayoutEdge",
  "LayoutCommunity",
  "layoutKnowledgeGraph",
  "layoutMemoryGraph",
  "graphLayout",
  "ui/resourceUri",
];
for (const obsolete of obsoleteGraphProductionContracts) {
  for (const { file, source } of productionSources) {
    assert.ok(!source.includes(obsolete), `Obsolete graph production contract ${obsolete} must be absent: ${file}`);
  }
}
const mcpIndex = await read("packages/mcp-server/src/index.ts");
const mcpToolRuntime = await read("packages/mcp-server/src/toolRuntime.ts");
// Shutdown stays bounded by the hard-exit timer. It first drains admitted tool
// calls so they can enter memory coordination, then closes memory admission and
// drains it before releasing native handles.
assert.match(mcpIndex, /const drainBudgetMs = config\.shutdownDrainMs \?\? 10_000/);
assert.match(mcpIndex, /setTimeout\(\(\) => process\.exit\(1\), drainBudgetMs \+ 5_000\)/);
assert.match(mcpIndex, /await drainToolRuntimeThenMemory\(toolRuntime, memoryCoordinator\)/);
assert.match(
  mcpToolRuntime,
  /runtime\.stopAdmission\(\);\s+await runtime\.drain\(\);\s+coordinator\.stopAdmission\(\);\s+await coordinator\.drain\(\)/,
);
assert.match(mcpIndex, /await stdioHandle\?\.close\(\)/);
assert.ok(
  mcpIndex.indexOf("await drainToolRuntimeThenMemory(toolRuntime, memoryCoordinator)") <
    mcpIndex.indexOf("await memoryStore.dispose()"),
  "Memory store disposal must follow tool-runtime and memory-coordinator drains",
);
assert.match(mcpIndex, /process\.stdin\.once\("end", \(\) => void shutdown\("stdio EOF"\)\)/);
for (const name of ["release", "docker:push"]) {
  assert.match(mcpPackage.scripts[name], /npm --prefix \.\.\/\.\. run publish:/);
  assert.doesNotMatch(mcpPackage.scripts[name], /npm publish|docker push/);
}

async function executableFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        return executableFiles(relativePath);
      }
      return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [relativePath] : [];
    }),
  );
  return files.flat();
}

const executableMcpFiles = [
  ...(await executableFiles("packages/mcp-server/src")),
  ...(await executableFiles("packages/mcp-server/test")),
  "scripts/docker-gate.mjs",
  "scripts/pack-smoke.mjs",
  "scripts/shutdown-soak.mjs",
];
assert.ok(
  executableMcpFiles.includes("packages/mcp-server/test/stdioHarnessLifecycle.test.ts"),
  "stdio harness lifecycle coverage must remain in the Task 5 deliverable",
);
for (const file of executableMcpFiles) {
  assert.doesNotMatch(
    await read(file),
    /@modelcontextprotocol\/sdk(?:\/|["'])/,
    `Executable MCP code must not import the monolithic v1 SDK: ${file}`,
  );
}

const builder = await read("scripts/build-vsix.js");
const vscodeIgnore = await read(".vscodeignore");
assert.match(vscodeIgnore, /!node_modules\/binary-extensions\/\*\*/);
// pdf-parse depends on pdfjs-dist. npm nests it under pdf-parse today (that package's allowlist line
// covers it), but a dedupe would hoist it to the root, so the root line stays while the dependency does.
assert.ok(
  JSON.parse(await read("package-lock.json")).packages["node_modules/pdf-parse"]?.dependencies?.["pdfjs-dist"],
  "pdf-parse no longer depends on pdfjs-dist: drop the !node_modules/pdfjs-dist/** line from .vscodeignore",
);
assert.match(vscodeIgnore, /^!node_modules\/pdfjs-dist\/\*\*$/m, "the VSIX must allowlist a hoisted pdfjs-dist");
for (const archiveDependency of ["adm-zip", "yazl", "buffer-crc32"]) {
  assert.match(
    vscodeIgnore,
    new RegExp(`^!node_modules/${archiveDependency}/\\*\\*$`, "m"),
    `VSIX must include externalized archive dependency: ${archiveDependency}`,
  );
}
for (const obsoleteArchiveDependency of [
  "archiver",
  "archiver-utils",
  "compress-commons",
  "crc-32",
  "crc32-stream",
  "zip-stream",
  "readable-stream",
  "lazystream",
  "normalize-path",
  "lodash",
  "glob",
]) {
  assert.doesNotMatch(
    vscodeIgnore,
    new RegExp(`^!node_modules/${obsoleteArchiveDependency}/\\*\\*$`, "m"),
    `VSIX must not retain obsolete archive allowlist: ${obsoleteArchiveDependency}`,
  );
}
for (const workspace of ["core", "mcp-server", "vscode"]) {
  assert.ok(
    builder.includes(`packages/${workspace}/tsconfig.tsbuildinfo`),
    `VSIX clean build must invalidate ${workspace} TypeScript incremental state`,
  );
}
// The staging install must be `npm ci` — an exact, reproducible tree from
// package-lock.json — never `npm install`, which is free to resolve something
// newer than the lockfile records. The call goes through Node rather than the
// `npm` launcher because Windows has only an `npm.cmd` shim, which Node refuses
// to spawn without a shell (CVE-2024-27980); what this pins is the `ci`, not
// the mechanism used to reach npm.
assert.match(builder, /runNodeScript\(\s*resolveNpmCli\(\),\s*\[\s*["']ci["']/);
assert.doesNotMatch(builder, /execSync\('npm install /);
// Neither shim form may come back: one fails with ENOENT on Windows, the other
// with EINVAL.
assert.doesNotMatch(builder, /execFileSync\(\s*["']npm(\.cmd)?["']/);
assert.match(builder, /verifyIntegrity\(archive, integrity/);
assert.match(builder, /assertSafeArchiveMember/);
assert.match(builder, /verifyNativePackages/);
assert.match(builder, /verifySharpNativesMatchTransformers\(nodeModules, targetPlatform\)/);
assert.match(builder, /onnxruntime-node: expected 1 \$\{targetPlatform\.target\} binding/);
assert.match(builder, /resolveTransformersDependency\(nm, "onnxruntime-node"\)/);
assert.doesNotMatch(builder, /napi-v3/);
assert.match(builder, /Cleaning and rebuilding extension output from source/);
assert.match(builder, /delete rootPkg\.scripts\?\.\["vscode:prepublish"\]/);
assert.doesNotMatch(builder, /\.vsce-staging-\$\{target\}/);
assert.doesNotMatch(
  builder,
  /dropOptionalPeersOnRootDependencies/,
  "VSIX staging relies on the root override, not on deleting peer declarations",
);
assert.doesNotMatch(
  builder,
  /No gutting hacks|VSCE does not reliably retain|@hono\/node-server requires hono/,
  "build-vsix comments must describe the current staging",
);
// sharp and its helpers ship nested under @huggingface/transformers (already allowlisted);
// none of them is installed at the root, so a root allowlist line for them is dead.
for (const name of [
  "sharp",
  "detect-libc",
  "color",
  "color-convert",
  "color-string",
  "color-name",
  "simple-swizzle",
  "semver",
]) {
  assert.doesNotMatch(
    vscodeIgnore,
    new RegExp(`^!node_modules/${name}/\\*\\*$`, "m"),
    `VSIX allowlist must not name the absent root package ${name}`,
  );
}
const vsixSmoke = await read("scripts/vsix-smoke.mjs");
const extensionHostSmoke = await read("scripts/vsix-extension-host-smoke.cjs");
const extensionEntry = await read("packages/vscode/src/extension.ts");
const installedSmokeSource = await read("packages/vscode/src/installedSmoke.ts");
const vscodeConstants = await read("packages/vscode/src/constants.ts");
const vscodeCommands = await read("packages/vscode/src/commands.ts");
const vscodeIngestionFlow = await read("packages/vscode/src/ingestionFlow.ts");
assert.match(vsixSmoke, /runTests\(/);
assert.match(vsixSmoke, /vsix-extension-host-smoke\.cjs/);
assert.match(vsixSmoke, /RAGNAROK_EXPECTED_EXTENSION_PATH: extensionDir/);
assert.match(vsixSmoke, /launchArgs: \[\s*workspace,/);
assert.match(vsixSmoke, /delete process\.env\.ELECTRON_RUN_AS_NODE/);
// Windows will not unlink a DLL a live process has loaded, so the smoke must not load
// LanceDB, Sharp or ONNX Runtime into its own process: a child process probes them, and
// the temporary profile (which holds those DLLs) is then deletable, with retries for a
// VS Code process that is slow to exit.
assert.doesNotMatch(
  vsixSmoke,
  /(?:[Rr]equire\(|import\()\s*["'](?:@lancedb\/lancedb|sharp|onnxruntime-node)["']/,
  "vsix-smoke must not load native modules in its own process",
);
assert.match(
  vsixSmoke,
  /execFileSync\(\s*process\.execPath,\s*\[path\.join\(root, "scripts\/vsix-native-probe\.cjs"\), extensionDir\]/,
  "vsix-smoke must run the native probe in a child Node process",
);
assert.match(
  vsixSmoke,
  /await rm\(profile, \{[^}]*\bmaxRetries: \d+/,
  "vsix-smoke must retry deleting its temporary profile",
);
const nativeProbe = await read("scripts/vsix-native-probe.cjs");
assert.match(nativeProbe, /extensionRequire\("@lancedb\/lancedb"\)/);
assert.match(nativeProbe, /transformersRequire\("sharp"\)/);
assert.match(nativeProbe, /transformersRequire\("onnxruntime-node"\)/);
assert.match(nativeProbe, /listSupportedBackends/);
assert.match(nativeProbe, /console\.log\(\s*JSON\.stringify\(/);
// VS Code 1.110+ names the macOS binary after the product and 1.140 dropped the
// Contents/MacOS/Electron link, so the extension-host smoke must launch the real binary.
const testElectronUtil = require("@vscode/test-electron/out/util.js");
const vscodeDownload = await mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-layout-"));
try {
  const vscodeContents = path.join(vscodeDownload, "Visual Studio Code.app", "Contents");
  await mkdir(path.join(vscodeContents, "MacOS"), { recursive: true });
  await writeFile(path.join(vscodeContents, "MacOS", "Code"), "");
  await writeFile(
    path.join(vscodeContents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Code</string></dict></plist>",
  );
  assert.equal(
    testElectronUtil.downloadDirToExecutablePath(vscodeDownload, "darwin-arm64"),
    path.join(vscodeContents, "MacOS", "Code"),
  );
} finally {
  // Removed even when the assertion fails, so a failing run leaves no temp tree behind.
  await rm(vscodeDownload, { recursive: true, force: true });
}
// Node refuses to spawn a .cmd file without a shell (CVE-2024-27980), and the Windows
// VS Code CLI is code.cmd: every CLI call goes through runCli.
assert.match(vsixSmoke, /import \{ cmdLine, needsShell, smokeSummary \} from "\.\/vsix-smoke-lib\.mjs";/);
assert.match(vsixSmoke, /const viaShell = needsShell\(code\);/);
assert.match(vsixSmoke, /execSync\(cmdLine\(\[code, \.\.\.baseArgs, \.\.\.args\]\), options\)/);
// Every child process vsix-smoke starts, by its first argument: where.exe, the native probe, and the
// VS Code CLI only through runCli (once with a shell, once without). A new direct CLI call adds an entry.
assert.deepEqual(
  [...vsixSmoke.matchAll(/\b(execFileSync|execSync|execFile|exec|spawnSync|spawn)\(\s*([^,)]+)/g)]
    .map((call) => `${call[1]}(${call[2].trim()}`)
    .sort(),
  ['execFileSync("where.exe"', "execFileSync(code", "execFileSync(process.execPath", "execSync(cmdLine([code"],
  "vsix-smoke must reach the VS Code CLI only through runCli",
);
const vsixSmokeLib = await import("./vsix-smoke-lib.mjs");
for (const [cli, platform, expected] of [
  ["C:\\VS Code\\bin\\code.cmd", "win32", true],
  ["code.CMD", "win32", true],
  ["C:\\tools\\code.bat", "win32", true],
  ["C:\\VS Code\\Code.exe", "win32", false],
  ["code.cmd", "linux", false],
]) {
  assert.equal(vsixSmokeLib.needsShell(cli, platform), expected, `needsShell(${cli}, ${platform})`);
}
assert.equal(
  vsixSmokeLib.cmdLine(["C:\\VS Code\\bin\\code.cmd", "--install-extension", "C:\\a b\\x.vsix"]),
  '"C:\\VS Code\\bin\\code.cmd" "--install-extension" "C:\\a b\\x.vsix"',
);
// cmd.exe expands %VAR% even inside double quotes and has no escape for it there; a quote or a line
// break would end the argument. Such a value is refused, never passed through altered.
for (const unsafe of ["C:\\%TEMP%\\x.vsix", 'C:\\a"b', "C:\\a\nb", "C:\\a\rb"]) {
  assert.throws(() => vsixSmokeLib.cmdLine(["code.cmd", unsafe]), /cannot pass .* through cmd\.exe/);
}
assert.equal(
  vsixSmokeLib.smokeSummary("hyorman.ragnarok@0.4.1", "1.140.0", "1.140.0"),
  "Installed, activated, and create/query/delete smoked hyorman.ragnarok@0.4.1 on VS Code 1.140.0.",
);
assert.equal(
  vsixSmokeLib.smokeSummary("hyorman.ragnarok@0.4.1", "1.140.0", "1.138.0"),
  "Installed, activated, and create/query/delete smoked hyorman.ragnarok@0.4.1 on VS Code 1.140.0 " +
    "(installed with the 1.138.0 CLI).",
);
// The success line names the VS Code that ran the extension host, which the host reports itself.
assert.match(vsixSmoke, /RAGNAROK_SMOKE_HOST_REPORT: hostReport/);
assert.match(vsixSmoke, /smokeSummary\(`\$\{pkg\.publisher\}\.\$\{pkg\.name\}@\$\{pkg\.version\}`, hostVersion, version\)/);
assert.match(extensionHostSmoke, /JSON\.stringify\(\{ vscodeVersion: vscode\.version \}\)/);
// cmd.exe expands %~dp0 to the current directory, not the batch file's, when a quoted
// code.cmd was found through PATH, so a bare name is resolved to an absolute path
// (where.exe is an .exe, no shell) before runCli quotes it.
assert.match(vsixSmoke, /if \(viaShell && !\/\[\\\\\/\]\/\.test\(code\)\) \{/);
assert.match(vsixSmoke, /execFileSync\("where\.exe", \[code\], \{ encoding: "utf8" \}\)/);
assert.match(vsixSmoke, /code = resolved;/);
assert.ok(
  vsixSmoke.indexOf('execFileSync("where.exe"') < vsixSmoke.indexOf("const runCli"),
  "a bare code.cmd must be resolved before runCli quotes it",
);
assert.match(extensionHostSmoke, /ragnarok\._runInstalledSmoke/);
assert.match(extensionHostSmoke, /extension\.extensionPath !== expectedExtensionPath/);
assert.match(extensionHostSmoke, /topicCreated: true, queryExecuted: true, topicDeleted: true/);
assert.match(installedSmokeSource, /topicManager\.addDocuments\(topic\.id, \[smokePath\], \{ signal \}\)/);
assert.match(installedSmokeSource, /result\.text\.includes\(evidenceToken\)/);
assert.match(installedSmokeSource, /topicManager\.getTopic\(topic\.id\) === null/);
assert.match(vscodeConstants, /INSTALLED_SMOKE: "ragnarok\._runInstalledSmoke"/);
assert.match(
  extensionEntry,
  /runInstalledSmoke: \(\) =>\s*lifecycle\.run\("installed VSIX smoke", \(signal\) =>\s*runInstalledSmoke\(\{ context, topicManager, ragTool: ragToolRegistration \}, signal\)/,
);
assert.match(extensionEntry, /registerCommand\(COMMANDS\.INSTALLED_SMOKE, \(\) =>\s*api\.runInstalledSmoke\(\)/);
assert.match(vscodeIngestionFlow, /topicManager\.addDocuments\(topicId, sources, \{ \.\.\.options, signal \}\)/);
assert.match(vscodeCommands, /import \{[^}]*\bingestWithProgress\b[^}]*\} from "\.\/ingestionFlow"/);

const packaging = require("./build-vsix.js");
assert.deepEqual(packaging.VSIX_GRAPH_ASSETS, ["memoryGraph.js", "memoryGraph.css"]);
assert.equal(typeof packaging.copyGraphAssetsToStaging, "function");
assert.equal(typeof packaging.removeGraphUiWorkspace, "function");
const graphAssetStaging = await mkdtemp(path.join(os.tmpdir(), "ragnarok-graph-assets-"));
packaging.copyGraphAssetsToStaging(graphAssetStaging);
assert.deepEqual((await readdir(path.join(graphAssetStaging, "media"))).sort(), ["memoryGraph.css", "memoryGraph.js"]);
await rm(graphAssetStaging, { recursive: true, force: true });
const graphWorkspaceStaging = await mkdtemp(path.join(os.tmpdir(), "ragnarok-graph-workspace-"));
await writeFile(
  path.join(graphWorkspaceStaging, "package.json"),
  JSON.stringify({ workspaces: ["packages/core", "packages/graph-ui", "packages/vscode"] }),
);
await mkdir(path.join(graphWorkspaceStaging, "packages/graph-ui"), { recursive: true });
await writeFile(path.join(graphWorkspaceStaging, "packages/graph-ui/package.json"), "{}");
packaging.removeGraphUiWorkspace(graphWorkspaceStaging);
assert.deepEqual(JSON.parse(await readFile(path.join(graphWorkspaceStaging, "package.json"), "utf8")).workspaces, [
  "packages/core",
  "packages/vscode",
]);
await assert.rejects(readFile(path.join(graphWorkspaceStaging, "packages/graph-ui/package.json")));
await rm(graphWorkspaceStaging, { recursive: true, force: true });
assert.equal(packaging.getNativePackageConfig("@img/sharp-darwin-arm64").description, "Sharp");
assert.equal(packaging.getNativePackageConfig("@img/sharp-libvips-darwin-arm64").description, "Sharp libvips");
assert.equal(
  packaging.expectedNativePackageName(packaging.getNativePackageConfig("@lancedb/lancedb-linux-x64-gnu"), {
    platform: "linux",
    target: "linux-x64",
  }),
  "@lancedb/lancedb-linux-x64-gnu",
);
assert.equal(
  packaging.expectedNativePackageName(packaging.getNativePackageConfig("@lancedb/lancedb-win32-arm64-msvc"), {
    platform: "win32",
    target: "win32-arm64",
  }),
  "@lancedb/lancedb-win32-arm64-msvc",
);
const nativePruneTree = await mkdtemp(path.join(os.tmpdir(), "ragnarok-native-prune-"));
for (const name of ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64", "sharp-win32-x64"]) {
  const packageDir = path.join(nativePruneTree, "@img", name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), "{}");
}
packaging.prunePlatformNativePackages(nativePruneTree, {
  platform: "darwin",
  target: "darwin-arm64",
});
await readFile(path.join(nativePruneTree, "@img", "sharp-darwin-arm64", "package.json"));
await readFile(path.join(nativePruneTree, "@img", "sharp-libvips-darwin-arm64", "package.json"));
await assert.rejects(readFile(path.join(nativePruneTree, "@img", "sharp-win32-x64", "package.json")));
await rm(nativePruneTree, { recursive: true, force: true });
const fixture = Buffer.from("locked native artifact");
const integrity = `sha512-${createHash("sha512").update(fixture).digest("base64")}`;
packaging.verifyIntegrity(fixture, integrity, "fixture");
assert.throws(() => packaging.verifyIntegrity(Buffer.from("tampered"), integrity, "fixture"), /mismatch/);
for (const unsafe of ["../escape", "package/../../escape", "/absolute", "C:\\absolute"]) {
  assert.throws(() => packaging.assertSafeArchiveMember(unsafe), /path/);
}
const emptyNodeModules = await mkdtemp(path.join(os.tmpdir(), "ragnarok-native-absence-"));
assert.throws(
  () =>
    packaging.verifyNativePackages(
      emptyNodeModules,
      { platform: "linux", target: "linux-x64", patterns: ["linux-x64", "linux-x64-gnu"] },
      [{}, {}, {}],
    ),
  /expected 1/,
);
await rm(emptyNodeModules, { recursive: true, force: true });
// Fixture helpers for the native-package guards. A staged tree is <staging>/node_modules:
// Transformers' own Sharp sits nested under it and the target platform packages at its root.
async function writePackage(nodeModules, name, manifest = {}) {
  const directory = path.join(nodeModules, ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, ...manifest }));
  return directory;
}
async function sharpFixture({ platformVersion = "0.35.5", libvipsVersion = "1.3.4", declareLibvips = true } = {}) {
  const nodeModules = path.join(await mkdtemp(path.join(os.tmpdir(), "ragnarok-sharp-natives-")), "node_modules");
  await writePackage(nodeModules, "@huggingface/transformers", { version: "4.3.0" });
  await writePackage(path.join(nodeModules, "@huggingface", "transformers", "node_modules"), "sharp", {
    version: "0.35.5",
    optionalDependencies: { "@img/sharp-linux-x64": "0.35.5", "@img/sharp-win32-x64": "0.35.5" },
  });
  await writePackage(nodeModules, "@img/sharp-linux-x64", {
    version: platformVersion,
    ...(declareLibvips ? { optionalDependencies: { "@img/sharp-libvips-linux-x64": "1.3.4" } } : {}),
  });
  await writePackage(nodeModules, "@img/sharp-libvips-linux-x64", { version: libvipsVersion });
  return nodeModules;
}
const linuxX64Target = { platform: "linux", arch: "x64", target: "linux-x64" };
const win32X64Target = { platform: "win32", arch: "x64", target: "win32-x64" };

// The Windows Sharp packages carry libvips-42.dll themselves and Sharp declares no Windows
// libvips package, so a Windows VSIX ships none and the root manifest installs none.
assert.deepEqual(
  packaging.nativePackageConfigsFor(win32X64Target).map((config) => config.description),
  ["LanceDB", "Sharp"],
);
assert.deepEqual(
  packaging.nativePackageConfigsFor(linuxX64Target).map((config) => config.description),
  ["LanceDB", "Sharp", "Sharp libvips"],
);
assert.deepEqual(
  Object.keys(pkg.optionalDependencies).filter((name) => name.startsWith("@img/sharp-libvips-win32-")),
  [],
  "No Windows libvips package may be installed for a VSIX",
);
assert.deepEqual(
  Object.keys(JSON.parse(await read("package-lock.json")).packages).filter((location) =>
    location.includes("@img/sharp-libvips-win32-"),
  ),
  [],
);
const win32NativeTree = await mkdtemp(path.join(os.tmpdir(), "ragnarok-native-win32-"));
for (const name of [
  "@lancedb/lancedb-win32-x64-msvc",
  "@img/sharp-win32-x64",
  "@img/sharp-libvips-win32-x64",
  "@img/sharp-libvips-win32-arm64",
]) {
  await writePackage(win32NativeTree, name);
}
assert.throws(
  () => packaging.verifyNativePackages(win32NativeTree, win32X64Target, [{}, {}]),
  /Sharp libvips: expected 0 win32-x64 package, found 1/,
);
packaging.prunePlatformNativePackages(win32NativeTree, win32X64Target);
await readFile(path.join(win32NativeTree, "@img", "sharp-win32-x64", "package.json"));
await assert.rejects(readFile(path.join(win32NativeTree, "@img", "sharp-libvips-win32-x64", "package.json")));
await assert.rejects(readFile(path.join(win32NativeTree, "@img", "sharp-libvips-win32-arm64", "package.json")));
packaging.verifyNativePackages(win32NativeTree, win32X64Target, [{}, {}]);
await rm(win32NativeTree, { recursive: true, force: true });
// Transformers' Sharp declares the Windows platform package and nothing past it.
const windowsSharpTree = await sharpFixture();
await writePackage(windowsSharpTree, "@img/sharp-win32-x64", { version: "0.35.5" });
packaging.verifySharpNativesMatchTransformers(windowsSharpTree, win32X64Target);
await rm(path.dirname(windowsSharpTree), { recursive: true, force: true });
// The allowlist decides where the shipped chain ends. A native that the last shipped package still
// declares (a future Windows Sharp that declares a libvips package, a target the allowlist does not
// know) would be pruned from the VSIX and Sharp would fail to load at run time.
const unendedChainTree = await sharpFixture();
await writePackage(unendedChainTree, "@img/sharp-win32-x64", {
  version: "0.35.5",
  optionalDependencies: { "@img/sharp-libvips-win32-x64": "1.3.4" },
});
assert.throws(
  () => packaging.verifySharpNativesMatchTransformers(unendedChainTree, win32X64Target),
  /@img\/sharp-win32-x64 declares @img\/sharp-libvips-win32-x64, but no shipped native package config covers it for win32-x64/,
);
await rm(path.dirname(unendedChainTree), { recursive: true, force: true });
// Every Sharp native that ships is declared by the package before it in the chain; an
// undeclared one is not what Sharp loads, so the build must not accept it on presence alone.
const undeclaredLibvipsTree = await sharpFixture({ declareLibvips: false });
assert.throws(
  () => packaging.verifySharpNativesMatchTransformers(undeclaredLibvipsTree, linuxX64Target),
  /@img[\\/]sharp-linux-x64 does not declare @img\/sharp-libvips-linux-x64/,
);
await rm(path.dirname(undeclaredLibvipsTree), { recursive: true, force: true });

// onnxruntime-node loads bin/napi-v*/<platform>/<arch>/onnxruntime_binding.node with no fallback:
// the prune keeps exactly the target binding and fails the build on none or on an ambiguous pair.
const onnxTree = await mkdtemp(path.join(os.tmpdir(), "ragnarok-onnx-prune-"));
await writePackage(onnxTree, "@huggingface/transformers", { version: "4.3.0" });
const onnxDir = await writePackage(
  path.join(onnxTree, "@huggingface", "transformers", "node_modules"),
  "onnxruntime-node",
  {
    version: "1.30.0",
  },
);
const onnxBinding = (napi, platform, arch) =>
  path.join(onnxDir, "bin", napi, platform, arch, "onnxruntime_binding.node");
for (const [platform, arch] of [
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
]) {
  await mkdir(path.dirname(onnxBinding("napi-v6", platform, arch)), { recursive: true });
  await writeFile(onnxBinding("napi-v6", platform, arch), "");
}
packaging.pruneOnnxruntimeNode(onnxTree, linuxX64Target);
await readFile(onnxBinding("napi-v6", "linux", "x64"));
for (const [platform, arch] of [
  ["darwin", "arm64"],
  ["linux", "arm64"],
  ["win32", "x64"],
]) {
  await assert.rejects(readFile(onnxBinding("napi-v6", platform, arch)), `ORT ${platform}/${arch} must be pruned`);
}
await mkdir(path.dirname(onnxBinding("napi-v7", "linux", "x64")), { recursive: true });
await writeFile(onnxBinding("napi-v7", "linux", "x64"), "");
assert.throws(
  () => packaging.pruneOnnxruntimeNode(onnxTree, linuxX64Target),
  /onnxruntime-node: expected 1 linux-x64 binding, found 2/,
);
// ONNX Runtime ships no macOS x64 binary since 1.24; such a target must fail, not ship.
assert.throws(
  () => packaging.pruneOnnxruntimeNode(onnxTree, { platform: "darwin", arch: "x64", target: "darwin-x64" }),
  /onnxruntime-node: expected 1 darwin-x64 binding, found 0/,
);
await rm(onnxTree, { recursive: true, force: true });

// The Sharp natives checked are the copies Transformers' own Sharp resolves, at the declared versions.
const matchingSharpTree = await sharpFixture();
packaging.verifySharpNativesMatchTransformers(matchingSharpTree, linuxX64Target);
// A stale copy nested under Transformers shadows the root one: it is the copy Sharp loads.
await writePackage(
  path.join(matchingSharpTree, "@huggingface", "transformers", "node_modules"),
  "@img/sharp-linux-x64",
  {
    version: "0.34.5",
  },
);
assert.throws(
  () => packaging.verifySharpNativesMatchTransformers(matchingSharpTree, linuxX64Target),
  /@img\/sharp-linux-x64@0\.34\.5 does not match the 0\.35\.5/,
);
await rm(path.dirname(matchingSharpTree), { recursive: true, force: true });
const staleLibvipsTree = await sharpFixture({ libvipsVersion: "1.3.3" });
assert.throws(
  () => packaging.verifySharpNativesMatchTransformers(staleLibvipsTree, linuxX64Target),
  /@img\/sharp-libvips-linux-x64@1\.3\.3 does not match the 1\.3\.4/,
);
await rm(path.dirname(staleLibvipsTree), { recursive: true, force: true });

// A nested copy beside a root copy ships twice; only one of them is what its consumer loads.
const depthTree = await mkdtemp(path.join(os.tmpdir(), "ragnarok-native-depth-"));
for (const name of ["@lancedb/lancedb-linux-x64-gnu", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]) {
  await writePackage(depthTree, name);
}
packaging.verifyNativePackages(depthTree, linuxX64Target, [{}, {}, {}]);
await writePackage(path.join(depthTree, "@huggingface", "transformers", "node_modules"), "@img/sharp-linux-x64");
assert.throws(
  () => packaging.verifyNativePackages(depthTree, linuxX64Target, [{}, {}, {}]),
  /Sharp: expected 1 linux-x64 package, found 2/,
);
await rm(depthTree, { recursive: true, force: true });

const dockerfile = await read("packages/mcp-server/Dockerfile");
const dockerignore = await read(".dockerignore");
const dockerGate = await read("scripts/docker-gate.mjs");
assert.match(dockerfile, /USER node/);
assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
assert.match(dockerfile, /FROM node:22-slim AS production-deps/);
assert.match(dockerfile, /--include-workspace-root=false/);
assert.match(dockerfile, /--omit=peer/);
assert.match(dockerfile, /--libc=glibc/);
assert.match(dockerfile, /onnxruntime-node\/bin\/napi-v6/);
assert.match(dockerfile, /test -f "\$\{onnx_bin\}\/linux\/\$\{onnx_arch\}\/onnxruntime_binding\.node"/);
assert.match(dockerfile, /onnxruntime-web/);
// Core loads Transformers with import() (dist/transformers.node.mjs); dist/transformers.node.cjs
// is the package's require/main entry. The image keeps exactly those two dist files.
assert.doesNotMatch(dockerfile, /jsep\.wasm/, "Transformers 4 ships no jsep.wasm; a prune line for it is dead");
// The pin reads a CRLF checkout (core.autocrlf on Windows) as well as an LF one.
const transformersPrune =
  /find node_modules\/@huggingface\/transformers\/dist -type f \\\r?\n\s+! -name transformers\.node\.mjs ! -name transformers\.node\.cjs -delete/;
for (const [endings, text] of [
  ["LF", dockerfile],
  ["CRLF", dockerfile.replaceAll("\n", "\r\n")],
]) {
  assert.match(text, transformersPrune, `the Transformers dist prune pin must read a ${endings} Dockerfile`);
}
// Both kept entries are checked after the prune, so an over-prune fails the image build itself.
for (const entry of ["transformers.node.mjs", "transformers.node.cjs"]) {
  assert.match(
    dockerfile,
    new RegExp(`test -f node_modules/@huggingface/transformers/dist/${entry.replaceAll(".", "\\.")}`),
    `the image build must check that ${entry} survived the prune`,
  );
}
const { spawnOutcome } = await import("./spawn-outcome.mjs");
assert.equal(spawnOutcome(spawnSync(process.execPath, ["-e", "process.exitCode = 3"]), 1000), "exit 3");
assert.equal(
  spawnOutcome(spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 100 }), 100),
  "timed out after 100 ms",
);
assert.equal(
  spawnOutcome(spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]), 1000),
  "killed by SIGKILL",
);
assert.equal(
  spawnOutcome(spawnSync("ragnarok-no-such-command"), 1000),
  "could not start: spawnSync ragnarok-no-such-command ENOENT",
);
const transformersManifest = JSON.parse(await read("node_modules/@huggingface/transformers/package.json"));
assert.equal(transformersManifest.exports.node.import.default, "./dist/transformers.node.mjs");
assert.equal(transformersManifest.exports.node.require.default, "./dist/transformers.node.cjs");
assert.match(dockerfile, /find node_modules packages\/core\/node_modules/);
assert.match(dockerfile, /--from=production-deps \/app\/node_modules\//);
assert.match(dockerfile, /COPY --chown=node:node/);
assert.doesNotMatch(dockerfile, /chown -R node:node \/data\/ragnarok \/app/);
assert.doesNotMatch(dockerfile, /COPY package\.json \.npmrc \.\//);
assert.equal(
  dockerfile.match(/COPY packages\/graph-ui\/package\.json packages\/graph-ui\//g)?.length,
  2,
  "Both npm-install stages must include the graph-ui workspace manifest",
);
const [, dockerBuildStage, dockerProductionDepsStage, dockerRuntimeStage] = dockerfile.split(/FROM node:22-slim AS /);
assert.match(dockerBuildStage, /COPY packages\/graph-ui\/ packages\/graph-ui\//);
assert.doesNotMatch(dockerProductionDepsStage, /COPY packages\/graph-ui\/ packages\/graph-ui\//);
assert.doesNotMatch(dockerRuntimeStage, /graph-ui|memoryGraph\.(?:js|css)|COPY media/);
assert.match(dockerignore, /\*\*\/\*\.tsbuildinfo/);

// The image ships a stdio-only server: no port, no health endpoint to poll,
// and no HTTP configuration baked into the layer.
assert.match(dockerfile, /CMD \["node", "packages\/mcp-server\/dist\/index\.js"\]/);
for (const forbidden of [
  /^EXPOSE /m,
  /^HEALTHCHECK /m,
  /--http/,
  /container-healthcheck\.mjs/,
  /^ENV RAGNAROK_PORT/m,
  /^ENV RAGNAROK_HTTP_HOST/m,
]) {
  assert.doesNotMatch(dockerfile, forbidden, `Stdio-only image must not contain ${forbidden}`);
}
await assert.rejects(
  read("packages/mcp-server/docker-compose.yml"),
  "compose orchestration cannot describe a stdio server the client must own",
);
await assert.rejects(read("scripts/container-healthcheck.mjs"), "a stdio server has no endpoint to health-check");
await assert.rejects(read("scripts/docker-smoke.mjs"), "the HTTP docker smoke client was folded into the stdio gate");

// The stdio gate must still prove the hardened runtime posture the deleted
// compose file used to carry, and must exercise the image over stdio.
for (const contract of [
  /"--read-only"/,
  /"--cap-drop",\s*\n?\s*"ALL"/,
  /"no-new-privileges"/,
  /"--init"/,
  /"\/tmp:size=256m"/,
  /"--stop-timeout"/,
  /spawn\("docker"/,
  /"run",\s*\n?\s*"-i",/,
  /server\/discover/,
  /tools\/list/,
  /expectedToolCount = 8/,
  /assertSecondServerSharesVolume/,
  /function assertTransformersLoads\(/,
  // The gate calls it right after the image contract, so an over-pruned Transformers fails first.
  /await assertImageContract\(\);\s*\n\s*assertTransformersLoads\(\);/,
  /transformers-ok/,
  // A timed-out or killed Transformers check names what happened instead of "(exit null)".
  /spawnOutcome\(result, TRANSFORMERS_CHECK_TIMEOUT_MS\)/,
  // The second server's tools get the same surface check as the first's, not only a count.
  /assertToolSurface\(tools, "Second server"\)/,
  /assertRuntimeHardening/,
  /closeCleanly/,
  /ExposedPorts/,
  /Healthcheck/,
]) {
  assert.match(dockerGate, contract, `Docker stdio gate must assert ${contract}`);
}
assert.doesNotMatch(dockerGate, /containerLogs/, "docker-gate must not keep the unused containerLogs helper");
assert.doesNotMatch(
  dockerGate,
  /remained running instead of failing fast/,
  "Docker gate must not expect a second server on the same volume to exit: leases are per write, not per process",
);
for (const forbidden of [/httpsRequest/, /RAGNAROK_DEPLOYMENT_MODE=shared/, /\/health/, /-p", "4000/]) {
  assert.doesNotMatch(dockerGate, forbidden, `Docker stdio gate must not probe HTTP: ${forbidden}`);
}

// The published invocation is a hardened `docker run -i`, not compose.
const rootPackage = JSON.parse(await read("package.json"));
assert.ok(!("docker:compose" in rootPackage.scripts), "compose entrypoint must not survive the stdio-only transport");
for (const flag of ["-i", "--init", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--tmpfs"]) {
  assert.ok(
    rootPackage.scripts["docker:run"].includes(flag),
    `documented docker run must keep the hardened flag ${flag}`,
  );
}
assert.doesNotMatch(rootPackage.scripts["docker:run"], /-p /, "a stdio container publishes no port");

const workflow = await read(".github/workflows/release.yml");
const workflowDocument = require("yaml").parse(workflow);
for (const use of workflow.matchAll(/uses:\s*([^\s]+)/g)) {
  assert.match(use[1], /@[a-f0-9]{40}$/i, `Unpinned action: ${use[1]}`);
}
assert.match(workflow, /cancel-in-progress: true/);
assert.match(workflow, /permissions:\s*\n\s*contents: read/);
assert.match(workflow, /npm run bench:acquire[\s\S]*npm run bench:release/);
assert.match(workflow, /vscode-tests:[\s\S]*xvfb-run -a npm test/);
assert.match(workflow, /benchmark-results-\$\{\{ github\.sha \}\}[\s\S]*path: artifacts\/evidence/);
assert.match(
  workflow,
  /artifacts\/bom\.cdx\.json[\s\S]*artifacts\/bom\.spdx\.json[\s\S]*artifacts\/evidence\/\*\.json/,
);
assert.match(workflow, /npm run release:verify[\s\S]*npm run publish:all/);
assert.match(workflow, /manifest:\s*\n\s*if: github\.ref_type == 'tag' && github\.ref_protected == true/);
assert.match(workflow, /download-release-attestation\.mjs/);
assert.match(workflow, /release-manifest\.attestation\.jsonl/);
assert.match(workflow, /release-publication-journal-\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(workflow, /RELEASE_MANIFEST_ATTESTED/);
assert.deepEqual(
  workflowDocument.jobs["vsix-installed"].strategy.matrix.include.map((entry) => entry.target).sort(),
  supportedVsixTargets,
);
// The runner images ship no VS Code and the Linux ones have no display. Every installed-VSIX leg therefore
// downloads VS Code (VSCODE_VERSION) instead of naming a preinstalled CLI, and a Linux leg runs the smoke
// under xvfb, which the arm image may not ship. The minimum-version job downloads its own VS Code too.
const smokeInvocation = /\bnode scripts\/vsix-smoke\.mjs\b/;
const vsixInstalledSteps = workflowDocument.jobs["vsix-installed"].steps;
const vsixInstalledSmokeSteps = vsixInstalledSteps.filter((step) => smokeInvocation.test(step.run ?? ""));
assert.equal(vsixInstalledSmokeSteps.length, 1, "vsix-installed has exactly one smoke step");
const vsixInstalledSmokeStep = vsixInstalledSmokeSteps[0];
assert.equal(vsixInstalledSmokeStep.env?.VSCODE_VERSION, "stable", "vsix-installed downloads the stable VS Code");
assert.ok(
  !("VSCODE_CLI" in (vsixInstalledSmokeStep.env ?? {})),
  "vsix-installed names no preinstalled VS Code CLI; the runner images ship none",
);
assert.ok(
  vsixInstalledSmokeStep.run.startsWith("${{ matrix.display }} node scripts/vsix-smoke.mjs"),
  "the vsix-installed smoke runs under the display command its matrix row names",
);
for (const row of workflowDocument.jobs["vsix-installed"].strategy.matrix.include) {
  assert.ok(!("cli" in row), `vsix-installed row ${row.target} must not name a preinstalled CLI`);
  const smokeCommand = vsixInstalledSmokeStep.run.replace("${{ matrix.display }}", row.display).trim();
  assert.equal(
    smokeCommand.startsWith("xvfb-run -a node scripts/vsix-smoke.mjs "),
    row.os.startsWith("ubuntu"),
    `vsix-installed row ${row.target} runs the smoke under xvfb-run -a exactly when it is a Linux row`,
  );
  assert.ok(
    /^(xvfb-run -a )?node scripts\/vsix-smoke\.mjs /.test(smokeCommand),
    `vsix-installed row ${row.target} has no display command other than xvfb-run -a`,
  );
}
const xvfbEnsureIndex = vsixInstalledSteps.findIndex((step) => String(step.run ?? "").includes("command -v xvfb-run"));
assert.ok(xvfbEnsureIndex >= 0, "vsix-installed must ensure xvfb-run exists");
assert.equal(vsixInstalledSteps[xvfbEnsureIndex].if, "runner.os == 'Linux'", "the xvfb step runs on Linux only");
assert.ok(
  vsixInstalledSteps[xvfbEnsureIndex].run.includes("apt-get install -y xvfb"),
  "the xvfb step installs xvfb when xvfb-run is missing",
);
assert.ok(
  xvfbEnsureIndex < vsixInstalledSteps.indexOf(vsixInstalledSmokeStep),
  "vsix-installed must ensure xvfb-run before the smoke needs it",
);
const vscodeMinimumSmokeStep = workflowDocument.jobs["vscode-minimum"].steps.find((step) =>
  smokeInvocation.test(step.run ?? ""),
);
assert.ok(
  vscodeMinimumSmokeStep?.run.startsWith("xvfb-run -a node scripts/vsix-smoke.mjs"),
  "vscode-minimum runs the smoke under xvfb-run -a; the runner has no display",
);
assert.equal(vscodeMinimumSmokeStep.env?.VSCODE_VERSION, "1.105.0", "vscode-minimum pins the declared minimum VS Code");
// A core suite that never exits (the Windows hang) must fail in minutes, not at the 45-minute job
// limit, and must name what kept it alive.
const coreSuiteStep = workflowDocument.jobs.native.steps.find((step) => step.run === "npm run test:core:compiled");
assert.equal(coreSuiteStep?.["timeout-minutes"], 15);
assert.equal(coreSuiteStep?.env?.RAGNAROK_REPORT_ACTIVE_RESOURCES, "1");
assert.match(await read("packages/core/test/setup.ts"), /export const mochaHooks/);
// The MCP and soak steps follow the core step on the same leg and have never run on Windows CI, so
// a hang there must also fail at 15 minutes and, for the MCP suite, name its handles.
const mcpSuiteStep = workflowDocument.jobs.native.steps.find((step) => step.run === "npm run test:mcp:compiled");
assert.ok(
  mcpSuiteStep?.["timeout-minutes"] <= 15,
  "the native leg's MCP suite step needs a timeout of 15 minutes or less",
);
assert.equal(mcpSuiteStep?.env?.RAGNAROK_REPORT_ACTIVE_RESOURCES, "1");
const soakStep = workflowDocument.jobs.native.steps.find((step) => step.run === "npm run test:shutdown-soak");
assert.ok(
  soakStep?.["timeout-minutes"] <= 15,
  "the native leg's shutdown soak step needs a timeout of 15 minutes or less",
);
assert.match(await read("packages/mcp-server/test/setup.ts"), /export const mochaHooks/);
// On Windows the core suite finishes but a native addon thread keeps the process alive, so both
// suites end themselves after a 10 s grace there. The exit carries Mocha's own code (no argument,
// never 0), and the timer is unref'd so a suite that exits on its own never reaches it.
for (const setupFile of ["packages/core/test/setup.ts", "packages/mcp-server/test/setup.ts"]) {
  const setupSource = await read(setupFile);
  assert.match(setupSource, /process\.platform === "win32"/, `${setupFile} applies the grace exit on Windows`);
  assert.match(setupSource, /RAGNAROK_TEST_FORCE_EXIT_GRACE/, `${setupFile} has the test-only grace-exit switch`);
  assert.match(setupSource, /\.unref\(\)/, `${setupFile} unrefs its timers`);
  assert.match(setupSource, /process\.exit\(\)/, `${setupFile} exits with Mocha's own code`);
  assert.doesNotMatch(setupSource, /process\.exit\(0\)/, `${setupFile} must not hard-code a passing exit code`);
}
const artifactBuildNeeds = workflowDocument.jobs["artifact-build"].needs;
assert.ok(!artifactBuildNeeds.includes("benchmarks"), "artifact-build must not depend on its benchmark consumer");
assert.equal(workflowDocument.jobs.benchmarks.needs, "artifact-build");
// GitHub's runners ship Docker with the classic image store: its `docker` buildx driver cannot export
// OCI, its `docker load` needs a manifest.json that an OCI layout lacks, and `docker push` re-encodes
// manifests (so the pushed digest would differ from the archived one). Each Docker job therefore
// switches the runner to the containerd image store before its first build, load or login.
for (const [jobName, dockerCommand] of [
  ["artifact-build", "docker buildx build"],
  ["docker-smoke", "docker load"],
  ["publish", "docker login"],
]) {
  const jobSteps = workflowDocument.jobs[jobName].steps;
  const switchIndex = jobSteps.findIndex((step) => step.run === "node scripts/use-containerd-image-store.mjs");
  const dockerIndex = jobSteps.findIndex((step) => String(step.run ?? "").includes(dockerCommand));
  assert.ok(switchIndex >= 0, `${jobName} must switch the runner to the containerd image store`);
  assert.ok(dockerIndex >= 0, `${jobName} must run ${dockerCommand}`);
  assert.ok(
    switchIndex < dockerIndex,
    `${jobName} must switch to the containerd image store before its first ${dockerCommand}`,
  );
}
const ociBuildStep = workflowDocument.jobs["artifact-build"].steps.find((step) =>
  String(step.run ?? "").includes("type=oci,dest=ragnarok-mcp.oci.tar"),
);
assert.ok(ociBuildStep, "artifact-build must export the release image as an OCI archive");
for (const flag of ["--provenance=false", "--sbom=false"]) {
  assert.ok(
    ociBuildStep.run.includes(flag),
    `the OCI image build must pass ${flag}, so the archive holds exactly one image manifest`,
  );
}
assert.ok(
  !ociBuildStep.run.includes("--builder"),
  "the OCI image build must use the default builder, which the containerd image store lets export OCI",
);
for (const [jobName, job] of Object.entries(workflowDocument.jobs)) {
  for (const step of job.steps ?? []) {
    assert.ok(
      !String(step.run ?? "").includes("docker buildx create"),
      `${jobName} must not create a container builder; the containerd image store replaces it`,
    );
  }
}
const withContainerdConfig = { "exec-opts": ["native.cgroupdriver=cgroupfs"], "cgroup-parent": "/actions_job" };
const withContainerdConfigBefore = structuredClone(withContainerdConfig);
assert.deepEqual(withContainerdSnapshotter(withContainerdConfig), {
  ...withContainerdConfigBefore,
  features: { "containerd-snapshotter": true },
});
assert.deepEqual(withContainerdSnapshotter({ features: { buildkit: true } }).features, {
  buildkit: true,
  "containerd-snapshotter": true,
});
assert.deepEqual(
  withContainerdConfig,
  withContainerdConfigBefore,
  "withContainerdSnapshotter must not mutate its input",
);
const benchmarkSteps = workflowDocument.jobs.benchmarks.steps;
const candidateDownloadIndex = benchmarkSteps.findIndex(
  (step) =>
    String(step.uses ?? "").startsWith("actions/download-artifact@") &&
    step.with?.name === "release-candidate-${{ github.sha }}" &&
    step.with?.path === "benchmark-artifacts",
);
const candidateDigestIndex = benchmarkSteps.findIndex((step) =>
  String(step.run ?? "").includes("verify-artifact-digests.mjs benchmark-artifacts/artifact-sha256.txt"),
);
const benchmarkRunIndex = benchmarkSteps.findIndex((step) => step.run === "npm run bench:release");
assert.ok(candidateDownloadIndex >= 0, "benchmark job must download the exact release candidate");
assert.ok(
  candidateDownloadIndex < candidateDigestIndex && candidateDigestIndex < benchmarkRunIndex,
  "benchmark must download and verify the candidate before measurement",
);
assert.equal(
  benchmarkSteps[benchmarkRunIndex].env.RAGNAROK_RELEASE_ARTIFACT_DIR,
  "benchmark-artifacts",
  "benchmark must measure tarballs from the downloaded candidate directory",
);
assert.ok(workflowDocument.jobs["release-gate"].needs.includes("benchmarks"));
assert.ok(workflowDocument.jobs.manifest.needs.includes("release-gate"));
assert.equal(workflowDocument.jobs.publish.needs, "manifest");

const releaseBenchmark = await read("scripts/run-release-benchmarks.mjs");
assert.match(releaseBenchmark, /status: blockers\.length === 0 \? "passed" : "blocked"/);
assert.match(releaseBenchmark, /RAGNAROK_RELEASE_ARTIFACT_DIR/);
assert.match(releaseBenchmark, /tarballNames\.length !== 2/);
assert.match(releaseBenchmark, /packageArtifacts\.push/);
assert.match(releaseBenchmark, /releasePerformanceBenchmark\.test\.js/);
assert.match(releaseBenchmark, /benchmarkWorkloads/);
assert.match(releaseBenchmark, /RAGNAROK_BENCHMARK_CHILD_ID/);
assert.match(releaseBenchmark, /rssMatches\.length !== 1/);
assert.match(releaseBenchmark, /childPeakMeasurements\.reduce/);
assert.match(releaseBenchmark, /childPeakRssRawUnit === "KiB"/);
assert.match(releaseBenchmark, /indexModelInitializationIncluded === false/);
for (const requiredBenchmarkFile of [
  "retrievalBenchmark.test.js",
  "vectorRetriever.test.js",
  "beirBenchmark.test.js",
  "rerankBenchmark.test.js",
  "framesBenchmark.test.js",
  "framesRerankBenchmark.test.js",
  "releasePerformanceBenchmark.test.js",
]) {
  assert.equal(
    releaseBenchmark.split(requiredBenchmarkFile).length - 1,
    1,
    `release workload partition must contain ${requiredBenchmarkFile} exactly once`,
  );
}
for (const blocker of ["missing_child_peak_rss", "missing_index_time", "missing_exact_package_measurement"]) {
  assert.match(releaseBenchmark, new RegExp(blocker));
}
const releasePerformanceBenchmark = await read("packages/core/benchmarks/releasePerformanceBenchmark.test.ts");
const releaseChildMetricsHook = await read("packages/core/benchmarks/releaseChildMetricsHook.ts");
assert.match(releasePerformanceBenchmark, /RAGNAROK_METRICS performance /);
assert.match(releaseChildMetricsHook, /process\.resourceUsage\(\)\.maxRSS/);
assert.match(releaseChildMetricsHook, /RAGNAROK_CHILD_METRICS/);

const createManifest = await read("scripts/create-release-manifest.mjs");
const verifyManifest = await read("scripts/release-manifest.mjs");
const publisher = await read("scripts/publish-release.mjs");
assert.match(createManifest, /OCI archive must contain exactly one SHA-256-addressed image manifest/);
assert.match(createManifest, /type: "benchmark"/);
assert.match(createManifest, /type: "cyclonedx"/);
assert.match(createManifest, /type: "spdx"/);
assert.doesNotMatch(createManifest, /sourceRef =/);
assert.match(verifyManifest, /exactly two npm, five VSIX, and one Docker artifact/);
assert.deepEqual(
  [...verifyManifest.matchAll(/"vsix-([a-z0-9-]+)"/g)].map((match) => match[1]).sort(),
  supportedVsixTargets,
);
assert.match(verifyManifest, /Benchmark evidence is incomplete or not bound to HEAD/);
assert.doesNotMatch(verifyManifest, /RAGNAROK_ALLOW_LOCAL_RELEASE/);
assert.doesNotMatch(verifyManifest, /RELEASE_MANIFEST_ATTESTED/);
assert.match(verifyManifest, /verifyReleaseAttestation/);
assert.match(createManifest, /predicateSha256/);
assert.doesNotMatch(createManifest, /attestationDigest/);
assert.match(publisher, /\["load", "--input", image\.path\]/);
assert.match(publisher, /\["push", image\.stagingRef\]/);
assert.match(publisher, /release-publication-journal\.json/);
assert.match(publisher, /await verifyReleaseManifest\(\)/);
assert.doesNotMatch(publisher, /imagetools", "create"/);

const {
  RELEASE_OIDC_ISSUER,
  RELEASE_PREDICATE_TYPE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW,
  buildAttestationVerificationArgs,
  verifyReleaseAttestation,
} = await import("./release-attestation.mjs");
const { assertBenchmarkPackageArtifacts, assertReleaseIdentity, expectedReleaseIdentity, requireProtectedReleaseTag } =
  await import("./release-metadata.mjs");
const { buildPublicationPlan, preflightPublication, publishDocker } = await import("./publish-release.mjs");
const attestationFixture = await mkdtemp(path.join(os.tmpdir(), "ragnarok-attestation-test-"));
try {
  const manifestPath = path.join(attestationFixture, "release-manifest.json");
  const bundlePath = path.join(attestationFixture, "release-manifest.attestation.jsonl");
  const manifestBytes = Buffer.from('{"schemaVersion":2}\n');
  const sourceSha = "a".repeat(40);
  const sourceRef = "refs/tags/v0.4.0";
  await writeFile(manifestPath, manifestBytes);
  await writeFile(bundlePath, '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n');
  const args = buildAttestationVerificationArgs({
    manifestPath,
    bundlePath,
    repository: RELEASE_REPOSITORY,
    workflow: RELEASE_WORKFLOW,
    sourceSha,
    sourceRef,
  });
  for (const binding of [
    ["--repo", RELEASE_REPOSITORY],
    ["--signer-workflow", RELEASE_WORKFLOW],
    ["--signer-digest", sourceSha],
    ["--source-digest", sourceSha],
    ["--source-ref", sourceRef],
    ["--cert-oidc-issuer", RELEASE_OIDC_ISSUER],
    ["--predicate-type", RELEASE_PREDICATE_TYPE],
  ]) {
    const index = args.indexOf(binding[0]);
    assert.ok(index >= 0, `missing attestation binding ${binding[0]}`);
    assert.equal(args[index + 1], binding[1]);
  }
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const verifiedOutput = JSON.stringify([
    {
      verificationResult: {
        signature: { certificate: { issuer: RELEASE_OIDC_ISSUER } },
        statement: { subject: [{ digest: { sha256: manifestDigest } }] },
      },
    },
  ]);
  const verified = await verifyReleaseAttestation({
    manifestPath,
    bundlePath,
    repository: RELEASE_REPOSITORY,
    workflow: RELEASE_WORKFLOW,
    sourceSha,
    sourceRef,
    execute(command, commandArgs) {
      assert.equal(command, "gh");
      assert.deepEqual(commandArgs, args);
      return verifiedOutput;
    },
  });
  assert.equal(verified.manifestSha256, manifestDigest);
  await assert.rejects(
    verifyReleaseAttestation({
      manifestPath,
      bundlePath,
      repository: RELEASE_REPOSITORY,
      workflow: RELEASE_WORKFLOW,
      sourceSha,
      sourceRef,
      execute() {
        const error = new Error("invalid signature");
        error.stderr = "signature verification failed";
        throw error;
      },
    }),
    /attestation verification failed.*signature verification failed/,
  );
  await assert.rejects(
    verifyReleaseAttestation({
      manifestPath,
      bundlePath,
      repository: RELEASE_REPOSITORY,
      workflow: RELEASE_WORKFLOW,
      sourceSha,
      sourceRef,
      execute() {
        return JSON.stringify([
          {
            verificationResult: {
              signature: { certificate: {} },
              statement: { subject: [{ digest: { sha256: "0".repeat(64) } }] },
            },
          },
        ]);
      },
    }),
    /not bound to the release manifest digest/,
  );
  const publicationManifest = {
    sourceSha,
    release: { vscode: { publisher: "hyorman", extensionId: "hyorman.ragnarok", version: "0.4.0" } },
    artifacts: [
      {
        type: "npm",
        packageName: "@ragnarok/core",
        version: "0.4.0",
        registry: "https://registry.npmjs.org",
        path: "core.tgz",
        sha256: "1".repeat(64),
      },
      {
        type: "npm",
        packageName: "@ragnarok/mcp-server",
        version: "0.4.0",
        registry: "https://registry.npmjs.org",
        path: "mcp.tgz",
        sha256: "2".repeat(64),
      },
    ],
  };
  const expectedIdentity = await expectedReleaseIdentity(root);
  assert.throws(
    () => assertReleaseIdentity({ ...expectedIdentity, tag: "v9.9.9" }, expectedIdentity),
    /tag\/package\/registry coordinates/,
  );
  assert.throws(
    () =>
      requireProtectedReleaseTag(expectedIdentity, {
        GITHUB_REPOSITORY: expectedIdentity.repository,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF: "refs/tags/v9.9.9",
        GITHUB_REF_NAME: "v9.9.9",
        GITHUB_REF_PROTECTED: "true",
      }),
    /environment identity did not match/,
  );
  const measuredArtifacts = [
    {
      packageName: "@ragnarok/core",
      path: "artifacts/ragnarok-core-0.4.0.tgz",
      sha256: "1".repeat(64),
      size: 101,
    },
    {
      packageName: "@ragnarok/mcp-server",
      path: "artifacts/ragnarok-mcp-server-0.4.0.tgz",
      sha256: "2".repeat(64),
      size: 202,
    },
  ];
  const measuredBenchmark = {
    packageSizes: { coreTarballBytes: 101, mcpTarballBytes: 202 },
    packageArtifacts: [
      {
        filename: "ragnarok-core-0.4.0.tgz",
        sha256: "1".repeat(64),
        size: 101,
        measurement: "coreTarballBytes",
      },
      {
        filename: "ragnarok-mcp-server-0.4.0.tgz",
        sha256: "2".repeat(64),
        size: 202,
        measurement: "mcpTarballBytes",
      },
    ],
  };
  assert.doesNotThrow(() => assertBenchmarkPackageArtifacts(measuredBenchmark, measuredArtifacts));
  assert.throws(
    () =>
      assertBenchmarkPackageArtifacts(
        {
          ...measuredBenchmark,
          packageArtifacts: [
            { ...measuredBenchmark.packageArtifacts[0], sha256: "0".repeat(64) },
            measuredBenchmark.packageArtifacts[1],
          ],
        },
        measuredArtifacts,
      ),
    /not bound to artifact/,
  );
  const publicationPlan = buildPublicationPlan(publicationManifest, "npm");
  await assert.rejects(
    preflightPublication({
      manifest: publicationManifest,
      plan: publicationPlan,
      journal: { channels: [] },
      environment: {},
      execute() {
        throw new Error("preflight must reject before invoking a command");
      },
    }),
    /npm publication token is missing/,
  );
  const dockerCommands = [];
  const dockerImage = {
    type: "docker",
    path: "artifacts/ragnarok-mcp.oci.tar",
    localRef: "ragnarok-mcp:ci",
    stagingRef: "ghcr.io/hyorman/ragnarok-mcp:staging-aaaaaaaa",
    immutableRef: "ghcr.io/hyorman/ragnarok-mcp:sha-aaaaaaaa",
    publishRef: "ghcr.io/hyorman/ragnarok-mcp:0.4.0",
    digest: `sha256:${"1".repeat(64)}`,
    sha256: "2".repeat(64),
  };
  await assert.rejects(
    publishDocker({
      image: dockerImage,
      journal: { channels: [] },
      journalPath: path.join(attestationFixture, "journal.json"),
      execute(command, commandArgs, options) {
        dockerCommands.push([command, ...commandArgs]);
        if (options?.encoding === "utf8") {
          return `Name: staging\nDigest: sha256:${"0".repeat(64)}\n`;
        }
        return "";
      },
    }),
    /staging digest.*did not match.*intended tags were not changed/i,
  );
  assert.ok(
    dockerCommands.some((command) => command[1] === "push" && command[2] === dockerImage.stagingRef),
    "Docker staging tag was not pushed",
  );
  assert.ok(
    !dockerCommands.some(
      (command) =>
        command[1] === "push" && (command[2] === dockerImage.immutableRef || command[2] === dockerImage.publishRef),
    ),
    "Docker intended tags changed before staging digest verification",
  );
  const successfulCommands = [];
  const successfulJournal = { channels: [] };
  const successfulJournalPath = path.join(attestationFixture, "successful-journal.json");
  await publishDocker({
    image: dockerImage,
    journal: successfulJournal,
    journalPath: successfulJournalPath,
    execute(command, commandArgs, options) {
      successfulCommands.push([command, ...commandArgs]);
      if (options?.encoding === "utf8") {
        return `Name: verified\nDigest: ${dockerImage.digest}\n`;
      }
      return "";
    },
  });
  assert.deepEqual(
    successfulCommands.filter((command) => command[1] === "push").map((command) => command[2]),
    [dockerImage.stagingRef, dockerImage.immutableRef, dockerImage.publishRef],
  );
  assert.deepEqual(
    JSON.parse(await readFile(successfulJournalPath, "utf8")).channels.map((entry) => [
      entry.channel,
      entry.coordinate,
      entry.status,
    ]),
    [
      ["docker-staging", dockerImage.stagingRef, "verified"],
      ["docker", dockerImage.immutableRef, "published"],
      ["docker", dockerImage.publishRef, "published"],
    ],
  );
} finally {
  await rm(attestationFixture, { recursive: true, force: true });
}

const assetCheck = await read("scripts/check-release-assets.mjs");
assert.match(assetCheck, /vsixUnpackedBytes/);
assert.match(assetCheck, /exactly one core and one MCP npm tarball/);

// The VSIX file name is the one contract between its producer (build-vsix) and the four places that
// find a file by target. vsce's own default name puts the target before the version, which none of
// them accepts, so the producer fixes the name with --out and this test applies every consumer's rule.
assert.equal(typeof packaging.vsixFileName, "function", "build-vsix exports vsixFileName");
assert.equal(
  packaging.vsixFileName({ name: "ragnarok", version: "0.4.1" }, "linux-x64"),
  "ragnarok-0.4.1-linux-x64.vsix",
);
const packageVsixSource =
  builder.match(/function packageVsix\(stagingDir, targetPlatform\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
assert.ok(packageVsixSource, "packageVsix must be locatable in build-vsix.js");
assert.match(packageVsixSource, /vsixFileName\(/, "packageVsix names the file with vsixFileName");
assert.deepEqual(
  packaging.vscePackageArgs({ name: "ragnarok", version: "0.4.1" }, "linux-x64"),
  ["package", "--target", "linux-x64", "--out", "ragnarok-0.4.1-linux-x64.vsix"],
  "vsce packages the target under the name every release consumer finds it by",
);
assert.match(
  packageVsixSource,
  /vscePackageArgs\(manifest, targetPlatform\.target\)/,
  "packageVsix passes vsce the arguments vscePackageArgs builds",
);
assert.doesNotMatch(
  packageVsixSource,
  /endsWith\("\.vsix"\)/,
  "packageVsix copies the exact file, not the first .vsix",
);
const globToRegExp = (glob) =>
  new RegExp(
    `^${path.posix
      .basename(glob)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`,
  );
const workflowSmokeGlob = (job) => {
  const globs = workflowDocument.jobs[job].steps
    .map(
      (step) =>
        /^(?:\$\{\{ matrix\.display \}\} |xvfb-run -a )?node scripts\/vsix-smoke\.mjs (artifacts\/.+)$/.exec(
          step.run ?? "",
        )?.[1],
    )
    .filter(Boolean);
  assert.equal(globs.length, 1, `${job} smokes exactly one VSIX glob`);
  return globs[0];
};
const installedGlob = workflowSmokeGlob("vsix-installed");
const minimumGlob = workflowSmokeGlob("vscode-minimum");
assert.match(installedGlob, /^artifacts\/\*-\$\{\{ matrix\.target \}\}\.vsix$/);
assert.match(minimumGlob, /^artifacts\/\*-linux-x64\.vsix$/);
assert.match(createManifest, /policy\.vsixTargets\.find\(\(target\) => name\.includes\(`-\$\{target\}\.vsix`\)\)/);
assert.match(
  vsixSmoke,
  /\["x64", "arm64"\]\.find\(\(arch\) => path\.basename\(vsix\)\.includes\(`-\$\{arch\}\.vsix`\)\)/,
);
assert.match(assetCheck, /name\.includes\(`-\$\{target\}-`\) \|\| name\.includes\(`-\$\{target\}\.`\)/);
const vsixNames = policy.vsixTargets.map((target) => packaging.vsixFileName(pkg, target));
assert.equal(new Set(vsixNames).size, policy.vsixTargets.length, "each target has its own VSIX name");
for (const target of policy.vsixTargets) {
  const name = packaging.vsixFileName(pkg, target);
  assert.equal(name, `${pkg.name}-${pkg.version}-${target}.vsix`);
  assert.deepEqual(
    vsixNames.filter((candidate) =>
      globToRegExp(installedGlob.replace("${{ matrix.target }}", target)).test(candidate),
    ),
    [name],
    `the vsix-installed glob finds exactly the ${target} VSIX`,
  );
  assert.equal(globToRegExp(minimumGlob).test(name), target === "linux-x64", `vscode-minimum globs only linux-x64`);
  assert.equal(
    policy.vsixTargets.find((candidate) => name.includes(`-${candidate}.vsix`)),
    target,
    `create-release-manifest identifies the ${target} VSIX`,
  );
  assert.equal(
    ["x64", "arm64"].find((arch) => path.basename(name).includes(`-${arch}.vsix`)),
    target.split("-")[1],
    `vsix-smoke reads the architecture of the ${target} VSIX`,
  );
  assert.equal(
    vsixNames.filter((candidate) => candidate.includes(`-${target}-`) || candidate.includes(`-${target}.`)).length,
    1,
    `check-release-assets finds exactly one VSIX for ${target}`,
  );
}

// Corpus downloads retry what a rate-limited or failing host will accept again, and nothing else. The
// fake fetch and the recording sleep make every wait observable without waiting.
const scriptedFetch = (...responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next();
  };
  return { calls, fetchImpl };
};
const reply =
  (status, headers = {}) =>
  () =>
    new Response(status === 200 ? "corpus" : "refused", { status, headers });
const downloadUrl = "https://en.wikipedia.org/api/rest_v1/page/summary/Irish_Book_Awards";
const recordedDownload = async (script, options = {}) => {
  const delays = [];
  const { calls, fetchImpl } = scriptedFetch(...script);
  const settled = await downloadWithRetry(downloadUrl, {
    fetchImpl,
    sleep: async (milliseconds) => void delays.push(milliseconds),
    ...options,
  }).then(
    (body) => ({ body }),
    (error) => ({ error }),
  );
  return { ...settled, calls, delays };
};

const retryAfterSeconds = await recordedDownload([reply(429, { "retry-after": "2" }), reply(200)]);
assert.equal(retryAfterSeconds.body?.toString("utf8"), "corpus");
assert.deepEqual(retryAfterSeconds.delays, [2000]);
assert.equal(retryAfterSeconds.calls.length, 2);

const serverErrors = await recordedDownload([reply(503), reply(503), reply(200)]);
assert.equal(serverErrors.body?.toString("utf8"), "corpus");
assert.deepEqual(serverErrors.delays, [1000, 2000]);

const notFound = await recordedDownload([reply(404)]);
assert.equal(notFound.error?.message, `Benchmark download ${downloadUrl} returned 404`);
assert.deepEqual(notFound.delays, []);
assert.equal(notFound.calls.length, 1);

const alwaysLimited = await recordedDownload([reply(429)], { attempts: 3 });
assert.equal(alwaysLimited.error?.message, `Benchmark download ${downloadUrl} returned 429 after 3 attempts`);
assert.equal(alwaysLimited.calls.length, 3);
assert.deepEqual(alwaysLimited.delays, [1000, 2000], "no wait follows the last attempt");

assert.deepEqual((await recordedDownload([reply(429, { "retry-after": "600" }), reply(200)])).delays, [60_000]);
assert.deepEqual(
  (await recordedDownload([reply(429, { "retry-after": "600" }), reply(200)], { maxDelayMs: 5000 })).delays,
  [5000],
);
assert.deepEqual(
  (await recordedDownload([reply(503)], { attempts: 8, maxDelayMs: 4000 })).delays,
  [1000, 2000, 4000, 4000, 4000, 4000, 4000],
  "exponential backoff is capped as well",
);

const clock = Date.parse("2026-10-04T12:00:00Z");
const retryAfterDate = (value) =>
  recordedDownload([reply(429, { "retry-after": value }), reply(200)], { now: () => clock });
assert.deepEqual((await retryAfterDate(new Date(clock + 7000).toUTCString())).delays, [7000]);
assert.deepEqual((await retryAfterDate(new Date(clock - 7000).toUTCString())).delays, [0], "a past date waits zero");
assert.deepEqual((await retryAfterDate("soon")).delays, [1000], "an unreadable Retry-After falls back to backoff");

const networkError = new TypeError("fetch failed");
const recovered = await recordedDownload([networkError, reply(200)]);
assert.equal(recovered.body?.toString("utf8"), "corpus");
assert.deepEqual(recovered.delays, [1000]);
const unreachable = await recordedDownload([networkError], { attempts: 2 });
assert.match(unreachable.error?.message ?? "", /fetch failed after 2 attempts$/);
assert.equal(unreachable.error?.cause, networkError);
assert.deepEqual(unreachable.delays, [1000]);

const identified = await recordedDownload([reply(200)]);
const [identifiedCall] = identified.calls;
assert.equal(identifiedCall.url, downloadUrl);
assert.equal(identifiedCall.init.redirect, "follow");
assert.ok(identifiedCall.init.signal instanceof AbortSignal, "every attempt has its own timeout");
assert.equal(identifiedCall.init.headers["user-agent"], BENCHMARK_USER_AGENT);
assert.match(BENCHMARK_USER_AGENT, /^RAGnarok-release-benchmark\/0\.4 \(https:\/\/github\.com\/hyorman\/RAGnarok\)$/);

const acquireCorpora = await read("scripts/acquire-benchmark-corpora.mjs");
assert.match(acquireCorpora, /import \{ downloadWithRetry \} from "\.\/benchmark-download\.mjs"/);
assert.doesNotMatch(
  acquireCorpora,
  /\bfetch\(|const download = /,
  "every corpus download goes through downloadWithRetry",
);
assert.equal([...acquireCorpora.matchAll(/downloadWithRetry\(/g)].length, 3, "SciFact, FRAMES and every article");
// A drifted sample has to be diagnosable from the failure alone: it names what was computed and what is pinned.
assert.match(
  acquireCorpora,
  /does not match the pinned sample \(got \$\{articleDigests\.length\} articles, \$\{articleSetSha256\}; `\s*\+\s*`pinned \$\{frames\.sampleArticleCount\}, \$\{frames\.sampleArticlesSha256\}\)\./,
);
assert.match(acquireCorpora, /Do not update checksums without reviewed source evidence\./);

const notice = await read("NOTICE");
const models = JSON.parse(await read("packages/core/assets/models/manifest.json"));
for (const model of models.models) {
  assert.match(notice, new RegExp(model.revision));
  assert.match(notice, new RegExp(model.license.replace("-", "\\-")));
}
const cdx = JSON.parse(await read("bom.cdx.json"));
const spdx = JSON.parse(await read("bom.spdx.json"));
assert.equal(cdx.bomFormat, "CycloneDX");
assert.equal(cdx.specVersion, "1.6");
assert.equal(spdx.spdxVersion, "SPDX-2.3");
// Every locked package and every bundled model, exactly: a fixed floor would
// either miss a truncated SBOM or fail when the dependency tree shrinks.
const lockedPackageCount = Object.entries(JSON.parse(await read("package-lock.json")).packages).filter(
  ([location, entry]) => location.includes("node_modules/") && entry.version,
).length;
assert.equal(cdx.components.length, lockedPackageCount + models.models.length);
assert.equal(spdx.packages.length, lockedPackageCount + models.models.length);
const componentRefs = cdx.components.map((component) => component["bom-ref"]);
assert.equal(new Set(componentRefs).size, componentRefs.length, "CycloneDX component bom-ref values must be unique");
const componentRefSet = new Set(componentRefs);
for (const dependency of cdx.dependencies ?? []) {
  assert.ok(componentRefSet.has(dependency.ref), `CycloneDX dependency source ref must exist: ${dependency.ref}`);
  for (const target of dependency.dependsOn ?? []) {
    assert.ok(componentRefSet.has(target), `CycloneDX dependency target ref must exist: ${target}`);
  }
}
for (const model of models.models) {
  assert.ok(cdx.components.some((component) => component.name === model.id && component.version === model.revision));
  assert.ok(spdx.packages.some((component) => component.name === model.id && component.versionInfo === model.revision));
}

const architecture = await read("ARCHITECTURE.md");
// Roles, audit records, and transfer handles left with the HTTP transport.
// The architecture must state the single-authority stdio model instead of
// re-describing a principal/role audit trail the server no longer emits.
assert.match(architecture, /The MCP server serves stdio only/);
assert.match(architecture, /The server emits no audit ledger/);
assert.doesNotMatch(architecture, /MCP request audit records contain a hashed principal, role/);
assert.doesNotMatch(architecture, /Transfer and operator token-rotation records/);

execFileSync("node", ["scripts/verify-model-manifest.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/check-licenses.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/check-secrets.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/check-docs.mjs"], { cwd: root, stdio: "inherit" });
console.log("Release/package static contracts passed.");
