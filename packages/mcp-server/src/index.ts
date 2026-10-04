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
 * on first run with a $defaults block documenting every setting — including
 * storage.commonDatabasePath, a folder of exported .rag archives contributing
 * read-only shared topics (unset by default, config.json only, no env var):
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
  HuggingFaceBackend,
  RemoteEmbeddingBackend,
  ModelRegistry,
  RAGQueryService,
  MemoryStore,
  CrossEncoderReranker,
  createSharedTopicSources,
  createEmbeddingServices,
  createMemoryServices,
} from "@ragnarok/core";
import type { RemoteEmbeddingFormat } from "@ragnarok/core";
import { loadConfig, getServerVersion } from "./config";
import { ensureConfigFile } from "./configFile";
import { EnvConfigProvider, ConsoleLoggerFactory, ConsoleNotifier } from "./adapters";
import { createLLMProvider, isUsableLLMProvider } from "./llmProviders";
import { registerTools } from "./tools";
import { registerGraphUiResource } from "./uiResource";
import type { MutationRunner } from "./tools";
import { createToolRuntime, drainToolRuntimeThenMemory } from "./toolRuntime";

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

  const modelRegistry = ModelRegistry.getInstance();
  const { embeddingService, embeddingRegistry } = createEmbeddingServices({
    config: configProvider,
    notifier,
    maxResidentLocal: config.maxResidentModels,
    // HuggingFace first, so the remote backend, when configured, is the fallback.
    createBackends: () => [
      new HuggingFaceBackend(modelRegistry, notifier, config.embeddingModel),
      ...(remoteEmbeddingOptions ? [new RemoteEmbeddingBackend(remoteEmbeddingOptions)] : []),
    ],
  });
  if (remoteEmbeddingOptions) {
    logger.info(`Registered remote embedding backend (${config.embeddingProvider}) at ${config.embeddingBaseUrl}`);
  }

  // Create topic manager
  const topicManager = await TopicManager.create({
    storageDir: config.storageDir,
    config: configProvider,
    notifier,
    embeddingService,
    embeddingRegistry,
    llmProvider,
    resetStorage: config.resetStorage,
    sharedTopicSources: createSharedTopicSources(config.commonDatabasePath),
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
  const {
    coordinator: memoryCoordinator,
    memoryService,
    graphService: graphVisualizationService,
  } = createMemoryServices(memoryStore);

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
      ragQueryService,
      memoryService,
      graphVisualizationService,
      memoryStore,
      config,
      runMutation,
      toolRuntime,
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
  // A stdio client shows the operator nothing but this stream, so a startup
  // refusal that has a concrete next action names it here. Both storage
  // refusals get a hint: pre-0.4 data (UnsupportedStorageError) can be backed
  // up by a reset, and storage written by a NEWER build
  // (StorageFormatVersionError) needs an upgrade or another directory.
  if ((error as Error)?.name === "UnsupportedStorageError") {
    console.error(
      "This storage holds data from an unsupported pre-0.4 build. Start once with RAGNAROK_RESET_STORAGE=1 to move it into a backup folder and begin a new store, or point RAGNAROK_STORAGE_DIR at another directory.",
    );
  } else if ((error as Error)?.name === "StorageFormatVersionError") {
    console.error(
      "This storage was written by a newer RAGnarok build. Upgrade, or point RAGNAROK_STORAGE_DIR at another directory.",
    );
  }
  process.exitCode = 1;
});
