import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import { setLoggerFactory, type ILoggerFactory, type MemoryHostContext, type MemoryService } from "@ragnarok/core";
import { VsCodeLoggerFactory } from "../src/adapters/vsCodeLogger";
import { COMMANDS, VIEWS } from "../src/constants";
import {
  MemoryTreeDataProvider,
  registerMemoryCommands,
  registerMemorySidebar,
  type MemoryCommandHost,
  type MemorySidebarHost,
  type MemoryTreeContextHost,
} from "../src/memoryTreeView";
import type { ExtensionOperationRunner } from "../src/extensionLifecycle";

const stats = {
  action: "stats" as const,
  totalMemories: 7,
  totalEntities: 3,
  totalRelationships: 2,
  byScope: { workspace: 5, branch: 2 },
  branches: ["main"],
  entityTypes: {},
  lastUpdated: 1700000000000,
  workspace: { workingDir: "/w", detectedBranch: "main" },
};

const resolvedContext: MemoryHostContext = {
  workingDir: "/w",
  branchContext: { state: "resolved", branch: "main" },
};

function statsService(result: unknown = stats) {
  const execute = sinon.stub().resolves(result);
  return { execute, service: { execute } as unknown as Pick<MemoryService, "execute"> };
}

function contextHost(context: MemoryHostContext = resolvedContext): MemoryTreeContextHost {
  return { resolve: () => context };
}

describe("memory tree view", function () {
  it("renders one row per stat", async function () {
    const provider = new MemoryTreeDataProvider(statsService().service, contextHost());
    const labels = (await provider.getChildren()).map((item) => item.label);
    expect(labels).to.deep.equal([
      "Memories: 7",
      "Workspace: 5",
      "Branch: 2",
      "Current branch: main",
      "Branches: 1",
      "Entities: 3",
      "Relationships: 2",
      `Updated: ${new Date(1700000000000).toLocaleString()}`,
    ]);
    provider.dispose();
  });

  it("reports an undetected branch instead of failing", async function () {
    const provider = new MemoryTreeDataProvider(
      statsService({ ...stats, workspace: { workingDir: "/w", detectedBranch: null } }).service,
      contextHost({ workingDir: "/w", branchContext: { state: "unavailable" } }),
    );
    const labels = (await provider.getChildren()).map((item) => item.label);
    expect(labels).to.include("Current branch: not detected");
    provider.dispose();
  });

  // The context is what scopes the stats to this workspace and branch; the
  // compiler cannot see it being dropped, so assert the forwarded arguments.
  it("asks the service for stats in the resolved host context", async function () {
    const { execute, service } = statsService();
    const provider = new MemoryTreeDataProvider(service, contextHost());

    await provider.getChildren();

    expect(execute.calledOnce).to.equal(true);
    expect(execute.firstCall.args[0]).to.deep.equal({ action: "stats" });
    expect(execute.firstCall.args[1]).to.equal(resolvedContext);
    provider.dispose();
  });

  it("awaits an asynchronously resolved host context", async function () {
    const { execute, service } = statsService();
    const provider = new MemoryTreeDataProvider(service, { resolve: () => Promise.resolve(resolvedContext) });

    const labels = (await provider.getChildren()).map((item) => item.label);

    expect(execute.firstCall.args[1]).to.equal(resolvedContext);
    expect(labels).to.include("Memories: 7");
    provider.dispose();
  });

  // A store that has never been written has lastUpdated === 0
  // (memoryStore.ts:438), which as a date is 1 Jan 1970.
  it("labels a store that has never been written as never updated", async function () {
    const provider = new MemoryTreeDataProvider(statsService({ ...stats, lastUpdated: 0 }).service, contextHost());
    const labels = (await provider.getChildren()).map((item) => item.label);
    expect(labels).to.include("Updated: never");
    expect(labels.some((label) => String(label).includes("1970"))).to.equal(false);
    provider.dispose();
  });

  // VS Code renders viewsWelcome only for an empty tree, so a first run has to
  // produce no rows at all for the welcome content to appear.
  it("renders no rows for an empty store so the welcome content can appear", async function () {
    const provider = new MemoryTreeDataProvider(
      statsService({
        ...stats,
        totalMemories: 0,
        totalEntities: 0,
        totalRelationships: 0,
        byScope: { workspace: 0, branch: 0 },
        branches: [],
        lastUpdated: 0,
      }).service,
      contextHost(),
    );
    expect(await provider.getChildren()).to.deep.equal([]);
    provider.dispose();
  });

  // The empty check must not hide a store that holds a graph but no memories.
  it("still renders rows when only the graph has content", async function () {
    const provider = new MemoryTreeDataProvider(
      statsService({
        ...stats,
        totalMemories: 0,
        byScope: { workspace: 0, branch: 0 },
      }).service,
      contextHost(),
    );
    const labels = (await provider.getChildren()).map((item) => item.label);
    expect(labels).to.have.length(8);
    expect(labels).to.include("Memories: 0");
    expect(labels).to.include("Entities: 3");
    provider.dispose();
  });

  it("reports a failed stats read as a row instead of a generic tree error", async function () {
    const execute = sinon.stub().rejects(new Error("stats failed for /Users/someone/ragnarok/memories.db"));
    const provider = new MemoryTreeDataProvider(
      { execute } as unknown as Pick<MemoryService, "execute">,
      contextHost(),
    );

    const labels = (await provider.getChildren()).map((item) => String(item.label));

    expect(labels).to.have.length(1);
    expect(labels[0]).to.include("Memory statistics unavailable");
    expect(labels[0]).to.include("<path>");
    expect(labels[0]).to.not.include("/Users/someone");
    provider.dispose();
  });

  it("returns no children for a statistic row", async function () {
    const { execute, service } = statsService();
    const provider = new MemoryTreeDataProvider(service, contextHost());
    const [first] = await provider.getChildren();

    expect(await provider.getChildren(first)).to.deep.equal([]);
    expect(execute.callCount).to.equal(1);
    expect(provider.getTreeItem(first)).to.equal(first);
    provider.dispose();
  });
});

