import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import type { GraphVisualizationDocument } from "@ragnarok/core";
import { MemoryGraphPanel, type MemoryGraphPanelFactory } from "../src/memoryGraphPanel";

function document(id: string): GraphVisualizationDocument {
  return {
    schema: "ragnarok.graph.visualization.v1",
    source: { kind: "memory", scope: "workspace" },
    nodes: [{ id, label: id, type: "memory", x: 0, y: 0, radius: 5, groupId: null, attributes: {} }],
    edges: [],
    groups: [],
    viewport: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    metadata: {
      originalNodeCount: 1,
      retainedNodeCount: 1,
      originalEdgeCount: 0,
      retainedEdgeCount: 0,
      truncated: false,
      truncationReasons: [],
      empty: false,
    },
  };
}

function harness() {
  const panels: any[] = [];
  const factory: MemoryGraphPanelFactory = {
    createWebviewPanel(viewType, title, column, options) {
      let disposeListener: (() => void) | undefined;
      let messageListener: ((message: unknown) => void) | undefined;
      let viewStateListener: (() => void) | undefined;
      const listenerDisposals: sinon.SinonSpy[] = [];
      const panel = {
        viewType,
        title,
        column,
        options,
        reveal: sinon.spy(),
        dispose: sinon.spy(() => disposeListener?.()),
        onDidDispose(listener: () => void) {
          disposeListener = listener;
          const dispose = sinon.spy();
          listenerDisposals.push(dispose);
          return { dispose };
        },
        visible: true,
        onDidChangeViewState(listener: () => void) {
          viewStateListener = listener;
          const dispose = sinon.spy();
          listenerDisposals.push(dispose);
          return { dispose };
        },
        setVisible(visible: boolean) {
          (panel as { visible: boolean }).visible = visible;
          viewStateListener?.();
        },
        webview: {
          cspSource: "vscode-webview://memory",
          html: "",
          asWebviewUri: sinon.spy((uri: any) => ({ toString: () => `webview:${uri.fsPath}` })),
          postMessage: sinon.spy(async () => true),
          onDidReceiveMessage(listener: (message: unknown) => void) {
            messageListener = listener;
            const dispose = sinon.spy();
            listenerDisposals.push(dispose);
            return { dispose };
          },
        },
        listenerDisposals,
        send(message: unknown) {
          messageListener?.(message);
        },
        close() {
          disposeListener?.();
        },
      };
      panels.push(panel);
      return panel as any;
    },
  };
  const manager = new MemoryGraphPanel(vscode.Uri.file("/extension"), factory, () => "fixed-nonce");
  return { manager, panels };
}

