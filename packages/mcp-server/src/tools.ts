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

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { McpServer, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
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
  projectKnowledgeGraphVisualization,
  projectMemoryGraphVisualization,
  reduceGraphVisualizationDocument,
} from "@ragnarok/core";
import type { AvailableModel, GraphVisualizationDocument } from "@ragnarok/core";
import { GRAPH_RESOURCE_URI } from "./uiResource";
import type { McpConfig } from "./config";
import type { AccessRole } from "./httpServer";
import type { TransferManager } from "./transferManager";
import { markMcpToolResult } from "./auditContext";

export type MutationRunner = <T>(operation: () => Promise<T>) => Promise<T>;
export type ToolRuntime = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export const MCP_LIMITS = Object.freeze({
  topicName: 200,
  query: 20_000,
  path: 4_096,
  url: 2_048,
  modelName: 255,
  responseBytes: 1_048_576,
});

const graphVisualizationInput = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("knowledge"),
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName),
      maxNodes: z.number().int().min(1).max(2_000).optional(),
    })
    .strict(),
  z.discriminatedUnion("memoryScope", [
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
  ]),
]);

class GraphVisualizationRecordTooLargeError extends Error {
  constructor() {
    super("A graph visualization record exceeds the response byte limit");
    this.name = "GraphVisualizationRecordTooLargeError";
  }
}

const NO_TOPICS_ERROR = "No topics found in the RAG database. Create a topic first.";

function isTopicNotFoundError(message: string): boolean {
  return message === NO_TOPICS_ERROR || message.startsWith("Topic not found:");
}

