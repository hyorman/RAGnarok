/**
 * Main extension entry point
 * Refactored to use new LangChain-based architecture
 */

import * as vscode from "vscode";
import { TopicManager } from "./managers/topicManager";
import { EmbeddingService } from "./embeddings/embeddingService";
import { VscodeLmBackend } from "./embeddings/vscodeLmBackend";
import { RAGTool } from "./ragTool";
import { CommandHandler } from "./commands";
import { TopicTreeDataProvider, ConfigTreeDataProvider } from "./topicTreeView";
import { VIEWS, CONFIG, CONTEXT, COMMANDS } from "./utils/constants";
import { Logger } from "./utils/logger";
import { GitHubTokenManager } from "./utils/githubTokenManager";

const logger = new Logger("Extension");

export async function activate(context: vscode.ExtensionContext) {
  logger.info("RAGnarōk extension activating...");

  try {
    // Initialize TopicManager (singleton with automatic initialization)
    const topicManager = await TopicManager.getInstance(context);

    // Initialize embedding service instance (will load model on first use)
    const embeddingService = EmbeddingService.getInstance();

    // Start model initialization in the background — don't block activation
    embeddingService.initialize().then(() => {
      logger.info('Embedding model initialized successfully');
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Embedding model initialization deferred', { error: msg });
    });

    // Initialize GitHub token manager
    GitHubTokenManager.initialize(context);
    logger.info("GitHub token manager initialized");

    // Signal that the extension has started loading (viewsWelcome uses this)
    vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, false);

    // Register Topics tree view
    const treeDataProvider = new TopicTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEWS.RAG_TOPICS, {
      treeDataProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(treeDataProvider);

    // Register Configuration tree view (separate panel, always shows settings)
    const configDataProvider = new ConfigTreeDataProvider();
    const configView = vscode.window.createTreeView(VIEWS.RAG_CONFIG, {
      treeDataProvider: configDataProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(configView);
    context.subscriptions.push(configDataProvider);

    // Register commands
    await CommandHandler.registerCommands(context, treeDataProvider, configDataProvider);

    // Load topics with error handling
    try {
      const topics = await topicManager.getAllTopics();
      logger.info(`Loaded ${topics.length} topics`);
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.HAS_TOPICS, topics.length > 0);
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, true);
    } catch (dbError) {
      logger.error("Failed to load topics", { error: dbError });
      // If topics index is corrupted, offer to reset it
      const response = await vscode.window.showErrorMessage(
        "Failed to load RAG topics. Would you like to reset the database?",
        "Reset Database",
        "Cancel"
      );

      if (response === "Reset Database") {
        // Delete all topics to reset
        const topics = await topicManager.getAllTopics();
        for (const topic of topics) {
          await topicManager.deleteTopic(topic.id);
        }
        vscode.window.showInformationMessage(
          "Database has been reset successfully."
        );
        logger.info("Database reset completed");
      }
      // Mark as loaded even on error so welcome screen updates
      vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, true);
      // Don't throw - let the extension continue working
    }

    // Register RAG tool for Copilot/LLM agents
    try {
      // Check if Language Model API is available
      if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
        logger.warn(
          "Language Model API not available. Requires VS Code 1.90+ and GitHub Copilot Chat."
        );
        vscode.window
          .showWarningMessage(
            "RAG Tool requires VS Code 1.90+ and GitHub Copilot Chat extension to be visible.",
            "Learn More"
          )
          .then((selection) => {
            if (selection === "Learn More") {
              vscode.env.openExternal(
                vscode.Uri.parse(
                  "https://code.visualstudio.com/docs/copilot/copilot-chat"
                )
              );
            }
          });
      } else {
        const ragToolDisposable = RAGTool.register(context);
        logger.info("RAG query tool registered successfully");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to register RAG tool", { error: errorMessage });
      vscode.window.showWarningMessage(
        `RAG tool registration failed: ${errorMessage}`
      );
    }

    // Register configuration change listener for embedding model
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        const localModelPathSetting = `${CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`;
        const treeViewConfigPaths = [
          `${CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
          `${CONFIG.ROOT}.${CONFIG.LLM_MODEL}`,
          `${CONFIG.ROOT}.${CONFIG.MAX_ITERATIONS}`,
          `${CONFIG.ROOT}.${CONFIG.CONFIDENCE_THRESHOLD}`,
        ];

        if (
          event.affectsConfiguration(localModelPathSetting)
        ) {
          if (embeddingService.isProcessing) {
            vscode.window.showWarningMessage(
              "RAGnarōk: Cannot change embedding model while ingestion is in progress. Please wait for it to finish."
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
                }
              );

              const model = embeddingService.getCurrentModel();

              logger.info(`Embedding model ready: ${model}`);
              vscode.window.showInformationMessage(
                `RAGnarōk: Embedding model set to "${model}"`
              );
            };

            await applyModel();
            // Refresh both tree views so local models / current model are visible
            treeDataProvider.refresh();
            configDataProvider.refresh();
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error("Failed to handle embedding model configuration change", {
              error: errorMessage,
            });
            vscode.window.showErrorMessage(
              `RAGnarōk: Failed to update embedding model: ${errorMessage}`
            );
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
              "RAGnarōk: Cannot change embedding backend while ingestion is in progress. Please wait for it to finish."
            );
            return;
          }

          logger.info("Embedding backend configuration changed");

          try {
            // Before applying user-requested backend change, probe availability.
            const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
            const requested = config.get<string>(CONFIG.EMBEDDING_BACKEND, 'auto');
            const requestedModel = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, '');

            if (requested === 'vscodeLM') {
              // Probe VS Code LM availability for the requested model id.
              const probe = new VscodeLmBackend(requestedModel || undefined);
              const ok = await probe.isAvailable();
              if (!ok) {
                logger.warn('Requested VS Code LM backend unavailable; reverting embeddingBackend setting to "auto"');
                // Revert user setting back to 'auto' to avoid leaving the extension in a broken state.
                try {
                  await vscode.workspace.getConfiguration(CONFIG.ROOT).update(
                    CONFIG.EMBEDDING_BACKEND,
                    'auto',
                    vscode.ConfigurationTarget.Workspace
                  );
                  vscode.window.showWarningMessage('Requested VS Code LM embedding backend is not available. Reverting to "auto".');
                } catch (updateErr: any) {
                  logger.error('Failed to update embeddingBackend setting to auto', { error: updateErr?.message ?? updateErr });
                }
              }
            }

            // Reset backend so it re-resolves from updated config
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
              }
            );

            const model = embeddingService.getCurrentModel();
            const backend = embeddingService.getActiveBackendType();
            logger.info(`Embedding backend switched: ${backend} (model: ${model})`);
            vscode.window.showInformationMessage(
              `RAGnarōk: Embedding backend set to "${backend}" (model: ${model})`
            );
            treeDataProvider.refresh();
            configDataProvider.refresh();
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error("Failed to switch embedding backend", {
              error: errorMessage,
            });
            vscode.window.showErrorMessage(
              `RAGnarōk: Failed to switch embedding backend: ${errorMessage}`
            );
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

        const affectsTreeViewConfig = treeViewConfigPaths.some((configPath) =>
          event.affectsConfiguration(configPath)
        );
        if (affectsTreeViewConfig) {
          logger.debug(
            "Configuration affecting tree view changed, refreshing view"
          );
          treeDataProvider.refresh();
          configDataProvider.refresh();
        }
      }
    );
    context.subscriptions.push(configChangeDisposable);

    logger.info("Extension activation complete");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to activate extension", { error: errorMessage });
    throw error; // Re-throw to signal activation failure
  }
}

export async function deactivate() {
  logger.info("RAGnarōk extension deactivating...");

  try {
    // Dispose of TopicManager (includes all caches and dependencies)
    const topicManager = await TopicManager.getInstance();
    topicManager.dispose();

    // Dispose of EmbeddingService
    const embeddingService = EmbeddingService.getInstance();
    embeddingService.dispose();

    logger.info("Extension deactivation complete");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error during deactivation", { error: errorMessage });
    // Don't throw - deactivation should be best-effort
  }
}
