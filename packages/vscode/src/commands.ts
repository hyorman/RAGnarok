/**
 * Command handlers for the RAG extension
 * Refactored to use new LangChain-based architecture with TopicManager
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import { TopicManager, EmbeddingService, Logger, sanitizeErrorMessage, Topic, MemoryStore } from "@ragnarok/core";
import { TopicTreeDataProvider, ConfigTreeDataProvider } from "./topicTreeView";
import { COMMANDS } from "./constants";
import { GitHubTokenManager } from "./githubTokenManager";
import { waitForAbortableUi, type ExtensionOperationRunner } from "./extensionLifecycle";

const logger = new Logger("CommandHandler");

export class NoDocumentsIngestedError extends Error {
  constructor() {
    super("No documents were ingested. Check the selected source and the extension logs for details.");
    this.name = "NoDocumentsIngestedError";
  }
}

/**
 * Bridge extension lifecycle cancellation into the core ingestion pipeline.
 * Once durable ingestion starts, shutdown aborts the supported core operation
 * and waits for it to unwind.
 */
export async function addDocumentsWithLifecycleSignal(
  topicManager: Pick<TopicManager, "addDocuments">,
  topicId: string,
  sources: string[],
  signal: AbortSignal | undefined,
  options: NonNullable<Parameters<TopicManager["addDocuments"]>[2]> = {},
) {
  signal?.throwIfAborted();
  const results = await topicManager.addDocuments(topicId, sources, { ...options, signal });
  signal?.throwIfAborted();
  if (results.length === 0) {
    throw new NoDocumentsIngestedError();
  }
  return results;
}

export class CommandHandler {
  private topicManager: TopicManager;
  private embeddingService: EmbeddingService;
  private memoryStore: MemoryStore;
  private treeDataProvider: TopicTreeDataProvider;
  private configDataProvider: ConfigTreeDataProvider;
  private context: vscode.ExtensionContext;
  private tokenManager: GitHubTokenManager;

  private constructor(
    context: vscode.ExtensionContext,
    topicManager: TopicManager,
    embeddingService: EmbeddingService,
    memoryStore: MemoryStore,
    treeDataProvider: TopicTreeDataProvider,
    configDataProvider: ConfigTreeDataProvider,
  ) {
    this.context = context;
    this.topicManager = topicManager;
    this.embeddingService = embeddingService;
    this.memoryStore = memoryStore;
    this.treeDataProvider = treeDataProvider;
    this.configDataProvider = configDataProvider;
    this.tokenManager = GitHubTokenManager.getInstance();
  }