describe("memory graph panel", function () {
  afterEach(() => sinon.restore());

  it("queues only the latest document until the webview announces readiness", async function () {
    const test = harness();
    const first = document("first");
    const latest = document("latest");

    await test.manager.show(first);
    await test.manager.show(latest);

    expect(test.panels).to.have.lengthOf(1);
    expect(test.panels[0].reveal.calledOnce).to.equal(true);
    expect(test.panels[0].webview.postMessage.called).to.equal(false);
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    expect(
      test.panels[0].webview.postMessage.calledOnceWithExactly({ type: "graphDocument", document: latest }),
    ).to.equal(true);
  });

  it("posts the latest document again when a restored webview becomes ready", async function () {
    const test = harness();
    const latest = document("restored");
    await test.manager.show(latest);
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    test.panels[0].webview.postMessage.resetHistory();

    test.panels[0].send({ type: "ready" });
    await Promise.resolve();

    expect(
      test.panels[0].webview.postMessage.calledOnceWithExactly({ type: "graphDocument", document: latest }),
    ).to.equal(true);
  });

  it("stops posting while hidden and delivers the latest document on the next ready", async function () {
    const test = harness();
    await test.manager.show(document("first"));
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    test.panels[0].webview.postMessage.resetHistory();

    test.panels[0].setVisible(false);
    const latest = document("latest");
    await test.manager.show(latest);
    expect(test.panels[0].webview.postMessage.called).to.equal(false);

    test.panels[0].setVisible(true);
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    expect(
      test.panels[0].webview.postMessage.calledOnceWithExactly({ type: "graphDocument", document: latest }),
    ).to.equal(true);
  });

  it("posts the regenerated document when the webview asks to refresh", async function () {
    const test = harness();
    const refreshed = document("refreshed");
    const onRefresh = sinon.stub().resolves(refreshed);
    await test.manager.show(document("first"), onRefresh);
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    test.panels[0].webview.postMessage.resetHistory();

    test.panels[0].send({ type: "refresh" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onRefresh.calledOnce).to.equal(true);
    expect(
      test.panels[0].webview.postMessage.calledOnceWithExactly({ type: "graphDocument", document: refreshed }),
    ).to.equal(true);
  });

  it("answers a failed or empty refresh with the previous document so loading always clears", async function () {
    const test = harness();
    const first = document("first");
    for (const handler of [sinon.stub().rejects(new Error("nope")), sinon.stub().resolves(undefined)]) {
      await test.manager.show(first, handler);
      test.panels[0].send({ type: "ready" });
      await Promise.resolve();
      test.panels[0].webview.postMessage.resetHistory();

      test.panels[0].send({ type: "refresh" });
      await Promise.resolve();
      await Promise.resolve();

      expect(
        test.panels[0].webview.postMessage.calledOnceWithExactly({ type: "graphDocument", document: first }),
      ).to.equal(true);
    }
  });

  it("ignores a refresh when the shown document came without a handler", async function () {
    const test = harness();
    await test.manager.show(document("first"));
    test.panels[0].send({ type: "ready" });
    await Promise.resolve();
    test.panels[0].webview.postMessage.resetHistory();

    test.panels[0].send({ type: "refresh" });
    await Promise.resolve();

    expect(test.panels[0].webview.postMessage.called).to.equal(false);
  });

  it("uses a strict nonce CSP and only webview-local script and stylesheet URIs", async function () {
    const test = harness();

    await test.manager.show(document("secure"));

    const panel = test.panels[0];
    expect(panel.viewType).to.equal("ragnarok.memoryGraph");
    expect(panel.options.enableScripts).to.equal(true);
    expect(panel.options.localResourceRoots).to.have.lengthOf(1);
    expect(panel.options.localResourceRoots[0].fsPath).to.equal("/extension/media");
    expect(panel.webview.html).to.include("default-src 'none'");
    expect(panel.webview.html).to.include("style-src vscode-webview://memory");
    expect(panel.webview.html).to.include("script-src 'nonce-fixed-nonce'");
    expect(panel.webview.html).to.include('href="webview:/extension/media/memoryGraph.css"');
    expect(panel.webview.html).to.include('nonce="fixed-nonce" src="webview:/extension/media/memoryGraph.js"');
    expect(panel.webview.html).to.include("data-ragnarok-graph-app");
    expect(panel.webview.html).to.include('id="graph"');
    expect(panel.webview.html).to.include('id="graph-refresh"');
  });

  it("clears cached state after manual close so a later show creates a new panel", async function () {
    const test = harness();
    await test.manager.show(document("first"));

    test.panels[0].close();
    await test.manager.show(document("second"));

    expect(test.panels).to.have.lengthOf(2);
  });

  it("ignores malformed ready messages and disposes listeners and the live panel", async function () {
    const test = harness();
    await test.manager.show(document("one"));
    const panel = test.panels[0];

    panel.send(null);
    panel.send({ type: "other" });
    expect(panel.webview.postMessage.called).to.equal(false);

    test.manager.dispose();

    expect(panel.dispose.calledOnce).to.equal(true);
    expect(panel.listenerDisposals.every((dispose: sinon.SinonSpy) => dispose.calledOnce)).to.equal(true);
  });
});
