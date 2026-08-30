import { expect } from "chai";
import * as path from "path";
import * as vscode from "vscode";
import type { GraphVisualizationDocument } from "@ragnarok/core";
import { MemoryGraphPanel } from "../src/memoryGraphPanel";

const EMPTY_DOCUMENT = {
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
} as unknown as GraphVisualizationDocument;

describe("memory graph webview in the extension host", function () {
  this.timeout(60_000);

  it("loads media/memoryGraph.js and completes the ready handshake", async function () {
    const extensionUri = vscode.Uri.file(path.resolve(__dirname, "../../../.."));
    let resolveReady: (message: unknown) => void;
    const ready = new Promise<unknown>((resolve) => {
      resolveReady = resolve;
    });

    const panel = new MemoryGraphPanel(extensionUri, {
      createWebviewPanel: (viewType, title, showOptions, options) => {
        const created = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
        created.webview.onDidReceiveMessage((message) => resolveReady(message));
        return created;
      },
    });

    await panel.show(EMPTY_DOCUMENT);
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("webview never posted 'ready'")), 30_000),
    );
    try {
      expect(await Promise.race([ready, timeout])).to.deep.equal({ type: "ready" });
    } finally {
      panel.dispose();
    }
  });
});
