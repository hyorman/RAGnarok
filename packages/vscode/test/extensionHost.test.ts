import { expect } from "chai";
import * as vscode from "vscode";
import type { RagnarokExtensionApi } from "../src/extension";
import { COMMANDS } from "../src/constants";

describe("real VS Code extension host activation", function () {
  this.timeout(120_000);

  let api: RagnarokExtensionApi;

  before(async function () {
    const extension = vscode.extensions.getExtension<RagnarokExtensionApi>("hyorman.ragnarok");
    expect(extension, "development/installed extension should be discoverable").to.not.equal(undefined);
    api = await extension!.activate();
  });

  it("activates through extensions.getExtension and exposes the release smoke API", function () {
    expect(api.apiVersion).to.equal(1);
    expect(api.lifecycle.isAcceptingOperations()).to.equal(true);
    expect(api.runInstalledSmoke).to.be.a("function");
  });

  it("registers commands and executes a topic tree refresh", async function () {
    const registered = await vscode.commands.getCommands(true);
    const expected = Object.values(COMMANDS).filter((command) => command !== COMMANDS.SET_CONTEXT);
    for (const command of expected) {
      expect(registered, `${command} should be registered`).to.include(command);
    }
    await vscode.commands.executeCommand(COMMANDS.REFRESH_TOPICS);
  });

  it("offers an opt-in native create/query/delete installed-artifact smoke", async function () {
    if (process.env.RAGNAROK_RUN_INSTALLED_SMOKE !== "1") {
      this.skip();
    }
    const result = await vscode.commands.executeCommand<Awaited<ReturnType<RagnarokExtensionApi["runInstalledSmoke"]>>>(
      COMMANDS.INSTALLED_SMOKE,
    );
    expect(result).to.deep.equal({
      topicCreated: true,
      queryExecuted: true,
      topicDeleted: true,
    });
  });
});
