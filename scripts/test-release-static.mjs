import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auditPolicyModule from "./audit-policy.mjs";
import * as releaseStaticPolicy from "./release-static-policy.mjs";

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
assert.deepEqual(
  evaluateAuditReport(
    normalizeLocalTarballAuditRanges(localTarballAuditReport, localTarballVersions),
    policy,
    auditNow,
    productionInstalledTree,
  ),
  {
    allowed: [],
    rejected: retiredFindingsRejected,
  },
  "known direct local-tarball roots must use their exact installed versions",
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
const transformersLs = spawnSync("npm", ["ls", "@huggingface/transformers", "--omit=dev", "--all", "--json"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(
  transformersLs.status,
  0,
  `npm ls @huggingface/transformers must be valid: ${transformersLs.stderr.trim()}`,
);
assert.match(
  packSmoke,
  /overrides: \{\s*"@langchain\/community": \{ "@huggingface\/transformers": coreManifest\.dependencies\["@huggingface\/transformers"\] \}/,
  "the pack-smoke consumer must carry the root's Transformers peer override",
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
assert.match(vsixSmoke, /transformersRequire\("sharp"\)/);
assert.match(vsixSmoke, /transformersRequire\("onnxruntime-node"\)/);
assert.match(vsixSmoke, /listSupportedBackends/);
// VS Code 1.110+ names the macOS binary after the product and 1.140 dropped the
// Contents/MacOS/Electron link, so the extension-host smoke must launch the real binary.
const testElectronUtil = require("@vscode/test-electron/out/util.js");
const vscodeDownload = await mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-layout-"));
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
await rm(vscodeDownload, { recursive: true, force: true });
// Node refuses to spawn a .cmd file without a shell (CVE-2024-27980), and the Windows
// VS Code CLI is code.cmd: every CLI call goes through runCli.
assert.match(vsixSmoke, /const viaShell = process\.platform === "win32" && \/\\\.cmd\$\/i\.test\(code\);/);
assert.doesNotMatch(vsixSmoke, /runArgs\(/, "vsix-smoke must reach the VS Code CLI only through runCli");
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
assert.match(
  dockerfile,
  /find node_modules\/@huggingface\/transformers\/dist -type f \\\n\s+! -name transformers\.node\.mjs ! -name transformers\.node\.cjs -delete/,
);
assert.match(dockerfile, /test -f node_modules\/@huggingface\/transformers\/dist\/transformers\.node\.mjs/);
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
  /assertStorageLock/,
  /assertRuntimeHardening/,
  /closeCleanly/,
  /ExposedPorts/,
  /Healthcheck/,
]) {
  assert.match(dockerGate, contract, `Docker stdio gate must assert ${contract}`);
}
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
const artifactBuildNeeds = workflowDocument.jobs["artifact-build"].needs;
assert.ok(!artifactBuildNeeds.includes("benchmarks"), "artifact-build must not depend on its benchmark consumer");
assert.equal(workflowDocument.jobs.benchmarks.needs, "artifact-build");
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
