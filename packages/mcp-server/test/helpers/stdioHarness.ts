/**
 * Shared harness for real-binary e2e tests: spawns the built server
 * (dist/index.js) with a scrubbed RAGNAROK_* environment and provides
 * JSON-RPC framing over stdio plus process-lifecycle helpers.
 */
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
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

interface ClosableHarness {
  close(): Promise<number | null>;
  forceClose(): Promise<number | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StdioHarnessLifecycleError extends Error {
  constructor(
    label: string,
    readonly operationError: unknown,
    readonly cleanupError: unknown,
    readonly forceCloseError?: unknown,
  ) {
    super(
      `${label} operation and cleanup failed: operation=${errorMessage(operationError)}; ` +
        `cleanup=${errorMessage(cleanupError)}` +
        (forceCloseError === undefined ? "" : `; forceClose=${errorMessage(forceCloseError)}`),
    );
    this.name = "StdioHarnessLifecycleError";
  }
}

export async function withStdioHarness<Harness extends ClosableHarness, Result>(
  create: () => Harness,
  operation: (harness: Harness) => Promise<Result>,
  label: string,
): Promise<Result> {
  const harness = create();
  let result!: Result;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation(harness);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let closeError: unknown;
  try {
    const exitCode = await harness.close();
    if (exitCode !== 0) {
      throw new Error(`${label} exited with code ${String(exitCode)}`);
    }
  } catch (error) {
    cleanupFailed = true;
    closeError = error;
  }

  let forceCloseFailed = false;
  let forceCloseError: unknown;
  if (cleanupFailed) {
    try {
      await harness.forceClose();
    } catch (error) {
      forceCloseFailed = true;
      forceCloseError = error;
    }
  }

  if (operationFailed && cleanupFailed) {
    throw new StdioHarnessLifecycleError(
      label,
      operationError,
      closeError,
      forceCloseFailed ? forceCloseError : undefined,
    );
  }
  if (forceCloseFailed) {
    throw new StdioHarnessLifecycleError(label, undefined, closeError, forceCloseError);
  }
  if (operationFailed) {
    throw operationError;
  }
  if (cleanupFailed) {
    throw closeError;
  }
  return result;
}

export class StdioHarness {
  proc: ChildProcess;
  private buffer = "";
  readonly messages: JsonRpcMessage[] = [];
  readonly nonProtocolLines: string[] = [];
  stderrText = "";
  private waiters: Array<{ predicate: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];
  private readonly envelope = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "e2e-harness", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  constructor(
    storageDir: string,
    allowedDir: string,
    configOverrides: Record<string, Record<string, unknown>> = {},
    extraArgs: string[] = [],
  ) {
    // The server reads these from <storageDir>/config.json, not the
    // environment. Seed the file before spawning: ensureConfigFile creates it
    // with `wx`, which no-ops on EEXIST, so ours survives and the server only
    // adds the $defaults/$envOnly blocks it authors.
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, "config.json"),
      `${JSON.stringify({ security: { allowedPaths: [allowedDir] }, ...configOverrides }, null, 2)}\n`,
    );
    // Scrub developer RAGNAROK_* config so the test is deterministic.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));
    this.proc = spawn(process.execPath, [SERVER_ENTRY, ...extraArgs], {
      env: {
        ...env,
        RAGNAROK_STORAGE_DIR: storageDir,
        RAGNAROK_WORKING_DIR: allowedDir,
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

  async discover(id = 1): Promise<JsonRpcMessage> {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "server/discover",
      params: { _meta: this.envelope },
    });
    return this.waitFor((message) => message.id === id, 30_000);
  }

  async listTools(id: number): Promise<JsonRpcMessage> {
    this.send({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: this.envelope } });
    return this.waitFor((message) => message.id === id, 30_000);
  }

  async callTool(id: number, name: string, args: Record<string, unknown>, timeoutMs = 30_000) {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args, _meta: this.envelope },
    });
    return this.waitFor((message) => message.id === id, timeoutMs);
  }

  /** Wait for a process that terminates on its own (no stdin close). */
  waitForExit(timeoutMs: number): Promise<number | null> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return Promise.resolve(this.proc.exitCode);
    }
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        this.proc.off("exit", onExit);
        reject(new Error("Timed out waiting for process exit"));
      }, timeoutMs);
      this.proc.once("exit", onExit);
    });
  }

  dispose(): void {
    this.proc.stdin?.end();
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return this.proc.exitCode;
    }
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        this.proc.off("exit", onExit);
        this.proc.kill();
        reject(new Error("Timed out waiting for the stdio server to shut down"));
      }, 15000);
      this.proc.once("exit", onExit);
      this.proc.stdin?.end();
    });
  }

  forceClose(timeoutMs = 5000): Promise<number | null> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return Promise.resolve(this.proc.exitCode);
    }
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        this.proc.off("exit", onExit);
        reject(new Error("Timed out waiting for forced stdio server termination"));
      }, timeoutMs);
      this.proc.once("exit", onExit);
      this.proc.kill("SIGKILL");
    });
  }
}
