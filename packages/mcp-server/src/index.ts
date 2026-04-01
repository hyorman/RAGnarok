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
 *   RAGNAROK_EMBEDDING_MODEL  — Embedding model (default: Xenova/all-MiniLM-L6-v2)
 *   RAGNAROK_LLM_PROVIDER     — LLM provider: openai, anthropic, ollama, none (default: none)
 *   RAGNAROK_LLM_API_KEY      — API key for OpenAI or Anthropic
 *   RAGNAROK_LLM_MODEL        — LLM model name (default: gpt-4o-mini)
 *   RAGNAROK_LLM_BASE_URL     — Ollama base URL (default: http://localhost:11434)
 *   RAGNAROK_PORT             — HTTP server port (default: 3000)
 *   RAGNAROK_EMBEDDING_PROVIDER   — Embedding provider: huggingface, openai, ollama (default: huggingface)
 *   RAGNAROK_EMBEDDING_BASE_URL   — Remote embedding API base URL (required for openai/ollama)
 *   RAGNAROK_EMBEDDING_API_KEY    — API key for remote embedding API (optional)
 *   RAGNAROK_LOG_LEVEL        — Log level: debug, info, warn, error
 *   ... see config.ts for all options
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  setLoggerFactory,
  Logger,
  LogLevel,
  TopicManager,
  EmbeddingService,
  HuggingFaceBackend,
  RemoteEmbeddingBackend,
  ModelRegistry,
} from "@ragnarok/core";
import type { RemoteEmbeddingFormat } from "@ragnarok/core";
import { loadConfig } from "./config";
import { EnvConfigProvider, ConsoleLoggerFactory, ConsoleNotifier } from "./adapters";
import { createLLMProvider } from "./llmProviders";
import { registerTools } from "./tools";
import { startHttpTransport } from "./httpServer";

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
  });

  logger.info(`Loaded ${topicManager.getAllTopics().length} topic(s) from ${config.storageDir}`);

  // Create MCP server
  const server = new McpServer({
    name: "ragnarok",
    version: "0.3.0",
  });

  // Register tools
  registerTools(server, topicManager, configProvider, llmProvider, embeddingService, config.storageDir);

  // Start transport
  const useHttp = process.argv.includes("--http");

  if (useHttp) {
    await startHttpTransport(server, config);
  } else {
    // stdio transport for local agents (default)
    logger.info("Starting stdio transport");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("RAGnarōk MCP server running (stdio)");
  }
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
