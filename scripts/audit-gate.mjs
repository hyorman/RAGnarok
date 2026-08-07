#!/usr/bin/env node
/**
 * Production dependency audit gate.
 *
 * A bare `npm audit --audit-level=moderate` cannot express "this advisory is
 * reviewed and accepted", so it fails on findings that release-policy.json has
 * already approved. This gate runs the same production audit and then holds the
 * report against the policy, so the supply-chain job enforces exactly what
 * pack-smoke enforces for the clean consumer.
 *
 * Fails when an advisory has no exact exception, when an exception has expired,
 * or when the approved `via` package/version is not the one installed.
 *
 * Usage: node scripts/audit-gate.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAuditReport } from "./audit-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runJson(command, args, { allowStatus = [0] } = {}) {
  const run = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  const label = [command, ...args].join(" ");
  if (run.error) throw new Error(`could not run \`${label}\`: ${run.error.message}`);
  if (run.signal) throw new Error(`\`${label}\` terminated by signal ${run.signal}`);
  if (!allowStatus.includes(run.status)) {
    throw new Error(`\`${label}\` failed with status ${run.status}: ${run.stderr.trim()}`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`\`${label}\` did not return valid JSON`);
  }
}

const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "release-policy.json"), "utf8"));

// Only the packages an exception is approved *through* need resolving: the
// evaluator rejects an exception whose approved via version is not installed.
const auditViaPackages = [
  ...new Set(
    policy.auditExceptions.map((exception) => {
      const separator = typeof exception.via === "string" ? exception.via.lastIndexOf("@") : -1;
      if (separator <= 0) throw new Error("release audit policy contains a malformed via package");
      return exception.via.slice(0, separator);
    }),
  ),
];

const installedTree = runJson("npm", ["ls", ...auditViaPackages, "--omit=dev", "--all", "--json"]);
// npm audit exits 1 whenever it reports findings, which is the normal case here.
const auditReport = runJson("npm", ["audit", "--omit=dev", "--json"], { allowStatus: [0, 1] });

const { allowed, rejected } = evaluateAuditReport(auditReport, policy, new Date(), installedTree);

for (const finding of allowed) {
  console.log(`Allowed until policy expiry: ${finding.advisory} via ${finding.dependency} ${finding.range}`);
}
if (rejected.length > 0) {
  const detail = rejected
    .map(
      (finding) =>
        `  ${finding.advisory ?? "<no advisory>"} ${finding.dependency} ${finding.range ?? ""} — ${finding.reason}`,
    )
    .join("\n");
  throw new Error(
    `Production audit rejected ${rejected.length} finding(s):\n${detail}\n` +
      "Patch the dependency, or add an exact, time-limited exception to release-policy.json.",
  );
}
console.log(`Production dependency audit policy passed (${allowed.length} approved exception(s), 0 rejected).`);
