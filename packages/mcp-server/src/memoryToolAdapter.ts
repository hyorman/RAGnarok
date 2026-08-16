import type { ServerContext } from "@modelcontextprotocol/server";
import type {
  MemoryHostContext,
  MemoryOperationInput,
  MemoryOperationResult,
  MemoryResetResult,
  MemoryService,
  MemoryStore,
} from "@ragnarok/core";
import type { McpConfig } from "./config";

type MemoryToolInput = Record<string, unknown> & { action: MemoryOperationInput["action"] };

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

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function normalizeMemoryInput(input: MemoryToolInput): MemoryOperationInput {
  switch (input.action) {
    case "store":
      return defined({
        action: "store" as const,
        content: (input.content as string | undefined) ?? "",
        scope: input.scope,
        branch: input.branch,
        tags: input.tags,
        ttlDays: input.ttlDays,
      }) as MemoryOperationInput;
    case "recall":
      return defined({
        action: "recall" as const,
        query: (input.query as string | undefined) ?? "",
        topK: input.topK,
        includeEntities: input.includeEntities,
        includeAuto: input.includeAuto,
        reinforce: input.reinforce,
        scope: input.scope,
        branch: input.branch,
      }) as MemoryOperationInput;
    case "forget":
      return defined({
        action: "forget" as const,
        id: input.id,
        olderThan: input.olderThan,
        expired: input.expired,
        scope: input.scope,
        branch: input.branch,
      }) as MemoryOperationInput;
    case "stats":
      return { action: "stats" };
    case "list":
      return defined({
        action: "list" as const,
        limit: input.limit,
        includeAuto: input.includeAuto,
        scope: input.scope,
        branch: input.branch,
      }) as MemoryOperationInput;
    case "decay":
      return defined({ action: "decay" as const, scope: input.scope, branch: input.branch }) as MemoryOperationInput;
    case "history":
      return { action: "history", id: (input.id as string | undefined) ?? "" };
    case "promote":
      return defined({
        action: "promote" as const,
        branch: (input.branch as string | undefined) ?? "",
        ids: input.ids,
        id: input.id,
      }) as MemoryOperationInput;
    case "links":
      return defined({ action: "links" as const, scope: input.scope, branch: input.branch }) as MemoryOperationInput;
    case "communities":
      return defined({
        action: "communities" as const,
        scope: input.scope,
        branch: input.branch,
      }) as MemoryOperationInput;
  }
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
    return toolError(error);
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
