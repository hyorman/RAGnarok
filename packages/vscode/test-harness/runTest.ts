/**
 * VS Code Extension Test Runner
 * Uses @vscode/test-electron to run tests in VS Code environment
 */

import * as path from "path";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { runTests } from "@vscode/test-electron";

const EXTENSION_HOST_ENV_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "VSCODE_CODE_CACHE_PATH",
  "VSCODE_CRASH_REPORTER_PROCESS_TYPE",
  "VSCODE_CWD",
  "VSCODE_ESM_ENTRYPOINT",
  "VSCODE_HANDLES_UNCAUGHT_ERRORS",
  "VSCODE_IPC_HOOK",
  "VSCODE_NLS_CONFIG",
  "VSCODE_PID",
] as const;

async function main() {
  const savedEnv = new Map<string, string | undefined>();
  let testProfileDir: string | undefined;
  try {
    // When tests are launched from inside a VS Code extension host, Electron/VS Code
    // bootstrap variables leak into the child process. In particular,
    // `ELECTRON_RUN_AS_NODE=1` makes the downloaded VS Code binary start as plain
    // Node.js, which rejects VS Code-specific CLI flags.
    for (const key of EXTENSION_HOST_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    // The folder containing the Extension Manifest package.json — the repo
    // root, four levels up from dist-test/packages/vscode/test-harness/.
    const extensionDevelopmentPath = path.resolve(__dirname, "../../../../");

    // The path to the extension test script
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const manifest = JSON.parse(await readFile(path.resolve(__dirname, "../../../../package.json"), "utf8")) as {
      engines: { vscode: string };
    };
    const minimumVersion = manifest.engines.vscode.replace(/^[^\d]*/, "");
    const requestedVersion = process.env.VSCODE_TEST_VERSION ?? minimumVersion;
    testProfileDir = await mkdtemp(path.join(tmpdir(), "ragnarok-vscode-test-"));

    // Run against the declared minimum by default. CI can set
    // VSCODE_TEST_VERSION=stable for a second compatibility lane.
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: requestedVersion,
      extensionTestsEnv: {
        ...process.env,
        RAGNAROK_EXTENSION_HOST_TEST: "1",
      },

      launchArgs: [
        "--user-data-dir",
        path.join(testProfileDir, "user-data"),
        "--extensions-dir",
        path.join(testProfileDir, "extensions"),
        "--disable-extensions", // Disable other extensions
        "--disable-workspace-trust", // Disable workspace trust dialog
        "--enable-proposed-api=hyorman.ragnarok",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  } finally {
    if (testProfileDir) {
      await rm(testProfileDir, { recursive: true, force: true });
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

main();