  /**
   * Register all commands
   */
  public static async registerCommands(
    context: vscode.ExtensionContext,
    topicManager: TopicManager,
    embeddingService: EmbeddingService,
    memoryStore: MemoryStore,
    treeDataProvider: TopicTreeDataProvider,
    configDataProvider: ConfigTreeDataProvider,
    operationRunner: ExtensionOperationRunner = async (_label, operation) => operation(new AbortController().signal),
  ): Promise<vscode.Disposable> {
    const handler = new CommandHandler(
      context,
      topicManager,
      embeddingService,
      memoryStore,
      treeDataProvider,
      configDataProvider,
    );
    const run = <T>(label: string, operation: (signal: AbortSignal) => Promise<T> | T): Promise<T> =>
      operationRunner(label, async (signal) => operation(signal));

    const registrations = [
      vscode.commands.registerCommand(COMMANDS.CREATE_TOPIC, () =>
        run(COMMANDS.CREATE_TOPIC, (signal) => handler.createTopic(signal)),
      ),
      vscode.commands.registerCommand(COMMANDS.DELETE_TOPIC, (item?: any) =>
        run(COMMANDS.DELETE_TOPIC, () => handler.deleteTopic(item)),
      ),
      vscode.commands.registerCommand(COMMANDS.ADD_DOCUMENT, (item?: any) =>
        run(COMMANDS.ADD_DOCUMENT, (signal) => handler.addDocument(item, signal)),
      ),
      vscode.commands.registerCommand(COMMANDS.ADD_GITHUB_REPO, (item?: any) =>
        run(COMMANDS.ADD_GITHUB_REPO, (signal) => handler.addGithubRepo(item, signal)),
      ),
      vscode.commands.registerCommand(COMMANDS.ADD_WEB_URL, (item?: any) =>
        run(COMMANDS.ADD_WEB_URL, (signal) => handler.addWebUrl(item, signal)),
      ),
      vscode.commands.registerCommand(COMMANDS.REFRESH_TOPICS, () =>
        run(COMMANDS.REFRESH_TOPICS, () => handler.refreshTopics()),
      ),
      vscode.commands.registerCommand(COMMANDS.CLEAR_MODEL_CACHE, () =>
        run(COMMANDS.CLEAR_MODEL_CACHE, () => handler.clearModelCache()),
      ),
      vscode.commands.registerCommand(COMMANDS.SET_EMBEDDING_MODEL, (model) =>
        run(COMMANDS.SET_EMBEDDING_MODEL, () => handler.setEmbeddingModel(model)),
      ),
      vscode.commands.registerCommand(COMMANDS.CLEAR_DATABASE, () =>
        run(COMMANDS.CLEAR_DATABASE, () => handler.clearDatabase()),
      ),
      // Config tree view commands (delegated to ConfigTreeDataProvider)
      vscode.commands.registerCommand(COMMANDS.SELECT_VSCODE_EMBEDDING_MODEL, () =>
        run(COMMANDS.SELECT_VSCODE_EMBEDDING_MODEL, () => configDataProvider.selectVscodeEmbeddingModel()),
      ),
      vscode.commands.registerCommand(COMMANDS.SELECT_HF_EMBEDDING_MODEL, () =>
        run(COMMANDS.SELECT_HF_EMBEDDING_MODEL, () => configDataProvider.selectHfEmbeddingModel()),
      ),
      vscode.commands.registerCommand(COMMANDS.SELECT_RERANKER_MODEL, () =>
        run(COMMANDS.SELECT_RERANKER_MODEL, () => configDataProvider.selectRerankerModel()),
      ),
      vscode.commands.registerCommand(COMMANDS.SELECT_LLM_MODEL, () =>
        run(COMMANDS.SELECT_LLM_MODEL, () => configDataProvider.selectLLMModel()),
      ),
      vscode.commands.registerCommand(COMMANDS.EDIT_CONFIG_ITEM, (configKey: string) =>
        run(COMMANDS.EDIT_CONFIG_ITEM, () => configDataProvider.editConfigItem(configKey)),
      ),
      // GitHub token management commands
      vscode.commands.registerCommand(COMMANDS.ADD_GITHUB_TOKEN, () =>
        run(COMMANDS.ADD_GITHUB_TOKEN, () => handler.addGithubToken()),
      ),
      vscode.commands.registerCommand(COMMANDS.LIST_GITHUB_TOKENS, () =>
        run(COMMANDS.LIST_GITHUB_TOKENS, () => handler.listGithubTokens()),
      ),
      vscode.commands.registerCommand(COMMANDS.REMOVE_GITHUB_TOKEN, () =>
        run(COMMANDS.REMOVE_GITHUB_TOKEN, () => handler.removeGithubToken()),
      ),
      // Import/Export commands
      vscode.commands.registerCommand(COMMANDS.EXPORT_TOPIC, (item?: any) =>
        run(COMMANDS.EXPORT_TOPIC, () => handler.exportTopic(item)),
      ),
      vscode.commands.registerCommand(COMMANDS.IMPORT_TOPIC, () =>
        run(COMMANDS.IMPORT_TOPIC, () => handler.importTopic()),
      ),
      vscode.commands.registerCommand(COMMANDS.RENAME_TOPIC, (item?: any) =>
        run(COMMANDS.RENAME_TOPIC, () => handler.renameTopic(item)),
      ),
    ];
    const composite = vscode.Disposable.from(...registrations);
    context.subscriptions.push(composite);
    return composite;
  }

