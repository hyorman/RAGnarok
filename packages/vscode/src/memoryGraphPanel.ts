import * as crypto from "crypto";
import * as vscode from "vscode";
import type { GraphVisualizationDocument } from "@ragnarok/core";

export interface MemoryGraphPanelFactory {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: vscode.ViewColumn,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ): vscode.WebviewPanel;
}

const vscodePanelFactory: MemoryGraphPanelFactory = {
  createWebviewPanel: (viewType, title, showOptions, options) =>
    vscode.window.createWebviewPanel(viewType, title, showOptions, options),
};

interface ActivePanel {
  panel: vscode.WebviewPanel;
  listeners: vscode.Disposable[];
}

export class MemoryGraphPanel implements vscode.Disposable {
  private active: ActivePanel | undefined;
  private latestDocument: GraphVisualizationDocument | undefined;
  private ready = false;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly factory: MemoryGraphPanelFactory = vscodePanelFactory,
    private readonly createNonce: () => string = () => crypto.randomBytes(16).toString("base64"),
  ) {}

  async show(document: GraphVisualizationDocument): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.latestDocument = document;
    if (!this.active) {
      this.createPanel();
    } else {
      this.active.panel.reveal(vscode.ViewColumn.Active);
    }
    if (this.ready) {
      await this.postLatestDocument();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.latestDocument = undefined;
    const active = this.detachPanel();
    active?.panel.dispose();
  }

  private createPanel(): void {
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, "media");
    const panel = this.factory.createWebviewPanel(
      "ragnarok.memoryGraph",
      "RAGnarok Memory Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [mediaUri],
      },
    );
    this.ready = false;
    const listeners = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!this.isReadyMessage(message)) {
          return;
        }
        this.ready = true;
        void this.postLatestDocument();
      }),
      panel.onDidDispose(() => {
        if (this.active?.panel === panel) {
          this.detachPanel();
          this.latestDocument = undefined;
        }
      }),
    ];
    this.active = { panel, listeners };
    panel.webview.html = this.createHtml(panel.webview, mediaUri);
  }

  private detachPanel(): ActivePanel | undefined {
    const active = this.active;
    this.active = undefined;
    this.ready = false;
    if (active) {
      for (const listener of active.listeners) {
        listener.dispose();
      }
    }
    return active;
  }

  private async postLatestDocument(): Promise<void> {
    const panel = this.active?.panel;
    const document = this.latestDocument;
    if (!panel || !document || !this.ready) {
      return;
    }
    await panel.webview.postMessage({ type: "graphDocument", document });
  }

  private isReadyMessage(message: unknown): message is { type: "ready" } {
    return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ready";
  }

  private createHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    const nonce = this.createNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "memoryGraph.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "memoryGraph.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>RAGnarok Memory Graph</title>
</head>
<body>
  <main id="app" data-ragnarok-graph-app>
    <header id="toolbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span id="title">RAGnarok Memory Graph</span>
      </div>
      <div class="toolbar-actions" aria-label="Graph controls">
        <button id="reset-view" type="button">Reset view</button>
        <button id="toggle-labels" type="button" aria-pressed="true">Labels</button>
      </div>
      <span id="truncation-banner" aria-live="polite"></span>
    </header>
    <section id="graph-stage" aria-label="Graph viewport">
      <div id="loading" role="status" aria-live="polite">Loading graph...</div>
      <div id="status" role="status" aria-live="polite"></div>
      <div id="error" role="alert" hidden></div>
      <svg id="graph" role="img" aria-labelledby="graph-title graph-description">
        <title id="graph-title">RAGnarok memory graph visualization</title>
        <desc id="graph-description">Interactive graph of connected memory entities.</desc>
      </svg>
      <aside id="panel" role="dialog" aria-labelledby="panel-title" hidden>
        <div class="panel-heading">
          <h2 id="panel-title"></h2>
          <button id="panel-close" type="button" aria-label="Close details">Close</button>
        </div>
        <dl id="panel-attrs"></dl>
      </aside>
    </section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
