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
 *   RAGNAROK_PORT             — HTTP server port (default: 3000)
 *   RAGNAROK_EMBEDDING_PROVIDER   — Embedding provider: huggingface, openai, ollama (default: huggingface)
 *   RAGNAROK_EMBEDDING_BASE_URL   — Remote embedding API base URL (required for openai/ollama)
 *   RAGNAROK_EMBEDDING_API_KEY    — API key for remote embedding API (optional)
 *   RAGNAROK_LOG_LEVEL        — Log level: debug, info, warn, error
 *   ... see config.ts for all options
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
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
import { registerGraphUiResource } from "./uiResource";
import type { MutationRunner, ToolRuntime } from "./tools";
import { startHttpTransport, HttpTransportHandle } from "./httpServer";
import type { AccessRole } from "./httpServer";
import { TransferManager } from "./transferManager";

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
    resetStorage: config.resetStorage,
  });

  logger.info(`Loaded ${topicManager.getAllTopics().length} topic(s) from ${config.storageDir}`);

  // Register tools
  const ragQueryService = new RAGQueryService(topicManager, configProvider, llmProvider);
  TopicManager.onAgentCacheCleanup.subscribe((topicId) => ragQueryService.clearAgentCache(topicId));

  const useHttp = process.argv.includes("--http");
  const deployment: "local" | "shared" = config.deploymentMode ?? "local";
  const sharedDeployment = deployment === "shared";
  const transferManager =
    useHttp && sharedDeployment
      ? new TransferManager(path.join(config.storageDir, ".transfers"), {
          maxFileBytes: config.transferMaxFileBytes ?? 64 * 1024 * 1024,
          maxAggregateBytes: config.transferMaxAggregateBytes ?? 256 * 1024 * 1024,
          maxSessionsPerPrincipal: config.transferMaxSessions ?? 8,
          ttlMs: config.transferTtlMs ?? 15 * 60_000,
        })
      : undefined;
  await transferManager?.initialize();

  // Create standalone memory store
  // Branch-scoped memory needs the PROJECT's directory, not the server's.
  // Global MCP clients often launch servers from a home/app directory, which
  // would silently mis-scope branch memories without an explicit working dir.
  const workingDir = config.workingDir || process.cwd();
  if (!config.workingDir && !sharedDeployment) {
    logger.warn(
      `RAGNAROK_WORKING_DIR not set — using process.cwd() (${workingDir}) for git branch detection. ` +
        "Set it when the server is launched outside the project directory.",
    );
  }
  // Downstream consumers (tools) read the RESOLVED working dir from config.
  config.workingDir = workingDir;
  const memoryStore = sharedDeployment
    ? undefined
    : new MemoryStore({
        storageDir: config.storageDir,
        embeddingService,
        llmProvider,
        workingDir,
        markdownPath: path.join(config.storageDir, "memories.md"),
      });
  if (sharedDeployment) {
    logger.info("Shared deployment (auth tokens configured): personal memory tools are disabled");
  }

  // Create reranker (always-on — gracefully degrades if ONNX model unavailable)
  const reranker = config.rerankerEnabled
    ? new CrossEncoderReranker(config.rerankerModel, { maxCandidates: config.rerankerMaxCandidates })
    : null;
  let rerankerReady = reranker === null;
  let rerankerFailure: string | undefined;
  // Share the SAME instance with the query path so rag_switch_reranker_model
  // affects query behaviour, not just the management tools' private copy.
  if (reranker) {
    ragQueryService.setReranker(reranker);
    // Non-blocking warm-up: the first query skips the model-load stall, and a
    // broken model surfaces in the startup log instead of at query time.
    void reranker
      .initialize()
      .then(() => {
        rerankerReady = true;
      })
      .catch((error) => {
        rerankerFailure = error instanceof Error ? error.message : String(error);
        logger.warn("Reranker warm-up failed — queries will fall back to original ranking", rerankerFailure);
      });
  }

  // Server factory: HTTP creates one instance per request; stdio pins one
  // instance per modern connection. All instances share the services.
  let acceptingOperations = true;
  let activeOperations = 0;
  const operationDrainWaiters: Array<() => void> = [];
  const toolRuntime: ToolRuntime = {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (!acceptingOperations) {
        throw new Error("SERVER_DRAINING: new tool operations are not accepted");
      }
      activeOperations++;
      try {
        return await operation();
      } finally {
        activeOperations--;
        if (activeOperations === 0) {
          for (const resolve of operationDrainWaiters.splice(0)) {
            resolve();
          }
        }
      }
    },
  };
  const closeOperationAdmission = (): void => {
    acceptingOperations = false;
  };
  const waitForOperationDrain = (): Promise<void> =>
    activeOperations === 0 ? Promise.resolve() : new Promise((resolve) => operationDrainWaiters.push(resolve));

  let mutationTail = Promise.resolve();
  const runMutation: MutationRunner = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  // Self-describing servers: agents that see both a local and a shared
  // RAGnarōk entry route between them by these instructions (design §4.2).
  const instructions = sharedDeployment
    ? "RAGnarōk team shared knowledge base (central, curated). Topics on this server are shared team data: " +
      "read-only unless your token grants write access. Personal memory tools are not available here — " +
      "personal knowledge bases and memory belong to a local RAGnarōk server. If a local RAGnarōk server " +
      "is also configured, prefer it for personal topics and memory; use this server for team-shared topics."
    : "RAGnarōk personal engine: local knowledge bases and project memory, full read/write on this machine. " +
      "If a remote team RAGnarōk server is also configured, prefer this local server for personal topics " +
      "and memory; use the remote one for team-shared topics.";

  const createMcpServer = (role: AccessRole = "admin", principal = "local-owner"): McpServer => {
    const server = new McpServer(
      {
        name: "ragnarok",
        version: getServerVersion(),
      },
      { instructions },
    );
    registerTools(
      server,
      topicManager,
      llmProvider,
      embeddingService,
      ragQueryService,
      memoryStore,
      reranker,
      config,
      role,
      runMutation,
      deployment,
      toolRuntime,
      transferManager,
      principal,
    );
    registerGraphUiResource(server);
    return server;
  };

  // Start transport
  let httpHandle: HttpTransportHandle | null = null;
  let stdioHandle: StdioServerHandle | null = null;

  if (useHttp) {
    httpHandle = await startHttpTransport(createMcpServer, config, {
      readiness: async () => {
        const blockingReasons: string[] = [];
        const modelState: string[] = [];
        if (!acceptingOperations) {
          blockingReasons.push("draining");
        }
        try {
          await topicManager.getStorageStatus();
        } catch {
          blockingReasons.push("storage_unavailable_or_locked");
        }
        if (!embeddingService.getCurrentModel()) {
          blockingReasons.push("embedding_model_unavailable");
        }
        if (!rerankerReady) {
          modelState.push(rerankerFailure ? "reranker_model_degraded" : "reranker_model_loading");
        }
        return {
          ready: blockingReasons.length === 0,
          reasons: [...blockingReasons, ...modelState],
        };
      },
      transferManager,
    });
  } else {
    // stdio transport for local agents (default)
    logger.info("Starting stdio transport");
    stdioHandle = serveStdio(() => createMcpServer(), {
      legacy: "reject",
      onerror: (error) => logger.error("stdio MCP error", error),
    });
    logger.info("RAGnarōk MCP server running (stdio, MCP 2026-07-28)");
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
    closeOperationAdmission();
    httpHandle?.closeAdmission();
    const drainBudgetMs = config.shutdownDrainMs ?? 10_000;
    const shutdownDeadline = Date.now() + drainBudgetMs;
    const hardExit = setTimeout(() => process.exit(1), drainBudgetMs + 5_000);

    try {
      const drainDeadline = new Promise<void>((resolve) => setTimeout(resolve, drainBudgetMs).unref());
      await Promise.race([waitForOperationDrain(), drainDeadline]);
      if (httpHandle) {
        await httpHandle.shutdown(shutdownDeadline);
      }
      await stdioHandle?.close();
      await memoryStore?.dispose();
      await ragQueryService.dispose();
      await topicManager.dispose();
      await embeddingService.dispose();
      await transferManager?.dispose();
      logger.info("Shutdown complete");
      clearTimeout(hardExit);
    } catch (error) {
      logger.error("Error during shutdown", error);
    }
    process.exitCode = 0;
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (stdioHandle) {
    process.stdin.once("end", () => void shutdown("stdio EOF"));
  }
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exitCode = 1;
});