  /**
   * Set embedding model in workspace configuration and initialize
   */
  public async setEmbeddingModel(model: string): Promise<void> {
    try {
      if (typeof (this.embeddingService as any).runTransactionalSwitch === "function") {
        await this.embeddingService.runTransactionalSwitch(
          this.embeddingService.getActiveBackendType() || undefined,
          model,
          async () => {
            await this.memoryStore.validateEmbeddingFingerprint();
            await this.topicManager.reinitializeWithNewModel();
          },
        );
      } else {
        await this.embeddingService.initialize(model);
        await this.topicManager.reinitializeWithNewModel();
      }

      vscode.window.showInformationMessage(`Embedding model set to "${model}"`);
      this.treeDataProvider.refresh();
    } catch (err) {
      logger.error("Failed to set embedding model", err);
      vscode.window.showErrorMessage(`Failed to set embedding model: ${sanitizeErrorMessage(err)}`);
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
          },
        );

        if (!selected) {
          return;
        }

        topicToRename = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(topicToRename.id)) {
        vscode.window.showWarningMessage(
          `Cannot rename "${topicToRename.name}" - topics from common database are read-only.`,
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

      vscode.window.showInformationMessage(`Topic renamed to "${newName.trim()}" successfully!`);
      this.treeDataProvider.refresh();
    } catch (error) {
      logger.error(`Failed to rename topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to rename topic: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * Create a new topic
   */
  private async createTopic(signal?: AbortSignal): Promise<void> {
    try {
      const name = await waitForAbortableUi(
        signal,
        vscode.window.showInputBox({
          prompt: "Enter topic name",
          placeHolder: "e.g., React Documentation, Company Policies",
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return "Topic name cannot be empty";
            }
            return null;
          },
        }),
      );

      if (!name) {
        return;
      }

      const description = await waitForAbortableUi(
        signal,
        vscode.window.showInputBox({
          prompt: "Enter topic description (optional)",
          placeHolder: "Brief description of this topic",
        }),
      );

      signal?.throwIfAborted();
      logger.info(`Creating topic: ${name}`);
      const topic = await this.topicManager.createTopic({
        name: name.trim(),
        description: description?.trim(),
      });

      vscode.window.showInformationMessage(`Topic "${topic.name}" created successfully!`);
      this.treeDataProvider.refresh();
      logger.info(`Topic created: ${topic.id}`);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      logger.error(`Failed to create topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to create topic: ${sanitizeErrorMessage(error)}`);
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
          vscode.window.showInformationMessage("No topics available to delete.");
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
          },
        );

        if (!selected) {
          return;
        }

        topicToDelete = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(topicToDelete.id)) {
        vscode.window.showWarningMessage(
          `Cannot delete "${topicToDelete.name}" - topics from common database are read-only.`,
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to delete topic "${topicToDelete.name}"? This will also delete all associated documents and embeddings.`,
        { modal: true },
        "Delete",
      );

      if (confirmation === "Delete") {
        logger.info(`Deleting topic: ${topicToDelete.name} (${topicToDelete.id})`);
        await this.topicManager.deleteTopic(topicToDelete.id);
        vscode.window.showInformationMessage(`Topic "${topicToDelete.name}" deleted.`);
        this.treeDataProvider.refresh();
        logger.info(`Topic deleted successfully`);
      }
    } catch (error) {
      logger.error(`Failed to delete topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to delete topic: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * Add a document to a topic
   */
  private async addDocument(item?: any, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      let selectedTopic: any;

      // If called from tree view with item
      if (item && item.topic) {
        selectedTopic = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          const create = await waitForAbortableUi(
            signal,
            vscode.window.showInformationMessage("No topics available. Would you like to create one?", "Create Topic"),
          );

          if (create === "Create Topic") {
            await this.createTopic(signal);
            return this.addDocument(undefined, signal); // Retry after creating topic
          }
          return;
        }

        const selected = await waitForAbortableUi(
          signal,
          vscode.window.showQuickPick(
            topics.map((t: any) => ({
              label: t.name,
              description: `${t.documentCount} document(s)`,
              topic: t,
            })),
            {
              placeHolder: "Select a topic",
            },
          ),
        );

        if (!selected) {
          return;
        }

        selectedTopic = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(selectedTopic.id)) {
        vscode.window.showWarningMessage(
          `Cannot add documents to "${selectedTopic.name}" - topics from common database are read-only.`,
        );
        return;
      }

      // Ask whether the user wants to select files or folders.
      // Some platforms/OS dialogs don't handle mixed file+folder mode well,
      // so present a choice and open the dialog in the selected mode.
      const selectionMode = await waitForAbortableUi(
        signal,
        vscode.window.showQuickPick(
          [
            { label: "Files", description: "Select one or more files", value: "files" },
            { label: "Folders", description: "Select one or more folders", value: "folders" },
          ],
          { placeHolder: "Add documents: choose Files or Folders" },
        ),
      );

      if (!selectionMode) {
        return; // user cancelled
      }

      let fileUris: readonly vscode.Uri[] | undefined;

      if (selectionMode.value === "files") {
        // File selection mode: include filters so users can narrow to document types
        fileUris = await waitForAbortableUi(
          signal,
          vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: {
              "All Files": ["*"],
              "Supported Documents": ["pdf", "md", "markdown", "html", "htm", "txt"],
              PDF: ["pdf"],
              Markdown: ["md", "markdown"],
              HTML: ["html", "htm"],
              Text: ["txt"],
            },
            openLabel: "Add Document(s)",
          }),
        );
      } else {
        // Folder selection mode: filters are ignored for folders, so omit them
        fileUris = await waitForAbortableUi(
          signal,
          vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: "Add Folder(s)",
          }),
        );
      }

      if (!fileUris || fileUris.length === 0) {
        return;
      }

      const filePaths = fileUris.map((uri) => uri.fsPath);
      signal?.throwIfAborted();

      // Check if any selected paths are directories
      let hasDirectories = false;
      for (const filePath of filePaths) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.isDirectory()) {
            hasDirectories = true;
            break;
          }
        } catch (_error) {
          // Ignore error, treat as file
        }
      }

      // Ask user about recursive loading if folders are selected
      let recursiveDirectory = false;
      if (hasDirectories) {
        const choice = await waitForAbortableUi(
          signal,
          vscode.window.showQuickPick(
            [
              { label: "Load recursively", description: "Include all files from subfolders", value: true },
              { label: "Load only from selected folders", description: "Don't scan subfolders", value: false },
            ],
            {
              placeHolder: "One or more folders selected. How would you like to load them?",
            },
          ),
        );

        if (!choice) {
          return; // User cancelled
        }

        recursiveDirectory = choice.value;
      }

      logger.info(`Adding ${filePaths.length} document(s) to topic: ${selectedTopic.name}`, { recursiveDirectory });

      // Process documents using TopicManager
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Processing documents...`,
          cancellable: false,
        },
        async (progress) => {
          const results = await addDocumentsWithLifecycleSignal(
            this.topicManager,
            selectedTopic.id,
            filePaths,
            signal,
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
            },
          );

          progress.report({ message: "Complete!" });

          const totalChunks = results.reduce((sum, r) => sum + r.pipelineResult.metadata.chunksStored, 0);
          const actualFileCount = results.reduce((sum, r) => sum + r.pipelineResult.metadata.originalDocuments, 0);
          logger.info(`Documents added: ${actualFileCount} files, ${totalChunks} chunks`);
        },
      );

      signal?.throwIfAborted();
      const stats = await this.topicManager.getTopicStats(selectedTopic.id);
      const actualFileCount = stats?.documentCount || 0;
      vscode.window.showInformationMessage(
        `Documents added to "${selectedTopic.name}" successfully! Total: ${actualFileCount} documents, ${stats?.chunkCount} chunks.`,
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      logger.error(`Failed to add document: ${error}`);
      vscode.window.showErrorMessage(`Failed to add document: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * Add a GitHub repository to a topic
   */
  private async addGithubRepo(item?: any, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      let selectedTopic: any;

      // If called from tree view with item
      if (item && item.topic) {
        selectedTopic = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          const create = await waitForAbortableUi(
            signal,
            vscode.window.showInformationMessage("No topics available. Would you like to create one?", "Create Topic"),
          );

          if (create === "Create Topic") {
            await this.createTopic(signal);
            return this.addGithubRepo(undefined, signal); // Retry after creating topic
          }
          return;
        }

        const selected = await waitForAbortableUi(
          signal,
          vscode.window.showQuickPick(
            topics.map((t: any) => ({
              label: t.name,
              description: `${t.documentCount} document(s)`,
              topic: t,
            })),
            {
              placeHolder: "Select a topic",
            },
          ),
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

        const hostChoice = await waitForAbortableUi(
          signal,
          vscode.window.showQuickPick(hostOptions, {
            placeHolder: "Select GitHub host or enter custom URL",
          }),
        );

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
        const repoPath = await waitForAbortableUi(
          signal,
          vscode.window.showInputBox({
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
          }),
        );

        if (!repoPath) {
          return;
        }

        repoUrl = `https://${selectedHost}/${repoPath.trim()}`;
      } else {
        // Full URL entry for custom hosts
        repoUrl =
          (await waitForAbortableUi(
            signal,
            vscode.window.showInputBox({
              ignoreFocusOut: true,
              prompt: "Enter full GitHub repository URL",
              placeHolder: "https://github.com/owner/repo",
              validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                  return "Repository URL cannot be empty";
                }
                if (!/^https?:\/\/[a-zA-Z0-9.-]+\/[\w-]+\/[\w.-]+/.test(value.trim())) {
                  return "Invalid GitHub URL. Format: https://host/owner/repo";
                }
                return null;
              },
            }),
          )) || "";

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
            const needToken = await waitForAbortableUi(
              signal,
              vscode.window.showQuickPick(
                [
                  {
                    label: "Enter Token",
                    description: "For private repositories",
                    value: true,
                  },
                  {
                    label: "Continue Without Token",
                    description: "Public repos only — 60 requests/hr limit (may fail for large repos)",
                    value: false,
                  },
                ],
                {
                  placeHolder: `No saved token for ${host}`,
                },
              ),
            );

            if (needToken?.value) {
              const tokenInput = await waitForAbortableUi(
                signal,
                vscode.window.showInputBox({
                  prompt: "Enter GitHub access token",
                  placeHolder: "ghp_xxxxxxxxxxxxxxxxxxxx",
                  password: true,
                  ignoreFocusOut: true,
                }),
              );

              if (tokenInput && tokenInput.trim().length > 0) {
                accessToken = tokenInput.trim();
                await this.tokenManager.promptToSaveToken(this.context, host, accessToken, signal);
              }
            }
          }
        }
      }

      // Get branch
      const branch = await waitForAbortableUi(
        signal,
        vscode.window.showInputBox({
          prompt: "Enter branch name",
          placeHolder: "main",
          value: "main",
          ignoreFocusOut: true,
        }),
      );

      if (!branch) {
        return;
      }

      // Optional: ignore patterns
      const defaultIgnore = "*.github*, *makefile*, **/TEST/**, **/tst/**, *.test.*, node_modules/**";
      const ignoreInput = await waitForAbortableUi(
        signal,
        vscode.window.showInputBox({
          prompt: "Enter ignore patterns (optional, comma-separated)",
          placeHolder: `${defaultIgnore} (press Enter to accept default)`,
          value: defaultIgnore,
          ignoreFocusOut: true,
        }),
      );

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

          const results = await addDocumentsWithLifecycleSignal(
            this.topicManager,
            selectedTopic.id,
            [repoUrl],
            signal,
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
            },
          );

          progress.report({ message: "Complete!", increment: 100 });

          const totalChunks = results.reduce((sum, r) => sum + r.pipelineResult.metadata.chunksStored, 0);
          logger.info(`GitHub repository added: ${totalChunks} chunks`);
        },
      );

      signal?.throwIfAborted();
      const stats = await this.topicManager.getTopicStats(selectedTopic.id);
      vscode.window.showInformationMessage(
        `GitHub repository added to "${selectedTopic.name}" successfully! Total: ${stats?.documentCount} documents, ${stats?.chunkCount} chunks.`,
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      logger.error(`Failed to add GitHub repository: ${error}`);
      vscode.window.showErrorMessage(`Failed to add GitHub repository: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * Add a web URL to a topic.
   * If the URL points to a GitHub repository, routes to addGithubRepo instead.
   */
  private async addWebUrl(item?: any, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      let selectedTopic: any;

      // If called from tree view with item
      if (item && item.topic) {
        selectedTopic = item.topic;
      } else {
        // Called from command palette - show picker
        const topics = await this.topicManager.getAllTopics();

        if (topics.length === 0) {
          const create = await waitForAbortableUi(
            signal,
            vscode.window.showInformationMessage("No topics available. Would you like to create one?", "Create Topic"),
          );

          if (create === "Create Topic") {
            await this.createTopic(signal);
            return this.addWebUrl(undefined, signal); // Retry after creating topic
          }
          return;
        }

        const selected = await waitForAbortableUi(
          signal,
          vscode.window.showQuickPick(
            topics.map((t: any) => ({
              label: t.name,
              description: `${t.documentCount} document(s)`,
              topic: t,
            })),
            {
              placeHolder: "Select a topic",
            },
          ),
        );

        if (!selected) {
          return;
        }

        selectedTopic = selected.topic;
      }

      // Check if topic is from common database (read-only)
      if (this.topicManager.isCommonTopic(selectedTopic.id)) {
        vscode.window.showWarningMessage(
          `Cannot add to "${selectedTopic.name}" - topics from common database are read-only.`,
        );
        return;
      }

      const url = await waitForAbortableUi(
        signal,
        vscode.window.showInputBox({
          prompt: "Enter web page URL to ingest",
          placeHolder: "https://example.com/docs/page",
          ignoreFocusOut: true,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return "URL cannot be empty";
            }
            try {
              const parsed = new URL(value.trim());
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return "URL must start with http:// or https://";
              }
            } catch {
              return "Invalid URL format";
            }
            return null;
          },
        }),
      );

      if (!url) {
        return;
      }

      const trimmedUrl = url.trim();

      // Detect GitHub repository URLs and route to the GitHub ingestion flow
      const parsed = new URL(trimmedUrl);
      const host = parsed.hostname.toLowerCase();
      const isGitHubHost = host === "github.com" || host.endsWith(".github.com");
      const hasRepoPath = /^\/[\w-]+\/[\w.-]+/.test(parsed.pathname);
      const hasToken = await this.tokenManager.getToken(host);

      if ((isGitHubHost || hasToken) && hasRepoPath) {
        const useGithub = await waitForAbortableUi(
          signal,
          vscode.window.showInformationMessage(
            "This looks like a GitHub repository. Use GitHub repository ingestion for better results?",
            "Yes, use GitHub ingestion",
            "No, load as web page",
          ),
        );
        if (useGithub === "Yes, use GitHub ingestion") {
          return this.addGithubRepo(item, signal);
        }
      }

      logger.info(`Adding web URL to topic: ${selectedTopic.name}`, { url: trimmedUrl });

      // Process web URL using TopicManager
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading web page...`,
          cancellable: false,
        },
        async (progress) => {
          const results = await addDocumentsWithLifecycleSignal(
            this.topicManager,
            selectedTopic.id,
            [trimmedUrl],
            signal,
            {
              onProgress: (pipelineProgress) => {
                progress.report({
                  message: pipelineProgress.message,
                  increment: pipelineProgress.progress / 100,
                });
              },
              loaderOptions: {
                fileType: "web",
              },
            },
          );

          progress.report({ message: "Complete!" });

          const totalChunks = results.reduce((sum, r) => sum + r.pipelineResult.metadata.chunksStored, 0);
          logger.info(`Web page added: ${totalChunks} chunks`);
        },
      );

      signal?.throwIfAborted();
      const stats = await this.topicManager.getTopicStats(selectedTopic.id);
      vscode.window.showInformationMessage(
        `Web page added to "${selectedTopic.name}" successfully! Total: ${stats?.documentCount} documents, ${stats?.chunkCount} chunks.`,
      );
      this.treeDataProvider.refresh();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      logger.error(`Failed to add web URL: ${error}`);
      vscode.window.showErrorMessage(`Failed to add web URL: ${sanitizeErrorMessage(error)}`);
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
      vscode.window.showErrorMessage(`Failed to clear cache: ${sanitizeErrorMessage(error)}`);
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
        "Clear Database",
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
      vscode.window.showErrorMessage(`Failed to clear database: ${sanitizeErrorMessage(error)}`);
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
          "Cancel",
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

      // Validate GitHub token format
      const trimmedToken = token.trim();
      const validTokenPatterns = [
        /^ghp_[a-zA-Z0-9]{36,255}$/, // Personal Access Token
        /^gho_[a-zA-Z0-9]{36,255}$/, // OAuth token
        /^ghu_[a-zA-Z0-9]{36,255}$/, // User-to-server token
        /^ghs_[a-zA-Z0-9]{36,255}$/, // Server-to-server token
        /^ghr_[a-zA-Z0-9]{36,255}$/, // Refresh token
        /^github_pat_[a-zA-Z0-9_]{22,}$/, // Fine-grained PAT v2
        /^[a-f0-9]{40}$/, // Legacy classic token
      ];
      const isValidFormat = validTokenPatterns.some((p) => p.test(trimmedToken));
      if (!isValidFormat) {
        vscode.window.showWarningMessage(
          "Token format does not match known GitHub token patterns. It will be stored but may not work.",
        );
      }

      // Save token
      await this.tokenManager.setToken(host.trim(), trimmedToken);
      await this.tokenManager.addHostToList(this.context, host.trim());

      vscode.window.showInformationMessage(`GitHub token saved for host "${host.trim()}"`);
      logger.info(`GitHub token added for host: ${host.trim()}`);
    } catch (error) {
      logger.error(`Failed to add GitHub token: ${error}`);
      vscode.window.showErrorMessage(`Failed to add GitHub token: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * List all saved GitHub tokens (hosts only, not the actual tokens)
   */
  private async listGithubTokens(): Promise<void> {
    try {
      const hosts = await this.tokenManager.listHosts(this.context);

      if (hosts.length === 0) {
        vscode.window.showInformationMessage('No GitHub tokens saved. Use "RAG: Add GitHub Token" to add one.');
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
      vscode.window.showErrorMessage(`Failed to list GitHub tokens: ${sanitizeErrorMessage(error)}`);
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
        },
      );

      if (!selected) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to remove the GitHub token for "${selected.label}"?`,
        "Remove",
        "Cancel",
      );

      if (confirmation === "Remove") {
        await this.tokenManager.deleteToken(selected.label);
        await this.tokenManager.removeHostFromList(this.context, selected.label);

        vscode.window.showInformationMessage(`GitHub token removed for "${selected.label}"`);
        logger.info(`GitHub token removed for host: ${selected.label}`);
      }
    } catch (error) {
      logger.error(`Failed to remove GitHub token: ${error}`);
      vscode.window.showErrorMessage(`Failed to remove GitHub token: ${sanitizeErrorMessage(error)}`);
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
        const topics = (await this.topicManager.getAllTopics()).filter(
          (t) => t.source !== "common", // Only show local topics for export
        );

        if (topics.length === 0) {
          vscode.window.showInformationMessage("No local topics available to export.");
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
          },
        );

        if (!selected) {
          return;
        }

        topicToExport = selected.topic;
      }

      // Check if topic is from common database
      if (this.topicManager.isCommonTopic(topicToExport.id)) {
        vscode.window.showWarningMessage(
          `Cannot export "${topicToExport.name}" - topics from common database cannot be exported.`,
        );
        return;
      }

      // Show save dialog
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${topicToExport.name.replace(/[^a-zA-Z0-9]/g, "_")}.rag`),
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
        },
      );

      vscode.window.showInformationMessage(`Topic "${topicToExport.name}" exported successfully!`);
      logger.info(`Topic exported: ${topicToExport.id}`);
    } catch (error) {
      logger.error(`Failed to export topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to export topic: ${sanitizeErrorMessage(error)}`);
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
        },
      );

      if (importedTopic) {
        vscode.window.showInformationMessage(`Topic "${importedTopic.name}" imported successfully!`);
        this.treeDataProvider.refresh();
        logger.info(`Topic imported: ${importedTopic.id}`);
      }
    } catch (error) {
      logger.error(`Failed to import topic: ${error}`);
      vscode.window.showErrorMessage(`Failed to import topic: ${sanitizeErrorMessage(error)}`);
    }
  }
}
