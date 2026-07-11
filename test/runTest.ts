/**
 * VS Code Extension Test Runner
 * Uses @vscode/test-electron to run tests in VS Code environment
 */

import * as path from "path";
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
  try {
    // When tests are launched from inside a VS Code extension host, Electron/VS Code
    // bootstrap variables leak into the child process. In particular,
    // `ELECTRON_RUN_AS_NODE=1` makes the downloaded VS Code binary start as plain
    // Node.js, which rejects VS Code-specific CLI flags.
    for (const key of EXTENSION_HOST_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test script
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Optional: Specify a version of VS Code to use
      // version: 'stable', // or 'insiders', or a specific version like '1.85.0'

      // Optional: Specify launch arguments
      launchArgs: [
        "--disable-extensions", // Disable other extensions
        "--disable-workspace-trust", // Disable workspace trust dialog
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  } finally {
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
