/**
 * Command handlers for the RAG extension
 * Refactored to use new LangChain-based architecture with TopicManager
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import { TopicManager } from "./managers/topicManager";
import { EmbeddingService } from "./embeddings/embeddingService";
import { TopicTreeDataProvider } from "./topicTreeView";
import { COMMANDS, CONFIG, TREE_CONFIG_KEY } from "./utils/constants";
import { Logger } from "./utils/logger";
import { GitHubTokenManager } from "./utils/githubTokenManager";
import { Topic } from "./utils/types";

const logger = new Logger("CommandHandler");

export class CommandHandler {
  private topicManager: TopicManager;
  private embeddingService: EmbeddingService;
  private treeDataProvider: TopicTreeDataProvider;
  private context: vscode.ExtensionContext;
  private tokenManager: GitHubTokenManager;

  private constructor(
    context: vscode.ExtensionContext,
    topicManager: TopicManager,
    treeDataProvider: TopicTreeDataProvider
  ) {
    this.context = context;
    this.topicManager = topicManager;
    this.embeddingService = EmbeddingService.getInstance();
    this.treeDataProvider = treeDataProvider;
    this.tokenManager = GitHubTokenManager.getInstance();
  }

  /**
   * Register all commands
   */
  public static async registerCommands(
    context: vscode.ExtensionContext,
    treeDataProvider: TopicTreeDataProvider
  ): Promise<void> {
    const topicManager = await TopicManager.getInstance();
    const handler = new CommandHandler(context, topicManager, treeDataProvider);

    context.subscriptions.push(
      vscode.commands.registerCommand(COMMANDS.CREATE_TOPIC, () =>
        handler.createTopic()
      ),
      vscode.commands.registerCommand(COMMANDS.DELETE_TOPIC, (item?: any) =>
        handler.deleteTopic(item)
      ),
      vscode.commands.registerCommand(COMMANDS.ADD_DOCUMENT, (item?: any) =>
        handler.addDocument(item)
      ),
      vscode.commands.registerCommand(COMMANDS.ADD_GITHUB_REPO, (item?: any) =>
        handler.addGithubRepo(item)
      ),
      vscode.commands.registerCommand(COMMANDS.REFRESH_TOPICS, () =>
        handler.refreshTopics()
      ),
      vscode.commands.registerCommand(COMMANDS.CLEAR_MODEL_CACHE, () =>
        handler.clearModelCache()
      ),
      vscode.commands.registerCommand(COMMANDS.SET_EMBEDDING_MODEL, (model) =>
        handler.setEmbeddingModel(model)
      ),
      vscode.commands.registerCommand(COMMANDS.CLEAR_DATABASE, () =>
        handler.clearDatabase()
      ),
      // Embedding model selection
      vscode.commands.registerCommand(COMMANDS.SELECT_VSCODE_EMBEDDING_MODEL, () =>
        handler.selectVscodeEmbeddingModel()
      ),
      vscode.commands.registerCommand(COMMANDS.SELECT_HF_EMBEDDING_MODEL, () =>
        handler.selectHfEmbeddingModel()
      ),
      vscode.commands.registerCommand(COMMANDS.SELECT_LLM_MODEL, () =>
        handler.selectLLMModel()
      ),
      vscode.commands.registerCommand(COMMANDS.EDIT_CONFIG_ITEM, (configKey: string) =>
        handler.editConfigItem(configKey)
      ),
      // GitHub token management commands
      vscode.commands.registerCommand(COMMANDS.ADD_GITHUB_TOKEN, () =>
        handler.addGithubToken()
      ),
      vscode.commands.registerCommand(COMMANDS.LIST_GITHUB_TOKENS, () =>
        handler.listGithubTokens()
      ),
      vscode.commands.registerCommand(COMMANDS.REMOVE_GITHUB_TOKEN, () =>
        handler.removeGithubToken()
      ),
      // Import/Export commands
      vscode.commands.registerCommand(COMMANDS.EXPORT_TOPIC, (item?: any) =>
        handler.exportTopic(item)
      ),
      vscode.commands.registerCommand(COMMANDS.IMPORT_TOPIC, () =>
        handler.importTopic()
      ),
      vscode.commands.registerCommand(COMMANDS.RENAME_TOPIC, (item?: any) =>
        handler.renameTopic(item)
      )
    );
  }

  /**
   * Set embedding model in workspace configuration and initialize
   */
  public async setEmbeddingModel(model: string): Promise<void> {
    try {
      // Initialize the embedding model now
      await this.embeddingService.initialize(model);

      // Reinitialize topic manager vector stores
      await this.topicManager.reinitializeWithNewModel();

      vscode.window.showInformationMessage(`Embedding model set to "${model}"`);
      this.treeDataProvider.refresh();
    } catch (err) {
      logger.error('Failed to set embedding model', err);
      vscode.window.showErrorMessage(`Failed to set embedding model: ${err}`);
    }
  }

  /**
   * Rename a topic
   */
  private async renameTopic(item?: any): Promise<void> {
    try {
      let topicToRename;

      // If called from tree view with item
      if (item && item.topic) {
        topicToRename = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          vscode.window.showInformationMessage("No topics available to rename.");
          return;
        }

        const selected = await vscode.window.showQuickPick(
          topics.map((t: any) => ({
            label: t.name,
            description: `${t.documentCount} document(s)`,
            detail: t.description,
            topic: t,
          })),
          {
            placeHolder: "Select a topic to rename",
          }
        );

        if (!selected) {
          return;
        }

        topicToRename = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(topicToRename.id)) {
        vscode.window.showWarningMessage(
          `Cannot rename "${topicToRename.name}" - topics from common database are read-only.`
        );
        return;
      }

      const newName = await vscode.window.showInputBox({
        prompt: "Enter new topic name",
        value: topicToRename.name,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "Topic name cannot be empty";
          }
          if (value.trim().toLowerCase() === topicToRename.name.toLowerCase()) {
            return "New name matches existing name";
          }
          return null;
        },
      });

      if (!newName) {
        return;
      }

      logger.info(`Renaming topic: ${topicToRename.name} to ${newName}`);
      await this.topicManager.updateTopic(topicToRename.id, {
        name: newName.trim(),
      });

      vscode.window.showInformationMessage(
        `Topic renamed to "${newName.trim()}" successfully!`
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      logger.error(`Failed to rename topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to rename topic: ${error}`);
    }
  }

  /**
   * Create a new topic
   */
  private async createTopic(): Promise<void> {
    try {
      const name = await vscode.window.showInputBox({
        prompt: "Enter topic name",
        placeHolder: "e.g., React Documentation, Company Policies",
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "Topic name cannot be empty";
          }
          return null;
        },
      });

      if (!name) {
        return;
      }

      const description = await vscode.window.showInputBox({
        prompt: "Enter topic description (optional)",
        placeHolder: "Brief description of this topic",
      });

      logger.info(`Creating topic: ${name}`);
      const topic = await this.topicManager.createTopic({
        name: name.trim(),
        description: description?.trim(),
      });

      vscode.window.showInformationMessage(
        `Topic "${topic.name}" created successfully!`
      );
      this.treeDataProvider.refresh();
      logger.info(`Topic created: ${topic.id}`);
    } catch (error) {
      logger.error(`Failed to create topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to create topic: ${error}`);
    }
  }

  /**
   * Delete a topic
   */
  private async deleteTopic(item?: any): Promise<void> {
    try {
      let topicToDelete;

      // If called from tree view with item
      if (item && item.topic) {
        topicToDelete = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          vscode.window.showInformationMessage(
            "No topics available to delete."
          );
          return;
        }

        const selected = await vscode.window.showQuickPick(
          topics.map((t: any) => ({
            label: t.name,
            description: `${t.documentCount} document(s)`,
            detail: t.description,
            topic: t,
          })),
          {
            placeHolder: "Select a topic to delete",
          }
        );

        if (!selected) {
          return;
        }

        topicToDelete = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(topicToDelete.id)) {
        vscode.window.showWarningMessage(
          `Cannot delete "${topicToDelete.name}" - topics from common database are read-only.`
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to delete topic "${topicToDelete.name}"? This will also delete all associated documents and embeddings.`,
        { modal: true },
        "Delete"
      );

      if (confirmation === "Delete") {
        logger.info(
          `Deleting topic: ${topicToDelete.name} (${topicToDelete.id})`
        );
        await this.topicManager.deleteTopic(topicToDelete.id);
        vscode.window.showInformationMessage(
          `Topic "${topicToDelete.name}" deleted.`
        );
        this.treeDataProvider.refresh();
        logger.info(`Topic deleted successfully`);
      }
    } catch (error) {
      logger.error(`Failed to delete topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to delete topic: ${error}`);
    }
  }

  /**
   * Add a document to a topic
   */
  private async addDocument(item?: any): Promise<void> {
    try {
      let selectedTopic: any;

      // If called from tree view with item
      if (item && item.topic) {
        selectedTopic = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          const create = await vscode.window.showInformationMessage(
            "No topics available. Would you like to create one?",
            "Create Topic"
          );

          if (create === "Create Topic") {
            await this.createTopic();
            return this.addDocument(); // Retry after creating topic
          }
          return;
        }

        const selected = await vscode.window.showQuickPick(
          topics.map((t: any) => ({
            label: t.name,
            description: `${t.documentCount} document(s)`,
            topic: t,
          })),
          {
            placeHolder: "Select a topic",
          }
        );

        if (!selected) {
          return;
        }

        selectedTopic = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(selectedTopic.id)) {
        vscode.window.showWarningMessage(
          `Cannot add documents to "${selectedTopic.name}" - topics from common database are read-only.`
        );
        return;
      }
      
      // Ask whether the user wants to select files or folders.
      // Some platforms/OS dialogs don't handle mixed file+folder mode well,
      // so present a choice and open the dialog in the selected mode.
      const selectionMode = await vscode.window.showQuickPick(
        [
          { label: "Files", description: "Select one or more files", value: "files" },
          { label: "Folders", description: "Select one or more folders", value: "folders" },
        ],
        { placeHolder: "Add documents: choose Files or Folders" }
      );

      if (!selectionMode) {
        return; // user cancelled
      }

      let fileUris: readonly vscode.Uri[] | undefined;

      if (selectionMode.value === "files") {
        // File selection mode: include filters so users can narrow to document types
        fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          filters: {
            "All Files": ["*"],
            "Supported Documents": [
              "pdf",
              "md",
              "markdown",
              "html",
              "htm",
              "txt",
            ],
            PDF: ["pdf"],
            Markdown: ["md", "markdown"],
            HTML: ["html", "htm"],
            Text: ["txt"],
          },
          openLabel: "Add Document(s)",
        });
      } else {
        // Folder selection mode: filters are ignored for folders, so omit them
        fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: "Add Folder(s)",
        });
      }

      if (!fileUris || fileUris.length === 0) {
        return;
      }

      const filePaths = fileUris.map((uri) => uri.fsPath);
      
      // Check if any selected paths are directories
      let hasDirectories = false;
      for (const filePath of filePaths) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.isDirectory()) {
            hasDirectories = true;
            break;
          }
        } catch (error) {
          // Ignore error, treat as file
        }
      }

      // Ask user about recursive loading if folders are selected
      let recursiveDirectory = false;
      if (hasDirectories) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: "Load recursively", description: "Include all files from subfolders", value: true },
            { label: "Load only from selected folders", description: "Don't scan subfolders", value: false },
          ],
          {
            placeHolder: "One or more folders selected. How would you like to load them?",
          }
        );

        if (!choice) {
          return; // User cancelled
        }

        recursiveDirectory = choice.value;
      }

      logger.info(
        `Adding ${filePaths.length} document(s) to topic: ${selectedTopic.name}`,
        { recursiveDirectory }
      );

      // Process documents using TopicManager
      await vscode.window.withProgress(
          {
          location: vscode.ProgressLocation.Notification,
          title: `Processing documents...`,
          cancellable: false,
        },
        async (progress) => {
          const results = await this.topicManager.addDocuments(
            selectedTopic.id,
            filePaths,
            {
              onProgress: (pipelineProgress) => {
                progress.report({
                  message: pipelineProgress.message,
                  increment: pipelineProgress.progress / 100,
                });
              },
              loaderOptions: {
                recursiveDirectory,
              },
            }
          );

          progress.report({ message: "Complete!" });

          const totalChunks = results.reduce(
            (sum, r) => sum + r.pipelineResult.metadata.chunksStored,
            0
          );
          const actualFileCount = results.reduce(
            (sum, r) => sum + r.pipelineResult.metadata.originalDocuments,
            0
          );
          logger.info(
            `Documents added: ${actualFileCount} files, ${totalChunks} chunks`
          );
        }
      );

      const stats = await this.topicManager.getTopicStats(selectedTopic.id);
      const actualFileCount = stats?.documentCount || 0;
      vscode.window.showInformationMessage(
        `Documents added to "${selectedTopic.name}" successfully! Total: ${actualFileCount} documents, ${stats?.chunkCount} chunks.`
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      logger.error(`Failed to add document: ${error}`);
      vscode.window.showErrorMessage(`Failed to add document: ${error}`);
    }
  }

  /**
   * Add a GitHub repository to a topic
   */
  private async addGithubRepo(item?: any): Promise<void> {
    try {
      let selectedTopic: any;

      // If called from tree view with item
      if (item && item.topic) {
        selectedTopic = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          const create = await vscode.window.showInformationMessage(
            "No topics available. Would you like to create one?",
            "Create Topic"
          );

          if (create === "Create Topic") {
            await this.createTopic();
            return this.addGithubRepo(); // Retry after creating topic
          }
          return;
        }

        const selected = await vscode.window.showQuickPick(
          topics.map((t: any) => ({
            label: t.name,
            description: `${t.documentCount} document(s)`,
            topic: t,
          })),
          {
            placeHolder: "Select a topic",
          }
        );

        if (!selected) {
          return;
        }

        selectedTopic = selected.topic;
      }

      // Check for saved GitHub hosts
      const savedHosts = await this.tokenManager.listHosts(this.context);
      let selectedHost: string | undefined;
      let accessToken: string | undefined;

      // If there are saved hosts, offer to use them
      if (savedHosts.length > 0) {
        const hostOptions = [
          ...savedHosts.map((host) => ({
            label: host,
            description: "✅ Saved token available",
            value: host,
          })),
          {
            label: "$(add) Enter custom URL",
            description: "Use a different GitHub server",
            value: "custom",
          },
        ];

        const hostChoice = await vscode.window.showQuickPick(hostOptions, {
          placeHolder: "Select GitHub host or enter custom URL",
        });

        if (!hostChoice) {
          return;
        }

        if (hostChoice.value !== "custom") {
          selectedHost = hostChoice.value;
          accessToken = await this.tokenManager.getToken(selectedHost);
          logger.info(`Using saved token for host: ${selectedHost}`);
        }
      }

      // Get repository path (owner/repo)
      let repoUrl: string;

      if (selectedHost) {
        // Simplified: just ask for owner/repo
        const repoPath = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `Enter repository (owner/repo) for ${selectedHost}`,
          placeHolder: "facebook/react",
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return "Repository path cannot be empty";
            }
            if (!/^[\w-]+\/[\w.-]+$/.test(value.trim())) {
              return "Invalid format. Use: owner/repo";
            }
            return null;
          },
        });

        if (!repoPath) {
          return;
        }

        repoUrl = `https://${selectedHost}/${repoPath.trim()}`;
      } else {
        // Full URL entry for custom hosts
        repoUrl =
          (await vscode.window.showInputBox({
            ignoreFocusOut: true,
            prompt: "Enter full GitHub repository URL",
            placeHolder: "https://github.com/owner/repo",
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return "Repository URL cannot be empty";
              }
              if (
                !/^https?:\/\/[a-zA-Z0-9.-]+\/[\w-]+\/[\w.-]+/.test(
                  value.trim()
                )
              ) {
                return "Invalid GitHub URL. Format: https://host/owner/repo";
              }
              return null;
            },
          })) || "";

        if (!repoUrl) {
          return;
        }

        // Extract host and check for token
        const host = this.tokenManager.extractHost(repoUrl);
        if (host) {
          accessToken = await this.tokenManager.getToken(host);
          if (accessToken) {
            logger.info(`Found saved token for host: ${host}`);
          } else {
            // Prompt for token if not found
            const needToken = await vscode.window.showQuickPick(
              [
                {
                  label: "Enter Token",
                  description: "For private repositories",
                  value: true,
                },
                {
                  label: "Continue Without Token",
                  description: "Public repositories only",
                  value: false,
                },
              ],
              {
                placeHolder: `No saved token for ${host}`,
              }
            );

            if (needToken?.value) {
              const tokenInput = await vscode.window.showInputBox({
                prompt: "Enter GitHub access token",
                placeHolder: "ghp_xxxxxxxxxxxxxxxxxxxx",
                password: true,
                ignoreFocusOut: true,
              });

              if (tokenInput && tokenInput.trim().length > 0) {
                accessToken = tokenInput.trim();
                await this.tokenManager.promptToSaveToken(
                  this.context,
                  host,
                  accessToken
                );
              }
            }
          }
        }
      }

      // Get branch
      const branch = await vscode.window.showInputBox({
        prompt: "Enter branch name",
        placeHolder: "main",
        value: "main",
        ignoreFocusOut: true,
      });

      if (!branch) {
        return;
      }

      // Optional: ignore patterns
      const defaultIgnore = "*.github*, *makefile*, **/TEST/**, **/tst/**, *.test.*, node_modules/**";
      const ignoreInput = await vscode.window.showInputBox({
        prompt: "Enter ignore patterns (optional, comma-separated)",
        placeHolder: `${defaultIgnore} (press Enter to accept default)`,
        value: defaultIgnore,
        ignoreFocusOut: true,
      });

      const ignorePaths =
        ignoreInput && ignoreInput.trim().length > 0
          ? ignoreInput
              .split(",")
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
          : undefined;

      logger.info(`Adding GitHub repository to topic: ${selectedTopic.name}`, {
        repoUrl,
        branch,
        ignorePaths,
      });

      // Process repository using TopicManager
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Processing GitHub repository...`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({
            message: "Fetching repository structure (this may take a while)...",
            increment: 10,
          });

          const results = await this.topicManager.addDocuments(
            selectedTopic.id,
            [repoUrl],
            {
              onProgress: (pipelineProgress) => {
                progress.report({
                  message: pipelineProgress.message,
                  increment: (pipelineProgress.progress / 100) * 90,
                });
              },
              loaderOptions: {
                fileType: "github",
                branch,
                recursive: true,
                ignorePaths,
                accessToken,
                maxConcurrency: 10, // Increase concurrency for faster loading
              },
            }
          );

          progress.report({ message: "Complete!", increment: 100 });

          const totalChunks = results.reduce(
            (sum, r) => sum + r.pipelineResult.metadata.chunksStored,
            0
          );
          logger.info(`GitHub repository added: ${totalChunks} chunks`);
        }
      );

      const stats = await this.topicManager.getTopicStats(selectedTopic.id);
      vscode.window.showInformationMessage(
        `GitHub repository added to "${selectedTopic.name}" successfully! Total: ${stats?.documentCount} documents, ${stats?.chunkCount} chunks.`
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      logger.error(`Failed to add GitHub repository: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      vscode.window.showErrorMessage(
        `Failed to add GitHub repository:\n\n${errorMessage}${errorStack ? '\n\nStack:\n' + errorStack : ''}`,
        "OK"
      );
    }
  }

  /**
   * Refresh topics view
   */
  private refreshTopics(): void {
    this.treeDataProvider.refresh();
    vscode.window.showInformationMessage("Topics refreshed.");
  }

  /**
   * Clear model cache
   */
  private async clearModelCache(): Promise<void> {
    try {
      await this.embeddingService.clearCache();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to clear cache: ${error}`);
    }
  }

  /**
   * Clear database
   */
  private async clearDatabase(): Promise<void> {
    try {
      const confirmation = await vscode.window.showWarningMessage(
        "Are you sure you want to clear the entire database? This will delete all topics, documents, and embeddings. This action cannot be undone.",
        { modal: true },
        "Clear Database"
      );

      if (confirmation === "Clear Database") {
        logger.warn("Clearing entire database");

        // Delete all topics (this will also clear their vector stores)
        const topics = await this.topicManager.getAllTopics();
        for (const topic of topics) {
          await this.topicManager.deleteTopic(topic.id);
        }

        // Clear embedding service cache
        await this.embeddingService.clearCache();

        vscode.window.showInformationMessage("Database cleared successfully.");
        this.treeDataProvider.refresh();
        logger.info("Database cleared");
      }
    } catch (error) {
      logger.error(`Failed to clear database: ${error}`);
      vscode.window.showErrorMessage(`Failed to clear database: ${error}`);
    }
  }

  /**
   * Add GitHub token for a specific host
   */
  private async addGithubToken(): Promise<void> {
    try {
      // Ask for host
      const host = await vscode.window.showInputBox({
        prompt: "Enter GitHub host",
        placeHolder: "e.g., github.com, github.company.com",
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "Host cannot be empty";
          }
          // Basic validation for host format
          if (!/^[a-zA-Z0-9.-]+$/.test(value.trim())) {
            return "Invalid host format";
          }
          return null;
        },
      });

      if (!host) {
        return;
      }

      // Check if token already exists
      const hasToken = await this.tokenManager.hasToken(host.trim());
      if (hasToken) {
        const overwrite = await vscode.window.showWarningMessage(
          `A token already exists for "${host.trim()}". Do you want to overwrite it?`,
          "Overwrite",
          "Cancel"
        );

        if (overwrite !== "Overwrite") {
          return;
        }
      }

      // Ask for token
      const token = await vscode.window.showInputBox({
        prompt: `Enter GitHub access token for ${host.trim()}`,
        placeHolder: "ghp_xxxxxxxxxxxxxxxxxxxx",
        password: true,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "Token cannot be empty";
          }
          return null;
        },
      });

      if (!token) {
        return;
      }

      // Save token
      await this.tokenManager.setToken(host.trim(), token.trim());
      await this.tokenManager.addHostToList(this.context, host.trim());

      vscode.window.showInformationMessage(
        `GitHub token saved for host "${host.trim()}"`
      );
      logger.info(`GitHub token added for host: ${host.trim()}`);
    } catch (error) {
      logger.error(`Failed to add GitHub token: ${error}`);
      vscode.window.showErrorMessage(`Failed to add GitHub token: ${error}`);
    }
  }

  /**
   * List all saved GitHub tokens (hosts only, not the actual tokens)
   */
  private async listGithubTokens(): Promise<void> {
    try {
      const hosts = await this.tokenManager.listHosts(this.context);

      if (hosts.length === 0) {
        vscode.window.showInformationMessage(
          'No GitHub tokens saved. Use "RAG: Add GitHub Token" to add one.'
        );
        return;
      }

      const items = hosts.map((host) => ({
        label: host,
        description: "GitHub host with saved token",
      }));

      await vscode.window.showQuickPick(items, {
        placeHolder: "Saved GitHub Tokens",
      });
    } catch (error) {
      logger.error(`Failed to list GitHub tokens: ${error}`);
      vscode.window.showErrorMessage(`Failed to list GitHub tokens: ${error}`);
    }
  }

  /**
   * Remove a saved GitHub token
   */
  private async removeGithubToken(): Promise<void> {
    try {
      const hosts = await this.tokenManager.listHosts(this.context);

      if (hosts.length === 0) {
        vscode.window.showInformationMessage("No GitHub tokens to remove.");
        return;
      }

      const selected = await vscode.window.showQuickPick(
        hosts.map((host) => ({
          label: host,
          description: "GitHub host",
        })),
        {
          placeHolder: "Select a host to remove its token",
        }
      );

      if (!selected) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to remove the GitHub token for "${selected.label}"?`,
        "Remove",
        "Cancel"
      );

      if (confirmation === "Remove") {
        await this.tokenManager.deleteToken(selected.label);
        await this.tokenManager.removeHostFromList(
          this.context,
          selected.label
        );

        vscode.window.showInformationMessage(
          `GitHub token removed for "${selected.label}"`
        );
        logger.info(`GitHub token removed for host: ${selected.label}`);
      }
    } catch (error) {
      logger.error(`Failed to remove GitHub token: ${error}`);
      vscode.window.showErrorMessage(`Failed to remove GitHub token: ${error}`);
    }
  }

  /**
   * Export a topic to a .rag file
   */
  private async exportTopic(item?: any): Promise<void> {
    try {
      let topicToExport;

      // If called from tree view with item
      if (item && item.topic) {
        topicToExport = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = this.topicManager.getAllTopics().filter(
          (t) => t.source !== 'common'  // Only show local topics for export
        );

        if (topics.length === 0) {
          vscode.window.showInformationMessage(
            "No local topics available to export."
          );
          return;
        }

        const selected = await vscode.window.showQuickPick(
          topics.map((t) => ({
            label: t.name,
            description: `${t.documentCount} document(s)`,
            detail: t.description,
            topic: t,
          })),
          {
            placeHolder: "Select a topic to export",
          }
        );

        if (!selected) {
          return;
        }

        topicToExport = selected.topic;
      }

      // Check if topic is from common database
      if (this.topicManager.isCommonTopic(topicToExport.id)) {
        vscode.window.showWarningMessage(
          `Cannot export "${topicToExport.name}" - topics from common database cannot be exported.`
        );
        return;
      }

      // Show save dialog
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${topicToExport.name.replace(/[^a-zA-Z0-9]/g, '_')}.rag`),
        filters: {
          "RAG Topic Archive": ["rag"],
        },
        saveLabel: "Export Topic",
      });

      if (!saveUri) {
        return;
      }

      logger.info(`Exporting topic: ${topicToExport.name} to ${saveUri.fsPath}`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Exporting "${topicToExport.name}"...`,
          cancellable: false,
        },
        async () => {
          await this.topicManager.exportTopic(topicToExport.id, saveUri.fsPath);
        }
      );

      vscode.window.showInformationMessage(
        `Topic "${topicToExport.name}" exported successfully!`
      );
      logger.info(`Topic exported: ${topicToExport.id}`);
    } catch (error) {
      logger.error(`Failed to export topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to export topic: ${error}`);
    }
  }

  /**
   * Import a topic from a .rag file
   */
  private async importTopic(): Promise<void> {
    try {
      // Show open dialog
      const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "RAG Topic Archive": ["rag"],
        },
        openLabel: "Import Topic",
      });

      if (!fileUris || fileUris.length === 0) {
        return;
      }

      const archivePath = fileUris[0].fsPath;
      logger.info(`Importing topic from: ${archivePath}`);

      let importedTopic: Topic | undefined;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Importing topic...",
          cancellable: false,
        },
        async () => {
          importedTopic = await this.topicManager.importTopic(archivePath);
        }
      );

      if (importedTopic) {
        vscode.window.showInformationMessage(
          `Topic "${importedTopic.name}" imported successfully!`
        );
        this.treeDataProvider.refresh();
        logger.info(`Topic imported: ${importedTopic.id}`);
      }
    } catch (error) {
      logger.error(`Failed to import topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to import topic: ${error}`);
    }
  }

  /**
   * List available VS Code LM embedding models and let the user pick one.
   * Reads `vscode.lm.embeddingModels` at runtime and presents a QuickPick.
   */
  private async selectVscodeEmbeddingModel(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = vscode.lm as any;

      if (!lm || typeof lm.computeEmbeddings !== 'function') {
        vscode.window.showWarningMessage(
          'VS Code LM Embeddings API is not available. ' +
          'Make sure you are running VS Code Insiders with the proposed API enabled and a provider (e.g. GitHub Copilot) installed.'
        );
        return;
      }

      const models: string[] | undefined = lm.embeddingModels;

      if (!models || models.length === 0) {
        vscode.window.showWarningMessage(
          'No embedding models are currently registered. ' +
          'Install a provider extension (e.g. GitHub Copilot) that registers embedding models.'
        );
        return;
      }

      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const currentModelId = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, '');

      const items: vscode.QuickPickItem[] = [
        {
          label: '$(sparkle) Auto (first available)',
          description: 'Clear the model ID setting — auto-select at runtime',
          detail: currentModelId === '' ? '$(check) Currently active' : undefined,
        },
        ...models.map((id: string) => ({
          label: id,
          description: id === currentModelId ? '$(check) Currently selected' : undefined,
        })),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a VS Code LM embedding model',
        title: 'Available VS Code LM Embedding Models',
      });

      if (!picked) {
        return; // cancelled
      }

      const newModelId = picked.label.startsWith('$(sparkle)') ? '' : picked.label;

      await config.update(
        CONFIG.EMBEDDING_VSCODE_MODEL_ID,
        newModelId || undefined, // undefined removes the key (resets to default)
        vscode.ConfigurationTarget.Workspace
      );

      const displayName = newModelId || 'Auto (first available)';
      vscode.window.showInformationMessage(
        `VS Code embedding model set to: ${displayName}`
      );
      logger.info(`VS Code embedding model set to: ${displayName}`);
    } catch (error) {
      logger.error(`Failed to select VS Code embedding model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select VS Code embedding model: ${error}`);
    }
  }

  /**
   * List available HuggingFace embedding models and let the user pick one,
   * or enter a custom HuggingFace Hub model ID.
   *
   * Shows curated models (with download status), locally discovered models,
   * and a free-text input option for any Transformers.js-compatible model.
   */
  private async selectHfEmbeddingModel(): Promise<void> {
    try {
      const models = await this.embeddingService.listAvailableModels();
      const currentModel = this.embeddingService.getCurrentModel();

      // Build QuickPick items
      const items: vscode.QuickPickItem[] = [];

      // Group: downloaded / local models first
      const downloaded = models.filter(m => m.downloaded);
      const notDownloaded = models.filter(m => !m.downloaded);

      if (downloaded.length > 0) {
        items.push({ label: 'Downloaded / Local', kind: vscode.QuickPickItemKind.Separator });
        for (const m of downloaded) {
          items.push({
            label: m.name,
            description: m.name === currentModel ? '$(check) Active' : `(${m.source})`,
            detail: 'Ready to use — no download needed',
          });
        }
      }

      if (notDownloaded.length > 0) {
        items.push({ label: 'Available for Download', kind: vscode.QuickPickItemKind.Separator });
        for (const m of notDownloaded) {
          const isXenova = m.name.startsWith('Xenova/');
          const detail = isXenova
            ? 'Pre-converted ONNX — reliable, will download on first use'
            : m.name.startsWith('sentence-transformers/')
              ? 'May auto-convert via Transformers.js v3 — download on first use'
              : 'Will be downloaded on first use';
          items.push({
            label: m.name,
            description: m.name === currentModel ? '$(check) Active' : `(${m.source})`,
            detail,
          });
        }
      }

      // Custom option
      items.push({ label: 'Custom', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: '$(pencil) Enter custom model ID…',
        description: 'any HuggingFace Hub model with ONNX support',
        detail: 'Model must have ONNX files (onnx/model.onnx) — Xenova/ namespace recommended',
        alwaysShow: true,
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: currentModel ? `Current: ${currentModel}` : 'Select a HuggingFace embedding model',
        title: 'HuggingFace Embedding Models',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!picked) {
        return; // cancelled
      }

      let selectedModel: string;

      if (picked.label.startsWith('$(pencil)')) {
        // Free-text input for custom model ID
        const customId = await vscode.window.showInputBox({
          prompt: 'Enter a HuggingFace Hub model ID (e.g. Xenova/all-MiniLM-L6-v2)',
          placeHolder: 'namespace/model-name',
          validateInput: (value) => {
            if (!value || !value.trim()) {
              return 'Model ID cannot be empty';
            }
            if (!value.includes('/')) {
              return 'Model ID should include namespace (e.g. Xenova/model-name)';
            }
            return null;
          },
        });
        if (!customId) {
          return; // cancelled
        }
        selectedModel = customId.trim();
      } else {
        selectedModel = picked.label;
      }

      if (selectedModel === currentModel) {
        vscode.window.showInformationMessage(`"${selectedModel}" is already the active model.`);
        return;
      }

      // Use the existing setEmbeddingModel command which handles initialization + re-indexing warnings
      await this.setEmbeddingModel(selectedModel);
    } catch (error) {
      logger.error(`Failed to select HuggingFace embedding model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select HuggingFace embedding model: ${error}`);
    }
  }

  /**
   * Discover available Copilot LLM models at runtime and let the user pick one.
   * Reads from `vscode.lm.selectChatModels` and writes the chosen family to settings.
   */
  private async selectLLMModel(): Promise<void> {
    try {
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        vscode.window.showWarningMessage(
          'VS Code Language Model API is not available. Make sure you have GitHub Copilot installed and VS Code 1.90+.'
        );
        return;
      }

      // Discover all available chat models
      const allModels = await vscode.lm.selectChatModels({});
      if (!allModels || allModels.length === 0) {
        vscode.window.showWarningMessage(
          'No LLM models are currently available. Ensure GitHub Copilot is signed in and active.'
        );
        return;
      }

      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const currentFamily = config.get<string>(CONFIG.AGENTIC_LLM_MODEL, 'gpt-4o-mini');

      // De-duplicate by family name and build quick pick items
      const familyMap = new Map<string, { vendor: string; maxTokens: number; count: number }>();
      for (const m of allModels) {
        const existing = familyMap.get(m.family);
        if (!existing || m.maxInputTokens > existing.maxTokens) {
          familyMap.set(m.family, {
            vendor: m.vendor,
            maxTokens: m.maxInputTokens,
            count: (existing?.count ?? 0) + 1,
          });
        } else {
          familyMap.set(m.family, { ...existing, count: existing.count + 1 });
        }
      }

      const items: vscode.QuickPickItem[] = [];

      for (const [family, info] of familyMap) {
        items.push({
          label: family,
          description: family === currentFamily
            ? '$(check) Active'
            : `${info.vendor} · ${info.maxTokens.toLocaleString()} max tokens`,
          detail: family === currentFamily
            ? `$(check) Currently selected · ${info.vendor} · ${info.maxTokens.toLocaleString()} max tokens`
            : undefined,
        });
      }

      // Sort: active model first, then alphabetically
      items.sort((a, b) => {
        if (a.label === currentFamily) { return -1; }
        if (b.label === currentFamily) { return 1; }
        return a.label.localeCompare(b.label);
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Current: ${currentFamily}`,
        title: `Available LLM Models (${allModels.length} found)`,
        matchOnDescription: true,
      });

      if (!picked) {
        return; // cancelled
      }

      if (picked.label === currentFamily) {
        vscode.window.showInformationMessage(`"${currentFamily}" is already the active LLM model.`);
        return;
      }

      await config.update(
        CONFIG.AGENTIC_LLM_MODEL,
        picked.label,
        vscode.ConfigurationTarget.Workspace
      );

      vscode.window.showInformationMessage(`LLM model set to: ${picked.label}`);
      logger.info(`LLM model set to: ${picked.label}`);
    } catch (error) {
      logger.error(`Failed to select LLM model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select LLM model: ${error}`);
    }
  }

  /**
   * Generic inline editor for any configuration item.
   * Handles booleans (toggle), enums (QuickPick), and numbers (InputBox).
   */
  public async editConfigItem(configKey: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);

    // Map tree-view keys to CONFIG constants + metadata
    const configMap: Record<string, {
      settingKey: string;
      type: 'boolean' | 'enum' | 'number';
      options?: string[];
      optionLabels?: Record<string, string>;
      min?: number;
      max?: number;
      step?: number;
      label: string;
    }> = {
      [TREE_CONFIG_KEY.EMBEDDING_BACKEND]: {
        settingKey: CONFIG.EMBEDDING_BACKEND,
        type: 'enum',
        options: ['auto', 'vscodeLM', 'huggingface'],
        optionLabels: {
          'auto': 'Auto — try VS Code LM first, fall back to HuggingFace',
          'vscodeLM': 'VS Code LM — requires an embedding provider (e.g. Copilot)',
          'huggingface': 'HuggingFace — local Transformers.js (offline)',
        },
        label: 'Embedding Backend',
      },
      [TREE_CONFIG_KEY.RETRIEVAL_STRATEGY]: {
        settingKey: CONFIG.RETRIEVAL_STRATEGY,
        type: 'enum',
        options: ['hybrid', 'vector', 'ensemble', 'bm25'],
        optionLabels: {
          'hybrid': 'Hybrid — 70% semantic + 30% keyword (recommended)',
          'vector': 'Vector — pure semantic similarity',
          'ensemble': 'Ensemble — RRF fusion (slower, more accurate)',
          'bm25': 'BM25 — pure keyword search (no embeddings)',
        },
        label: 'Retrieval Strategy',
      },
      [TREE_CONFIG_KEY.AGENTIC_MODE]: {
        settingKey: CONFIG.USE_AGENTIC_MODE,
        type: 'boolean',
        label: 'Agentic Mode',
      },
      [TREE_CONFIG_KEY.USE_LLM]: {
        settingKey: CONFIG.AGENTIC_USE_LLM,
        type: 'boolean',
        label: 'LLM Planning',
      },
      [TREE_CONFIG_KEY.ITERATIVE_REFINEMENT]: {
        settingKey: CONFIG.AGENTIC_ITERATIVE_REFINEMENT,
        type: 'boolean',
        label: 'Iterative Refinement',
      },
      [TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT]: {
        settingKey: CONFIG.AGENTIC_INCLUDE_WORKSPACE,
        type: 'boolean',
        label: 'Include Workspace Context',
      },
      [TREE_CONFIG_KEY.MAX_ITERATIONS]: {
        settingKey: CONFIG.AGENTIC_MAX_ITERATIONS,
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        label: 'Max Iterations',
      },
      [TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD]: {
        settingKey: CONFIG.AGENTIC_CONFIDENCE_THRESHOLD,
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: 'Confidence Threshold',
      },
      [TREE_CONFIG_KEY.TOP_K]: {
        settingKey: CONFIG.TOP_K,
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        label: 'Top K Results',
      },
      [TREE_CONFIG_KEY.CHUNK_SIZE]: {
        settingKey: CONFIG.CHUNK_SIZE,
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        label: 'Chunk Size',
      },
      [TREE_CONFIG_KEY.CHUNK_OVERLAP]: {
        settingKey: CONFIG.CHUNK_OVERLAP,
        type: 'number',
        min: 0,
        max: 500,
        step: 10,
        label: 'Chunk Overlap',
      },
      [TREE_CONFIG_KEY.LOG_LEVEL]: {
        settingKey: CONFIG.LOG_LEVEL,
        type: 'enum',
        options: ['debug', 'info', 'warn', 'error'],
        optionLabels: {
          'debug': 'Debug — verbose logging for troubleshooting',
          'info': 'Info — standard messages (recommended)',
          'warn': 'Warn — only warnings and errors',
          'error': 'Error — only error messages',
        },
        label: 'Log Level',
      },
    };

    const entry = configMap[configKey];
    if (!entry) {
      logger.warn(`editConfigItem: unknown config key "${configKey}"`);
      return;
    }

    try {
      if (entry.type === 'boolean') {
        // Toggle
        const current = config.get<boolean>(entry.settingKey, false);
        await config.update(entry.settingKey, !current, vscode.ConfigurationTarget.Workspace);
        const state = !current ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`${entry.label}: ${state}`);
        logger.info(`${entry.label} toggled to ${state}`);

      } else if (entry.type === 'enum' && entry.options) {
        const current = config.get<string>(entry.settingKey, entry.options[0]);
        const items: vscode.QuickPickItem[] = entry.options.map(opt => ({
          label: opt,
          description: opt === current ? '(current)' : undefined,
          detail: entry.optionLabels?.[opt],
        }));

        const picked = await vscode.window.showQuickPick(items, {
          title: `Select ${entry.label}`,
          placeHolder: `Current: ${current}`,
        });
        if (!picked) { return; }
        if (picked.label === current) {
          vscode.window.showInformationMessage(`${entry.label} is already "${current}".`);
          return;
        }
        await config.update(entry.settingKey, picked.label, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`${entry.label} set to: ${picked.label}`);
        logger.info(`${entry.label} set to: ${picked.label}`);

      } else if (entry.type === 'number') {
        const current = config.get<number>(entry.settingKey, 0);
        const input = await vscode.window.showInputBox({
          title: `Set ${entry.label}`,
          prompt: `Enter a value between ${entry.min ?? 0} and ${entry.max ?? '∞'}`,
          value: String(current),
          validateInput: (val) => {
            const num = Number(val);
            if (isNaN(num)) { return 'Must be a number'; }
            if (entry.min !== undefined && num < entry.min) { return `Minimum is ${entry.min}`; }
            if (entry.max !== undefined && num > entry.max) { return `Maximum is ${entry.max}`; }
            return undefined;
          },
        });
        if (input === undefined) { return; }
        const numVal = Number(input);
        await config.update(entry.settingKey, numVal, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`${entry.label} set to: ${numVal}`);
        logger.info(`${entry.label} set to: ${numVal}`);
      }

      this.treeDataProvider.refresh();
    } catch (error) {
      logger.error(`Failed to edit ${entry.label}: ${error}`);
      vscode.window.showErrorMessage(`Failed to edit ${entry.label}: ${error}`);
    }
  }
}
