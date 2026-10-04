import { z } from "zod";
import { executeQueryTool } from "@ragnarok/core";
import { MCP_LIMITS, type ToolContext } from "./shared";

export function registerQueryTools(ctx: ToolContext): void {
  // rag_query — Query a topic with RAG
  ctx.registerTool(
    "rag_query",
    "Query a RAG topic to find relevant information. Supports both simple retrieval and agentic multi-step query planning.",
    z.object({
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to search within"),
      query: z.string().trim().min(1).max(MCP_LIMITS.query).describe("The search query or question"),
      topK: z.number().int().min(1).max(20).optional().describe("Number of top results to return (default: 10)"),
      retrievalStrategy: z
        .enum(["vector", "hybrid", "bm25"])
        .optional()
        .describe(
          "Retrieval strategy: 'vector' (semantic only), 'hybrid' (semantic + keyword), or 'bm25' (keyword only). Optional - uses configured value if not provided.",
        ),
    }),
    ctx.readOnlyAnnotations,
    // No workspace context is supplied: editor state is VS Code's alone. Query
    // failures keep MCP's flat {error: message} shape; only rag_memory uses
    // {error: {code, message}}.
    async ({ topic, query, topK, retrievalStrategy }, context) => {
      try {
        return ctx.toolJson(
          await executeQueryTool(
            { topic, query, topK, retrievalStrategy },
            { ragQueryService: ctx.ragQueryService },
            context.mcpReq.signal,
          ),
        );
      } catch (error) {
        return ctx.toolError(error);
      }
    },
  );
}
