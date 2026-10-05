import { z } from "zod";
import { GRAPH_VISUALIZATION_MAX_NODES, TOOL_LIMITS } from "@ragnarok/core";
import { GRAPH_RESOURCE_URI } from "../uiResource";
import { invokeMemoryResetTool, invokeMemoryTool } from "../memoryToolAdapter";
import { invokeGraphVisualizationTool } from "../graphVisualizationAdapter";
import { MCP_LIMITS, measureToolResultForResponse, type ToolContext } from "./shared";

const graphVisualizationInput = z.discriminatedUnion("memoryScope", [
  z
    .object({
      source: z.literal("memory"),
      memoryScope: z.literal("workspace"),
      maxNodes: z.number().int().min(1).max(GRAPH_VISUALIZATION_MAX_NODES).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("memory"),
      memoryScope: z.literal("branch"),
      branch: z.string().trim().min(1).max(TOOL_LIMITS.branch),
      maxNodes: z.number().int().min(1).max(GRAPH_VISUALIZATION_MAX_NODES).optional(),
    })
    .strict(),
]);

/**
 * The rag_memory input schema. Every bound comes from TOOL_LIMITS in
 * @ragnarok/core, which mirrors MemoryService.validateCommonInput, so the Zod
 * gate and the service reject the same inputs at the same thresholds.
 */
export function buildMemoryInputSchema() {
  return z.object({
    action: z
      .enum(["store", "recall", "forget", "stats", "list", "decay", "history", "promote", "links", "communities"])
      .describe("The memory operation to perform"),
    content: z
      .string()
      .trim()
      .min(1)
      .max(TOOL_LIMITS.memoryContent)
      .optional()
      .describe("Memory content to store (required for 'store' action)"),
    query: z
      .string()
      .trim()
      .min(1)
      .max(TOOL_LIMITS.memoryQuery)
      .optional()
      .describe("Search query (required for 'recall' action)"),
    topK: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.memoryTopK)
      .optional()
      .describe("Number of results to return (default: 10, for 'recall' action)"),
    includeEntities: z
      .boolean()
      .optional()
      .describe("Include related graph entities in recall results (default: false)"),
    id: z
      .string()
      .trim()
      .min(1)
      .max(TOOL_LIMITS.memoryId)
      .optional()
      .describe("Memory entry ID (for 'forget' or 'history' action)"),
    olderThan: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.memoryDays)
      .optional()
      .describe("Forget memories older than N days (for 'forget' action)"),
    expired: z
      .boolean()
      .optional()
      .describe(
        "Purge entries whose TTL has passed or whose effective confidence decayed below the expiry threshold (for 'forget' action)",
      ),
    scope: z
      .enum(["workspace", "branch"])
      .optional()
      .describe("Memory scope (default: 'workspace' for store, both for recall)"),
    branch: z
      .string()
      .trim()
      .min(1)
      .max(TOOL_LIMITS.branch)
      .optional()
      .describe("Git branch name (auto-detected if scope is 'branch' and not provided)"),
    tags: z
      .array(z.string().trim().min(1).max(TOOL_LIMITS.tag))
      .max(TOOL_LIMITS.tags)
      .optional()
      .describe("Tags to attach to memory (for 'store' action)"),
    ttlDays: z.number().positive().max(TOOL_LIMITS.memoryDays).optional().describe("Optional memory TTL in days"),
    includeAuto: z.boolean().optional().describe("Include reserved auto-generated memories"),
    reinforce: z.boolean().optional().describe("Update access counters during recall (writer sessions only)"),
    ids: z
      .array(z.string().trim().min(1).max(TOOL_LIMITS.memoryId))
      .max(TOOL_LIMITS.ids)
      .optional()
      .describe("Memory IDs for promote"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.memoryListLimit)
      .optional()
      .describe("Max entries to return (for 'list' action, default: 50)"),
  });
}

export function registerMemoryTools(ctx: ToolContext): void {
  // Narrowed locals: property narrowing on `ctx` does not survive into the handler closures.
  const { memoryService, memoryBranchProvider, graphVisualizationService } = ctx;
  const graphResponseBytes = Math.min(
    ctx.config?.maxResponseBytes ?? MCP_LIMITS.responseBytes,
    MCP_LIMITS.responseBytes,
  );

  // The memory tools are structurally absent when their service dependencies were not built.
  if (memoryService) {
    ctx.registerTool(
      "rag_reset_memory",
      "Delete all standalone memories before changing embedding space",
      z.object({ confirm: z.literal(true) }),
      ctx.destructiveAnnotations,
      async (_input, context) => invokeMemoryResetTool(context, memoryService),
    );
  }

  // ────────────────────────────────────────────────────────────
  // Memory tools
  // ────────────────────────────────────────────────────────────

  if (memoryService && memoryBranchProvider) {
    ctx.registerTool(
      "rag_memory",
      "Store, recall, forget, list, or get stats for project memories. " +
        "Memories are stored per-workspace or per-git-branch. " +
        "Entities and relationships are automatically extracted when an LLM is available. " +
        "Supports decay (expire stale entries), history (version chain), promote (branch→workspace), links (cross-scope entity links), " +
        "and communities (clusters of related entities in the memory graph; requires an LLM provider).",
      buildMemoryInputSchema(),
      ctx.writeAnnotations,
      async (input, context) => invokeMemoryTool(input, context, memoryService, memoryBranchProvider, ctx.config),
    );
  }

  // rag_memory_visualize — interactive memory graph document for MCP Apps. It
  // reads the memory graph, so it is absent without a graph service rather than
  // registered as a tool that could only ever error.
  if (graphVisualizationService) {
    ctx.registerTool(
      "rag_memory_visualize",
      "Visualize a RAGnarōk workspace-memory or branch-memory graph as a deterministic bounded document.",
      graphVisualizationInput,
      ctx.readOnlyAnnotations,
      async (input, context) =>
        invokeGraphVisualizationTool(
          input,
          context,
          graphVisualizationService,
          graphResponseBytes,
          measureToolResultForResponse,
        ),
      { ui: { resourceUri: GRAPH_RESOURCE_URI } },
    );
  }
}
