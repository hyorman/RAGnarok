/**
 * Main extension entry point
 * Wires VS Code adapters to the portable @ragnarok/core engine
 */

import * as vscode from "vscode";
import { TopicManager, EmbeddingService, Logger, setLoggerFactory, CONFIG, HuggingFaceBackend, ModelRegistry } from "@ragnarok/core";
import { VsCodeLoggerFactory } from "./adapters/vsCodeLogger";
import { VsCodeConfigProvider } from "./adapters/vsCodeConfigProvider";
import { VsCodeNotifier } from "./adapters/vsCodeNotifier";
import { VsCodeLLMProvider } from "./adapters/vsCodeLLMProvider";
import { VscodeLmBackend } from "./vscodeLmBackend";
import { RAGTool } from "./ragTool";
import { CommandHandler } from "./commands";
import { TopicTreeDataProvider, ConfigTreeDataProvider } from "./topicTreeView";
import { VIEWS, CONTEXT, COMMANDS } from "./constants";
import { GitHubTokenManager } from "./githubTokenManager";

// Install VS Code logger factory before anything else
setLoggerFactory(new VsCodeLoggerFactory());

const logger = new Logger("Extension");

export async function activate(context: vscode.ExtensionContext) {
  logger.info("RAGnarōk extension activating...");

  try {
    // Create adapter instances
    const configProvider = new VsCodeConfigProvider();
    const notifier = new VsCodeNotifier();

    // Create LLM provider
    const llmProvider = new VsCodeLLMProvider();

    // Initialize embedding service
    const embeddingService = new EmbeddingService({ config: configProvider, notifier });

    // Register VS Code LM embedding backend (proposed embeddings API)
    const vscodeLmBackend = new VscodeLmBackend();
    embeddingService.registerBackend(vscodeLmBackend);

    // Register HuggingFace backend as the default fallback
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, notifier);
    embeddingService.registerBackend(hfBackend);

    // Initialize TopicManager with VS Code storage path
    const storageDir = context.globalStorageUri.fsPath;
    const topicManager = await TopicManager.create({
      storageDir,
      config: configProvider,
      notifier,
      embeddingService,
    });

    // Start model initialization in the background — don't block activation
    embeddingService
      .initialize()
      .then(() => {
        logger.info("Embedding model initialized successfully");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Embedding model initialization deferred", { error: msg });
      });

    // Initialize GitHub token manager
    GitHubTokenManager.initialize(context);
    logger.info("GitHub token manager initialized");

    // Signal that the extension has started loading (viewsWelcome uses this)
    vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, false);

    // Register Topics tree view
    const treeDataProvider = new TopicTreeDataProvider(topicManager, embeddingService);
    const treeView = vscode.window.createTreeView(VIEWS.RAG_TOPICS, {
      treeDataProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(treeDataProvider);

    // Register Configuration tree view (separate panel, always shows settings)
    const configDataProvider = new ConfigTreeDataProvider(embeddingService);
    const configView = vscode.window.createTreeView(VIEWS.RAG_CONFIG, {
      treeDataProvider: configDataProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(configView);
    context.subscriptions.push(configDataProvider);

    // Register commands
    await CommandHandler.registerCommands(
      context,
      topicManager,
      embeddingService,
      treeDataProvider,
      configDataProvider,
    );

    // Load topics with error handling
    try {
      const topics = await topicManager.getAllTopics();
      logger.info(`Loaded ${topics.length} topics`);
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.HAS_TOPICS, topics.length > 0);
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, true);
    } catch (dbError) {
      logger.error("Failed to load topics", { error: dbError });
      const response = await vscode.window.showErrorMessage(
        "Failed to load RAG topics. Would you like to reset the database?",
        "Reset Database",
        "Cancel",
      );

      if (response === "Reset Database") {
        const topics = await topicManager.getAllTopics();
        for (const topic of topics) {
          await topicManager.deleteTopic(topic.id);
        }
        vscode.window.showInformationMessage("Database has been reset successfully.");
        logger.info("Database reset completed");
      }
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, true);
    }

    // Register RAG tool for Copilot/LLM agents
    try {
      if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
        logger.warn("Language Model API not available. Requires VS Code 1.90+ and GitHub Copilot Chat.");
        vscode.window
          .showWarningMessage(
            "RAG Tool requires VS Code 1.90+ and GitHub Copilot Chat extension to be visible.",
            "Learn More",
          )
          .then((selection) => {
            if (selection === "Learn More") {
              vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/docs/copilot/copilot-chat"));
            }
          });
      } else {
        RAGTool.register(context, topicManager, embeddingService, configProvider, llmProvider);
        logger.info("RAG query tool registered successfully");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to register RAG tool", { error: errorMessage });
      vscode.window.showWarningMessage(`RAG tool registration failed: ${errorMessage}`);
    }

    // Register configuration change listener for embedding model
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
      const localModelPathSetting = `${CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`;
      const treeViewConfigPaths = [
        `${CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
        `${CONFIG.ROOT}.${CONFIG.LLM_MODEL}`,
        `${CONFIG.ROOT}.${CONFIG.MAX_ITERATIONS}`,
        `${CONFIG.ROOT}.${CONFIG.CONFIDENCE_THRESHOLD}`,
      ];

      if (event.affectsConfiguration(localModelPathSetting)) {
        if (embeddingService.isProcessing) {
          vscode.window.showWarningMessage(
            "RAGnarōk: Cannot change embedding model while ingestion is in progress. Please wait for it to finish.",
          );
          return;
        }

        logger.info("Embedding local model path changed");

        try {
          const applyModel = async (): Promise<void> => {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `RAGnarōk: Updating embedding model...`,
              },
              async (progress) => {
                progress.report({ message: "Loading embedding model..." });
                await embeddingService.initialize();

                progress.report({ message: "Reinitializing services..." });
                await topicManager.reinitializeWithNewModel();
              },
            );

            const model = embeddingService.getCurrentModel();
            logger.info(`Embedding model ready: ${model}`);
            vscode.window.showInformationMessage(`RAGnarōk: Embedding model set to "${model}"`);
          };

          await applyModel();
          treeDataProvider.refresh();
          configDataProvider.refresh();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Failed to handle embedding model configuration change", {
            error: errorMessage,
          });
          vscode.window.showErrorMessage(`RAGnarōk: Failed to update embedding model: ${errorMessage}`);
        }
      }

      // Handle Embedding Backend or VS Code Model ID change
      const embeddingBackendSetting = `${CONFIG.ROOT}.${CONFIG.EMBEDDING_BACKEND}`;
      const embeddingVscodeModelSetting = `${CONFIG.ROOT}.${CONFIG.EMBEDDING_VSCODE_MODEL_ID}`;
      if (
        event.affectsConfiguration(embeddingBackendSetting) ||
        event.affectsConfiguration(embeddingVscodeModelSetting)
      ) {
        if (embeddingService.isProcessing) {
          vscode.window.showWarningMessage(
            "RAGnarōk: Cannot change embedding backend while ingestion is in progress. Please wait for it to finish.",
          );
          return;
        }

        logger.info("Embedding backend configuration changed");

        try {
          const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
          const requested = config.get<string>(CONFIG.EMBEDDING_BACKEND, "auto");
          const requestedModel = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");

          if (requested === "vscodeLM") {
            const probe = new VscodeLmBackend(requestedModel || undefined);
            const ok = await probe.isAvailable();
            if (!ok) {
              logger.warn('Requested VS Code LM backend unavailable; reverting embeddingBackend setting to "auto"');
              try {
                await vscode.workspace
                  .getConfiguration(CONFIG.ROOT)
                  .update(CONFIG.EMBEDDING_BACKEND, "auto", vscode.ConfigurationTarget.Workspace);
                vscode.window.showWarningMessage(
                  'Requested VS Code LM embedding backend is not available. Reverting to "auto".',
                );
              } catch (updateErr: any) {
                logger.error("Failed to update embeddingBackend setting to auto", {
                  error: updateErr?.message ?? updateErr,
                });
              }
            }
          }

          embeddingService.resetBackendSelection();

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `RAGnarōk: Switching embedding backend...`,
            },
            async (progress) => {
              progress.report({ message: "Resolving backend..." });
              await embeddingService.initialize();

              progress.report({ message: "Reinitializing services..." });
              await topicManager.reinitializeWithNewModel();
            },
          );

          const model = embeddingService.getCurrentModel();
          const backend = embeddingService.getActiveBackendType();
          logger.info(`Embedding backend switched: ${backend} (model: ${model})`);
          vscode.window.showInformationMessage(`RAGnarōk: Embedding backend set to "${backend}" (model: ${model})`);
          treeDataProvider.refresh();
          configDataProvider.refresh();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Failed to switch embedding backend", {
            error: errorMessage,
          });
          vscode.window.showErrorMessage(`RAGnarōk: Failed to switch embedding backend: ${errorMessage}`);
        }
      }

      // Handle Common Database Path change
      if (event.affectsConfiguration(`${CONFIG.ROOT}.${CONFIG.COMMON_DATABASE_PATH}`)) {
        logger.info("Common database path configuration changed");
        await topicManager.loadCommonDatabase();
        treeDataProvider.refresh();
        configDataProvider.refresh();
        vscode.window.showInformationMessage("Common database reloaded");
      }

      const affectsTreeViewConfig = treeViewConfigPaths.some((configPath) => event.affectsConfiguration(configPath));
      if (affectsTreeViewConfig) {
        logger.debug("Configuration affecting tree view changed, refreshing view");
        treeDataProvider.refresh();
        configDataProvider.refresh();
      }
    });
    context.subscriptions.push(configChangeDisposable);

    logger.info("Extension activation complete");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to activate extension", { error: errorMessage });
    throw error;
  }
}
