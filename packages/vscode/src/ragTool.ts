/**
 * RAG Query Tool for Copilot/LLM Agent integration
 * Refactored to use new LangChain-based architecture with RAGAgent
 */

import * as vscode from "vscode";
import {
  TopicManager,
  EmbeddingService,
  Logger,
  RAGQueryParams,
  RAGQueryResult,
  IConfigProvider,
  ILLMProvider,
  RAGQueryService,
  TopicEmptyError,
  MemoryStore,
  LanceDBCheckpointSaver,
} from "@ragnarok/core";
import { TOOLS, VSCODE_CONFIG } from "./constants";
import { WorkspaceContextProvider } from "./workspaceContext";

const logger = new Logger("RAGTool");

export class RAGTool {
  private embeddingService: EmbeddingService;
  private config: IConfigProvider;
  private llmProvider: ILLMProvider;
  private ragQueryService: RAGQueryService;
  private cleanupSubscription: { unsubscribe(): void };

  constructor(
    topicManager: TopicManager,
    embeddingService: EmbeddingService,
    config: IConfigProvider,
    llmProvider: ILLMProvider,
    memoryStore?: MemoryStore,
    checkpointer?: LanceDBCheckpointSaver,
  ) {
    this.embeddingService = embeddingService;
    this.config = config;
    this.llmProvider = llmProvider;
    this.ragQueryService = new RAGQueryService(topicManager, config, llmProvider);
    this.ragQueryService.setGraphDeps({ memoryStore, embeddingService, checkpointer });
    this.cleanupSubscription = TopicManager.onAgentCacheCleanup.subscribe((topicId) =>
      this.ragQueryService.clearAgentCache(topicId),
    );
  }

  /**
   * Register the RAG query tool with VSCode
   */
  public static register(
    context: vscode.ExtensionContext,
    topicManager: TopicManager,
    embeddingService: EmbeddingService,
    config: IConfigProvider,
    llmProvider: ILLMProvider,
    memoryStore?: MemoryStore,
    checkpointer?: LanceDBCheckpointSaver,
  ): vscode.Disposable {
    const tool = new RAGTool(topicManager, embeddingService, config, llmProvider, memoryStore, checkpointer);

    // Register as a language model tool
    const ragTool = vscode.lm.registerTool(TOOLS.RAG_QUERY, {
      invoke: async (
        options: vscode.LanguageModelToolInvocationOptions<RAGQueryParams>,
        token: vscode.CancellationToken,
      ) => {
        const params = options.input;
        // Convert VS Code CancellationToken to AbortSignal
        const abortController = new AbortController();
        const onCancel = token.onCancellationRequested(() => abortController.abort());
        try {
          const result = await tool.executeQuery(params, abortController.signal);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
          ]);
        } finally {
          onCancel.dispose();
        }
      },
      prepareInvocation: async (options: vscode.LanguageModelToolInvocationPrepareOptions<RAGQueryParams>) => {
        const params = options.input;
        return {
          invocationMessage: `Searching RAG database for topic "${params.topic}" with query: "${params.query}"`,
        };
      },
    });

    // Create a composite disposable that disposes both the tool registration and the RAGTool instance
    const compositeDisposable = vscode.Disposable.from(ragTool, {
      dispose: () => {
        tool.dispose();
      },
    });

    context.subscriptions.push(compositeDisposable);
    return compositeDisposable;
  }

  /**
   * Execute a RAG query (supports both simple and agentic modes)
   */
  private async executeQuery(params: RAGQueryParams, signal?: AbortSignal): Promise<RAGQueryResult> {
    try {
      logger.info(`Executing RAG query: "${params.query}" for topic: "${params.topic}"`);

      // Ensure embedding service is ready
      await this.embeddingService.initialize();

      // Optionally inject workspace context when LLM refinement is plausible
      const includeWorkspace = this.config.get<boolean>(VSCODE_CONFIG.INCLUDE_WORKSPACE, true);
      const canUseWorkspaceContext =
        includeWorkspace && params.query.trim().includes(" ") && (await this.llmProvider.isAvailable());

      let workspaceContext: string | undefined;
      if (canUseWorkspaceContext) {
        const wsContext = await WorkspaceContextProvider.getContext({
          includeSelection: true,
          includeActiveFile: true,
          includeWorkspace: true,
          maxCodeLength: 1000,
        });
        workspaceContext = JSON.stringify(wsContext, null, 2);
      } else if (includeWorkspace) {
        logger.debug("Skipping workspace context: LLM refinement unavailable or not expected", {
          query: params.query.substring(0, 100),
        });
      }

      // Delegate to the shared RAGQueryService
      return await this.ragQueryService.executeQuery(params, workspaceContext, signal);
    } catch (error) {
      if (error instanceof TopicEmptyError) {
        // Return empty result with structured info instead of a generic error
        return {
          query: params.query,
          topicName: error.topicName,
          topicMatched: "fallback",
          results: [],
          agenticMetadata: {
            mode: "agentic",
            steps: [],
            totalIterations: 0,
            queryComplexity: "simple",
            confidence: 0,
          },
        };
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      logger.error(`RAG Query Failed: ${rawMessage}`);
      const sanitizedMessage = rawMessage
        .replace(/\/[\w/.-]+/g, "<path>")
        .replace(/[A-Z]:\\[\w\\.-]+/g, "<path>")
        .replace(/at\s+\w+\s+\([\s\S]*?\)/g, "")
        .trim();
      throw new Error(`RAG Query Failed: ${sanitizedMessage}`);
    }
  }

  /**
   * Dispose of all resources and clean up.
   */
  private dispose(): void {
    logger.info("Disposing RAGTool");
    this.cleanupSubscription.unsubscribe();
    void this.ragQueryService.dispose();
    logger.info("RAGTool disposed");
  }
}
