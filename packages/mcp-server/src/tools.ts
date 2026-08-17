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
 * Embedding management tools:
 * - rag_list_embedding_models: List available embedding models
 * - rag_embedding_info: Get current embedding model info
 * - rag_switch_embedding_model: Switch the active embedding model
 *
 * Memory tools:
 * - rag_memory: Store, recall, forget, list, stats, decay, history, promote, links, or communities for project
 *   memories
 * - rag_reset_memory: Delete all standalone memories (kept separate: destructive)
 * - rag_memory_visualize: Interactive memory graph document for MCP Apps
 *
 * Reranker and LLM management have no tools: both are configured exclusively
 * through config.json and are internal to the retrieval pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { McpServer, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  TopicManager,
  RetrievalStrategy,
  EmbeddingService,
  RAGQueryService,
  TopicEmptyError,
  MemoryStore,
  MemoryService,
  GraphVisualizationService,
} from "@ragnarok/core";
import type { AvailableModel } from "@ragnarok/core";
import { GRAPH_RESOURCE_URI } from "./uiResource";
import type { McpConfig } from "./config";
import { invokeMemoryResetTool, invokeMemoryTool } from "./memoryToolAdapter";
import { invokeGraphVisualizationTool } from "./graphVisualizationAdapter";
import type { ToolRuntime } from "./toolRuntime";

export type MutationRunner = <T>(operation: () => Promise<T>) => Promise<T>;
export type { ToolRuntime } from "./toolRuntime";

export const MCP_LIMITS = Object.freeze({
  topicName: 200,
  query: 20_000,
  path: 4_096,
  url: 2_048,
  modelName: 255,
  responseBytes: 1_048_576,
});

const ingestInput = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("files"),
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to add documents to"),
      filePaths: z
        .array(z.string().trim().min(1).max(MCP_LIMITS.path))
        .min(1)
        .max(100)
        .describe("Array of file paths to add"),
    })
    .strict(),
  z
    .object({
      source: z.literal("url"),
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to add the page to"),
      url: z.string().url().max(MCP_LIMITS.url).describe("Public HTTP(S) page URL"),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      topic: z
        .string()
        .trim()
        .min(1)
        .max(MCP_LIMITS.topicName)
        .describe("The name of the topic to add the repository to"),
      url: z.string().url().max(MCP_LIMITS.url).describe("HTTPS URL of an allowlisted GitHub or GHES repository"),
      branch: z.string().min(1).max(255).optional().describe("Branch to index (default branch if omitted)"),
    })
    .strict(),
]);

const topicInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("stats"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to get stats for"),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(100).describe("Name for the new topic"),
      description: z.string().max(2000).optional().describe("Description of the topic"),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The topic to rename"),
      newName: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The new topic name"),
    })
    .strict(),
  z
    .object({
      action: z.literal("export"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The topic to export"),
    })
    .strict(),
  z
    .object({
      action: z.literal("import"),
      archivePath: z
        .string()
        .min(1)
        .max(MCP_LIMITS.path)
        .describe("Path to a storage-v2 .rag archive inside the allowed roots"),
      confirm: z.literal(true),
    })
    .strict(),
]);

const graphVisualizationInput = z.discriminatedUnion("memoryScope", [
  z
    .object({
      source: z.literal("memory"),
      memoryScope: z.literal("workspace"),
      maxNodes: z.number().int().min(1).max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("memory"),
      memoryScope: z.literal("branch"),
      branch: z.string().trim().min(1).max(255),
      maxNodes: z.number().int().min(1).max(2_000).optional(),
    })
    .strict(),
]);

