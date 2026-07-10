/**
 * MCP tool definitions for RAGnarōk
 *
 * RAG tools:
 * - rag_query: Query a topic with RAG
 * - rag_list_topics: List available topics
 * - rag_topic_stats: Get statistics for a topic
 * - rag_create_topic: Create a new topic
 * - rag_add_documents: Add documents to a topic
 *
 * Embedding management tools:
 * - rag_list_embedding_models: List available embedding models
 * - rag_embedding_info: Get current embedding model info
 * - rag_switch_embedding_model: Switch the active embedding model
 *
 * LLM management tools:
 * - rag_llm_status: Get current LLM provider status
 *
 * Memory tools:
 * - rag_memory: Store, recall, forget, list, stats, decay, history, promote, or links for project memories
 */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TopicManager,
  RetrievalStrategy,
  ILLMProvider,
  EmbeddingService,
  RAGQueryService,
  TopicEmptyError,
  MemoryStore,
  CrossEncoderReranker,
  RerankerModelRegistry,
} from "@ragnarok/core";
import type { AvailableModel } from "@ragnarok/core";
import type { McpConfig } from "./config";

export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  llmProvider: ILLMProvider,
  embeddingService: EmbeddingService,
  ragQueryService: RAGQueryService,
  memoryStore?: MemoryStore,
  reranker?: CrossEncoderReranker | null,
  config?: McpConfig,
): void {
  // rag_query — Query a topic with RAG
  server.tool(
    "rag_query",
    "Query a RAG topic to find relevant information. Supports both simple retrieval and agentic multi-step query planning.",
    {
      topic: z.string().describe("The name of the topic to search within"),
      query: z.string().describe("The search query or question"),
      topK: z.number().optional().describe("Number of top results to return (default: 10)"),
      retrievalStrategy: z
        .enum(["vector", "hybrid", "ensemble", "bm25", "graph", "graph_hybrid"])
        .optional()
        .describe("Retrieval strategy: vector, hybrid, ensemble, bm25, graph (entity relationship traversal), or graph_hybrid (graph + semantic)"),
    },
    async ({ topic, query, topK, retrievalStrategy }) => {
      try {
        const result = await ragQueryService.executeQuery({
          topic,
          query,
          topK,
          retrievalStrategy: retrievalStrategy as RetrievalStrategy | undefined,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        // TopicEmptyError is informational, not a query failure — return as non-error
        if (error instanceof TopicEmptyError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ message: error.message, topicName: error.topicName }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // rag_list_topics — List available topics
  server.tool("rag_list_topics", "List all available RAG topics with their metadata", {}, async () => {
    try {
      const topics = topicManager.getAllTopics();
      const topicList = topics.map((t) => ({
        name: t.name,
        description: t.description,
        documentCount: t.documentCount,
        createdAt: new Date(t.createdAt).toISOString(),
        updatedAt: new Date(t.updatedAt).toISOString(),
        source: t.source || "local",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ topics: topicList, count: topicList.length }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // rag_topic_stats — Get statistics for a topic
  server.tool(
    "rag_topic_stats",
    "Get detailed statistics for a specific RAG topic",
    {
      topic: z.string().describe("The name of the topic to get stats for"),
    },
    async ({ topic }) => {
      try {
        const topicMatch = await topicManager.resolveTopicByName(topic);
        const matchedTopic = topicMatch.topic;

        const stats = await topicManager.getTopicStats(matchedTopic.id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // rag_create_topic — Create a new topic
  server.tool(
    "rag_create_topic",
    "Create a new RAG topic for organizing documents",
    {
      name: z.string().describe("Name for the new topic"),
      description: z.string().optional().describe("Description of the topic"),
    },
    async ({ name, description }) => {
      try {
        const topic = await topicManager.createTopic({ name, description });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  topic: {
                    id: topic.id,
                    name: topic.name,
                    description: topic.description,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // rag_add_documents — Add documents to a topic
  server.tool(
    "rag_add_documents",
    "Add one or more documents to a RAG topic. Supports PDF, Markdown, HTML, and plain text files.",
    {
      topic: z.string().describe("The name of the topic to add documents to"),
      filePaths: z.array(z.string()).describe("Array of file paths to add"),
    },
    async ({ topic, filePaths }) => {
      try {
        // Validate file paths to prevent path traversal attacks
        for (const filePath of filePaths) {
          const resolved = path.resolve(filePath);
          // Reject paths where resolving eliminates '..' segments (traversal attempt)
          if (path.isAbsolute(filePath)) {
            if (resolved !== path.normalize(filePath)) {
              throw new Error(`Invalid file path (path traversal detected): ${filePath}`);
            }
          } else {
            // For relative paths, ensure no '..' path segments exist
            const segments = filePath.split(/[/\\]/);
            if (segments.includes("..")) {
              throw new Error(`Invalid file path (parent directory traversal not allowed): ${filePath}`);
            }
          }
        }

        const topicMatch = await topicManager.resolveTopicByName(topic);
        const matchedTopic = topicMatch.topic;

        const results = await topicManager.addDocuments(matchedTopic.id, filePaths);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  topic: matchedTopic.name,
                  documentsAdded: filePaths.length,
                  results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // Embedding management tools
  // ────────────────────────────────────────────────────────────

  // rag_list_embedding_models — List all available embedding models
  server.tool(
    "rag_list_embedding_models",
    "List available embedding models (curated, bundled, local, and downloaded)",
    {},
    async () => {
      try {
        const models = await embeddingService.listAvailableModels();
        const currentModel = embeddingService.getCurrentModel();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  currentModel,
                  models: models.map((m: AvailableModel) => ({
                    name: m.name,
                    source: m.source,
                    downloaded: m.downloaded ?? false,
                    active: m.name === currentModel,
                  })),
                  count: models.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // rag_embedding_info — Get information about the current embedding model
  server.tool(
    "rag_embedding_info",
    "Get information about the currently active embedding model and backend",
    {},
    async () => {
      try {
        const currentModel = embeddingService.getCurrentModel();
        const backendType = embeddingService.getActiveBackendType();
        const localModelPath = embeddingService.getLocalModelPath();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  currentModel,
                  backend: backendType,
                  localModelPath: localModelPath ?? "none",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // rag_switch_embedding_model — Switch the active embedding model
  server.tool(
    "rag_switch_embedding_model",
    "Switch the active embedding model. The model will be downloaded if not already cached.",
    {
      model: z.string().describe("Embedding model identifier (e.g. 'Xenova/all-MiniLM-L6-v2')"),
    },
    async ({ model }) => {
      try {
        const previousModel = embeddingService.getCurrentModel();

        // Re-initialize the embedding service with the new model
        await embeddingService.initialize(model);

        const newModel = embeddingService.getCurrentModel();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  previousModel,
                  newModel,
                  message: `Embedding model switched to ${newModel}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // LLM management tools
  // ────────────────────────────────────────────────────────────

  // rag_llm_status — Get current LLM provider status
  server.tool(
    "rag_llm_status",
    "Get the current LLM provider status and configuration",
    {},
    async () => {
      try {
        const available = await llmProvider.isAvailable();
        const model = available ? await llmProvider.selectModel() : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  available,
                  model: model
                    ? { id: model.id, family: model.family }
                    : null,
                  hint: !available
                    ? "Set RAGNAROK_LLM_PROVIDER to 'openai', 'anthropic', or 'ollama' and provide the required API key to enable agentic query planning."
                    : undefined,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // Reranker management tools
  // ────────────────────────────────────────────────────────────

  // rag_list_reranker_models — List available cross-encoder reranker models
  server.tool(
    "rag_list_reranker_models",
    "List available cross-encoder reranker models with their status",
    {},
    async () => {
      try {
        const registry = RerankerModelRegistry.getInstance();
        const models = await registry.listAvailableModels();
        const currentModel = reranker?.getCurrentModel() ?? null;

        const result = {
          currentModel,
          enabled: reranker != null,
          isAvailable: reranker?.isAvailable() ?? false,
          models: models.map((m) => ({
            name: m.name,
            source: m.source,
            downloaded: m.downloaded ?? false,
            active: m.name === currentModel,
          })),
          count: models.length,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
          isError: true,
        };
      }
    },
  );

  // rag_reranker_info — Get current reranker configuration and status
  server.tool(
    "rag_reranker_info",
    "Get current reranker configuration and status",
    {},
    async () => {
      try {
        const result = {
          enabled: reranker != null,
          currentModel: reranker?.getCurrentModel() ?? null,
          isAvailable: reranker?.isAvailable() ?? false,
          maxCandidates: config?.rerankerMaxCandidates ?? null,
          candidateMultiplier: config?.rerankerCandidateMultiplier ?? null,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
          isError: true,
        };
      }
    },
  );

  // rag_switch_reranker_model — Switch to a different cross-encoder reranker model
  server.tool(
    "rag_switch_reranker_model",
    "Switch to a different cross-encoder reranker model",
    {
      model: z.string().min(1).describe("The reranker model identifier (e.g., 'Xenova/ms-marco-MiniLM-L-6-v2')"),
    },
    async ({ model }) => {
      try {
        if (!reranker) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Reranker is not available." }) }],
            isError: true,
          };
        }

        const previousModel = reranker.getCurrentModel();
        await reranker.switchModel(model);
        const newModel = reranker.getCurrentModel();

        const result = {
          success: true,
          previousModel,
          newModel,
          message: `Switched reranker model from ${previousModel} to ${newModel}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
          isError: true,
        };
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // Memory tools
  // ────────────────────────────────────────────────────────────

  if (memoryStore) {
    server.tool(
      "rag_memory",
      "Store, recall, forget, list, or get stats for project memories. " +
        "Memories are stored per-workspace or per-git-branch. " +
        "Entities and relationships are automatically extracted when an LLM is available. " +
        "Supports decay (expire stale entries), history (version chain), promote (branch→workspace), and links (cross-scope entity links).",
      {
        action: z
          .enum(["store", "recall", "forget", "stats", "list", "decay", "history", "promote", "links"])
          .describe("The memory operation to perform"),
        content: z
          .string()
          .optional()
          .describe("Memory content to store (required for 'store' action)"),
        query: z
          .string()
          .optional()
          .describe("Search query (required for 'recall' action)"),
        topK: z
          .number()
          .optional()
          .describe("Number of results to return (default: 10, for 'recall' action)"),
        includeEntities: z
          .boolean()
          .optional()
          .describe("Include related graph entities in recall results (default: false)"),
        id: z
          .string()
          .optional()
          .describe("Memory entry ID (for 'forget' or 'history' action)"),
        olderThan: z
          .number()
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
          .optional()
          .describe("Git branch name (auto-detected if scope is 'branch' and not provided)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags to attach to memory (for 'store' action)"),
        limit: z
          .number()
          .optional()
          .describe("Max entries to return (for 'list' action, default: 50)"),
      },
      async ({
        action,
        content,
        query,
        topK,
        includeEntities,
        id,
        olderThan,
        expired,
        scope,
        branch,
        tags,
        limit,
      }) => {
        try {
          switch (action) {
            case "store": {
              if (!content) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({ error: "'content' is required for 'store' action" }),
                    },
                  ],
                  isError: true,
                };
              }
              const entry = await memoryStore.store({
                content,
                scope: scope ?? "workspace",
                branch,
                tags,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "store",
                        memory: {
                          id: entry.id,
                          content: entry.content,
                          scope: entry.scope,
                          branch: entry.branch,
                          entityIds: entry.entityIds,
                          tags: entry.tags,
                          createdAt: new Date(entry.createdAt).toISOString(),
                        },
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "recall": {
              if (!query) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({ error: "'query' is required for 'recall' action" }),
                    },
                  ],
                  isError: true,
                };
              }
              const result = await memoryStore.recall({
                query,
                scope,
                branch,
                topK: topK ?? 10,
                includeEntities: includeEntities ?? false,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "recall",
                        memories: result.memories.map(({ entry, score }) => ({
                          id: entry.id,
                          content: entry.content,
                          scope: entry.scope,
                          branch: entry.branch,
                          score: Math.round(score * 1000) / 1000,
                          tags: entry.tags,
                          createdAt: new Date(entry.createdAt).toISOString(),
                        })),
                        entities: result.entities.map(({ entity, score }) => ({
                          name: entity.name,
                          type: entity.type,
                          description: entity.description,
                          score: Math.round(score * 1000) / 1000,
                        })),
                        count: result.memories.length,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "forget": {
              const count = await memoryStore.forget({
                id,
                scope,
                branch,
                olderThan,
                expired,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      { action: "forget", forgottenCount: count },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "stats": {
              const memStats = await memoryStore.stats();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      { action: "stats", ...memStats },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "list": {
              const entries = await memoryStore.list({
                scope,
                branch,
                limit: limit ?? 50,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "list",
                        memories: entries.map((e) => ({
                          id: e.id,
                          content:
                            e.content.slice(0, 200) +
                            (e.content.length > 200 ? "..." : ""),
                          scope: e.scope,
                          branch: e.branch,
                          tags: e.tags,
                          accessCount: e.accessCount,
                          createdAt: new Date(e.createdAt).toISOString(),
                        })),
                        count: entries.length,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "decay": {
              const status = await memoryStore.runDecay(scope, branch);
              const { expiredCount: belowThresholdCount, ...rest } = status;
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "decay",
                        ...rest,
                        belowThresholdCount,
                        note: "Use the 'forget' action with expired: true to remove expired entries",
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "history": {
              if (!id) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({ error: "'id' is required for 'history' action" }),
                    },
                  ],
                  isError: true,
                };
              }
              const versions = await memoryStore.getVersionHistory(id);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "history",
                        entryId: id,
                        versions: versions.map((v) => ({
                          id: v.id,
                          content:
                            v.content.slice(0, 200) +
                            (v.content.length > 200 ? "..." : ""),
                          version: v.version ?? 1,
                          isLatest: v.isLatest ?? true,
                          confidence: v.confidence ?? 1.0,
                          supersededBy: v.supersededBy ?? null,
                          createdAt: new Date(v.createdAt).toISOString(),
                        })),
                        count: versions.length,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "promote": {
              if (!branch) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({ error: "'branch' is required for 'promote' action" }),
                    },
                  ],
                  isError: true,
                };
              }
              const entryIds = id ? id.split(",").map(s => s.trim()) : undefined;
              const promoted = await memoryStore.promoteToWorkspace(branch, entryIds);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      { action: "promote", branch, promotedCount: promoted },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "links": {
              const sourceScope = scope ? (scope === "branch" && branch ? `branch:${branch}` : scope) : undefined;
              const links = await memoryStore.discoverLinks(sourceScope, undefined);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        action: "links",
                        links: links.map((l) => ({
                          sourceScope: l.sourceScope,
                          targetScope: l.targetScope,
                          entityName: l.entityName,
                          entityType: l.entityType,
                          confidence: Math.round(l.confidence * 1000) / 1000,
                        })),
                        count: links.length,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }}
