/**
 * VS Code Extension Test Runner
 * Uses @vscode/test-electron to run tests in VS Code environment
 */

import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
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
  }
}

main();
