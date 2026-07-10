#!/usr/bin/env node
/**
 * Pack smoke test — verifies the published npm artifacts actually run.
 *
 * 1. `npm pack` both workspaces (runs each package's prepack = clean + build)
 * 2. Install the exact tarballs into a clean temporary consumer project
 * 3. `require('@ragnarok/core')` must succeed
 * 4. Launch the installed `ragnarok-mcp` bin and complete an MCP stdio
 *    handshake (initialize → initialized → tools/list)
 * 5. Assert stdout carried ONLY JSON-RPC frames (no diagnostic output)
 *
 * Usage: node scripts/pack-smoke.mjs [--keep]
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-pack-smoke-"));
const packDir = path.join(workDir, "tarballs");
const consumerDir = path.join(workDir, "consumer");
fs.mkdirSync(packDir);
fs.mkdirSync(consumerDir);

// Deterministic environment: the server under test must not pick up the
// developer's RAGNAROK_* configuration.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")),
);

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
console.log("Packing workspaces (runs prepack: clean + build)...");
execSync(
  `npm pack --workspace=@ragnarok/core --workspace=@ragnarok/mcp-server --pack-destination "${packDir}"`,
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: cleanEnv },
);

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
execSync(
  `npm install --no-audit --no-fund "${path.join(packDir, coreTgz)}" "${path.join(packDir, mcpTgz)}"`,
  { cwd: consumerDir, stdio: ["ignore", "ignore", "inherit"], env: cleanEnv },
);

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
const proc = spawn(bin, [], {
  cwd: consumerDir,
  env: { ...cleanEnv, RAGNAROK_STORAGE_DIR: path.join(workDir, "storage") },
});

let buf = "";
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
proc.stderr.on("data", () => {}); // diagnostics belong here; ignored

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");

setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pack-smoke", version: "1.0.0" },
    },
  });
}, 3000);

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
}, 6000);

setTimeout(() => {
  proc.kill();
  const init = responses.find((r) => r.id === 1);
  const tools = responses.find((r) => r.id === 2);

  if (!init?.result?.serverInfo) fail("initialize did not return serverInfo");
  if (!Array.isArray(tools?.result?.tools) || tools.result.tools.length === 0) {
    fail("tools/list returned no tools");
  }
  if (nonJsonLines.length > 0) {
    fail(
      `stdout carried ${nonJsonLines.length} non-protocol line(s), e.g.: ${nonJsonLines[0].slice(0, 120)}`,
    );
  }

  console.log(
    `\n✓ pack-smoke passed — server ${init.result.serverInfo.name}@${init.result.serverInfo.version}, ` +
      `${tools.result.tools.length} tools, stdout clean`,
  );
  cleanup();
  process.exit(0);
}, 12000);
