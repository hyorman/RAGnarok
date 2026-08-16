import { expect } from "chai";
import sinon from "sinon";
import type { GraphVisualizationDocument, GraphVisualizationRequest } from "@ragnarok/core";
import { COMMANDS } from "../src/constants";
import {
  registerMemoryGraphCommand,
  type MemoryGraphCommandHost,
  type MemoryGraphWorkspaceFolder,
} from "../src/memoryGraphCommand";
import type { ExtensionOperationRunner } from "../src/extensionLifecycle";

const graphDocument: GraphVisualizationDocument = {
  schema: "ragnarok.graph.visualization.v1",
  source: { kind: "memory", scope: "workspace" },
  nodes: [],
  edges: [],
  groups: [],
  viewport: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  metadata: {
    originalNodeCount: 0,
    retainedNodeCount: 0,
    originalEdgeCount: 0,
    retainedEdgeCount: 0,
    truncated: false,
    truncationReasons: [],
    empty: true,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function namedDocument(name: string): GraphVisualizationDocument {
  return {
    ...graphDocument,
    nodes: [{ id: name, label: name, type: "memory", x: 0, y: 0, radius: 5, groupId: null, attributes: {} }],
    metadata: {
      ...graphDocument.metadata,
      originalNodeCount: 1,
      retainedNodeCount: 1,
      empty: false,
    },
  };
}

function folder(name: string, fsPath: string): MemoryGraphWorkspaceFolder {
  return { name, uri: { fsPath } };
}

function harness(folders: readonly MemoryGraphWorkspaceFolder[]) {
  let callback: (() => Promise<void>) | undefined;
  const events: string[] = [];
  const showWorkspaceFolderPick = sinon.stub().callsFake(async () => {
    events.push("folder");
    return folders[1];
  });
  const showScopeQuickPick = sinon.stub().callsFake(async (items) => {
    events.push("scope");
    return items[1];
  });
  const getCurrentBranch = sinon.stub().resolves("feature/graph");
  const host: MemoryGraphCommandHost = {
    workspaceFolders: folders,
    registerCommand(command, handler) {
      expect(command).to.equal(COMMANDS.SHOW_MEMORY_GRAPH);
      callback = handler;
      return { dispose: sinon.spy() };
    },
    showWorkspaceFolderPick,
    showScopeQuickPick,
    showErrorMessage: sinon.spy(async () => undefined),
    getCurrentBranch,
  };
  const graphService = { generate: sinon.stub().resolves(graphDocument) };
  const panel = { show: sinon.spy() };
  const run = async <T>(_label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    operation(new AbortController().signal);
  const operationRunner = sinon.spy(run) as sinon.SinonSpy & ExtensionOperationRunner;
  const registration = registerMemoryGraphCommand(graphService, panel, operationRunner, host);
  return {
    invoke: () => callback!(),
    events,
    host,
    graphService,
    panel,
    operationRunner,
    registration,
  };
}

describe("memory graph command", function () {
  afterEach(() => sinon.restore());

  it("picks a folder before scope in multi-root mode and uses that folder's displayed branch", async function () {
    const first = folder("one", "/workspace/one");
    const second = folder("two", "/workspace/two");
    const test = harness([first, second]);

    await test.invoke();

    expect(test.events).to.deep.equal(["folder", "scope"]);
    expect((test.host.getCurrentBranch as sinon.SinonSpy).calledOnceWithExactly(second.uri.fsPath)).to.equal(true);
    const scopeItems = (test.host.showScopeQuickPick as sinon.SinonSpy).firstCall.args[0];
    expect(scopeItems[1].label).to.include("feature/graph");
    expect(
      test.graphService.generate.calledOnceWithExactly({ scope: "branch", branch: "feature/graph" }, sinon.match.any),
    ).to.equal(true);
    expect(test.operationRunner.calledOnce).to.equal(true);
    expect(test.panel.show.calledOnceWithExactly(graphDocument)).to.equal(true);
  });

  it("generates a workspace graph without requiring a branch", async function () {
    const test = harness([folder("one", "/workspace/one")]);
    (test.host.showScopeQuickPick as sinon.SinonStub).callsFake(async (items) => items[0]);

    await test.invoke();

    expect((test.host.showWorkspaceFolderPick as sinon.SinonSpy).called).to.equal(false);
    expect(test.graphService.generate.firstCall.args[0] as GraphVisualizationRequest).to.deep.equal({
      scope: "workspace",
    });
  });

  it("stops when folder selection is cancelled", async function () {
    const test = harness([folder("one", "/one"), folder("two", "/two")]);
    (test.host.showWorkspaceFolderPick as sinon.SinonStub).resolves(undefined);

    await test.invoke();

    expect((test.host.showScopeQuickPick as sinon.SinonSpy).called).to.equal(false);
    expect(test.graphService.generate.called).to.equal(false);
  });

  it("stops when scope selection is cancelled", async function () {
    const test = harness([folder("one", "/one")]);
    (test.host.showScopeQuickPick as sinon.SinonStub).resolves(undefined);

    await test.invoke();

    expect(test.graphService.generate.called).to.equal(false);
    expect(test.panel.show.called).to.equal(false);
  });

  it("shows a concise error instead of requesting a branch graph when Git has no current branch", async function () {
    const test = harness([folder("one", "/one")]);
    (test.host.getCurrentBranch as sinon.SinonStub).resolves(null);

    await test.invoke();

    expect((test.host.showErrorMessage as sinon.SinonSpy).calledOnce).to.equal(true);
    expect((test.host.showErrorMessage as sinon.SinonSpy).firstCall.args[0]).to.include("current Git branch");
    expect(test.graphService.generate.called).to.equal(false);
  });

  it("keeps the later graph when an earlier invocation resolves last", async function () {
    const test = harness([folder("one", "/one")]);
    (test.host.showScopeQuickPick as sinon.SinonStub).callsFake(async (items) => items[0]);
    const first = deferred<GraphVisualizationDocument>();
    const second = deferred<GraphVisualizationDocument>();
    test.graphService.generate.onFirstCall().returns(first.promise);
    test.graphService.generate.onSecondCall().returns(second.promise);

    const invocationA = test.invoke();
    while (test.graphService.generate.callCount < 1) {
      await Promise.resolve();
    }
    const invocationB = test.invoke();
    while (test.graphService.generate.callCount < 2) {
      await Promise.resolve();
    }

    const documentB = namedDocument("B");
    second.resolve(documentB);
    await invocationB;
    first.resolve(namedDocument("A"));
    await invocationA;

    expect(test.panel.show.calledOnceWithExactly(documentB)).to.equal(true);
  });

  it("does not surface an error from an invocation superseded by a later success", async function () {
    const test = harness([folder("one", "/one")]);
    (test.host.showScopeQuickPick as sinon.SinonStub).callsFake(async (items) => items[0]);
    const first = deferred<GraphVisualizationDocument>();
    const second = deferred<GraphVisualizationDocument>();
    test.graphService.generate.onFirstCall().returns(first.promise);
    test.graphService.generate.onSecondCall().returns(second.promise);

    const invocationA = test.invoke();
    while (test.graphService.generate.callCount < 1) {
      await Promise.resolve();
    }
    const invocationB = test.invoke();
    while (test.graphService.generate.callCount < 2) {
      await Promise.resolve();
    }
    second.resolve(namedDocument("B"));
    await invocationB;

    first.reject(new Error("stale failure"));

    expect(await invocationA).to.equal(undefined);
  });

  it("does not show a missing-branch error from an invocation superseded while detecting Git context", async function () {
    const test = harness([folder("one", "/one")]);
    const firstBranch = deferred<string | null>();
    (test.host.getCurrentBranch as sinon.SinonStub).onFirstCall().returns(firstBranch.promise);
    (test.host.getCurrentBranch as sinon.SinonStub).onSecondCall().resolves("main");
    (test.host.showScopeQuickPick as sinon.SinonStub).onFirstCall().callsFake(async (items) => items[0]);
    (test.host.showScopeQuickPick as sinon.SinonStub).onSecondCall().callsFake(async (items) => items[1]);

    const invocationA = test.invoke();
    while ((test.host.getCurrentBranch as sinon.SinonStub).callCount < 1) {
      await Promise.resolve();
    }
    const invocationB = test.invoke();
    await invocationB;

    firstBranch.resolve(null);
    await invocationA;

    expect((test.host.showErrorMessage as sinon.SinonSpy).called).to.equal(false);
  });
});
