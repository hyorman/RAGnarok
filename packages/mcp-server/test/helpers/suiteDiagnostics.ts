/**
 * Root-hook diagnostics both packages' test setups install. The core and MCP
 * copies of this file are identical, and the release static tests hold them so.
 * Mocha runs without --exit, so one leaked handle hangs a suite.
 *
 * - RAGNAROK_REPORT_ACTIVE_RESOURCES=1 (exactly "1") reports what keeps the
 *   process alive after the suite, and starts a stall watchdog that names the
 *   test holding the event loop if one blocks it mid-suite.
 * - On Windows the suite finishes but a native addon thread keeps the process
 *   alive, so a process still running 10 s after the last test is ended with
 *   Mocha's own exit code: process.exit() with no argument lets Mocha's exit
 *   listener supply its failure count. RAGNAROK_TEST_FORCE_EXIT_GRACE=1 applies
 *   that grace exit on any OS (test-only, to verify it).
 *
 * Every line is written synchronously: on Windows a pipe is asynchronous, and a
 * line still queued when process.exit() runs would be lost.
 */
import * as fs from "fs";
import { Worker } from "worker_threads";

// The MCP package resolves its own @types/node 18, whose Process lacks
// getActiveResourcesInfo, which every supported runtime (Node >=22) has.
type ProcessWithActiveResources = NodeJS.Process & { getActiveResourcesInfo(): string[] };

/** How long the main thread may miss its heartbeat before the watchdog names the running test. */
const STALL_MS = 60_000;
const HEARTBEAT_MS = 1_000;
const GRACE_EXIT_MS = 10_000;
const REPORT_DELAY_MS = 2_000;

function writeLine(line: string): void {
  fs.writeSync(2, `${line}\n`);
}

export interface StallReport {
  test: string;
  blockedMs: number;
}

export interface StallWatchdog {
  /** Names the test now running, for a report. */
  testStarted(title: string): void;
  stop(): Promise<void>;
}

// Runs in a worker thread, outside the main event loop, so it still runs while a test blocks that loop.
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
let test = "(no test has started)";
let lastBeat = Date.now();
let reportedAt = 0;
parentPort.on("message", (message) => {
  lastBeat = Date.now();
  if (message.kind === "test") test = message.title;
});
setInterval(() => {
  const blockedMs = Date.now() - lastBeat;
  if (blockedMs >= workerData.stallMs && Date.now() - reportedAt >= workerData.stallMs) {
    reportedAt = Date.now();
    if (workerData.writeToStderr) {
      fs.writeSync(2, "Main thread blocked for " + (blockedMs / 1000).toFixed(1) + " s; last test started: " + test + "\\n");
    }
    parentPort.postMessage({ test, blockedMs });
  }
}, Math.max(10, Math.floor(workerData.stallMs / 4)));
`;

/**
 * Report a main thread that stops answering. A test blocked in native code or a
 * synchronous loop holds the event loop, so no timer on it (Mocha's own
 * timeouts included) can fire; the watchdog's worker thread can. It names the
 * last test that started once the heartbeat is `stallMs` late, and again each
 * further `stallMs`.
 */
export function startStallWatchdog(options: {
  stallMs: number;
  heartbeatMs: number;
  onStall?: (report: StallReport) => void;
  writeToStderr?: boolean;
}): StallWatchdog {
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { stallMs: options.stallMs, writeToStderr: options.writeToStderr ?? true },
  });
  worker.unref();
  worker.on("message", (report: StallReport) => options.onStall?.(report));
  const heartbeat = setInterval(() => worker.postMessage({ kind: "heartbeat" }), options.heartbeatMs);
  heartbeat.unref();
  return {
    testStarted: (title) => worker.postMessage({ kind: "test", title }),
    stop: async () => {
      clearInterval(heartbeat);
      await worker.terminate();
    },
  };
}

/** The root hooks for `env` and `platform`; {} when no diagnostic applies. */
export function suiteHooks(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Mocha.RootHookObject {
  const reportActiveResources = env.RAGNAROK_REPORT_ACTIVE_RESOURCES === "1";
  const graceExit = platform === "win32" || env.RAGNAROK_TEST_FORCE_EXIT_GRACE === "1";
  if (!reportActiveResources && !graceExit) {
    return {};
  }
  let watchdog: StallWatchdog | undefined;
  const watchdogHooks: Mocha.RootHookObject = reportActiveResources
    ? {
        beforeAll(): void {
          watchdog = startStallWatchdog({ stallMs: STALL_MS, heartbeatMs: HEARTBEAT_MS });
        },
        beforeEach(this: Mocha.Context): void {
          watchdog?.testStarted(this.currentTest?.fullTitle() ?? "(unnamed test)");
        },
      }
    : {};
  return {
    ...watchdogHooks,
    afterAll(): void {
      void watchdog?.stop();
      setTimeout(
        () => {
          const resources = (process as ProcessWithActiveResources).getActiveResourcesInfo();
          writeLine(`Active resources after the suite: ${JSON.stringify(resources)}`);
          if (graceExit) {
            writeLine(
              "Forcing exit: the process did not exit on its own (native handles); see test/helpers/suiteDiagnostics.ts",
            );
            process.exit();
          }
        },
        graceExit ? GRACE_EXIT_MS : REPORT_DELAY_MS,
      ).unref();
    },
  };
}
