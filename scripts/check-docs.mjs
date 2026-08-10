import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = [
  "README.md",
  "ARCHITECTURE.md",
  "MIGRATION.md",
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/BENCHMARKS.md",
  "docs/RELEASE.md",
  "packages/core/README.md",
  "packages/mcp-server/README.md",
  "packages/vscode/README.md",
];
const staleReports = [
  "-CODEX-PLAN.md",
  "CODEX-CHANGES-REVIEW.md",
  "CODEX-COMPREHENSIVE-BRANCH-REVIEW.md",
  "COMPREHENSIVE-BRANCH-REVIEW.md",
  "CONSOLIDATED-FIX-PLAN.md",
  "CORE-REVIEW-REPORT.md",
  "DESIGN-IMPLEMENTATION-REVIEW.md",
  "IMPLEMENTATION-REVIEW.md",
  "MCP-FUNCTIONAL-TEST-REPORT.md",
  "STRUCTURAL-REVIEW-REPORT.md",
  "now-create-comprehensive-plan-serialized-rabbit.md",
];

for (const relative of canonical) {
  const absolute = path.join(root, relative);
  const contents = await readFile(absolute, "utf8");
  for (const match of contents.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    target = decodeURIComponent(target.split("#", 1)[0]);
    if (!target) continue;
    await access(path.resolve(path.dirname(absolute), target)).catch(() => {
      throw new Error(`${relative}: broken documentation link ${match[1]}`);
    });
  }
}

const mcp = await readFile(path.join(root, "packages/mcp-server/README.md"), "utf8");
assert.doesNotMatch(mcp, /Existing branch-era storage .* intentionally not migrated/);
assert.match(mcp, /Shared reader[\s\S]*Shared curator[\s\S]*Shared admin/);
for (const variable of [
  "RAGNAROK_DEPLOYMENT_MODE",
  "RAGNAROK_ADMIN_API_KEY",
  "RAGNAROK_TLS_CERT_PATH",
  "RAGNAROK_TRUSTED_PROXIES",
  "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
]) {
  assert.match(mcp, new RegExp(variable), `MCP guide must document ${variable}`);
}

const core = await readFile(path.join(root, "packages/core/README.md"), "utf8");
for (const strategy of ["VECTOR", "HYBRID", "BM25"]) {
  assert.match(core, new RegExp(`\\*\\*${strategy}\\*\\*`), `Core guide must document the ${strategy} strategy`);
}
for (const removed of ["GRAPH_HYBRID", "EnsembleRetriever", "LangGraph"]) {
  assert.doesNotMatch(core, new RegExp(removed), `Core guide must not document removed subsystem ${removed}`);
}
assert.match(core, /embedding fingerprint/i);
assert.match(core, /requires reindexing/i);

for (const relative of staleReports) {
  await access(path.join(root, relative))
    .then(() => {
      throw new Error(`Stale branch report must not ship: ${relative}`);
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
}

console.log("Canonical documentation contracts passed.");
