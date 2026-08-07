"use strict";

const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("hyorman.ragnarok");
  if (!extension) {
    throw new Error("Installed RAGnarōk extension is not discoverable in the extension host");
  }
  const expectedExtensionPath = process.env.RAGNAROK_EXPECTED_EXTENSION_PATH;
  if (!expectedExtensionPath || extension.extensionPath !== expectedExtensionPath) {
    throw new Error(
      `VSIX smoke activated an unexpected extension path: expected ${expectedExtensionPath}, got ${extension.extensionPath}`,
    );
  }
  const api = await extension.activate();
  if (api?.apiVersion !== 1 || typeof api.runInstalledSmoke !== "function") {
    throw new Error("Installed RAGnarōk extension did not expose release smoke API v1");
  }
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("ragnarok._runInstalledSmoke")) {
    throw new Error("Installed RAGnarōk release smoke command is not registered");
  }
  const result = await vscode.commands.executeCommand("ragnarok._runInstalledSmoke");
  const expected = { topicCreated: true, queryExecuted: true, topicDeleted: true };
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(`Installed RAGnarōk create/query/delete smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(`Installed extension-host smoke passed: ${JSON.stringify(result)}`);
}

module.exports = { run };