interface CommandHarness {
  readonly host: MemoryCommandHost;
  readonly reset: sinon.SinonStub;
  readonly warnings: Array<{ message: string; options: { modal: boolean }; action: string }>;
  readonly information: string[];
  readonly errors: string[];
  readonly refreshes: number[];
  readonly runLabels: string[];
  readonly disposed: string[];
  readonly provider: MemoryTreeDataProvider;
  readonly registration: vscode.Disposable;
  invoke(command: string): Promise<void>;
  readonly runSignal: AbortSignal;
}

function commandHarness(options: { confirmation?: string | undefined; resetError?: unknown } = {}): CommandHarness {
  const handlers = new Map<string, () => Promise<void> | void>();
  const warnings: CommandHarness["warnings"] = [];
  const information: string[] = [];
  const errors: string[] = [];
  const disposed: string[] = [];
  const runLabels: string[] = [];
  const refreshes: number[] = [];
  const controller = new AbortController();

  const reset = sinon.stub().callsFake(async () => {
    if (options.resetError) {
      throw options.resetError;
    }
    return { success: true };
  });
  const memoryService = { reset } as unknown as Pick<MemoryService, "reset">;

  const host: MemoryCommandHost = {
    registerCommand(command, callback) {
      handlers.set(command, callback);
      return { dispose: () => disposed.push(command) };
    },
    showWarningMessage: async (message, modalOptions, action) => {
      warnings.push({ message, options: modalOptions, action });
      return "confirmation" in options ? options.confirmation : action;
    },
    showInformationMessage: async (message) => {
      information.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      errors.push(message);
      return undefined;
    },
  };

  const provider = new MemoryTreeDataProvider(statsService().service, contextHost());
  const originalRefresh = provider.refresh.bind(provider);
  provider.refresh = () => {
    refreshes.push(refreshes.length + 1);
    originalRefresh();
  };

  const run: ExtensionOperationRunner = async (label, operation) => {
    runLabels.push(label);
    return operation(controller.signal);
  };

  const registration = registerMemoryCommands(memoryService, provider, run, host);

  return {
    host,
    reset,
    warnings,
    information,
    errors,
    refreshes,
    runLabels,
    disposed,
    provider,
    registration,
    runSignal: controller.signal,
    invoke: async (command) => {
      const handler = handlers.get(command);
      expect(handler, `${command} should be registered`).to.be.a("function");
      await handler!();
    },
  };
}