// Re-serializes JSON text content and mirrors it as structuredContent so
// clients get a typed payload without the tool handlers building it twice.
function normalizeToolResult(value: any): any {
  if (!value?.content) {
    return value;
  }
  let structuredContent: unknown;
  const content = value.content.map((item: any) => {
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

function responseTooLargeResult(): any {
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

function isResponseTooLargeResult(result: any): boolean {
  return Boolean(
    result.isError &&
    result.content?.some((item: any) => {
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
  value: any,
  maxResponseBytes: number,
): { fits: boolean; responseBytes: number; result: any } {
  let result = normalizeToolResult(value);
  let responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (responseBytes > maxResponseBytes) {
    result = responseTooLargeResult();
    responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    return { fits: false, responseBytes, result };
  }
  return { fits: !isResponseTooLargeResult(result), responseBytes, result };
}

export function registerTools(
  server: McpServer,
  topicManager: TopicManager,
  embeddingService: EmbeddingService,
  ragQueryService: RAGQueryService,
  memoryStore?: MemoryStore,
  memoryService?: MemoryService,
  graphVisualizationService?: GraphVisualizationService,
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">,
  config?: McpConfig,
  runMutation: MutationRunner = (operation) => operation(),
  runtime: ToolRuntime = { run: (operation) => operation() },
  runMemoryMutation: MutationRunner = (operation) => operation(),
): void {
  const readOnlyAnnotations: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const writeAnnotations: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  const destructiveAnnotations = { ...writeAnnotations, destructiveHint: true };
  const networkWriteAnnotations = { ...writeAnnotations, openWorldHint: true };
  type ToolHandler = (args: any, context: ServerContext) => Promise<any>;
  type PendingTool = {
    name: string;
    config: {
      description: string;
      inputSchema: z.ZodType<any>;
      annotations: ToolAnnotations;
      _meta?: Record<string, unknown>;
    };
    handler: ToolHandler;
  };

  const pendingTools: PendingTool[] = [];
  const makeRegistrar =
    (enabled: boolean) =>
    (
      name: string,
      description: string,
      inputSchema: z.ZodType<any>,
      annotations: ToolAnnotations,
      handler: ToolHandler,
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
              await handler(args, context),
              config?.maxResponseBytes ?? MCP_LIMITS.responseBytes,
            );
            return result;
          }),
      });
    };
  const registerTool = makeRegistrar(true);
  const toolJson = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  });
  const graphResponseBytes = Math.min(config?.maxResponseBytes ?? MCP_LIMITS.responseBytes, MCP_LIMITS.responseBytes);
  const toolError = (error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      },
    ],
    isError: true,
  });
  // rag_query — Query a topic with RAG
  registerTool(
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
    readOnlyAnnotations,
    async ({ topic, query, topK, retrievalStrategy }, context) => {
      try {
        const result = await ragQueryService.executeQuery(
          {
            topic,
            query,
            topK,
            retrievalStrategy: retrievalStrategy as RetrievalStrategy | undefined,
          },
          undefined,
          context.mcpReq.signal,
        );
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

  // rag_ingest (files variant) — Add documents to a topic
  //
  // Paths are restricted to the configured allowlist roots
  // (security.allowedPaths, defaulting to the working directory): a remote
  // authenticated client must not be able to index — and thus read back —
  // arbitrary files on the server. Symlinks are resolved before containment
  // checks so a link inside an allowed root can't escape it.
  let allowedRootsPromise: Promise<string[]> | undefined;
  const getAllowedRoots = (): Promise<string[]> => {
    allowedRootsPromise ??= (async () => {
      const configured = config?.allowedPaths?.length
        ? [...config.allowedPaths]
        : [config?.workingDir || process.cwd()];
      if (config?.exportDir) {
        configured.push(config.exportDir);
      }
      const roots: string[] = [];
      for (const root of configured) {
        try {
          roots.push(await fs.realpath(path.resolve(root)));
        } catch {
          // Nonexistent roots can't contain anything — skip.
        }
      }
      return roots;
    })();
    return allowedRootsPromise;
  };

  async function assertPathAllowed(filePath: string): Promise<string> {
    let real: string;
    try {
      real = await fs.realpath(path.resolve(filePath));
    } catch {
      throw new Error(`File not found or unreadable: ${filePath}`);
    }
    const roots = await getAllowedRoots();
    const contained = roots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!contained) {
      throw new Error(
        `Path not allowed: ${filePath}. Allowed roots: ${roots.join(", ") || "(none)"} — set "security.allowedPaths" in config.json to widen access.`,
      );
    }
    return real;
  }

  type IngestInput = z.infer<typeof ingestInput>;

  async function ingestFiles(input: Extract<IngestInput, { source: "files" }>, context: ServerContext): Promise<any> {
    const topicMatch = await topicManager.resolveTopicByName(input.topic);
    const matchedTopic = topicMatch.topic;

    // Per-file processing so the response reports the actual outcome of
    // every file instead of claiming blanket success.
    const files: Array<{ path: string; status: "added" | "failed"; chunkCount?: number; error?: string }> = [];
    for (const filePath of input.filePaths) {
      try {
        const realPath = await assertPathAllowed(filePath);
        const results = await runMutation(() =>
          topicManager.addDocuments(matchedTopic.id, [realPath], {
            signal: context.mcpReq.signal,
          }),
        );
        if (results.length > 0) {
          files.push({
            path: filePath,
            status: "added",
            chunkCount: results.reduce((sum, r) => sum + r.pipelineResult.metadata.chunksStored, 0),
          });
        } else {
          files.push({ path: filePath, status: "failed", error: "document processing failed (see server logs)" });
        }
      } catch (error) {
        files.push({
          path: filePath,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const added = files.filter((f) => f.status === "added");
    return {
      ...toolJson({
        success: added.length > 0,
        partial: added.length > 0 && added.length < files.length,
        topic: matchedTopic.name,
        documentsAdded: added.length,
        documentsFailed: files.length - added.length,
        files,
      }),
      isError: added.length === 0,
    };
  }

  async function ingestUrl(input: Extract<IngestInput, { source: "url" }>, context: ServerContext): Promise<any> {
    const parsed = new URL(input.url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP(S) URLs are supported");
    }
    if (parsed.username || parsed.password) {
      throw new Error("URLs containing credentials are not allowed");
    }
    const match = await topicManager.resolveTopicByName(input.topic);
    const results = await runMutation(() =>
      topicManager.addDocuments(match.topic.id, [input.url], {
        loaderOptions: { fileType: "web" },
        signal: context.mcpReq.signal,
      }),
    );
    return toolJson({ success: results.length > 0, outcomes: results });
  }

  async function ingestGithub(input: Extract<IngestInput, { source: "github" }>, context: ServerContext): Promise<any> {
    const parsed = new URL(input.url);
    if (parsed.username || parsed.password || parsed.protocol !== "https:") {
      throw new Error("GitHub repositories require an HTTPS URL without embedded credentials");
    }
    if (!config?.githubHosts.includes(parsed.hostname.toLowerCase())) {
      throw new Error("GitHub host is not allowlisted");
    }
    const match = await topicManager.resolveTopicByName(input.topic);
    const results = await runMutation(() =>
      topicManager.addDocuments(match.topic.id, [input.url], {
        loaderOptions: {
          fileType: "github",
          branch: input.branch,
          accessToken: config?.githubToken || undefined,
        },
        signal: context.mcpReq.signal,
      }),
    );
    return toolJson({ success: results.length > 0, outcomes: results });
  }

  registerTool(
    "rag_ingest",
    "Add content to a RAG topic from one of three sources: 'files' (local paths inside the server's allowed roots, " +
      "PDF/Markdown/HTML/plain text), 'url' (one public HTTP(S) page, with SSRF and size protections), or " +
      "'github' (a repository from an allowlisted GitHub or GHES host).",
    ingestInput,
    networkWriteAnnotations,
    async (input: IngestInput, context) => {
      try {
        switch (input.source) {
          case "files":
            return await ingestFiles(input, context);
          case "url":
            return await ingestUrl(input, context);
          case "github":
            return await ingestGithub(input, context);
        }
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // Embedding management tools
  // ────────────────────────────────────────────────────────────

  // rag_list_embedding_models — List all available embedding models
  registerTool(
    "rag_list_embedding_models",
    "List available embedding models (curated, bundled, local, and downloaded)",
    z.object({}),
    readOnlyAnnotations,
    async () => {
      try {
        const models = await embeddingService.listAvailableModels();
        const currentModel = embeddingService.getCurrentModel();
        // With a remote provider configured, the service returns the remote
        // catalogue; local registry entries mean the remote listing failed and
        // the fallback would otherwise impersonate a usable catalogue.
        const remoteConfigured = Boolean(config && config.embeddingProvider !== "huggingface");
        const remoteListingFailed = remoteConfigured && !models.some((m: AvailableModel) => m.source === "remote");

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
                  ...(remoteListingFailed
                    ? {
                        remoteListingFailed: true,
                        warning:
                          "The configured remote embedding provider could not be queried; the local model catalogue shown here is not usable for switching.",
                      }
                    : {}),
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
  registerTool(
    "rag_embedding_info",
    "Get information about the currently active embedding model and backend",
    z.object({}),
    readOnlyAnnotations,
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
                  // From config.json — reported even before the backend is
                  // initialized, when currentModel still shows the registry
                  // default rather than the configured value.
                  configuredModel: config?.embeddingModel ?? null,
                  configuredProvider: config?.embeddingProvider ?? null,
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
  registerTool(
    "rag_switch_embedding_model",
    "Switch the active embedding model. The model will be downloaded if not already cached. " +
      "Rejected when standalone memory holds vectors of a different dimension.",
    z.object({
      model: z
        .string()
        .trim()
        .min(1)
        .max(MCP_LIMITS.modelName)
        .describe("Embedding model identifier (e.g. 'Xenova/all-MiniLM-L6-v2')"),
    }),
    writeAnnotations,
    async ({ model }) => {
      try {
        return await runMemoryMutation(() =>
          runMutation(async () => {
            const previousModel = embeddingService.getCurrentModel();
            const hasFingerprintGuard = typeof (memoryStore as any)?.validateEmbeddingFingerprint === "function";
            const previousDimension = hasFingerprintGuard
              ? 0
              : (await embeddingService.embed("dimension probe")).length;

            const validateAndReinitialize = async (): Promise<void> => {
              if (memoryStore) {
                if (hasFingerprintGuard) {
                  await memoryStore.validateEmbeddingFingerprint();
                } else {
                  const newDimension = (await embeddingService.embed("dimension probe")).length;
                  const memStats = await memoryStore.stats();
                  if (memStats.totalMemories > 0 && newDimension !== previousDimension) {
                    throw new Error(
                      `Cannot switch embedding dimension from ${previousDimension} to ${newDimension} while memories exist`,
                    );
                  }
                }
              }
              await topicManager.reinitializeWithNewModel();
            };

            // Hold publication until memory compatibility and dependent managers
            // have both accepted the candidate model.
            if (typeof (embeddingService as any).runTransactionalSwitch === "function") {
              await embeddingService.runTransactionalSwitch(
                embeddingService.getActiveBackendType() || undefined,
                model,
                validateAndReinitialize,
              );
            } else {
              // Compatibility path for externally supplied legacy services.
              await embeddingService.initialize(model);
              try {
                await validateAndReinitialize();
              } catch (error) {
                await embeddingService.initialize(previousModel);
                throw error;
              }
            }

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
          }),
        );
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

  registerTool(
    "rag_delete_topic",
    "Permanently delete a local topic and all of its data",
    z.object({ topic: z.string().min(1).max(MCP_LIMITS.topicName), confirm: z.literal(true) }),
    destructiveAnnotations,
    async ({ topic }) => {
      try {
        const match = await topicManager.resolveTopicByName(topic);
        await runMutation(() => topicManager.deleteTopic(match.topic.id));
        return toolJson({ success: true, deletedTopic: match.topic.name });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerTool(
    "rag_remove_document",
    "Permanently remove one indexed source from a topic",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName),
      documentId: z.string().min(1).max(255),
      confirm: z.literal(true),
    }),
    destructiveAnnotations,
    async ({ topic, documentId }) => {
      try {
        const match = await topicManager.resolveTopicByName(topic);
        const result = await runMutation(() => topicManager.removeDocument(match.topic.id, documentId));
        return toolJson({ success: true, document: result.document, chunksRemoved: result.chunksRemoved });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  type TopicInput = z.infer<typeof topicInput>;

  registerTool(
    "rag_topic",
    "Manage RAG topics: 'list' all topics, 'stats' for one topic (statistics plus its indexed documents), " +
      "'create' a new topic, 'rename' a topic, 'export' a topic as a storage-v2 .rag archive under the configured " +
      "export directory, or 'import' a .rag archive from an allowlisted path (requires confirm: true).",
    topicInput,
    writeAnnotations,
    async (input: TopicInput) => {
      try {
        switch (input.action) {
          case "list": {
            const topics = topicManager.getAllTopics().map((t) => ({
              name: t.name,
              description: t.description,
              documentCount: t.documentCount,
              createdAt: new Date(t.createdAt).toISOString(),
              updatedAt: new Date(t.updatedAt).toISOString(),
              source: t.source || "local",
            }));
            return toolJson({ topics, count: topics.length });
          }
          case "stats": {
            const match = await topicManager.resolveTopicByName(input.topic);
            const stats = await topicManager.getTopicStats(match.topic.id);
            const documents = topicManager
              .listDocuments(match.topic.id)
              .map((document) => ({ ...document, documentId: document.id }));
            return toolJson({ ...stats, documents });
          }
          case "create": {
            const topic = await runMutation(() =>
              topicManager.createTopic({ name: input.name, description: input.description }),
            );
            return toolJson({
              success: true,
              topic: { id: topic.id, name: topic.name, description: topic.description },
            });
          }
          case "rename": {
            const match = await topicManager.resolveTopicByName(input.topic);
            const updated = await runMutation(() => topicManager.updateTopic(match.topic.id, { name: input.newName }));
            return toolJson({ success: true, topic: updated });
          }
          case "export": {
            if (!config) {
              throw new Error("Export configuration unavailable");
            }
            const match = await topicManager.resolveTopicByName(input.topic);
            await fs.mkdir(config.exportDir, { recursive: true });
            const safeName = match.topic.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "topic";
            const exportPath = path.join(config.exportDir, `${safeName}-${Date.now()}.rag`);
            await runMutation(() => topicManager.exportTopic(match.topic.id, exportPath));
            const bytes = await fs.readFile(exportPath);
            return toolJson({
              path: exportPath,
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
          case "import": {
            const realPath = await assertPathAllowed(input.archivePath);
            const topic = await runMutation(() => topicManager.importTopic(realPath));
            return toolJson({ success: true, topic });
          }
        }
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // The memory tools are structurally absent when their service dependencies were not built.
  if (memoryService) {
    registerTool(
      "rag_reset_memory",
      "Delete all standalone memories before changing embedding space",
      z.object({ confirm: z.literal(true) }),
      destructiveAnnotations,
      async (_input, context) => invokeMemoryResetTool(context, memoryService),
    );
  }

  // ────────────────────────────────────────────────────────────
  // Memory tools
  // ────────────────────────────────────────────────────────────

  if (memoryService && memoryBranchProvider) {
    registerTool(
      "rag_memory",
      "Store, recall, forget, list, or get stats for project memories. " +
        "Memories are stored per-workspace or per-git-branch. " +
        "Entities and relationships are automatically extracted when an LLM is available. " +
        "Supports decay (expire stale entries), history (version chain), promote (branch→workspace), links (cross-scope entity links), " +
        "and communities (clusters of related entities in the memory graph; requires an LLM provider).",
      z.object({
        action: z
          .enum(["store", "recall", "forget", "stats", "list", "decay", "history", "promote", "links", "communities"])
          .describe("The memory operation to perform"),
        content: z
          .string()
          .trim()
          .min(1)
          .max(50_000)
          .optional()
          .describe("Memory content to store (required for 'store' action)"),
        query: z.string().trim().min(1).optional().describe("Search query (required for 'recall' action)"),
        topK: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of results to return (default: 10, for 'recall' action)"),
        includeEntities: z
          .boolean()
          .optional()
          .describe("Include related graph entities in recall results (default: false)"),
        id: z.string().trim().min(1).optional().describe("Memory entry ID (for 'forget' or 'history' action)"),
        olderThan: z
          .number()
          .int()
          .min(1)
          .max(3650)
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
          .max(255)
          .optional()
          .describe("Git branch name (auto-detected if scope is 'branch' and not provided)"),
        tags: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe("Tags to attach to memory (for 'store' action)"),
        ttlDays: z.number().positive().max(3650).optional().describe("Optional memory TTL in days"),
        includeAuto: z.boolean().optional().describe("Include reserved auto-generated memories"),
        reinforce: z.boolean().optional().describe("Update access counters during recall (writer sessions only)"),
        ids: z.array(z.string().trim().min(1)).max(500).optional().describe("Memory IDs for promote"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max entries to return (for 'list' action, default: 50)"),
      }),
      writeAnnotations,
      async (input, context) => invokeMemoryTool(input, context, memoryService, memoryBranchProvider, config),
    );
  }

  // rag_memory_visualize — interactive memory graph document for MCP Apps. It
  // reads the memory graph, so it is absent without a graph service rather than
  // registered as a tool that could only ever error.
  if (graphVisualizationService) {
    registerTool(
      "rag_memory_visualize",
      "Visualize a RAGnarōk workspace-memory or branch-memory graph as a deterministic bounded document.",
      graphVisualizationInput,
      readOnlyAnnotations,
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

  for (const tool of pendingTools.sort((left, right) => left.name.localeCompare(right.name))) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}
