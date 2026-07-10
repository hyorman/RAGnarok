/**
 * Stdio transport E2E test.
 *
 * Launches the built server (dist/index.js) as a real child process, completes
 * an MCP initialize → initialized → tools/list handshake over stdio, and
 * asserts that stdout carried ONLY JSON-RPC protocol frames. Any diagnostic
 * text on stdout corrupts the protocol stream for strict clients.
 *
 * Skips when dist/index.js has not been built (run `npm run build` first;
 * `npm run test:all` at the repo root builds before testing).
 */
import { expect } from "chai";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ENTRY = path.join(PACKAGE_ROOT, "dist", "index.js");

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: any;
  error?: any;
}

class StdioHarness {
  proc: ChildProcess;
  private buffer = "";
  readonly messages: JsonRpcMessage[] = [];
  readonly nonProtocolLines: string[] = [];
  private waiters: Array<{ predicate: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];

  constructor(storageDir: string) {
    // Scrub developer RAGNAROK_* config so the test is deterministic.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...env, RAGNAROK_STORAGE_DIR: storageDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // stderr is the designated diagnostics channel; drain and ignore.
    this.proc.stderr!.on("data", () => {});
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (w.predicate(msg)) {
            w.resolve(msg);
            return false;
          }
          return true;
        });
      } catch {
        this.nonProtocolLines.push(line);
      }
    }
  }

  send(msg: object): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  waitFor(predicate: (m: JsonRpcMessage) => boolean, timeoutMs: number): Promise<JsonRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for message`)), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  dispose(): void {
    this.proc.kill();
  }
}

describe("stdio transport E2E", function () {
  // Server startup loads config + topic manager; allow headroom.
  this.timeout(30000);

  let harness: StdioHarness | undefined;
  let storageDir: string;

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      // eslint-disable-next-line no-console
      console.error(`Skipping stdio E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-stdio-e2e-"));
  });

  after(function () {
    harness?.dispose();
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("completes initialize + tools/list with a protocol-clean stdout", async function () {
    harness = new StdioHarness(storageDir);

    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-e2e", version: "1.0.0" },
      },
    });

    const initResponse = await harness.waitFor((m) => m.id === 1, 20000);
    expect(initResponse.error, "initialize returned an error").to.equal(undefined);
    expect(initResponse.result?.serverInfo?.name).to.equal("ragnarok");

    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    harness.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const toolsResponse = await harness.waitFor((m) => m.id === 2, 10000);
    expect(toolsResponse.error, "tools/list returned an error").to.equal(undefined);
    expect(toolsResponse.result?.tools).to.be.an("array").with.length.greaterThan(0);

    expect(
      harness.nonProtocolLines,
      `stdout must carry only JSON-RPC frames; got: ${harness.nonProtocolLines.slice(0, 3).join(" | ")}`,
    ).to.deep.equal([]);
  });
});