describe("memory sidebar commands", function () {
  it("resets memory after a modal confirmation and refreshes the tree", async function () {
    const harness = commandHarness();

    await harness.invoke(COMMANDS.RESET_MEMORY);

    expect(harness.warnings).to.have.length(1);
    expect(harness.warnings[0].options).to.deep.equal({ modal: true });
    expect(harness.warnings[0].action).to.equal("Reset Memory");
    expect(harness.warnings[0].message).to.include("cannot be undone");
    expect(harness.reset.calledOnce).to.equal(true);
    expect(harness.refreshes).to.have.length(1);
    expect(harness.information).to.deep.equal(["RAGnarōk memory reset."]);
    expect(harness.errors).to.deep.equal([]);
    harness.provider.dispose();
  });

  // The guard that matters: a dismissed modal must leave every memory in place.
  it("does not reset when the confirmation is dismissed", async function () {
    const harness = commandHarness({ confirmation: undefined });

    await harness.invoke(COMMANDS.RESET_MEMORY);

    expect(harness.warnings).to.have.length(1);
    expect(harness.reset.called).to.equal(false);
    expect(harness.runLabels).to.deep.equal([]);
    expect(harness.refreshes).to.deep.equal([]);
    expect(harness.information).to.deep.equal([]);
    harness.provider.dispose();
  });

  // Strict equality, not truthiness: any other answer is not consent either.
  it("does not reset for any answer other than the reset action", async function () {
    for (const confirmation of ["Cancel", "reset memory", "Reset Memory "]) {
      const harness = commandHarness({ confirmation });

      await harness.invoke(COMMANDS.RESET_MEMORY);

      expect(harness.reset.called, `"${confirmation}" must not reset memory`).to.equal(false);
      expect(harness.refreshes).to.deep.equal([]);
      harness.provider.dispose();
    }
  });

  it("runs the reset through the operation runner and forwards its signal", async function () {
    const harness = commandHarness();

    await harness.invoke(COMMANDS.RESET_MEMORY);

    expect(harness.runLabels).to.deep.equal(["reset memory"]);
    expect(harness.reset.firstCall.args[0]).to.equal(harness.runSignal);
    harness.provider.dispose();
  });

  it("reports a failed reset with a sanitized message and leaves the tree alone", async function () {
    const harness = commandHarness({ resetError: new Error("reset failed for /Users/someone/ragnarok/memories.db") });

    await harness.invoke(COMMANDS.RESET_MEMORY);

    expect(harness.errors).to.have.length(1);
    expect(harness.errors[0]).to.include("Failed to reset memory:");
    expect(harness.errors[0]).to.include("<path>");
    expect(harness.errors[0]).to.not.include("/Users/someone");
    expect(harness.information).to.deep.equal([]);
    expect(harness.refreshes).to.deep.equal([]);
    harness.provider.dispose();
  });

  it("refreshes the tree on demand and disposes both commands", async function () {
    const harness = commandHarness();
    let changes = 0;
    const subscription = harness.provider.onDidChangeTreeData(() => {
      changes++;
    });

    await harness.invoke(COMMANDS.REFRESH_MEMORY);
    expect(harness.refreshes).to.have.length(1);
    expect(changes).to.equal(1);

    harness.registration.dispose();
    expect(harness.disposed).to.have.members([COMMANDS.RESET_MEMORY, COMMANDS.REFRESH_MEMORY]);
    subscription.dispose();
    harness.provider.dispose();
  });
});

