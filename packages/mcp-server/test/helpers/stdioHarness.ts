/**
 * Shared harness for real-binary e2e tests: spawns the built server
 * (dist/index.js) with a scrubbed RAGNAROK_* environment and provides
 * JSON-RPC framing over stdio plus process-lifecycle helpers.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

export const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
export const SERVER_ENTRY = path.join(PACKAGE_ROOT, "dist", "index.js");

export interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: any;
  error?: any;
}

export class StdioHarness {
  proc: ChildProcess;
  private buffer = "";
  readonly messages: JsonRpcMessage[] = [];
  readonly nonProtocolLines: string[] = [];
  stderrText = "";
  private waiters: Array<{ predicate: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];

  constructor(
    storageDir: string,
    allowedDir: string,
    overrides: Record<string, string> = {},
    extraArgs: string[] = [],
  ) {
    // Scrub developer RAGNAROK_* config so the test is deterministic.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));
    this.proc = spawn(process.execPath, [SERVER_ENTRY, ...extraArgs], {
      env: {
        ...env,
        RAGNAROK_STORAGE_DIR: storageDir,
        RAGNAROK_WORKING_DIR: allowedDir,
        RAGNAROK_ALLOWED_PATHS: allowedDir,
        ...overrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // stderr is the designated diagnostics channel; keep it for assertions.
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
    });
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
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for message`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** initialize → wait for response → notifications/initialized. */
  async initialize(id = 1): Promise<JsonRpcMessage> {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-harness", version: "1.0.0" },
      },
    });
    const response = await this.waitFor((m) => m.id === id, 30000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
  }

  async callTool(id: number, name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<JsonRpcMessage> {
    this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return this.waitFor((message) => message.id === id, timeoutMs);
  }

  /** Wait for a process that terminates on its own (no stdin close). */
  waitForExit(timeoutMs: number): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return Promise.resolve(this.proc.exitCode);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  dispose(): void {
    this.proc.stdin?.end();
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return this.proc.exitCode;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.proc.kill();
        reject(new Error("Timed out waiting for the stdio server to shut down"));
      }, 15000);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.stdin?.end();
    });
  }
}
