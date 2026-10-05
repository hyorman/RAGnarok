import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createMemoryServices, UnsupportedStorageError } from "@ragnarok/core";
import { activateWithServiceFactory, type ActivationRuntimeFactory, type RagnarokExtensionApi } from "../src/extension";
import { COMMANDS, TOOLS, VIEWS } from "../src/constants";
import { CommandHandler } from "../src/commands";
import { GitHubTokenManager } from "../src/githubTokenManager";

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

  it("contributes the shared topics refresh command", async function () {
    const commands = await vscode.commands.getCommands(true);
    expect(commands).to.include("ragnarok.refreshSharedTopics");
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

  // The modal is the only place a user learns why activation refused: it has to
  // name the folder, say what was found in it, and offer to reveal it.
  it("refuses unsupported pre-0.4 storage with a modal that lists what was found and can reveal the folder", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-unsupported-storage-"));
    const executed: Array<[string, unknown[]]> = [];
    const executeCommand = sinon
      .stub(vscode.commands, "executeCommand")
      .callsFake(async (command: string, ...args: unknown[]) => {
        executed.push([command, args]);
        return undefined as never;
      });
    const showErrorMessage = sinon.stub(vscode.window, "showErrorMessage").resolves("Reveal Folder" as never);
    const serviceFactory = {
      createEmbeddingService: () => ({ registerBackend: sinon.spy(), dispose: async () => undefined }),
      createTopicManager: async () => {
        throw new UnsupportedStorageError(storageDir, ["database", "topics.json"]);
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
      showErrorMessage.restore();
      await fs.rm(storageDir, { recursive: true, force: true });
    }

    // The refusal still propagates: the modal reports it, it does not swallow it.
    expect(caught).to.be.instanceOf(UnsupportedStorageError);
    expect(showErrorMessage.calledOnce).to.equal(true);
    const [message, options, action] = showErrorMessage.firstCall.args as unknown as [
      string,
      vscode.MessageOptions,
      string,
    ];
    expect(message).to.include(context.globalStorageUri.fsPath);
    expect(options).to.deep.equal({ modal: true, detail: "Found in that folder: database, topics.json" });
    expect(action).to.equal("Reveal Folder");
    const reveal = executed.find(([command]) => command === "revealFileInOS");
    expect((reveal?.[1][0] as vscode.Uri | undefined)?.fsPath).to.equal(context.globalStorageUri.fsPath);
  });

  /** Activate with a topic manager that fails with `failure`; return the arguments of every showErrorMessage call. */
  async function errorMessagesForActivationFailure(failure: unknown): Promise<unknown[][]> {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-activation-refusal-"));
    const executeCommand = sinon.stub(vscode.commands, "executeCommand").resolves(undefined as never);
    const showErrorMessage = sinon.stub(vscode.window, "showErrorMessage").resolves(undefined as never);
    const serviceFactory = {
      createEmbeddingService: () => ({ registerBackend: sinon.spy(), dispose: async () => undefined }),
      createTopicManager: async () => {
        throw failure;
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
    try {
      let caught: unknown;
      await activateWithServiceFactory(context as any, serviceFactory as any).catch((error: unknown) => {
        caught = error;
      });
      expect(caught, "activation must fail with the topic manager's error").to.equal(failure);
      return showErrorMessage.getCalls().map((call) => call.args as unknown[]);
    } finally {
      executeCommand.restore();
      showErrorMessage.restore();
      await fs.rm(storageDir, { recursive: true, force: true });
    }
  }

  it("shows the refusal modal with no detail when the refusal names no entries", async function () {
    const calls = await errorMessagesForActivationFailure(new UnsupportedStorageError("/unused"));
    expect(calls).to.have.length(1);
    const options = calls[0][1] as vscode.MessageOptions;
    expect(options.modal).to.equal(true);
    expect(options.detail, "an empty detail line would read 'Found in that folder: '").to.equal(undefined);
  });

  it("shows the refusal modal's detail with how many entries it left out", async function () {
    const calls = await errorMessagesForActivationFailure(
      new UnsupportedStorageError("/unused", ["a", "b", "c", "d", "e"], 2),
    );
    expect(calls).to.have.length(1);
    expect((calls[0][1] as vscode.MessageOptions).detail).to.equal("Found in that folder: a, b, c, d, e and 2 more");
  });

  it("shows no refusal modal for any other failure, even one named like the refusal", async function () {
    const impostor = Object.assign(new Error("pre-0.4 data"), {
      name: "UnsupportedStorageError",
      entries: ["database"],
    });
    for (const failure of [new Error("storage could not be opened"), impostor]) {
      const calls = await errorMessagesForActivationFailure(failure);
      const modals = calls.filter(([, options]) => (options as vscode.MessageOptions | undefined)?.modal === true);
      expect(modals, `${failure.name}: ${failure.message}`).to.deep.equal([]);
    }
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

// CommandHandler.registerCommands is exercised directly here (registerCommand
// stubbed) rather than through a second activateWithServiceFactory: the
// production activation in the describe block above already registered the
// real "ragnarok.*" command ids on the live vscode.commands registry, and a
// second real registration under the same ids throws.
describe("command error mapping", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("maps a StorageBusyError to the busy-writer notification instead of the generic failure message", async function () {
    GitHubTokenManager.initialize({
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
      },
    } as unknown as vscode.ExtensionContext);

    const registered = new Map<string, (...args: unknown[]) => unknown>();
    sinon.stub(vscode.commands, "registerCommand").callsFake(((
      id: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      registered.set(id, callback);
      return { dispose: () => undefined };
    }) as typeof vscode.commands.registerCommand);
    const showErrorMessage = sinon.stub(vscode.window, "showErrorMessage").resolves(undefined);
    const showInputBox = sinon.stub(vscode.window, "showInputBox");
    showInputBox.onFirstCall().resolves("New Topic");
    showInputBox.onSecondCall().resolves(undefined);

    const busyError = Object.assign(new Error("busy"), {
      name: "StorageBusyError",
      holder: { pid: 123 },
    });
    const topicManager = { createTopic: sinon.stub().rejects(busyError) };
    const context = { subscriptions: [] as unknown[] };

    await CommandHandler.registerCommands(
      context as unknown as vscode.ExtensionContext,
      topicManager as unknown as import("@ragnarok/core").TopicManager,
      {} as unknown as import("@ragnarok/core").EmbeddingService,
      {} as unknown as import("@ragnarok/core").MemoryStore,
      { refresh: sinon.spy() } as unknown as import("../src/topicTreeView").TopicTreeDataProvider,
      {} as unknown as import("../src/topicTreeView").ConfigTreeDataProvider,
    );

    const createTopicHandler = registered.get(COMMANDS.CREATE_TOPIC);
    expect(createTopicHandler, "CREATE_TOPIC should be registered").to.be.a("function");
    await createTopicHandler!();

    expect(showErrorMessage.calledOnce).to.equal(true);
    const message = showErrorMessage.firstCall.args[0] as string;
    expect(message).to.include("123");
    expect(message).to.not.include("Failed to create topic");
    expect(topicManager.createTopic.calledOnce).to.equal(true);
  });
});
