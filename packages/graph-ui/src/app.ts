import type { GraphVisualizationDocument } from "./documentTypes";
import { clearVisualization, renderDocument, showEmpty, showError, showLoading } from "./renderer";
import { installGraphToolbar } from "./toolbar";

export interface GraphAppBridge {
  setDocumentHandler(
    handler: (document: GraphVisualizationDocument) => void,
    errorHandler: (error: unknown) => void,
  ): void;
  connect(): Promise<void>;
  /** Optional: hosts that can re-send the document on demand implement this. */
  requestRefresh?(): void;
}

export async function startGraphApp(
  bridge: GraphAppBridge,
  connectionError = "Unable to connect to the graph host.",
): Promise<void> {
  showLoading();
  installGraphToolbar({ requestRefresh: bridge.requestRefresh?.bind(bridge) });

  bridge.setDocumentHandler(displayGraphDocument, displayGraphError);

  try {
    await bridge.connect();
  } catch {
    clearVisualization();
    showError(connectionError);
  }
}

export function displayGraphDocument(graph: GraphVisualizationDocument): void {
  clearVisualization();
  if (graph.nodes.length === 0) {
    showEmpty();
  } else {
    renderDocument(graph);
  }
}

export function displayGraphError(error: unknown): void {
  clearVisualization();
  showError(error instanceof Error ? error.message : "Unable to display the graph visualization.");
}
