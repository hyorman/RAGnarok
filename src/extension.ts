/**
 * Main extension entry point
 * Refactored to use new LangChain-based architecture
 */

import * as vscode from "vscode";
import { TopicManager } from "./managers/topicManager";
import { EmbeddingService } from "./embeddings/embeddingService";
import { RAGTool } from "./ragTool";
import { CommandHandler } from "./commands";
import { TopicTreeDataProvider } from "./topicTreeView";
import { VIEWS, STATE, COMMANDS, CONFIG } from "./utils/constants";
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

    // Initialize GitHub token manager
    GitHubTokenManager.initialize(context);
    logger.info("GitHub token manager initialized");

    // Register tree view
    const treeDataProvider = new TopicTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEWS.RAG_TOPICS, {
      treeDataProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Register commands
    await CommandHandler.registerCommands(context, treeDataProvider);

    // Load topics with error handling
    try {
      const topics = await topicManager.getAllTopics();
      logger.info(`Loaded ${topics.length} topics`);
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

    // Show welcome message on first activation
    const hasShownWelcome = context.globalState.get(
      STATE.HAS_SHOWN_WELCOME,
      false
    );
    if (!hasShownWelcome) {
      const response = await vscode.window.showInformationMessage(
        "Welcome to RAGnarōk! Create topics and add documents to enable RAG queries.",
        "Create Topic",
        "Learn More"
      );

      if (response === "Create Topic") {
        vscode.commands.executeCommand(COMMANDS.CREATE_TOPIC);
      } else if (response === "Learn More") {
        vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/hyorman/ragnarok")
        );
      }

      await context.globalState.update(STATE.HAS_SHOWN_WELCOME, true);
    }

    // Register configuration change listener for embedding model
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        const localModelPathSetting = `${CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`;
        const treeViewConfigPaths = [
          `${CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
          `${CONFIG.ROOT}.${CONFIG.USE_AGENTIC_MODE}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_USE_LLM}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_MAX_ITERATIONS}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_CONFIDENCE_THRESHOLD}`,
          `${CONFIG.ROOT}.${CONFIG.AGENTIC_ITERATIVE_REFINEMENT}`,
        ];

        if (
          event.affectsConfiguration(localModelPathSetting)
        ) {
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
            // Refresh the tree view so local models / current model are visible
            treeDataProvider.refresh();
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

        // Handle Common Database Path change
        if (event.affectsConfiguration(`${CONFIG.ROOT}.${CONFIG.COMMON_DATABASE_PATH}`)) {
          logger.info("Common database path configuration changed");
          await topicManager.loadCommonDatabase();
          treeDataProvider.refresh();
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
