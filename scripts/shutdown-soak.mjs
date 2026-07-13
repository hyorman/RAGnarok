import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/mcp-server/dist/index.js");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "ragnarok-shutdown-soak-"));

try {
  for (let iteration = 1; iteration <= 20; iteration++) {
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
        reject(new Error(`shutdown iteration ${iteration} timed out`));
      }, 45_000);
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
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "shutdown-soak", version: "1.0.0" },
          },
        })}\n`,
      );
    });
  }
  console.log("20/20 stdio shutdown iterations exited cleanly.");
} finally {
  await rm(storageDir, { recursive: true, force: true });
}
