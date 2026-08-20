import { displayGraphDocument } from "../app";
import { connectVsCodeBridge, requestGraphRefresh, type VsCodeApi } from "../bridges/vscodeBridge";
import type { GraphVisualizationDocument } from "../documentTypes";
import { installGraphToolbar } from "../toolbar";

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

window.addEventListener("DOMContentLoaded", () => {
  const api = acquireVsCodeApi<GraphVisualizationDocument>();
  installGraphToolbar({ requestRefresh: () => requestGraphRefresh(api) });
  void connectVsCodeBridge(api, window, displayGraphDocument);
});
