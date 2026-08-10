import { createMcpGraphAppBridge, type GraphAppBridge } from "./bridge";
import { clearVisualization, renderDocument, showEmpty, showError } from "./renderer";
import { parseGraphVisualizationResult } from "./schema";

export async function startGraphApp(bridge: GraphAppBridge = createMcpGraphAppBridge()): Promise<void> {
  const loading = document.querySelector<HTMLElement>("#loading");
  if (loading) {
    loading.hidden = false;
  }

  bridge.setToolResultHandler((result) => {
    clearVisualization();
    try {
      const graph = parseGraphVisualizationResult(result);
      if (graph.nodes.length === 0) {
        showEmpty();
      } else {
        renderDocument(graph);
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Unable to display the graph visualization.");
    }
  });

  try {
    await bridge.connect();
  } catch {
    clearVisualization();
    showError("Unable to connect to the MCP host.");
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    void startGraphApp();
  });
}
