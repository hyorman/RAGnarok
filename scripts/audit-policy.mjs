const BLOCKING = new Set(["moderate", "high", "critical"]);
const SEVERITIES = new Set(["none", "info", "low", ...BLOCKING]);
const AUDIT_COUNT_SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const GHSA = /^GHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;
const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const ADVISORY_RANGE = new RegExp(
  `^(?:<=|>=|<|>|=)${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`,
);
const EXACT_VERSION = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`,
);
const REQUIRED_EXCEPTION_FIELDS = [
  "advisory",
  "dependency",
  "range",
  "via",
  "reason",
  "invalidatedBy",
  "owner",
  "expires",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactString(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function advisoryFromUrl(url) {
  if (typeof url !== "string") return undefined;
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/.exec(url);
  return match?.[1];
}

function parseVia(value) {
  if (!isExactString(value)) return undefined;
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);
  return isExactString(name) && EXACT_VERSION.test(version) ? { name, version } : undefined;
}

function isFixAvailable(value) {
  if (typeof value === "boolean") return true;
  if (!isRecord(value)) return false;
  const fields = Object.keys(value).sort();
  return (
    fields.length === 3 &&
    fields[0] === "isSemVerMajor" &&
    fields[1] === "name" &&
    fields[2] === "version" &&
    isExactString(value.name) &&
    isExactString(value.version) &&
    typeof value.isSemVerMajor === "boolean"
  );
}

function hasValidVulnerabilityNodes(vulnerabilities) {
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (
      !isRecord(vulnerability) ||
      !isExactString(vulnerability.name) ||
      vulnerability.name !== name ||
      !AUDIT_COUNT_SEVERITIES.includes(vulnerability.severity) ||
      typeof vulnerability.isDirect !== "boolean" ||
      !Array.isArray(vulnerability.via) ||
      !Array.isArray(vulnerability.effects) ||
      vulnerability.effects.some((effect) => !isExactString(effect)) ||
      !isExactString(vulnerability.range) ||
      !Array.isArray(vulnerability.nodes) ||
      vulnerability.nodes.some((node) => !isExactString(node)) ||
      !isFixAvailable(vulnerability.fixAvailable)
    ) {
      return false;
    }
  }
  return true;
}

function hasReconciledVulnerabilityCounts(report) {
  const counts = report.metadata?.vulnerabilities;
  if (!isRecord(counts)) return false;
  for (const severity of [...AUDIT_COUNT_SEVERITIES, "total"]) {
    if (!Number.isInteger(counts[severity]) || counts[severity] < 0) return false;
  }
  if (AUDIT_COUNT_SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0) !== counts.total) return false;

  const observed = Object.fromEntries(AUDIT_COUNT_SEVERITIES.map((severity) => [severity, 0]));
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    if (!isRecord(vulnerability) || !AUDIT_COUNT_SEVERITIES.includes(vulnerability.severity)) return false;
    observed[vulnerability.severity]++;
  }
  return (
    Object.keys(report.vulnerabilities).length === counts.total &&
    AUDIT_COUNT_SEVERITIES.every((severity) => observed[severity] === counts[severity])
  );
}

export function normalizeLocalTarballAuditRanges(report, localVersions) {
  const normalized = structuredClone(report);
  if (!isRecord(normalized) || !isRecord(normalized.vulnerabilities) || !isRecord(localVersions)) return normalized;

  for (const [name, version] of Object.entries(localVersions)) {
    const vulnerability = normalized.vulnerabilities[name];
    if (
      !isExactString(version) ||
      !EXACT_VERSION.test(version) ||
      !isRecord(vulnerability) ||
      vulnerability.name !== name ||
      vulnerability.isDirect !== true ||
      vulnerability.range !== "" ||
      !Array.isArray(vulnerability.nodes) ||
      vulnerability.nodes.length !== 1 ||
      vulnerability.nodes[0] !== `node_modules/${name}`
    ) {
      continue;
    }
    vulnerability.range = version;
  }
  return normalized;
}

function malformedException(exception) {
  if (!isRecord(exception) || REQUIRED_EXCEPTION_FIELDS.some((field) => !isExactString(exception[field]))) {
    return true;
  }
  if (!GHSA.test(exception.advisory)) return true;
  if (exception.dependency.includes("*") || !ADVISORY_RANGE.test(exception.range)) return true;
  if (!parseVia(exception.via)) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) return true;
  const expires = Date.parse(`${exception.expires}T23:59:59.999Z`);
  return !Number.isFinite(expires) || new Date(expires).toISOString().slice(0, 10) !== exception.expires;
}

function resolveAdvisories(name, vulnerabilities, visiting = new Set(), chain = []) {
  if (visiting.has(name)) {
    return {
      advisories: [],
      rejected: [{ dependency: name, reason: "Cyclic vulnerability graph" }],
      hasAdvisorySource: false,
    };
  }

  const vulnerability = vulnerabilities[name];
  if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
    return {
      advisories: [],
      rejected: [{ dependency: name, reason: "Malformed vulnerability source" }],
      hasAdvisorySource: false,
    };
  }

  const next = new Set(visiting).add(name);
  const advisories = [];
  const rejected = [];
  let hasAdvisorySource = false;
  for (const via of vulnerability.via) {
    if (isExactString(via)) {
      if (!Object.hasOwn(vulnerabilities, via)) {
        rejected.push({ dependency: via, reason: "Missing vulnerability reference" });
        continue;
      }
      const resolved = resolveAdvisories(via, vulnerabilities, next, [...chain, name]);
      advisories.push(...resolved.advisories);
      rejected.push(...resolved.rejected);
      hasAdvisorySource ||= resolved.hasAdvisorySource;
    } else if (isRecord(via)) {
      const advisory = advisoryFromUrl(via.url);
      if (
        !advisory ||
        !isExactString(via.dependency) ||
        !isExactString(via.range) ||
        !ADVISORY_RANGE.test(via.range) ||
        !SEVERITIES.has(via.severity)
      ) {
        rejected.push({ dependency: name, reason: "Malformed advisory source" });
        continue;
      }
      hasAdvisorySource = true;
      if (BLOCKING.has(via.severity)) {
        advisories.push({
          advisory,
          dependency: via.dependency,
          range: via.range,
          chain: [...chain, name, ...(via.dependency === name ? [] : [via.dependency])],
        });
      }
    } else {
      rejected.push({ dependency: name, reason: "Malformed vulnerability reference" });
    }
  }

  if (!hasAdvisorySource && rejected.length === 0) {
    rejected.push({ dependency: name, reason: "No advisory source" });
  }
  return { advisories, rejected, hasAdvisorySource };
}

function installedVersions(tree) {
  if (!isRecord(tree)) return undefined;
  const versions = new Map();
  const visiting = new Set();
  const visit = (node) => {
    if (!isRecord(node) || visiting.has(node)) return isRecord(node);
    visiting.add(node);
    if (node.dependencies === undefined) return true;
    if (!isRecord(node.dependencies)) return false;
    for (const [name, dependency] of Object.entries(node.dependencies)) {
      if (!isRecord(dependency) || !isExactString(dependency.version)) return false;
      const packageVersions = versions.get(name) ?? new Set();
      packageVersions.add(dependency.version);
      versions.set(name, packageVersions);
      if (!visit(dependency)) return false;
    }
    return true;
  };
  return visit(tree) ? versions : undefined;
}

export function evaluateAuditReport(report, policy, now = new Date(), installedTree) {
  const allowed = [];
  const rejected = [];
  if (
    !isRecord(report) ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !hasValidVulnerabilityNodes(report.vulnerabilities) ||
    !hasReconciledVulnerabilityCounts(report)
  ) {
    return { allowed, rejected: [{ dependency: "<audit-report>", reason: "Malformed npm audit report" }] };
  }
  if (!isRecord(policy) || !Array.isArray(policy.auditExceptions) || policy.auditExceptions.some(malformedException)) {
    return { allowed, rejected: [{ dependency: "<audit-policy>", reason: "Malformed audit policy" }] };
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { allowed, rejected: [{ dependency: "<audit-policy>", reason: "Malformed evaluation date" }] };
  }

  const exceptionKeys = new Set();
  for (const exception of policy.auditExceptions) {
    const key = `${exception.advisory}\0${exception.dependency}\0${exception.range}`;
    if (exceptionKeys.has(key)) {
      return { allowed, rejected: [{ dependency: "<audit-policy>", reason: "Duplicate audit exception" }] };
    }
    exceptionKeys.add(key);
  }

  const findings = new Map();
  const seenRejections = new Set();
  const reject = (finding) => {
    const key = `${finding.advisory ?? ""}\0${finding.dependency}\0${finding.range ?? ""}\0${finding.reason}`;
    if (!seenRejections.has(key)) {
      seenRejections.add(key);
      rejected.push(finding);
    }
  };

  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(vulnerability) || !SEVERITIES.has(vulnerability.severity) || !Array.isArray(vulnerability.via)) {
      reject({ dependency: name, reason: "Malformed vulnerability entry" });
      continue;
    }
    const resolved = resolveAdvisories(name, report.vulnerabilities);
    for (const finding of resolved.rejected) reject(finding);
    for (const finding of resolved.advisories) {
      const key = `${finding.advisory ?? ""}\0${finding.dependency}\0${finding.range}`;
      const existing = findings.get(key);
      if (existing) {
        existing.chains.push(finding.chain);
      } else {
        findings.set(key, { ...finding, chains: [finding.chain] });
      }
    }
  }

  const versions = installedVersions(installedTree);
  for (const finding of findings.values()) {
    const exception = policy.auditExceptions.find(
      (candidate) =>
        candidate.advisory === finding.advisory &&
        candidate.dependency === finding.dependency &&
        candidate.range === finding.range,
    );
    const resultFinding = {
      advisory: finding.advisory,
      dependency: finding.dependency,
      range: finding.range,
    };
    const expires = exception && Date.parse(`${exception.expires}T23:59:59.999Z`);
    if (!exception) {
      reject({ ...resultFinding, reason: "No exact audit exception" });
    } else if (expires < now.getTime()) {
      reject({ ...resultFinding, reason: "Audit exception expired" });
    } else {
      const approvedVia = parseVia(exception.via);
      if (!approvedVia || !finding.chains.some((chain) => chain.includes(approvedVia.name))) {
        reject({ ...resultFinding, reason: "Approved via package is not in advisory chain" });
      } else if (
        versions?.get(approvedVia.name)?.size !== 1 ||
        !versions.get(approvedVia.name).has(approvedVia.version)
      ) {
        reject({ ...resultFinding, reason: "Approved via version is not installed" });
      } else {
        allowed.push({ ...resultFinding, reason: exception.reason });
      }
    }
  }
  return { allowed, rejected };
}