// deleteTopic logs before the delete, after success, and on failure
// (commands.ts:369,372,377). An irreversible memory wipe leaves the same trace.
describe("memory reset logging", function () {
  let records: string[];

  beforeEach(function () {
    records = [];
    const factory: ILoggerFactory = {
      createLogger: () => ({
        debug: () => undefined,
        info: (message: string) => {
          records.push(`info:${message}`);
        },
        warn: () => undefined,
        error: (message: string) => {
          records.push(`error:${message}`);
        },
      }),
    };
    setLoggerFactory(factory);
  });

  afterEach(function () {
    setLoggerFactory(new VsCodeLoggerFactory());
  });

  function loggingHarness(resetError?: unknown) {
    let handler: (() => Promise<void> | void) | undefined;
    const host: MemoryCommandHost = {
      registerCommand(command, callback) {
        if (command === COMMANDS.RESET_MEMORY) {
          handler = callback;
        }
        return { dispose: () => undefined };
      },
      showWarningMessage: async (_message, _options, action) => action,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    };
    const memoryService = {
      reset: async () => {
        records.push("reset");
        if (resetError) {
          throw resetError;
        }
        return { success: true };
      },
    } as unknown as Pick<MemoryService, "reset">;
    const provider = new MemoryTreeDataProvider(statsService().service, contextHost());
    const run: ExtensionOperationRunner = (_label, operation) => operation(new AbortController().signal);
    registerMemoryCommands(memoryService, provider, run, host);
    return { invoke: async () => handler!(), provider };
  }

  it("logs the wipe before it happens and its success afterwards", async function () {
    const harness = loggingHarness();

    await harness.invoke();

    const reset = records.indexOf("reset");
    expect(reset).to.be.greaterThan(-1);
    expect(records.slice(0, reset).some((entry) => entry.startsWith("info:"))).to.equal(true);
    expect(records.slice(reset + 1).some((entry) => entry.startsWith("info:"))).to.equal(true);
    harness.provider.dispose();
  });

  it("logs a failed wipe as an error", async function () {
    const harness = loggingHarness(new Error("disk on fire"));

    await harness.invoke();

    expect(records.some((entry) => entry.startsWith("error:"))).to.equal(true);
    harness.provider.dispose();
  });

  it("logs nothing when the confirmation is declined", async function () {
    let handler: (() => Promise<void> | void) | undefined;
    const provider = new MemoryTreeDataProvider(statsService().service, contextHost());
    registerMemoryCommands(
      { reset: async () => ({ success: true }) } as unknown as Pick<MemoryService, "reset">,
      provider,
      (_label, operation) => operation(new AbortController().signal),
      {
        registerCommand(command, callback) {
          if (command === COMMANDS.RESET_MEMORY) {
            handler = callback;
          }
          return { dispose: () => undefined };
        },
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
      },
    );

    await handler!();

    expect(records).to.deep.equal([]);
    provider.dispose();
  });
});

describe("memory sidebar registration", function () {
  function sidebarHarness() {
    const created: Array<{ viewId: string; options: { treeDataProvider: unknown; showCollapseAll: boolean } }> = [];
    const registered: string[] = [];
    const disposed: string[] = [];
    const execute = sinon.stub().resolves(stats);
    const memoryService = { execute, reset: sinon.stub().resolves({ success: true }) } as unknown as Pick<
      MemoryService,
      "execute" | "reset"
    >;
    const host: MemorySidebarHost = {
      createTreeView(viewId, options) {
        created.push({ viewId, options });
        return { dispose: () => disposed.push(viewId) };
      },
      resolveContext: async () => resolvedContext,
      registerCommand(command, callback) {
        registered.push(command);
        void callback;
        return { dispose: () => disposed.push(command) };
      },
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    };

    const run: ExtensionOperationRunner = (_label, operation) => operation(new AbortController().signal);
    const registration = registerMemorySidebar(memoryService, run, host);
    return { created, registered, disposed, execute, registration };
  }

  it("creates the contributed memory view with a stats provider and both commands", async function () {
    const harness = sidebarHarness();

    expect(harness.created).to.have.length(1);
    expect(harness.created[0].viewId).to.equal(VIEWS.RAG_MEMORY);
    expect(harness.created[0].options.showCollapseAll).to.equal(false);
    const provider = harness.created[0].options.treeDataProvider as MemoryTreeDataProvider;
    expect(provider).to.be.instanceOf(MemoryTreeDataProvider);
    expect(harness.registered).to.deep.equal([COMMANDS.RESET_MEMORY, COMMANDS.REFRESH_MEMORY]);

    const labels = (await provider.getChildren()).map((item) => item.label);
    expect(labels).to.include("Memories: 7");
    expect(harness.execute.firstCall.args[1]).to.deep.equal(resolvedContext);
  });

  it("disposes the view and both commands together", function () {
    const harness = sidebarHarness();

    harness.registration.dispose();

    expect(harness.disposed).to.have.members([VIEWS.RAG_MEMORY, COMMANDS.RESET_MEMORY, COMMANDS.REFRESH_MEMORY]);
  });
});
