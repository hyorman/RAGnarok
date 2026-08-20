import { startGraphApp } from "../app";
import { createMcpGraphAppBridge } from "../bridges/mcpBridge";

window.addEventListener("DOMContentLoaded", () => {
  void startGraphApp(createMcpGraphAppBridge(), "Unable to connect to the MCP host.");
});
