#!/usr/bin/env node
/**
 * RAGnarōk MCP Server
 *
 * Exposes RAG tools via the Model Context Protocol.
 * Supports stdio transport (default) and HTTP transport (--http flag).
 *
 * Usage:
 *   ragnarok-mcp              # stdio mode (for Claude, Cursor, VS Code, etc.)
 *   ragnarok-mcp --http       # HTTP mode (for web agents)
 *
 * Environment variables:
 *   RAGNAROK_STORAGE_DIR      — Database storage directory (default: ~/.ragnarok)
 *   RAGNAROK_WORKING_DIR      — Project root for git-branch-scoped memory (default: process.cwd())
 *   RAGNAROK_ALLOWED_PATHS    — Roots rag_add_documents may read, path-delimiter separated (default: the working dir)
 *   RAGNAROK_EMBEDDING_MODEL  — Embedding model (default: Xenova/all-MiniLM-L6-v2)
 *   RAGNAROK_LLM_PROVIDER     — LLM provider: openai, anthropic, ollama, none (default: none)
 *   RAGNAROK_LLM_API_KEY      — API key for OpenAI or Anthropic
 *   RAGNAROK_LLM_MODEL        — LLM model name (default: gpt-4o-mini)
 *   RAGNAROK_LLM_BASE_URL     — LLM API base URL override (Ollama defaults to http://localhost:11434; OpenAI/Anthropic use their official endpoints unless set)
 *   RAGNAROK_LANGGRAPH_ENABLED — Run queries/indexing through the LangGraph pipeline (default: false, experimental)
 *   RAGNAROK_PORT             — HTTP server port (default: 3000)
 *   RAGNAROK_EMBEDDING_PROVIDER   — Embedding provider: huggingface, openai, ollama (default: huggingface)
 *   RAGNAROK_EMBEDDING_BASE_URL   — Remote embedding API base URL (required for openai/ollama)
 *   RAGNAROK_EMBEDDING_API_KEY    — API key for remote embedding API (optional)
 *   RAGNAROK_LOG_LEVEL        — Log level: debug, info, warn, error
 *   ... see config.ts for all options
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import {
  setLoggerFactory,
  Logger,
  LogLevel,
  TopicManager,
  EmbeddingService,
  HuggingFaceBackend,
  RemoteEmbeddingBackend,
  ModelRegistry,
  RAGQueryService,
  MemoryStore,
  CrossEncoderReranker,
} from "@ragnarok/core";
import type { RemoteEmbeddingFormat } from "@ragnarok/core";
import { loadConfig, getServerVersion } from "./config";
import { EnvConfigProvider, ConsoleLoggerFactory, ConsoleNotifier } from "./adapters";
import { createLLMProvider } from "./llmProviders";
import { registerTools } from "./tools";
import { startHttpTransport, HttpTransportHandle } from "./httpServer";

async function main(): Promise<void> {
  const config = loadConfig();

  // Bootstrap logging
  const loggerFactory = new ConsoleLoggerFactory();
  setLoggerFactory(loggerFactory);

  const logLevel =
    config.logLevel === "debug"
      ? LogLevel.DEBUG
      : config.logLevel === "warn"
        ? LogLevel.WARN
        : config.logLevel === "error"
          ? LogLevel.ERROR
          : LogLevel.INFO;
  Logger.setLogLevel(logLevel);

  const logger = new Logger("MCP-Server");
  logger.info("Starting RAGnarōk MCP server");

  // Create adapters
  const configProvider = new EnvConfigProvider(config);
  const notifier = new ConsoleNotifier();
  const llmProvider = createLLMProvider(config);

  // Initialize core services
  const embeddingService = new EmbeddingService({ config: configProvider, notifier });

  // Initialize embedding backend (HuggingFace only — no VS Code LM in MCP mode)
  const modelRegistry = ModelRegistry.getInstance();
  const hfBackend = new HuggingFaceBackend(modelRegistry, notifier, config.embeddingModel);
  embeddingService.registerBackend(hfBackend);

  // Register remote embedding backend if URL is configured
  if (config.embeddingProvider !== "huggingface") {
    if (!config.embeddingBaseUrl) {
      throw new Error("RAGNAROK_EMBEDDING_BASE_URL is required when RAGNAROK_EMBEDDING_PROVIDER is not huggingface");
    }
    const remoteBackend = new RemoteEmbeddingBackend({
      baseUrl: config.embeddingBaseUrl,
      apiKey: config.embeddingApiKey || undefined,
      format: config.embeddingProvider as RemoteEmbeddingFormat,
      modelName: config.embeddingModel,
    });
    embeddingService.registerBackend(remoteBackend);
    logger.info(`Registered remote embedding backend (${config.embeddingProvider}) at ${config.embeddingBaseUrl}`);
  }

  // Create topic manager
  const topicManager = await TopicManager.create({
    storageDir: config.storageDir,
    config: configProvider,
    notifier,
    embeddingService,
    llmProvider,
  });

  logger.info(`Loaded ${topicManager.getAllTopics().length} topic(s) from ${config.storageDir}`);

  // Register tools
  const ragQueryService = new RAGQueryService(topicManager, configProvider, llmProvider);
  TopicManager.onAgentCacheCleanup.subscribe((topicId) => ragQueryService.clearAgentCache(topicId));

  // Create standalone memory store
  // Branch-scoped memory needs the PROJECT's directory, not the server's.
  // Global MCP clients often launch servers from a home/app directory, which
  // would silently mis-scope branch memories without an explicit working dir.
  const workingDir = config.workingDir || process.cwd();
  if (!config.workingDir) {
    logger.warn(
      `RAGNAROK_WORKING_DIR not set — using process.cwd() (${workingDir}) for git branch detection. ` +
        "Set it when the server is launched outside the project directory.",
    );
  }
  // Downstream consumers (tools) read the RESOLVED working dir from config.
  config.workingDir = workingDir;
  const memoryStore = new MemoryStore({
    storageDir: config.storageDir,
    embeddingService,
    llmProvider,
    workingDir,
    markdownPath: path.join(config.storageDir, "memories.md"),
  });

  ragQueryService.setGraphDeps({ memoryStore, notifier, embeddingService });

  // Create reranker (always-on — gracefully degrades if ONNX model unavailable)
  const reranker = new CrossEncoderReranker(config.rerankerModel, {
    maxCandidates: config.rerankerMaxCandidates,
  });
  // Share the SAME instance with the query path so rag_switch_reranker_model
  // affects query behaviour, not just the management tools' private copy.
  ragQueryService.setReranker(reranker);

  // Server factory: stdio uses a single instance; the HTTP transport creates
  // one server+transport pair per client session (all sharing the services).
  const createMcpServer = (): McpServer => {
    const server = new McpServer({
      name: "ragnarok",
      version: getServerVersion(),
    });
    registerTools(server, topicManager, llmProvider, embeddingService, ragQueryService, memoryStore, reranker, config);
    return server;
  };

  // Start transport
  const useHttp = process.argv.includes("--http");

  let httpHandle: HttpTransportHandle | null = null;
  let stdioServer: McpServer | null = null;

  if (useHttp) {
    httpHandle = await startHttpTransport(createMcpServer, config);
  } else {
    // stdio transport for local agents (default)
    logger.info("Starting stdio transport");
    stdioServer = createMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    logger.info("RAGnarōk MCP server running (stdio)");
  }

  // Graceful shutdown: close transports, then release native/model resources
  // and pending timers (memory auto-decay, ONNX sessions, LanceDB handles).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);

    try {
      if (httpHandle) {
        await httpHandle.shutdown();
      }
      if (stdioServer) {
        await stdioServer.close();
      }
      await memoryStore.dispose();
      ragQueryService.dispose();
      reranker.dispose();
      topicManager.dispose();
      embeddingService.dispose();
      logger.info("Shutdown complete");
    } catch (error) {
      logger.error("Error during shutdown", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
