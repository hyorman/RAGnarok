import type { ServerContext } from "@modelcontextprotocol/server";
import { MemoryServiceError, normalizeMemoryInput, toolErrorPayload } from "@ragnarok/core";
import type {
  MemoryHostContext,
  MemoryOperationResult,
  MemoryResetResult,
  MemoryService,
  MemoryStore,
  MemoryToolInput,
} from "@ragnarok/core";
import type { McpConfig } from "./config";

export type MemoryToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

function toolJson(value: unknown, isError = false): MemoryToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(error: unknown): MemoryToolResult {
  return toolJson({ error: error instanceof Error ? error.message : String(error) }, true);
}

/**
 * rag_memory reports the canonical {error: {code, message}} payload both hosts
 * share; isError stays on the MCP envelope around it. Other MCP tools keep
 * their flat error body until their own switchover.
 */
function memoryToolError(error: unknown): MemoryToolResult {
  const payload =
    error instanceof MemoryServiceError
      ? toolErrorPayload(error.code, error.message)
      : toolErrorPayload("MEMORY_OPERATION_FAILED", error instanceof Error ? error.message : String(error));
  return toolJson(payload, true);
}

async function resolveHostContext(
  branchProvider: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
): Promise<MemoryHostContext> {
  const detectedBranch = await branchProvider.getCurrentBranch();
  return {
    workingDir: config?.workingDir || process.cwd(),
    branchContext: detectedBranch ? { state: "resolved", branch: detectedBranch } : { state: "unavailable" },
  };
}

export async function invokeMemoryTool(
  input: MemoryToolInput,
  context: ServerContext,
  memoryService: Pick<MemoryService, "execute">,
  branchProvider: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
): Promise<MemoryToolResult> {
  try {
    const hostContext = await resolveHostContext(branchProvider, config);
    const result = await memoryService.execute(normalizeMemoryInput(input), hostContext, context.mcpReq.signal);
    return toolJson(result satisfies MemoryOperationResult);
  } catch (error) {
    return memoryToolError(error);
  }
}

export async function invokeMemoryResetTool(
  context: ServerContext,
  memoryService: Pick<MemoryService, "reset">,
): Promise<MemoryToolResult> {
  try {
    const result = await memoryService.reset(context.mcpReq.signal);
    return toolJson(result satisfies MemoryResetResult);
  } catch (error) {
    return toolError(error);
  }
}
