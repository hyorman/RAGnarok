import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { GraphAppBridge } from "../app";
import { parseGraphVisualizationResult } from "../schema";

export function createMcpGraphAppBridge(): GraphAppBridge {
  const app = new App({ name: "RAGnarok Graph", version: "0.6.0" });
  return {
    setDocumentHandler(handler, errorHandler) {
      app.ontoolresult = (result) => {
        try {
          handler(parseGraphVisualizationResult(result));
        } catch (error) {
          errorHandler(error);
        }
      };
    },
    connect() {
      return app.connect();
    },
  };
}
