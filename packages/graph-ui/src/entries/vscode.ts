import { displayGraphDocument } from "../app";
import { connectVsCodeBridge, type VsCodeApi } from "../bridges/vscodeBridge";
import type { GraphVisualizationDocument } from "../documentTypes";

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

window.addEventListener("DOMContentLoaded", () => {
  void connectVsCodeBridge(acquireVsCodeApi<GraphVisualizationDocument>(), window, displayGraphDocument);
});
