import { App } from "@modelcontextprotocol/ext-apps";
import type { ToolResultLike } from "./documentTypes";

export interface GraphAppBridge {
  setToolResultHandler(handler: (result: ToolResultLike) => void): void;
  connect(): Promise<void>;
}

export function createMcpGraphAppBridge(): GraphAppBridge {
  const app = new App({ name: "RAGnarok Graph", version: "0.6.0" });
  return {
    setToolResultHandler(handler) {
      app.ontoolresult = (result) => handler(result);
    },
    connect() {
      return app.connect();
    },
  };
}
