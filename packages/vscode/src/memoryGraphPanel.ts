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

/**
 * Regenerates the graph the panel is currently showing. Resolves with the fresh
 * document, or `undefined` when generation failed or was superseded — the panel
 * then re-posts what it already had, so the webview's loading indicator clears
 * either way.
 */
export type MemoryGraphRefresh = () => Promise<GraphVisualizationDocument | undefined>;

export class MemoryGraphPanel implements vscode.Disposable {
  private active: ActivePanel | undefined;
  private latestDocument: GraphVisualizationDocument | undefined;
  private refreshHandler: MemoryGraphRefresh | undefined;
  private ready = false;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly factory: MemoryGraphPanelFactory = vscodePanelFactory,
    private readonly createNonce: () => string = () => crypto.randomBytes(16).toString("base64"),
  ) {}

  async show(document: GraphVisualizationDocument, onRefresh?: MemoryGraphRefresh): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.latestDocument = document;
    this.refreshHandler = onRefresh;
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
    this.refreshHandler = undefined;
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
        const type = this.messageType(message);
        if (type === "ready") {
          this.ready = true;
          void this.postLatestDocument();
        } else if (type === "refresh") {
          void this.handleRefresh();
        }
      }),
      panel.onDidDispose(() => {
        if (this.active?.panel === panel) {
          this.detachPanel();
          this.latestDocument = undefined;
          this.refreshHandler = undefined;
        }
      }),
      panel.onDidChangeViewState(() => {
        if (this.active?.panel === panel && !panel.visible) {
          // The webview context is torn down while hidden, so a postMessage
          // would be dropped. The recreated script announces "ready" again on
          // reveal, which re-delivers the latest document.
          this.ready = false;
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

  /**
   * Answers a webview refresh with a document unconditionally: on a failed or
   * superseded regeneration the previous document goes back, because a webview
   * left waiting would show its loading indicator forever.
   */
  private async handleRefresh(): Promise<void> {
    const handler = this.refreshHandler;
    if (!handler || this.disposed) {
      return;
    }
    let next: GraphVisualizationDocument | undefined;
    try {
      next = await handler();
    } catch {
      // The refresh handler reports its own failures to the user.
      next = undefined;
    }
    if (this.disposed) {
      return;
    }
    if (next) {
      this.latestDocument = next;
    }
    await this.postLatestDocument();
  }

  private messageType(message: unknown): string | undefined {
    if (typeof message !== "object" || message === null) {
      return undefined;
    }
    const type = (message as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
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
        <button id="graph-refresh" type="button" title="Reload the graph and reset the view">Refresh</button>
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