function utf8Prefix(value: Buffer, maximumBytes: number): string {
  let end = Math.min(maximumBytes, value.length);
  while (end > 0 && end < value.length && (value[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return value.subarray(0, end).toString("utf8");
}

const REDACTED_FIELD = /(path|directory|storage|workingdir|modelpath|archivepath|exportdir)/i;
const TRANSFER_ENDPOINT_FIELD = /^(uploadEndpoint|downloadEndpoint)$/;
const TRANSFER_ENDPOINT =
  /^transfer\/(?:uploads|downloads)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeSharedValue(value: unknown, fieldName?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => sanitizeSharedValue(nested));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !REDACTED_FIELD.test(key))
        .map(([key, nested]) => [key, sanitizeSharedValue(nested, key)]),
    );
  }
  if (typeof value === "string") {
    // Transfer capability URLs are opaque, principal-bound, expiring relative
    // endpoints—not filesystem paths. Preserve only the exact shape emitted
    // by TransferManager; all other path-like strings remain redacted.
    if (fieldName && TRANSFER_ENDPOINT_FIELD.test(fieldName) && TRANSFER_ENDPOINT.test(value)) {
      return value;
    }
    if (
      path.isAbsolute(value) ||
      /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ||
      /[/\\]\.(?:ragnarok|cache)(?:[/\\]|$)/i.test(value)
    ) {
      return "[server-managed]";
    }
    return value
      .replace(/(?<![:/])\/(?!\/)[^\s"',;]+/g, "[server-managed]")
      .replace(/[A-Za-z]:[\\/][^\s"',;]+/g, "[server-managed]");
  }
  return value;
}

function sanitizeToolResult(value: any, deployment: "local" | "shared"): any {
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
      const sanitized = deployment === "shared" ? sanitizeSharedValue(parsed) : parsed;
      structuredContent ??= sanitized;
      return { ...item, text: JSON.stringify(sanitized, null, 2) };
    } catch {
      return deployment === "shared"
        ? { ...item, text: item.text.replace(/(?:[A-Za-z]:)?[/\\][^\s"'`]+/g, "[server-managed]") }
        : item;
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
  deployment: "local" | "shared",
  maxResponseBytes: number,
): { fits: boolean; responseBytes: number; result: any } {
  let result = sanitizeToolResult(value, deployment);
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
  llmProvider: ILLMProvider,
  embeddingService: EmbeddingService,
  ragQueryService: RAGQueryService,
  memoryStore?: MemoryStore,
  reranker?: CrossEncoderReranker | null,
  config?: McpConfig,
  accessRole: AccessRole | "writer" = "admin",
  runMutation: MutationRunner = (operation) => operation(),
  deployment: "local" | "shared" = "local",
  runtime: ToolRuntime = { run: (operation) => operation() },
  transferManager?: TransferManager,
  principal = "local-owner",
): void {
  const normalizedRole: AccessRole = accessRole === "writer" ? "admin" : accessRole;
  const curatorOnly = () => {
    if (normalizedRole === "reader") {
      throw new Error("Curator token required for this operation");
    }
  };
  const adminOnly = () => {
    if (normalizedRole !== "admin") {
      throw new Error("Admin token required for this operation");
    }
  };
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
  // Shared deployments serve multiple parties; label every tool so an agent
  // that also sees a local RAGnarōk server can route between them deliberately.
  const describeTool = (description: string): string =>
    deployment === "shared" ? `[Team shared KB] ${description}` : description;
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
        config: { description: describeTool(description), inputSchema, annotations, ...(_meta ? { _meta } : {}) },
        handler: (args, context) =>
          runtime.run(async () => {
            const { result } = measureToolResultForResponse(
              await handler(args, context),
              deployment,
              config?.maxResponseBytes ?? MCP_LIMITS.responseBytes,
            );
            markMcpToolResult(result);
            return result;
          }),
      });
    };
  const registerTool = makeRegistrar(true);
  const registerCuratorTool = makeRegistrar(normalizedRole === "curator" || normalizedRole === "admin");
  const registerAdminTool = makeRegistrar(normalizedRole === "admin");
  const registerServerPathTool = deployment === "shared" ? makeRegistrar(false) : registerCuratorTool;
  const registerLocalAdminTool = deployment === "shared" ? makeRegistrar(false) : registerAdminTool;
  const toolJson = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  });
  const graphResponseBytes = Math.min(config?.maxResponseBytes ?? MCP_LIMITS.responseBytes, MCP_LIMITS.responseBytes);
  const measureGraphToolResult = (candidate: ReturnType<typeof toolJson>) =>
    measureToolResultForResponse(candidate, deployment, graphResponseBytes);
  const graphError = (code: string, message: string) => {
    const create = (candidateMessage: string) => toolJson({ error: { code, message: candidateMessage } }, true);
    const full = create(message);
    if (measureGraphToolResult(full).fits) {
      return full;
    }

    const encoded = Buffer.from(message, "utf8");
    let fittingBytes = 0;
    let rejectedBytes = encoded.length;
    while (rejectedBytes - fittingBytes > 1) {
      const candidateBytes = Math.floor((fittingBytes + rejectedBytes) / 2);
      const candidate = create(`${utf8Prefix(encoded, candidateBytes)}...`);
      if (measureGraphToolResult(candidate).fits) {
        fittingBytes = candidateBytes;
      } else {
        rejectedBytes = candidateBytes;
      }
    }
    return create(`${utf8Prefix(encoded, fittingBytes)}...`);
  };
  const fitGraphVisualizationResult = (document: GraphVisualizationDocument): GraphVisualizationDocument => {
    let measurements = 0;
    const measure = (candidateDocument: GraphVisualizationDocument): boolean => {
      measurements += 1;
      if (measurements > 24) {
        throw new Error("Graph visualization response reduction exceeded 24 measurements");
      }
      return measureGraphToolResult(toolJson(candidateDocument)).fits;
    };

    if (measure(document)) {
      return document;
    }

    const nodeCount = document.nodes.length;
    const edgeCount = document.edges.length;
    const zeroEdgeDocument = edgeCount === 0 ? document : reduceGraphVisualizationDocument(document, nodeCount, 0);
    const zeroEdgesFit = edgeCount === 0 ? false : measure(zeroEdgeDocument);
    if (zeroEdgesFit) {
      let fittingEdgeCount = 0;
      let rejectedEdgeCount = edgeCount;
      while (rejectedEdgeCount - fittingEdgeCount > 1) {
        const candidateEdgeCount = Math.floor((fittingEdgeCount + rejectedEdgeCount) / 2);
        const candidate = reduceGraphVisualizationDocument(document, nodeCount, candidateEdgeCount);
        if (measure(candidate)) {
          fittingEdgeCount = candidateEdgeCount;
        } else {
          rejectedEdgeCount = candidateEdgeCount;
        }
      }
      return reduceGraphVisualizationDocument(document, nodeCount, fittingEdgeCount);
    }

    if (nodeCount === 1) {
      throw new GraphVisualizationRecordTooLargeError();
    }

    let fittingNodeCount = 0;
    let rejectedNodeCount = nodeCount;
    while (rejectedNodeCount - fittingNodeCount > 1) {
      const candidateNodeCount = Math.floor((fittingNodeCount + rejectedNodeCount) / 2);
      const candidate = reduceGraphVisualizationDocument(document, candidateNodeCount, 0);
      if (measure(candidate)) {
        fittingNodeCount = candidateNodeCount;
      } else {
        rejectedNodeCount = candidateNodeCount;
      }
    }
    if (fittingNodeCount === 0) {
      throw new GraphVisualizationRecordTooLargeError();
    }
    return reduceGraphVisualizationDocument(document, fittingNodeCount, 0);
  };
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

  // rag_list_topics — List available topics
  registerTool(
    "rag_list_topics",
    "List all available RAG topics with their metadata",
    z.object({}),
    readOnlyAnnotations,
    async () => {
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
    },
  );

  // rag_topic_stats — Get statistics for a topic
  registerTool(
    "rag_topic_stats",
    "Get detailed statistics for a specific RAG topic",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to get stats for"),
    }),
    readOnlyAnnotations,
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
  registerCuratorTool(
    "rag_create_topic",
    "Create a new RAG topic for organizing documents",
    z.object({
      name: z.string().trim().min(1).max(100).describe("Name for the new topic"),
      description: z.string().max(2000).optional().describe("Description of the topic"),
    }),
    writeAnnotations,
    async ({ name, description }) => {
      try {
        curatorOnly();
        const topic = await runMutation(() => topicManager.createTopic({ name, description }));
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
  //
  // Paths are restricted to the configured allowlist roots
  // (RAGNAROK_ALLOWED_PATHS, defaulting to the working directory): a remote
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
        `Path not allowed: ${filePath}. Allowed roots: ${roots.join(", ") || "(none)"} — configure RAGNAROK_ALLOWED_PATHS to widen access.`,
      );
    }
    return real;
  }

  registerServerPathTool(
    "rag_add_documents",
    "Add one or more documents to a RAG topic. Supports PDF, Markdown, HTML, and plain text files. " +
      "Paths must be inside the server's allowed roots (RAGNAROK_ALLOWED_PATHS).",
    z.object({
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to add documents to"),
      filePaths: z
        .array(z.string().trim().min(1).max(MCP_LIMITS.path))
        .min(1)
        .max(100)
        .describe("Array of file paths to add"),
    }),
    writeAnnotations,
    async ({ topic, filePaths }, context) => {
      try {
        if (deployment === "shared") {
          adminOnly();
        } else {
          curatorOnly();
        }
        const topicMatch = await topicManager.resolveTopicByName(topic);
        const matchedTopic = topicMatch.topic;

        // Per-file processing so the response reports the actual outcome of
        // every file instead of claiming blanket success.
        const files: Array<{ path: string; status: "added" | "failed"; chunkCount?: number; error?: string }> = [];
        for (const filePath of filePaths) {
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
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: added.length > 0,
                  partial: added.length > 0 && added.length < files.length,
                  topic: matchedTopic.name,
                  documentsAdded: added.length,
                  documentsFailed: files.length - added.length,
                  files,
                },
                null,
                2,
              ),
            },
          ],
          isError: added.length === 0,
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

  if (transferManager && deployment === "shared") {
    registerCuratorTool(
      "rag_create_document_upload",
      "Create an owned, expiring streamed upload handle. PUT raw bytes to the returned relative endpoint.",
      z.object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.enum([
          "text/markdown",
          "text/plain",
          "text/html",
          "application/pdf",
          "application/octet-stream",
        ]),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
      writeAnnotations,
      async ({ filename, contentType, size, sha256 }) => {
        try {
          curatorOnly();
          return toolJson(
            await transferManager.createUpload(principal, normalizedRole, {
              kind: "document",
              filename,
              contentType,
              size,
              sha256,
            }),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
    registerCuratorTool(
      "rag_ingest_upload",
      "Consume a completed streamed document upload and ingest it into a topic. Upload handles are single-use.",
      z.object({
        topic: z.string().trim().min(1).max(MCP_LIMITS.topicName),
        uploadId: z.string().uuid(),
      }),
      writeAnnotations,
      async ({ topic, uploadId }, context) => {
        try {
          curatorOnly();
          const match = await topicManager.resolveTopicByName(topic);
          const results = await transferManager.consumeUpload(principal, uploadId, "document", (uploadedPath) =>
            runMutation(() =>
              topicManager.addDocuments(match.topic.id, [uploadedPath], {
                signal: context.mcpReq.signal,
              }),
            ),
          );
          return toolJson({ success: results.length > 0, topic: match.topic.name, outcomes: results });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

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
  registerAdminTool(
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
        adminOnly();
        const previousModel = embeddingService.getCurrentModel();
        const hasFingerprintGuard = typeof (memoryStore as any)?.validateEmbeddingFingerprint === "function";
        const previousDimension = hasFingerprintGuard ? 0 : (await embeddingService.embed("dimension probe")).length;

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
          await runMutation(() =>
            embeddingService.runTransactionalSwitch(
              embeddingService.getActiveBackendType() || undefined,
              model,
              validateAndReinitialize,
            ),
          );
        } else {
          // Compatibility path for externally supplied legacy services.
          await runMutation(async () => {
            await embeddingService.initialize(model);
            try {
              await validateAndReinitialize();
            } catch (error) {
              await embeddingService.initialize(previousModel);
              throw error;
            }
          });
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
  registerTool(
    "rag_llm_status",
    "Get the current LLM provider status and configuration",
    z.object({}),
    readOnlyAnnotations,
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
                  model: model ? { id: model.id, family: model.family } : null,
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
  registerTool(
    "rag_list_reranker_models",
    "List available cross-encoder reranker models with their status",
    z.object({}),
    readOnlyAnnotations,
    async () => {
      try {
        const registry = RerankerModelRegistry.getInstance();
        const models = await registry.listAvailableModels();
        const currentModel = reranker?.getCurrentModel() ?? null;

        const result = {
          currentModel,
          enabled: reranker !== null && reranker !== undefined,
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

  // rag_reranker_info — Get current reranker configuration and status
  registerTool(
    "rag_reranker_info",
    "Get current reranker configuration and status",
    z.object({}),
    readOnlyAnnotations,
    async () => {
      try {
        const result = {
          enabled: reranker !== null && reranker !== undefined,
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

  // rag_switch_reranker_model — Switch to a different cross-encoder reranker model
  registerAdminTool(
    "rag_switch_reranker_model",
    "Switch to a different cross-encoder reranker model",
    z.object({
      model: z
        .string()
        .min(1)
        .max(MCP_LIMITS.modelName)
        .describe("The reranker model identifier (e.g., 'Xenova/ms-marco-MiniLM-L-6-v2')"),
    }),
    writeAnnotations,
    async ({ model }) => {
      try {
        adminOnly();
        if (!reranker) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Reranker is not available." }) }],
            isError: true,
          };
        }

        const previousModel = reranker.getCurrentModel();
        await runMutation(() => reranker.switchModel(model));
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

  registerTool(
    "rag_list_documents",
    "List indexed sources for a topic",
    z.object({ topic: z.string().min(1).max(MCP_LIMITS.topicName) }),
    readOnlyAnnotations,
    async ({ topic }) => {
      try {
        const match = await topicManager.resolveTopicByName(topic);
        const documents = topicManager
          .listDocuments(match.topic.id)
          .map((document) => ({ ...document, documentId: document.id }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ topic: match.topic.name, documents, count: documents.length }, null, 2),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerCuratorTool(
    "rag_delete_topic",
    "Permanently delete a local topic and all of its data",
    z.object({ topic: z.string().min(1).max(MCP_LIMITS.topicName), confirm: z.literal(true) }),
    destructiveAnnotations,
    async ({ topic }) => {
      try {
        curatorOnly();
        const match = await topicManager.resolveTopicByName(topic);
        await runMutation(() => topicManager.deleteTopic(match.topic.id));
        return toolJson({ success: true, deletedTopic: match.topic.name });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerCuratorTool(
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
        curatorOnly();
        const match = await topicManager.resolveTopicByName(topic);
        const result = await runMutation(() => topicManager.removeDocument(match.topic.id, documentId));
        return toolJson({ success: true, document: result.document, chunksRemoved: result.chunksRemoved });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerCuratorTool(
    "rag_rename_topic",
    "Rename a local topic",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName),
      newName: z.string().trim().min(1).max(MCP_LIMITS.topicName),
    }),
    writeAnnotations,
    async ({ topic, newName }) => {
      try {
        curatorOnly();
        const match = await topicManager.resolveTopicByName(topic);
        const updated = await runMutation(() => topicManager.updateTopic(match.topic.id, { name: newName }));
        return toolJson({ success: true, topic: updated });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerCuratorTool(
    "rag_add_url",
    "Fetch and index one public HTTP(S) page with SSRF and size protections",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName),
      url: z.string().url().max(MCP_LIMITS.url),
    }),
    networkWriteAnnotations,
    async ({ topic, url }, context) => {
      try {
        curatorOnly();
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("Only HTTP(S) URLs are supported");
        }
        if (parsed.username || parsed.password) {
          throw new Error("URLs containing credentials are not allowed");
        }
        if (deployment === "shared" && parsed.protocol !== "https:") {
          throw new Error("Shared deployments only ingest HTTPS URLs");
        }
        const match = await topicManager.resolveTopicByName(topic);
        const results = await runMutation(() =>
          topicManager.addDocuments(match.topic.id, [url], {
            loaderOptions: { fileType: "web" },
            signal: context.mcpReq.signal,
          }),
        );
        return toolJson({ success: results.length > 0, outcomes: results });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerCuratorTool(
    "rag_add_github_repo",
    "Index a repository from an allowlisted GitHub or GHES host",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName),
      url: z.string().url().max(MCP_LIMITS.url),
      branch: z.string().min(1).max(255).optional(),
    }),
    networkWriteAnnotations,
    async ({ topic, url, branch }, context) => {
      try {
        curatorOnly();
        const parsed = new URL(url);
        if (parsed.username || parsed.password || parsed.protocol !== "https:") {
          throw new Error("GitHub repositories require an HTTPS URL without embedded credentials");
        }
        if (!config?.githubHosts.includes(parsed.hostname.toLowerCase())) {
          throw new Error("GitHub host is not allowlisted");
        }
        const match = await topicManager.resolveTopicByName(topic);
        const results = await runMutation(() =>
          topicManager.addDocuments(match.topic.id, [url], {
            loaderOptions: {
              fileType: "github",
              branch,
              accessToken: config?.githubToken || undefined,
            },
            signal: context.mcpReq.signal,
          }),
        );
        return toolJson({ success: results.length > 0, outcomes: results });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAdminTool(
    "rag_export_topic",
    deployment === "shared"
      ? "Export a topic to a single-use streamed download handle without exposing a server path"
      : "Export a topic as a storage-v2 .rag archive under the configured export directory",
    z.object({ topic: z.string().min(1).max(MCP_LIMITS.topicName) }),
    writeAnnotations,
    async ({ topic }) => {
      try {
        adminOnly();
        if (!config) {
          throw new Error("Export configuration unavailable");
        }
        const match = await topicManager.resolveTopicByName(topic);
        await fs.mkdir(config.exportDir, { recursive: true });
        const safeName = match.topic.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "topic";
        const exportPath = path.join(config.exportDir, `${safeName}-${Date.now()}.rag`);
        await runMutation(() => topicManager.exportTopic(match.topic.id, exportPath));
        if (deployment === "shared") {
          if (!transferManager) {
            await fs.rm(exportPath, { force: true });
            throw new Error("Shared transfer service unavailable");
          }
          try {
            const handle = await transferManager.createDownload(principal, {
              filePath: exportPath,
              filename: `${safeName}.rag`,
              contentType: "application/vnd.ragnarok.archive",
            });
            return toolJson({ transfer: handle });
          } catch (error) {
            await fs.rm(exportPath, { force: true });
            throw error;
          }
        }
        const bytes = await fs.readFile(exportPath);
        return toolJson({
          path: exportPath,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLocalAdminTool(
    "rag_import_topic",
    "Import a validated storage-v2 .rag archive from an allowlisted path",
    z.object({ archivePath: z.string().min(1).max(MCP_LIMITS.path), confirm: z.literal(true) }),
    destructiveAnnotations,
    async ({ archivePath }) => {
      try {
        adminOnly();
        const realPath = await assertPathAllowed(archivePath);
        const topic = await runMutation(() => topicManager.importTopic(realPath));
        return toolJson({ success: true, topic });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (transferManager && deployment === "shared") {
    registerAdminTool(
      "rag_create_archive_upload",
      "Create an owned, expiring streamed .rag upload handle. PUT raw bytes to the returned relative endpoint.",
      z.object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.enum(["application/vnd.ragnarok.archive", "application/octet-stream", "application/zip"]),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
      writeAnnotations,
      async ({ filename, contentType, size, sha256 }) => {
        try {
          adminOnly();
          return toolJson(
            await transferManager.createUpload(principal, "admin", {
              kind: "archive",
              filename,
              contentType,
              size,
              sha256,
            }),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
    registerAdminTool(
      "rag_import_upload",
      "Consume a completed streamed .rag archive upload and import it. Upload handles are single-use.",
      z.object({ uploadId: z.string().uuid(), confirm: z.literal(true) }),
      destructiveAnnotations,
      async ({ uploadId }) => {
        try {
          adminOnly();
          const topic = await transferManager.consumeUpload(principal, uploadId, "archive", (uploadedPath) =>
            runMutation(() => topicManager.importTopic(uploadedPath)),
          );
          return toolJson({ success: true, topic });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  // Memory is always personal → never served from a shared deployment, so the
  // memory tools are structurally absent there for every role (P3).
  if (memoryStore && deployment !== "shared") {
    registerAdminTool(
      "rag_reset_memory",
      "Delete all standalone memories before changing embedding space",
      z.object({ confirm: z.literal(true) }),
      destructiveAnnotations,
      async ({ confirm }) => {
        try {
          adminOnly();
          if (!memoryStore) {
            throw new Error("Memory store is unavailable");
          }
          await runMutation(() => memoryStore.reset(confirm));
          return toolJson({ success: true });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  registerTool(
    "rag_storage_status",
    "Report storage format and configured locations",
    z.object({}),
    readOnlyAnnotations,
    async () => {
      try {
        return toolJson(await topicManager.getStorageStatus());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  // Memory tools
  // ────────────────────────────────────────────────────────────

  if (memoryStore && deployment !== "shared") {
    registerTool(
      "rag_memory",
      "Store, recall, forget, list, or get stats for project memories. " +
        "Memories are stored per-workspace or per-git-branch. " +
        "Entities and relationships are automatically extracted when an LLM is available. " +
        "Supports decay (expire stale entries), history (version chain), promote (branch→workspace), and links (cross-scope entity links).",
      z.object({
        action: z
          .enum(["store", "recall", "forget", "stats", "list", "decay", "history", "promote", "links"])
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
      async (
        {
          action,
          content,
          query,
          topK,
          includeEntities,
          id,
          ids,
          olderThan,
          expired,
          scope,
          branch,
          tags,
          ttlDays,
          includeAuto,
          reinforce,
          limit,
        },
        context,
      ) => {
        try {
          if (["store", "forget", "decay", "promote"].includes(action)) {
            curatorOnly();
          }
          // Branch scope explicitly requested but unresolvable must be an
          // error, not a silent fall-back to workspace scope: the caller
          // would store/read memories in a scope they didn't ask for.
          if (scope === "branch" && !branch && (action === "store" || action === "recall" || action === "list")) {
            const detected = await memoryStore.getCurrentBranch();
            if (!detected) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error:
                        "Branch scope requested but no git branch could be detected in the working directory " +
                        "(not a git repo or detached HEAD). Pass 'branch' explicitly or set RAGNAROK_WORKING_DIR " +
                        "to the project root.",
                    }),
                  },
                ],
                isError: true,
              };
            }
          }

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
              const entry = await runMutation(() =>
                memoryStore.store({
                  content,
                  scope: scope ?? "workspace",
                  branch,
                  tags,
                  ...(ttlDays !== undefined ? { ttlDays } : {}),
                  signal: context.mcpReq.signal,
                }),
              );
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
                ...(includeAuto ? { includeAuto: true } : {}),
                ...(normalizedRole === "reader" ? { reinforce: false } : reinforce !== undefined ? { reinforce } : {}),
                signal: context.mcpReq.signal,
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
              if (branch && scope === "workspace") {
                return toolError(new Error("'branch' cannot be combined with workspace scope for 'forget'"));
              }
              if (olderThan !== undefined && (!Number.isInteger(olderThan) || olderThan < 1)) {
                return toolError(new Error("'olderThan' must be a positive whole number of days for 'forget'"));
              }
              if (olderThan !== undefined && !scope && !branch) {
                return toolError(new Error("'olderThan' requires an explicit 'scope' or 'branch' for 'forget'"));
              }
              if (olderThan !== undefined && expired) {
                return toolError(new Error("'olderThan' cannot be combined with 'expired' for 'forget'"));
              }
              if (id && (scope || branch || olderThan !== undefined || expired)) {
                return toolError(
                  new Error("'id' cannot be combined with scope, branch, olderThan, or expired for 'forget'"),
                );
              }
              if (!id && olderThan === undefined && !expired) {
                return toolError(new Error("'forget' requires 'id', 'olderThan', or 'expired: true'"));
              }
              const count = await runMutation(() =>
                memoryStore.forget({
                  id,
                  scope: branch && !scope ? "branch" : scope,
                  branch,
                  olderThan,
                  expired,
                }),
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ action: "forget", forgottenCount: count }, null, 2),
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
                      {
                        action: "stats",
                        ...memStats,
                        // Surface where branch detection actually points so
                        // mis-scoped setups are visible instead of silent.
                        workspace: {
                          workingDir: config?.workingDir || process.cwd(),
                          detectedBranch: await memoryStore.getCurrentBranch(),
                        },
                      },
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
                ...(includeAuto ? { includeAuto: true } : {}),
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
                          content: e.content.slice(0, 200) + (e.content.length > 200 ? "..." : ""),
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
                          content: v.content.slice(0, 200) + (v.content.length > 200 ? "..." : ""),
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
              const entryIds = ids ?? (id ? id.split(",").map((s: string) => s.trim()) : undefined);
              const promoted = await memoryStore.promoteToWorkspace(branch, entryIds);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ action: "promote", branch, promotedCount: promoted }, null, 2),
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

  // rag_graph_visualize — interactive knowledge/memory graph document for MCP Apps.
  registerCuratorTool(
    "rag_graph_visualize",
    "Visualize a RAGnarōk knowledge, workspace-memory, or branch-memory graph as a deterministic bounded document.",
    graphVisualizationInput,
    readOnlyAnnotations,
    async (input) => {
      if (input.source === "knowledge") {
        let match;
        try {
          match = await topicManager.resolveTopicByName(input.topic);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return graphError(
            isTopicNotFoundError(message) ? "GRAPH_TOPIC_NOT_FOUND" : "GRAPH_VISUALIZATION_FAILED",
            message,
          );
        }
        if (!match?.topic) {
          return graphError("GRAPH_TOPIC_NOT_FOUND", `Topic not found: ${input.topic}`);
        }

        try {
          const graph = await topicManager.getKnowledgeGraph(match.topic.id);
          const document = projectKnowledgeGraphVisualization(
            {
              entities: graph?.getAllEntities() ?? [],
              relationships: graph?.getAllRelationships() ?? [],
            },
            { kind: "knowledge", topicId: match.topic.id, topicName: match.topic.name },
            { maxNodes: input.maxNodes },
          );
          return toolJson(fitGraphVisualizationResult(document));
        } catch (error) {
          if (error instanceof GraphVisualizationRecordTooLargeError) {
            return graphError("GRAPH_VISUALIZATION_RECORD_TOO_LARGE", error.message);
          }
          const message = error instanceof Error ? error.message : String(error);
          return graphError("GRAPH_VISUALIZATION_FAILED", message);
        }
      }

      if (deployment === "shared" || !memoryStore) {
        return graphError("GRAPH_MEMORY_UNAVAILABLE", "Memory graph visualization is unavailable in this deployment");
      }

      try {
        const branch = input.memoryScope === "branch" ? input.branch : undefined;
        const snapshot = await memoryStore.getGraphSnapshot(input.memoryScope, branch);
        const source =
          input.memoryScope === "branch"
            ? ({ kind: "memory", scope: "branch", branch: input.branch } as const)
            : ({ kind: "memory", scope: "workspace" } as const);
        const document = projectMemoryGraphVisualization(snapshot, source, { maxNodes: input.maxNodes });
        return toolJson(fitGraphVisualizationResult(document));
      } catch (error) {
        if (error instanceof GraphVisualizationRecordTooLargeError) {
          return graphError("GRAPH_VISUALIZATION_RECORD_TOO_LARGE", error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return graphError("GRAPH_VISUALIZATION_FAILED", message);
      }
    },
    { ui: { resourceUri: GRAPH_RESOURCE_URI } },
  );

  for (const tool of pendingTools.sort((left, right) => left.name.localeCompare(right.name))) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}
