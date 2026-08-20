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
import { COMMANDS, TOOLS, VIEWS } from "../src/constants";

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

  // Runs against the live activation, before the rollback test tears it down.
  // The reset command is deliberately not executed here: its modal has no user.
  it("registers the memory sidebar commands and refreshes the memory tree", async function () {
    const registered = await vscode.commands.getCommands(true);
    expect(registered).to.include(COMMANDS.RESET_MEMORY);
    expect(registered).to.include(COMMANDS.REFRESH_MEMORY);
    await vscode.commands.executeCommand(COMMANDS.REFRESH_MEMORY);
    // VS Code derives <viewId>.focus from the manifest, so this fails if the
    // view contribution is dropped or its id drifts from the constant.
    expect(registered).to.include(`${VIEWS.RAG_MEMORY}.focus`);
  });

  // Witnesses the extension.ts wiring, not just the tool class: invokeTool only
  // reaches a tool that activation actually registered, so dropping the
  // TopicTool.register call fails here rather than passing unnoticed.
  it("registers ragTopic with the language model API during activation", async function () {
    const result = await vscode.lm.invokeTool(
      TOOLS.RAG_TOPIC,
      { input: { action: "list" }, toolInvocationToken: undefined },
      new vscode.CancellationTokenSource().token,
    );
    const part = result.content[0] as vscode.LanguageModelTextPart;
    const payload = JSON.parse(part.value);

    expect(payload.count).to.be.a("number");
    expect(payload.topics).to.be.an("array");
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
    const memoryService = { execute: sinon.stub(), reset: sinon.stub() };
    const serviceFactory = {
      createEmbeddingService: () => embeddingService,
      createTopicManager: async () => topicManager,
      createMemoryStore: () => memoryStore,
      createMemoryCoordinator: () => coordinator,
      createMemoryService: () => memoryService,
      createGraphVisualizationService: () => ({ generate: sinon.stub() }),
    };
    // Witnesses the extension.ts wiring: dropping the registerMemorySidebar call
    // leaves this spy uncalled and its dispose event missing from the rollback.
    const registerMemorySidebar = sinon.spy((_service: unknown, _operationRunner: unknown) => ({
      dispose: () => events.push("memorySidebar:dispose"),
    }));
    const runtimeFactory: ActivationRuntimeFactory = {
      registerMemoryTools: () => ({ dispose: () => events.push("memoryTools:dispose") }),
      createMemoryGraphPanel: () => ({
        show: sinon.stub(),
        dispose: () => events.push("graphPanel:dispose"),
      }),
      registerMemoryGraphCommand: () => ({ dispose: () => events.push("graphCommand:dispose") }),
      registerMemorySidebar,
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
    expect(registerMemorySidebar.calledOnce).to.equal(true);
    expect(registerMemorySidebar.firstCall.args[0]).to.equal(memoryService);
    expect(registerMemorySidebar.firstCall.args[1]).to.be.a("function");
    expect(events).to.deep.equal([
      "memoryTools:dispose",
      "graphCommand:dispose",
      "graphPanel:dispose",
      "memorySidebar:dispose",
      "memoryCoordinator:stop",
      "memoryCoordinator:drain",
      "memoryStore:dispose",
      "topicManager:dispose",
      "embeddingService:dispose",
    ]);
  });

  // Without this the views keep "RAGnarōk is starting up..." forever, so a
  // storage failure is indistinguishable from a slow start.
  it("publishes the activation-failed context key instead of leaving the views mid-start", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-activation-failed-"));
    const contexts: Array<[string, unknown]> = [];
    const executeCommand = sinon
      .stub(vscode.commands, "executeCommand")
      .callsFake(async (command: string, ...args: unknown[]) => {
        if (command === COMMANDS.SET_CONTEXT) {
          contexts.push([args[0] as string, args[1]]);
        }
        return undefined as never;
      });
    const serviceFactory = {
      createEmbeddingService: () => ({ registerBackend: sinon.spy(), dispose: async () => undefined }),
      createTopicManager: async () => {
        throw new Error("storage could not be opened");
      },
      createMemoryStore: () => ({ dispose: async () => undefined }),
      createMemoryCoordinator: () => ({ stopAdmission: () => undefined, drain: async () => undefined }),
      createMemoryService: () => ({ execute: sinon.stub(), reset: sinon.stub() }),
      createGraphVisualizationService: () => ({ generate: sinon.stub() }),
    };
    const context = {
      globalStorageUri: vscode.Uri.file(storageDir),
      extensionUri: vscode.Uri.file("/extension"),
      subscriptions: [],
    };

    let caught: unknown;
    try {
      await activateWithServiceFactory(context as any, serviceFactory as any);
    } catch (error) {
      caught = error;
    } finally {
      executeCommand.restore();
      await fs.rm(storageDir, { recursive: true, force: true });
    }

    // The failure still propagates: this reports the state, it does not swallow it.
    expect(caught).to.be.instanceOf(Error);
    const failedStates = contexts.filter(([key]) => key === "ragnarok.activationFailed").map(([, value]) => value);
    // Cleared on entry so a retry does not inherit the previous panel, set on failure.
    expect(failedStates).to.deep.equal([false, true]);
    expect(contexts.some(([key, value]) => key === "ragnarok.loaded" && value === true)).to.equal(false);
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
