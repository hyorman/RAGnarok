import type { GraphVisualizationDocument } from "./documentTypes";
import { clearVisualization, renderDocument, showEmpty, showError } from "./renderer";

export interface GraphAppBridge {
  setDocumentHandler(
    handler: (document: GraphVisualizationDocument) => void,
    errorHandler: (error: unknown) => void,
  ): void;
  connect(): Promise<void>;
}

export async function startGraphApp(
  bridge: GraphAppBridge,
  connectionError = "Unable to connect to the graph host.",
): Promise<void> {
  const loading = document.querySelector<HTMLElement>("#loading");
  if (loading) {
    loading.hidden = false;
  }

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
