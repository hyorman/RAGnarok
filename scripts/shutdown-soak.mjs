import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOAK_ITERATIONS = 20;
export const ITERATION_TIMEOUT_MS = 45_000;
// The CI step allows 15 minutes. Giving up at 12 lets this script's own message, which names the
// iteration, report a stall instead of the runner's kill.
export const SOAK_BUDGET_MS = 12 * 60_000;

/** The next iteration's timeout: 45 s, or whatever the soak's budget still allows. */
export function iterationTimeoutMs(startedAt, now, iteration) {
  const remaining = SOAK_BUDGET_MS - (now - startedAt);
  if (remaining <= 0) {
    throw new Error(
      `shutdown soak exceeded its ${SOAK_BUDGET_MS / 60_000}-minute budget before iteration ${iteration}`,
    );
  }
  return Math.min(ITERATION_TIMEOUT_MS, remaining);
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = path.join(root, "packages/mcp-server/dist/index.js");
  const storageDir = await mkdtemp(path.join(os.tmpdir(), "ragnarok-shutdown-soak-"));
  const startedAt = Date.now();
  try {
    for (let iteration = 1; iteration <= SOAK_ITERATIONS; iteration++) {
      const timeoutMs = iterationTimeoutMs(startedAt, Date.now(), iteration);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry], {
          cwd: root,
          env: {
            // Scrub developer RAGNAROK_* config so the soak is deterministic.
            ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_"))),
            RAGNAROK_STORAGE_DIR: storageDir,
            RAGNAROK_LOG_LEVEL: "error",
            // Exercise the ONNX-session lifecycle — the historical SIGABRT
            // source. Startup warm-up loads the model; shutdown disposes it.
            RAGNAROK_RERANKER_ENABLED: "true",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`shutdown iteration ${iteration} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes('"id":1')) {
            // Windows cannot deliver a catchable SIGTERM; end stdin so the
            // server takes its stdio-EOF shutdown path instead.
            if (process.platform === "win32") child.stdin.end();
            else child.kill("SIGTERM");
          }
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 || signal || /SIGABRT|mutex lock failed|libc\+\+abi/.test(stderr)) {
            reject(new Error(`shutdown iteration ${iteration} failed: code=${code} signal=${signal}\n${stderr}`));
          } else {
            resolve();
          }
        });
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "e2e-harness", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          })}\n`,
        );
      });
    }
    console.log(`${SOAK_ITERATIONS}/${SOAK_ITERATIONS} stdio shutdown iterations exited cleanly.`);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
