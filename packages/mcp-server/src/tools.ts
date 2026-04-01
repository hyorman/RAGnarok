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
 */

import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TopicManager,
  RAGAgent,
  RetrievalStrategy,
  IConfigProvider,
  ILLMProvider,
  EmbeddingService,
  VectorStoreFactory,
  EXTENSION,
  Topic,
} from "@ragnarok/core";
import type { AvailableModel } from "@ragnarok/core";

export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  config: IConfigProvider,
  llmProvider: ILLMProvider,
  embeddingService: EmbeddingService,
  storageDir: string,
): void {
  // rag_query — Query a topic with RAG
  server.tool(
    "rag_query",
    "Query a RAG topic to find relevant information. Supports both simple retrieval and agentic multi-step query planning.",
    {
      topic: z.string().describe("The name of the topic to search within"),
      query: z.string().describe("The search query or question"),
      topK: z.number().optional().describe("Number of top results to return (default: 5)"),
      retrievalStrategy: z
        .enum(["vector", "hybrid", "ensemble", "bm25"])
        .optional()
        .describe("Retrieval strategy: vector, hybrid, ensemble, or bm25"),
    },
    async ({ topic, query, topK, retrievalStrategy }) => {
      try {
        // Find the topic
        const allTopics = topicManager.getAllTopics();
        const matchedTopic = allTopics.find((t) => t.name.toLowerCase() === topic.toLowerCase());

        if (!matchedTopic) {
          const available = allTopics.map((t) => t.name).join(", ");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Topic "${topic}" not found`,
                  availableTopics: available || "No topics available",
                }),
              },
            ],
          };
        }

        // Get vector store for the topic
        const databaseDir = path.join(storageDir, EXTENSION.DATABASE_DIR);
        const vectorStoreFactory = new VectorStoreFactory(
          databaseDir,
          embeddingService.getCurrentModel(),
          embeddingService,
        );

        const vectorStore = await vectorStoreFactory.loadStore(matchedTopic.id);
        if (!vectorStore) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `No vector store found for topic "${matchedTopic.name}"` }),
              },
            ],
          };
        }

        // Create and run RAG agent
        const ragAgent = new RAGAgent(config, llmProvider);
        await ragAgent.initialize(vectorStore);

        const strategy =
          (retrievalStrategy as RetrievalStrategy) ??
          (config.get<string>("retrievalStrategy", "hybrid") as RetrievalStrategy);

        const results = await ragAgent.query(query, {
          topicName: matchedTopic.name,
          topK: topK ?? config.get<number>("topK", 5),
          retrievalStrategy: strategy,
          maxIterations: config.get<number>("maxIterations", 3),
          confidenceThreshold: config.get<number>("confidenceThreshold", 0.7),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
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
        const allTopics = topicManager.getAllTopics();
        const matchedTopic = allTopics.find((t: Topic) => t.name.toLowerCase() === topic.toLowerCase());

        if (!matchedTopic) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Topic "${topic}" not found` }),
              },
            ],
          };
        }

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
        const allTopics = topicManager.getAllTopics();
        const matchedTopic = allTopics.find((t: Topic) => t.name.toLowerCase() === topic.toLowerCase());

        if (!matchedTopic) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Topic "${topic}" not found` }),
              },
            ],
          };
        }

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
}
