#!/usr/bin/env node
/**
 * RAGnarōk MCP Server
 *
 * Exposes RAG tools via the Model Context Protocol over stdio — the only
 * transport. The server is a personal, single-user engine on this machine.
 *
 * Usage:
 *   ragnarok-mcp              # stdio (for Claude, Cursor, VS Code, etc.)
 *
 * Environment variables — secrets, bootstrap paths and one-shot switches only.
 * Everything else lives in <storageDir>/config.json, which the server generates
 * on first run with a $defaults block documenting every setting:
 *   RAGNAROK_STORAGE_DIR       — Database storage directory (default: ~/.ragnarok)
 *   RAGNAROK_WORKING_DIR       — Project root for git-branch-scoped memory (default: process.cwd())
 *   RAGNAROK_LLM_API_KEY       — API key for OpenAI or Anthropic
 *   RAGNAROK_EMBEDDING_API_KEY — API key for a remote embedding API (optional)
 *   RAGNAROK_GITHUB_TOKEN      — GitHub token (falls back to GITHUB_ACCESS_TOKEN)
 *   RAGNAROK_RESET_STORAGE     — One-shot: reset storage on this launch
 *   RAGNAROK_IGNORE_LOCK       — One-shot: bypass the single-writer lock (unsafe)
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
  EmbeddingServiceRegistry,
  HuggingFaceBackend,
  RemoteEmbeddingBackend,
  ModelRegistry,
  RAGQueryService,
  MemoryStore,
  MemoryOperationCoordinator,
  MemoryService,
  GraphVisualizationService,
  CrossEncoderReranker,
} from "@ragnarok/core";
import type { RemoteEmbeddingFormat } from "@ragnarok/core";
import { loadConfig, getServerVersion, assertNoRemovedEnvVars } from "./config";
import { ensureConfigFile } from "./configFile";
import { EnvConfigProvider, ConsoleLoggerFactory, ConsoleNotifier } from "./adapters";
import { createLLMProvider, isUsableLLMProvider } from "./llmProviders";
import { registerTools } from "./tools";
import { registerGraphUiResource } from "./uiResource";
import type { MutationRunner } from "./tools";
import { createToolRuntime, drainToolRuntimeThenMemory } from "./toolRuntime";

async function main(): Promise<void> {
  // Before anything else: an operator who still supplies HTTP-era settings has
  // a false model of what this process is. Say so instead of ignoring them.
  assertNoRemovedEnvVars();
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

  // Write the discoverable config.json (and refresh its $defaults) once the
  // logger exists: a failure here is only ever a warning, and in stdio mode
  // stdout belongs to the JSON-RPC transport, so console is not an option.
  ensureConfigFile(config.storageDir, (message) => logger.warn(message));

  // Create adapters
  const configProvider = new EnvConfigProvider(config);
  const notifier = new ConsoleNotifier();
  const llmProvider = createLLMProvider(config);

  // A misconfigured remote provider must fail at startup, not on the first
  // store load, so the URL is validated here rather than inside the builder.
  let remoteEmbeddingOptions: ConstructorParameters<typeof RemoteEmbeddingBackend>[0] | undefined;
  if (config.embeddingProvider !== "huggingface") {
    if (!config.embeddingBaseUrl) {
      throw new Error('config.json: "embedding.baseUrl" is required when "embedding.provider" is not huggingface');
    }
    remoteEmbeddingOptions = {
      baseUrl: config.embeddingBaseUrl,
      apiKey: config.embeddingApiKey || undefined,
      format: config.embeddingProvider as RemoteEmbeddingFormat,
      modelName: config.embeddingModel,
    };
  }

  // Builds a fully-backed embedding service. Every service needs the same
  // backends: one with none registered cannot initialize at all, and the
  // fallback in EmbeddingService.initialize is disabled for an empty list.
  // The backend instances are constructed per call on purpose — sharing one
  // HuggingFaceBackend across services would reintroduce the shared-model bug
  // one level down, since initializeForBackend re-points the backend itself.
  const modelRegistry = ModelRegistry.getInstance();
  const buildEmbeddingService = () => {
    const service = new EmbeddingService({ config: configProvider, notifier });
    // HuggingFace only in MCP mode — no VS Code LM. Registered first so the
    // remote backend, when present, stays the last-registered fallback.
    service.registerBackend(new HuggingFaceBackend(modelRegistry, notifier, config.embeddingModel));
    if (remoteEmbeddingOptions) {
      service.registerBackend(new RemoteEmbeddingBackend(remoteEmbeddingOptions));
    }
    return service;
  };

  // Initialize core services
  const embeddingService = buildEmbeddingService();
  if (remoteEmbeddingOptions) {
    logger.info(`Registered remote embedding backend (${config.embeddingProvider}) at ${config.embeddingBaseUrl}`);
  }

  // One registry for the whole process: a registry per consumer would give each
  // its own resident models and defeat the cap.
  const embeddingRegistry = new EmbeddingServiceRegistry({
    createService: buildEmbeddingService,
    maxResidentLocal: config.maxResidentModels,
  });

  // Create topic manager
  const topicManager = await TopicManager.create({
    storageDir: config.storageDir,
    config: configProvider,
    notifier,
    embeddingService,
    embeddingRegistry,
    llmProvider,
    resetStorage: config.resetStorage,
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
  // MemoryStore decides in its constructor whether entity extraction exists, so
  // it must not receive the NullProvider stand-in: a truthy-but-inert provider
  // makes `isEntityExtractionEnabled()` report a graph that can never populate,
  // and an empty result then reads as "nothing known" instead of "disabled".
  // Every other consumer keeps the no-op and probes it with isAvailable().
  const memoryStore = new MemoryStore({
    storageDir: config.storageDir,
    embeddingService,
    llmProvider: isUsableLLMProvider(llmProvider) ? llmProvider : undefined,
    workingDir,
    markdownPath: path.join(config.storageDir, "memories.md"),
  });
  const memoryCoordinator = new MemoryOperationCoordinator();
  const memoryService = new MemoryService(memoryStore, memoryCoordinator);
  const graphVisualizationService = new GraphVisualizationService(memoryStore, memoryCoordinator);

  // Reranking is unconditional: the cross-encoder ONNX model ships inside the
  // package, so there is no download to opt out of and no configuration to get
  // wrong. It degrades gracefully — a model that fails to load leaves queries
  // on first-stage ranking rather than failing them.
  const reranker = new CrossEncoderReranker(config.rerankerModel, {
    maxCandidates: config.rerankerMaxCandidates,
  });
  let rerankerFailure: string | undefined;
  ragQueryService.setReranker(reranker);
  // Non-blocking warm-up: the first query skips the model-load stall, and a
  // broken model surfaces in the startup log instead of at query time.
  void reranker.initialize().catch((error) => {
    rerankerFailure = error instanceof Error ? error.message : String(error);
    logger.warn("Reranker warm-up failed — queries will fall back to original ranking", rerankerFailure);
  });

  // Server factory: stdio pins one instance per connection. Every instance
  // shares the services created above.
  const toolRuntime = createToolRuntime();

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

  // Self-describing server: the instructions tell an agent what this entry is
  // for, so it can route between RAGnarōk and its other tools deliberately.
  const instructions =
    "RAGnarōk personal engine: local knowledge bases and project memory, full read/write on this machine.";

  const createMcpServer = (): McpServer => {
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
      embeddingService,
      ragQueryService,
      memoryStore,
      memoryService,
      graphVisualizationService,
      memoryStore,
      config,
      runMutation,
      toolRuntime,
      (operation) => memoryCoordinator.runMutation(operation),
    );
    registerGraphUiResource(server);
    return server;
  };

  // Start transport — stdio is the only transport.
  let stdioHandle: StdioServerHandle | null = null;

  logger.info("Starting stdio transport");
  stdioHandle = serveStdio(() => createMcpServer(), {
    legacy: "reject",
    onerror: (error) => logger.error("stdio MCP error", error),
  });
  logger.info("RAGnarōk MCP server running (stdio, MCP 2026-07-28)");

  // Graceful shutdown: close transports, then release native/model resources
  // and pending timers (memory auto-decay, ONNX sessions, LanceDB handles).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);
    const drainBudgetMs = config.shutdownDrainMs ?? 10_000;
    const hardExit = setTimeout(() => process.exit(1), drainBudgetMs + 5_000);

    try {
      await drainToolRuntimeThenMemory(toolRuntime, memoryCoordinator);
      await stdioHandle?.close();
      await memoryStore.dispose();
      await ragQueryService.dispose();
      await topicManager.dispose();
      await embeddingRegistry.disposeAll();
      await embeddingService.dispose();
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
