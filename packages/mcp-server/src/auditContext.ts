import { AsyncLocalStorage } from "node:async_hooks";

export type McpAuditState = { toolFailed: boolean };

export const mcpAuditContext = new AsyncLocalStorage<McpAuditState>();

export function markMcpToolResult(result: { isError?: unknown } | undefined): void {
  if (result?.isError === true) {
    const state = mcpAuditContext.getStore();
    if (state) {
      state.toolFailed = true;
    }
  }
}
