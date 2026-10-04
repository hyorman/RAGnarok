/**
 * MCP tool definitions for RAGnarōk
 *
 * RAG tools:
 * - rag_query: Query a topic with RAG
 * - rag_ingest: Add local files, a web page, or a GitHub repository to a topic
 * - rag_topic: List, create, rename, export, import, or get stats (incl. documents) for topics
 * - rag_delete_topic: Permanently delete a topic (kept separate: destructive)
 * - rag_remove_document: Permanently remove one indexed source (kept separate: destructive)
 *
 * Memory tools:
 * - rag_memory: Store, recall, forget, list, stats, decay, history, promote, links, or communities for project
 *   memories
 * - rag_reset_memory: Delete all standalone memories (kept separate: destructive)
 * - rag_memory_visualize: Interactive memory graph document for MCP Apps
 *
 * Embedding models, the reranker, and the LLM have no tools: all three are
 * configured exclusively through config.json and are internal to the
 * retrieval pipeline.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { TopicManager, RAGQueryService, MemoryStore, MemoryService, GraphVisualizationService } from "@ragnarok/core";
import type { McpConfig } from "./config";
import type { ToolRuntime } from "./toolRuntime";
import {
  destructiveAnnotations,
  makeRegistrar,
  networkWriteAnnotations,
  readOnlyAnnotations,
  toolError,
  toolErrorMessage,
  toolJson,
  writeAnnotations,
  type MutationRunner,
  type PendingTool,
  type ToolContext,
} from "./tools/shared";
import { createPathGuard, registerIngestTools } from "./tools/ingestTools";
import { registerMemoryTools } from "./tools/memoryTools";
import { registerQueryTools } from "./tools/queryTools";
import { registerTopicTools } from "./tools/topicTools";

export { MCP_LIMITS, measureToolResultForResponse, type MutationRunner } from "./tools/shared";
export { buildMemoryInputSchema } from "./tools/memoryTools";

export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  ragQueryService: RAGQueryService,
  memoryService?: MemoryService,
  graphVisualizationService?: GraphVisualizationService,
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
  runMutation: MutationRunner = (operation) => operation(),
  runtime: ToolRuntime = { run: (operation) => operation() },
): void {
  const pendingTools: PendingTool[] = [];
  const registerTool = makeRegistrar(pendingTools, runtime, config)(true);
  const ctx: ToolContext = {
    topicManager,
    ragQueryService,
    memoryService,
    graphVisualizationService,
    memoryBranchProvider,
    config,
    runMutation,
    toolRuntime: runtime,
    readOnlyAnnotations,
    writeAnnotations,
    destructiveAnnotations,
    networkWriteAnnotations,
    toolJson,
    toolError,
    toolErrorMessage,
    registerTool,
    assertPathAllowed: createPathGuard(config),
  };

  registerQueryTools(ctx);
  registerIngestTools(ctx);
  registerTopicTools(ctx);
  registerMemoryTools(ctx);

  for (const tool of pendingTools.sort((left, right) => left.name.localeCompare(right.name))) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}
