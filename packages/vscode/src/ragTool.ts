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
} from "@ragnarok/core";
import { TOOLS, VSCODE_CONFIG } from "./constants";
import { WorkspaceContextProvider } from "./workspaceContext";

const logger = new Logger("RAGTool");

export interface RAGToolRegistration extends vscode.Disposable {
  readonly tool: RAGTool;
  disposeAsync(): Promise<void>;
}

export class RAGTool {
  private embeddingService: EmbeddingService;
  private config: IConfigProvider;
  private llmProvider: ILLMProvider;
  private ragQueryService: RAGQueryService;
  private cleanupSubscription: { unsubscribe(): void };
  private readonly activeQueries = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private acceptingQueries = true;
  private disposePromise: Promise<void> | undefined;

  constructor(
    topicManager: TopicManager,
    embeddingService: EmbeddingService,
    config: IConfigProvider,
    llmProvider: ILLMProvider,
  ) {
    this.embeddingService = embeddingService;
    this.config = config;
    this.llmProvider = llmProvider;
    this.ragQueryService = new RAGQueryService(topicManager, config, llmProvider);
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
  ): RAGToolRegistration {
    const tool = new RAGTool(topicManager, embeddingService, config, llmProvider);

    // Register as a language model tool
    const ragTool = vscode.lm.registerTool(TOOLS.RAG_QUERY, {
      invoke: async (
        options: vscode.LanguageModelToolInvocationOptions<RAGQueryParams>,
        token: vscode.CancellationToken,
      ) => {
        const params = options.input;
        // Convert VS Code CancellationToken to AbortSignal
        const abortController = new AbortController();
        if (token.isCancellationRequested) {
          abortController.abort(new Error("RAG query cancelled"));
        }
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
    const registration = vscode.Disposable.from(ragTool);
    const compositeDisposable: RAGToolRegistration = {
      tool,
      dispose: () => {
        registration.dispose();
        tool.stopAdmission();
      },
      disposeAsync: async () => {
        registration.dispose();
        await tool.disposeAsync();
      },
    };

    context.subscriptions.push(compositeDisposable);
    return compositeDisposable;
  }

  /**
   * Execute a RAG query (supports both simple and agentic modes)
   */
  public async executeQuery(params: RAGQueryParams, signal?: AbortSignal): Promise<RAGQueryResult> {
    if (!this.acceptingQueries) {
      throw new Error("RAGnarōk is shutting down and is not accepting new queries");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("RAG query cancelled"));
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    this.activeControllers.add(controller);
    const query = this.executeQueryCore(params, controller.signal);
    this.activeQueries.add(query);
    try {
      return await query;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.activeQueries.delete(query);
      this.activeControllers.delete(controller);
    }
  }

  private async executeQueryCore(params: RAGQueryParams, signal: AbortSignal): Promise<RAGQueryResult> {
    try {
      signal.throwIfAborted();
      logger.info(`Executing RAG query: "${params.query}" for topic: "${params.topic}"`);

      // Ensure embedding service is ready
      await this.embeddingService.initialize();
      signal.throwIfAborted();

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
        signal.throwIfAborted();
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
  private stopAdmission(): void {
    if (!this.acceptingQueries) {
      return;
    }
    this.acceptingQueries = false;
    for (const controller of this.activeControllers) {
      controller.abort(new Error("RAGnarōk is shutting down"));
    }
  }

  public disposeAsync(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        logger.info("Disposing RAGTool");
        this.stopAdmission();
        await Promise.allSettled([...this.activeQueries]);
        this.cleanupSubscription.unsubscribe();
        await this.ragQueryService.dispose();
        logger.info("RAGTool disposed");
      })();
    }
    return this.disposePromise;
  }
}
