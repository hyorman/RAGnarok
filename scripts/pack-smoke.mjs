#!/usr/bin/env node
/**
 * Pack smoke test — verifies the published npm artifacts actually run.
 *
 * 1. `npm pack` both workspaces (runs each package's prepack = clean + build)
 * 2. Install the exact tarballs into a clean temporary consumer project
 * 3. `require('@ragnarok/core')` must succeed
 * 4. Launch the installed `ragnarok-mcp` bin and complete an MCP stdio
 *    modern exchange (server/discover → tools/list)
 * 5. Assert stdout carried ONLY JSON-RPC frames (no diagnostic output)
 *
 * Usage: node scripts/pack-smoke.mjs [--keep]
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAuditReport, normalizeLocalTarballAuditRanges } from "./audit-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-pack-smoke-"));
const artifactArg = process.argv.find((arg) => arg.startsWith("--artifacts="));
const packDir = artifactArg
  ? path.resolve(ROOT, artifactArg.slice("--artifacts=".length))
  : path.join(workDir, "tarballs");
const consumerDir = path.join(workDir, "consumer");
if (!artifactArg) fs.mkdirSync(packDir);
fs.mkdirSync(consumerDir);

// Deterministic environment: the server under test must not pick up the
// developer's RAGNAROK_* configuration.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));

function fail(msg) {
  console.error(`\n✗ pack-smoke FAILED: ${msg}`);
  console.error(`  work dir kept for inspection: ${workDir}`);
  process.exit(1);
}

function cleanup() {
  if (process.argv.includes("--keep")) {
    console.log(`\nKeeping work dir: ${workDir}`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── 1. Pack ────────────────────────────────────────────────────────────────
if (!artifactArg) {
  console.log("Packing workspaces (runs prepack: clean + build)...");
  execSync(`npm pack --workspace=@ragnarok/core --workspace=@ragnarok/mcp-server --pack-destination "${packDir}"`, {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: cleanEnv,
  });
} else {
  console.log(`Using prebuilt npm artifacts from ${packDir}...`);
}

const tarballs = fs.readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
const coreTgz = tarballs.find((f) => f.startsWith("ragnarok-core-"));
const mcpTgz = tarballs.find((f) => f.startsWith("ragnarok-mcp-server-"));
if (!coreTgz || !mcpTgz) fail(`expected two tarballs, got: ${tarballs.join(", ")}`);

// ── 2. Clean consumer install ──────────────────────────────────────────────
console.log("Installing tarballs into clean consumer...");
fs.writeFileSync(
  path.join(consumerDir, "package.json"),
  JSON.stringify({ name: "pack-smoke-consumer", private: true, version: "1.0.0" }),
);
execSync(`npm install --no-audit --no-fund "${path.join(packDir, coreTgz)}" "${path.join(packDir, mcpTgz)}"`, {
  cwd: consumerDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: cleanEnv,
});
console.log("Auditing clean-consumer production dependencies...");
const releasePolicy = JSON.parse(fs.readFileSync(path.join(ROOT, "release-policy.json"), "utf8"));
const auditViaPackages = [
  ...new Set(
    releasePolicy.auditExceptions.map((exception) => {
      const separator = typeof exception.via === "string" ? exception.via.lastIndexOf("@") : -1;
      if (separator <= 0) fail("release audit policy contains a malformed via package");
      return exception.via.slice(0, separator);
    }),
  ),
];
const installedTreeRun = spawnSync("npm", ["ls", ...auditViaPackages, "--omit=dev", "--all", "--json"], {
  cwd: consumerDir,
  encoding: "utf8",
  env: cleanEnv,
});
if (installedTreeRun.error) fail(`could not inspect installed dependencies: ${installedTreeRun.error.message}`);
if (installedTreeRun.signal) fail(`npm ls terminated by signal ${installedTreeRun.signal}`);
if (installedTreeRun.status !== 0) {
  fail(`npm ls failed with status ${installedTreeRun.status}: ${installedTreeRun.stderr.trim()}`);
}
let installedTree;
try {
  installedTree = JSON.parse(installedTreeRun.stdout);
} catch {
  fail("npm ls did not return valid JSON");
}
const auditRun = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  cwd: consumerDir,
  encoding: "utf8",
  env: cleanEnv,
});
if (auditRun.error) fail(`could not run npm audit: ${auditRun.error.message}`);
if (auditRun.signal) fail(`npm audit terminated by signal ${auditRun.signal}`);
if (![0, 1].includes(auditRun.status)) {
  fail(`npm audit failed with status ${auditRun.status}: ${auditRun.stderr.trim()}`);
}
let auditReport;
try {
  auditReport = JSON.parse(auditRun.stdout);
} catch {
  fail("npm audit did not return valid JSON");
}
const localTarballVersions = Object.fromEntries(
  ["@ragnarok/core", "@ragnarok/mcp-server"].map((name) => [name, installedTree.dependencies?.[name]?.version]),
);
// npm emits empty aggregate ranges for local file tarball roots; recover only
// these known direct roots from the exact versions npm reports as installed.
const normalizedAuditReport = normalizeLocalTarballAuditRanges(auditReport, localTarballVersions);
const evaluation = evaluateAuditReport(normalizedAuditReport, releasePolicy, new Date(), installedTree);
if (evaluation.rejected.length > 0) {
  fail(`production audit rejected: ${JSON.stringify(evaluation.rejected)}`);
}
for (const finding of evaluation.allowed) {
  console.warn(
    `Allowed until policy expiry: ${finding.advisory} via ${finding.dependency} ${finding.range} (${finding.reason})`,
  );
}

// ── 3. Require core ────────────────────────────────────────────────────────
console.log("Requiring @ragnarok/core from the packed artifact...");
try {
  execSync(
    `node -e "const c = require('@ragnarok/core'); if (typeof c.MemoryStore !== 'function' || typeof c.TopicManager !== 'function') throw new Error('missing exports');"`,
    { cwd: consumerDir, stdio: ["ignore", "ignore", "inherit"], env: cleanEnv },
  );
} catch {
  fail("require('@ragnarok/core') failed in clean consumer");
}

// ── 4 + 5. Stdio handshake with stdout purity check ────────────────────────
console.log("Launching installed ragnarok-mcp binary (stdio handshake)...");
const bin = path.join(consumerDir, "node_modules", ".bin", "ragnarok-mcp");
const observeChildClose = (child) =>
  new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
const proc = spawn(bin, [], {
  cwd: consumerDir,
  env: { ...cleanEnv, RAGNAROK_STORAGE_DIR: path.join(workDir, "storage") },
});
const childClose = observeChildClose(proc);

let buf = "";
let stderr = "";
let spawnError;
const responses = [];
const nonJsonLines = [];
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      nonJsonLines.push(line);
    }
  }
});
proc.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-64 * 1024);
});
proc.on("error", (error) => {
  spawnError = error;
});

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForChildClose = (child, close, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    close.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "e2e-harness", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

await delay(3000);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: { _meta: envelope },
});
await delay(3000);
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope } });
await delay(6000);

const discover = responses.find((r) => r.id === 1);
const tools = responses.find((r) => r.id === 2);
if (!discover?.result || discover.error) fail("server/discover did not succeed");
if (!Array.isArray(tools?.result?.tools) || tools.result.tools.length === 0) {
  fail("tools/list returned no tools");
}
if (nonJsonLines.length > 0) {
  fail(`stdout carried ${nonJsonLines.length} non-protocol line(s), e.g.: ${nonJsonLines[0].slice(0, 120)}`);
}
if (spawnError) fail(`ragnarok-mcp process failed: ${spawnError.message}`);

const gracefulClose = waitForChildClose(proc, childClose, 15_000);
proc.stdin.end();
let exit;
try {
  exit = await gracefulClose;
} catch (error) {
  fail(`ragnarok-mcp graceful shutdown timed out: ${error.message}`);
}
if (exit.code !== 0 || exit.signal) {
  fail(`ragnarok-mcp did not exit cleanly: code=${exit.code} signal=${exit.signal}`);
}
if (/SIGABRT|mutex lock failed|libc\+\+abi/.test(stderr)) {
  fail(`ragnarok-mcp stderr contained a native abort trace: ${stderr.slice(-1000)}`);
}

console.log(`\n✓ pack-smoke passed — modern discovery, ${tools.result.tools.length} tools, stdout clean, exit 0`);
cleanup();
