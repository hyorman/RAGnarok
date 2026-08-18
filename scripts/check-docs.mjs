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
// The stdio server has no roles, so the guide must not resurrect a role matrix.
assert.doesNotMatch(mcp, /Shared reader|Shared curator|Shared admin/);
for (const variable of ["RAGNAROK_STORAGE_DIR"]) {
  assert.match(mcp, new RegExp(variable), `MCP guide must document ${variable}`);
}
// The settings that moved into config.json must be documented by their key.
// Asserting on the old variable names would pin the guide to a configuration
// mechanism the server no longer has.
for (const key of ["security.allowedPaths", "embedding.model", "llm.provider", "limits.maxResponseBytes"]) {
  assert.match(mcp, new RegExp(key.replace(".", "\\.")), `MCP guide must document ${key}`);
}
// Variables removed with the HTTP transport are rejected at startup by
// assertNoRemovedEnvVars, whose REMOVED_ENV_VARS array is the list. Naming
// them here would read as documentation of a supported setting.
for (const removed of [
  "RAGNAROK_DEPLOYMENT_MODE",
  "RAGNAROK_ADMIN_API_KEY",
  "RAGNAROK_TLS_CERT_PATH",
  "RAGNAROK_TRUSTED_PROXIES",
  "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
]) {
  assert.doesNotMatch(mcp, new RegExp(removed), `MCP guide must not document removed variable ${removed}`);
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

const rootReadme = await readFile(path.join(root, "README.md"), "utf8");
const vscodeReadme = await readFile(path.join(root, "packages/vscode/README.md"), "utf8");
const architecture = await readFile(path.join(root, "ARCHITECTURE.md"), "utf8");
const operations = await readFile(path.join(root, "docs/OPERATIONS.md"), "utf8");
const security = await readFile(path.join(root, "docs/SECURITY.md"), "utf8");
const release = await readFile(path.join(root, "docs/RELEASE.md"), "utf8");
// The extension contributes exactly ragQuery, ragTopic, and ragMemory. Naming
// ragResetMemory would document a tool that no longer exists: the irreversible
// wipe is the sidebar's Reset Memory command, not something a model may call.
for (const tool of ["ragQuery", "ragTopic", "ragMemory"]) {
  for (const [name, contents] of [
    ["root README", rootReadme],
    ["vscode README", vscodeReadme],
  ]) {
    assert.match(contents, new RegExp(tool), `${name} must document the ${tool} tool`);
  }
}
for (const [name, contents] of [
  ["root README", rootReadme],
  ["vscode README", vscodeReadme],
  ["architecture", architecture],
  ["security", security],
]) {
  assert.doesNotMatch(contents, /ragResetMemory/, `${name} must not document the removed ragResetMemory tool`);
}
assert.match(vscodeReadme, /RAGnarok: Show Memory Graph/);
assert.match(architecture, /separate storage/i);
assert.match(core, /MemoryService/);
assert.match(vscodeReadme, /confirmation/i);
assert.match(mcp, /inline MCP App/i);
for (const [name, contents] of [
  ["root README", rootReadme],
  ["architecture", architecture],
  ["operations", operations],
  ["security", security],
]) {
  assert.match(contents, /no\s+cross-host data sharing/i, `${name} must document host storage isolation`);
}
assert.match(release, /media\/memoryGraph\.js/);
assert.match(release, /media\/memoryGraph\.css/);

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
