import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  activateWithServiceFactory,
  createMemoryServices,
  type ActivationRuntimeFactory,
  type RagnarokExtensionApi,
} from "../src/extension";
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

  it("constructs memory and graph services with one shared coordinator", function () {
    const store = {};
    const coordinator = {};
    const memoryService = {};
    const graphService = {};
    const factory = {
      createMemoryCoordinator: sinon.spy(() => coordinator),
      createMemoryService: sinon.spy(() => memoryService),
      createGraphVisualizationService: sinon.spy(() => graphService),
    };

    const services = createMemoryServices(store as any, factory as any);

    expect(services).to.deep.equal({ coordinator, memoryService, graphService });
    expect(factory.createMemoryService.calledOnce).to.equal(true);
    expect(factory.createMemoryService.firstCall.args).to.deep.equal([store, coordinator]);
    expect(factory.createGraphVisualizationService.calledOnce).to.equal(true);
    expect(factory.createGraphVisualizationService.firstCall.args).to.deep.equal([store, coordinator]);
  });

  it("rolls back all memory graph resources when activation fails after native registration", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-activation-rollback-"));
    const events: string[] = [];
    const embeddingService = {
      registerBackend: sinon.spy(),
      dispose: async () => {
        events.push("embeddingService:dispose");
      },
    };
    const topicManager = {
      dispose: async () => {
        events.push("topicManager:dispose");
      },
    };
    const memoryStore = {
      dispose: async () => {
        events.push("memoryStore:dispose");
      },
    };
    const coordinator = {
      stopAdmission: () => events.push("memoryCoordinator:stop"),
      drain: async () => {
        events.push("memoryCoordinator:drain");
      },
    };
    const serviceFactory = {
      createEmbeddingService: () => embeddingService,
      createTopicManager: async () => topicManager,
      createMemoryStore: () => memoryStore,
      createMemoryCoordinator: () => coordinator,
      createMemoryService: () => ({ execute: sinon.stub(), reset: sinon.stub() }),
      createGraphVisualizationService: () => ({ generate: sinon.stub() }),
    };
    const runtimeFactory: ActivationRuntimeFactory = {
      registerMemoryTools: () => ({ dispose: () => events.push("memoryTools:dispose") }),
      createMemoryGraphPanel: () => ({
        show: sinon.stub(),
        dispose: () => events.push("graphPanel:dispose"),
      }),
      registerMemoryGraphCommand: () => ({ dispose: () => events.push("graphCommand:dispose") }),
      afterMemorySurfacesRegistered: () => {
        throw new Error("post-registration failure");
      },
    };
    const context = {
      globalStorageUri: vscode.Uri.file(storageDir),
      extensionUri: vscode.Uri.file("/extension"),
      subscriptions: [],
    };

    let caught: unknown;
    try {
      await activateWithServiceFactory(context as any, serviceFactory as any, runtimeFactory);
    } catch (error) {
      caught = error;
    } finally {
      await fs.rm(storageDir, { recursive: true, force: true });
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal("post-registration failure");
    expect(events).to.deep.equal([
      "memoryTools:dispose",
      "graphCommand:dispose",
      "graphPanel:dispose",
      "memoryCoordinator:stop",
      "memoryCoordinator:drain",
      "memoryStore:dispose",
      "topicManager:dispose",
      "embeddingService:dispose",
    ]);
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
