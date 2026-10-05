import { type CallToolResult, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  classifyToolError,
  TopicManager,
  RAGQueryService,
  MemoryStore,
  MemoryService,
  GraphVisualizationService,
  TOOL_LIMITS,
} from "@ragnarok/core";
import type { McpConfig } from "../config";
import { MCP_DEFAULTS } from "../defaults";
import type { ToolRuntime } from "../toolRuntime";

export type MutationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export const MCP_LIMITS = Object.freeze({
  topicName: TOOL_LIMITS.topicName,
  query: TOOL_LIMITS.query,
  path: 4_096,
  url: 2_048,
  responseBytes: MCP_DEFAULTS.MAX_RESPONSE_BYTES,
});

// Re-serializes JSON text content and mirrors it as structuredContent so
// clients get a typed payload without the tool handlers building it twice.
function normalizeToolResult(value: CallToolResult): CallToolResult {
  if (!value?.content) {
    return value;
  }
  let structuredContent: Record<string, unknown> | undefined;
  const content = value.content.map((item) => {
    if (item?.type !== "text" || typeof item.text !== "string") {
      return item;
    }
    try {
      const parsed = JSON.parse(item.text);
      structuredContent ??= parsed;
      return { ...item, text: JSON.stringify(parsed, null, 2) };
    } catch {
      return item;
    }
  });
  return { ...value, content, ...(structuredContent ? { structuredContent } : {}) };
}

function responseTooLargeResult(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: { code: "RESPONSE_TOO_LARGE", message: "Tool response exceeds configured limit" },
        }),
      },
    ],
  };
}

function isResponseTooLargeResult(result: CallToolResult): boolean {
  return Boolean(
    result.isError &&
    result.content?.some((item) => {
      if (item?.type !== "text" || typeof item.text !== "string") {
        return false;
      }
      try {
        return JSON.parse(item.text)?.error?.code === "RESPONSE_TOO_LARGE";
      } catch {
        return false;
      }
    }),
  );
}

export function measureToolResultForResponse(
  value: CallToolResult,
  maxResponseBytes: number,
): { fits: boolean; responseBytes: number; result: CallToolResult } {
  let result = normalizeToolResult(value);
  let responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (responseBytes > maxResponseBytes) {
    result = responseTooLargeResult();
    responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    return { fits: false, responseBytes, result };
  }
  return { fits: !isResponseTooLargeResult(result), responseBytes, result };
}

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const writeAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const destructiveAnnotations = { ...writeAnnotations, destructiveHint: true };
export const networkWriteAnnotations = { ...writeAnnotations, openWorldHint: true };

export type ToolHandler<Schema extends z.ZodType = z.ZodType> = (
  args: z.infer<Schema>,
  context: ServerContext,
) => Promise<CallToolResult>;
export type PendingTool = {
  name: string;
  config: {
    description: string;
    inputSchema: z.ZodType;
    annotations: ToolAnnotations;
    _meta?: Record<string, unknown>;
  };
  handler: ToolHandler<z.ZodType>;
};

export type ToolRegistrar = <Schema extends z.ZodType>(
  name: string,
  description: string,
  inputSchema: Schema,
  annotations: ToolAnnotations,
  handler: ToolHandler<Schema>,
  _meta?: Record<string, unknown>,
) => void;

export const makeRegistrar =
  (pendingTools: PendingTool[], runtime: ToolRuntime, config: McpConfig | undefined) =>
  (enabled: boolean): ToolRegistrar =>
  <Schema extends z.ZodType>(
    name: string,
    description: string,
    inputSchema: Schema,
    annotations: ToolAnnotations,
    handler: ToolHandler<Schema>,
    _meta?: Record<string, unknown>,
  ): void => {
    if (!enabled) {
      return;
    }
    pendingTools.push({
      name,
      config: { description, inputSchema, annotations, ...(_meta ? { _meta } : {}) },
      handler: (args, context) =>
        runtime.run(async () => {
          const { result } = measureToolResultForResponse(
            // The server parses `args` with `inputSchema` before calling this.
            await handler(args as z.infer<Schema>, context),
            config?.maxResponseBytes ?? MCP_LIMITS.responseBytes,
          );
          return result;
        }),
    });
  };

export const toolJson = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true as const } : {}),
});

// StorageBusyError means a foreign writer still held the write lease when
// this mutation's bounded 5s wait expired — that reads as "try again
// shortly", not the generic per-operation failure text. Typed on
// error.name (never message matching) so unrelated errors are unaffected.
export const toolErrorMessage = (error: unknown): string => classifyToolError(error).message;
export const toolError = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ error: toolErrorMessage(error) }),
    },
  ],
  isError: true,
});

/**
 * Everything the tool handlers captured as closures while they lived inside
 * registerTools. Each register*Tools(ctx) module reads its dependencies here.
 */
export interface ToolContext {
  topicManager: TopicManager;
  ragQueryService: RAGQueryService;
  memoryService?: MemoryService;
  graphVisualizationService?: GraphVisualizationService;
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">;
  config?: McpConfig;
  runMutation: MutationRunner;
  readOnlyAnnotations: ToolAnnotations;
  writeAnnotations: ToolAnnotations;
  destructiveAnnotations: ToolAnnotations;
  networkWriteAnnotations: ToolAnnotations;
  toolJson: typeof toolJson;
  toolError: typeof toolError;
  toolErrorMessage: typeof toolErrorMessage;
  registerTool: ToolRegistrar;
  assertPathAllowed: (filePath: string) => Promise<string>;
}
