/**
 * Main extension entry point
 * Wires VS Code adapters to the portable @ragnarok/core engine
 */

import * as vscode from "vscode";
import {
  TopicManager,
  EmbeddingService,
  Logger,
  setLoggerFactory,
  CONFIG,
  HuggingFaceBackend,
  ModelRegistry,
  MemoryStore,
  MemoryOperationCoordinator,
  MemoryService,
  GraphVisualizationService,
  createSharedTopicSources,
  createEmbeddingServices,
  createMemoryServices,
} from "@ragnarok/core";
import { VsCodeLoggerFactory } from "./adapters/vsCodeLogger";
import { VsCodeConfigProvider } from "./adapters/vsCodeConfigProvider";
import { VsCodeNotifier } from "./adapters/vsCodeNotifier";
import { VsCodeLLMProvider } from "./adapters/vsCodeLLMProvider";
import { VscodeLmBackend } from "./vscodeLmBackend";
import { RAGTool } from "./ragTool";
import { TopicTool } from "./topicTool";
import { CommandHandler } from "./commands";
import { TopicTreeDataProvider, ConfigTreeDataProvider } from "./topicTreeView";
import { VIEWS, CONTEXT, COMMANDS, VSCODE_CONFIG } from "./constants";
import { GitHubTokenManager } from "./githubTokenManager";
import { ExtensionLifecycle } from "./extensionLifecycle";
import { registerMemoryTools } from "./memoryTools";
import { MemoryGraphPanel } from "./memoryGraphPanel";
import { registerMemoryGraphCommand } from "./memoryGraphCommand";
import { registerMemorySidebar } from "./memoryTreeView";
import { registerConfigurationHandler } from "./embeddingConfigHandler";
import { runInstalledSmoke } from "./installedSmoke";

// Install VS Code logger factory before anything else
setLoggerFactory(new VsCodeLoggerFactory());

const logger = new Logger("Extension");

export interface RagnarokExtensionApi {
  readonly apiVersion: 1;
  readonly lifecycle: {
    isAcceptingOperations(): boolean;
    activeOperationCount(): number;
  };
  runInstalledSmoke(): Promise<{
    topicCreated: boolean;
    queryExecuted: boolean;
    topicDeleted: boolean;
  }>;
}

export interface ActivationServiceFactory {
  createEmbeddingService(options: ConstructorParameters<typeof EmbeddingService>[0]): EmbeddingService;
  createTopicManager(options: Parameters<typeof TopicManager.create>[0]): Promise<TopicManager>;
  createMemoryStore(options: ConstructorParameters<typeof MemoryStore>[0]): MemoryStore;
  createMemoryCoordinator(): MemoryOperationCoordinator;
  createMemoryService(store: MemoryStore, coordinator: MemoryOperationCoordinator): MemoryService;
  createGraphVisualizationService(
    store: MemoryStore,
    coordinator: MemoryOperationCoordinator,
  ): GraphVisualizationService;
}

export interface ActivationRuntimeFactory {
  registerMemoryTools(
    memoryService: Pick<MemoryService, "execute">,
    operationRunner: ExtensionLifecycle["run"],
  ): vscode.Disposable;
  createMemoryGraphPanel(extensionUri: vscode.Uri): Pick<MemoryGraphPanel, "show" | "dispose">;
  registerMemoryGraphCommand(
    graphService: Pick<GraphVisualizationService, "generate">,
    panel: Pick<MemoryGraphPanel, "show">,
    operationRunner: ExtensionLifecycle["run"],
  ): vscode.Disposable;
  registerMemorySidebar(
    memoryService: Pick<MemoryService, "execute" | "reset">,
    operationRunner: ExtensionLifecycle["run"],
  ): vscode.Disposable;
  afterMemorySurfacesRegistered?(): void | Promise<void>;
}

const defaultServiceFactory: ActivationServiceFactory = {
  createEmbeddingService: (options) => new EmbeddingService(options),
  createTopicManager: (options) => TopicManager.create(options),
  createMemoryStore: (options) => new MemoryStore(options),
  createMemoryCoordinator: () => new MemoryOperationCoordinator(),
  createMemoryService: (store, coordinator) => new MemoryService(store, coordinator),
  createGraphVisualizationService: (store, coordinator) => new GraphVisualizationService(store, coordinator),
};

const defaultRuntimeFactory: ActivationRuntimeFactory = {
  registerMemoryTools: (memoryService, operationRunner) => registerMemoryTools(memoryService, operationRunner),
  createMemoryGraphPanel: (extensionUri) => new MemoryGraphPanel(extensionUri),
  registerMemoryGraphCommand,
  registerMemorySidebar: (memoryService, operationRunner) => registerMemorySidebar(memoryService, operationRunner),
};

/**
 * Keeps the tree views live when another process writes topics.json/a
 * topic-documents file, or when a reset in another window
 * takes the storage tree away and later gives it back. Both kinds refresh
 * both views; `storage-unavailable` additionally warns, since a read racing
 * that window can surface stale or momentarily-missing data.
 */
export function wireExternalStorageChangeRefresh(
  topicManager: Pick<TopicManager, "onExternalChange">,
  treeDataProvider: Pick<TopicTreeDataProvider, "refresh">,
  configDataProvider: Pick<ConfigTreeDataProvider, "refresh">,
  showWarning: (message: string) => void,
): { dispose(): void } {
  return topicManager.onExternalChange((change) => {
    treeDataProvider.refresh();
    configDataProvider.refresh();
    if (change.kind === "storage-unavailable") {
      showWarning(
        "RAGnarōk storage is temporarily unavailable (another window is resetting it, or the folder was moved)",
      );
    }
  });
}

let activeLifecycle: ExtensionLifecycle | undefined;

/**
 * Never allowed to throw: it runs on the activation failure path, where a
 * second error would replace the original cause with a setContext failure.
 */
async function setActivationFailed(failed: boolean): Promise<void> {
  try {
    await vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.ACTIVATION_FAILED, failed);
  } catch (error) {
    logger.error("Failed to publish the activation state context key", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<RagnarokExtensionApi> {
  return activateWithServiceFactory(context, defaultServiceFactory);
}

/** Test seam for activation/storage/model failure paths. Production uses activate(). */
export async function activateWithServiceFactory(
  context: vscode.ExtensionContext,
  serviceFactory: ActivationServiceFactory,
  runtimeFactory: ActivationRuntimeFactory = defaultRuntimeFactory,
): Promise<RagnarokExtensionApi> {
  logger.info("RAGnarōk extension activating...");
  if (activeLifecycle) {
    await activeLifecycle.dispose();
  }
  const storageDir = context.globalStorageUri.fsPath;
  const lifecycle = new ExtensionLifecycle(storageDir);
  activeLifecycle = lifecycle;

  try {
    // Cleared first: a retry after a failed activation must not inherit the
    // previous attempt's failure panel.
    await setActivationFailed(false);

    // Create adapter instances
    const configProvider = new VsCodeConfigProvider();
    const notifier = new VsCodeNotifier();

    // Create LLM provider
    const llmProvider = new VsCodeLLMProvider();

    const modelRegistry = ModelRegistry.getInstance();
    const { embeddingService, embeddingRegistry } = createEmbeddingServices({
      config: configProvider,
      notifier,
      // Mirrors McpConfig.maxResidentModels' default; VS Code has no setting for it.
      maxResidentLocal: 2,
      createService: (options) => serviceFactory.createEmbeddingService(options),
      // VS Code LM first; HuggingFace last, so it is the fallback.
      createBackends: () => [
        new VscodeLmBackend(undefined, {
          modelIdResolver: () => configProvider.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, ""),
        }),
        new HuggingFaceBackend(modelRegistry, notifier),
      ],
    });
    lifecycle.setResources({ embeddingService });
    lifecycle.setResources({ embeddingRegistry });

    // Initialize TopicManager with VS Code storage path
    const createTopicManager = () =>
      serviceFactory.createTopicManager({
        storageDir,
        config: configProvider,
        notifier,
        embeddingService,
        embeddingRegistry,
        llmProvider,
        sharedTopicSources: (() => {
          const configuredPath = vscode.workspace
            .getConfiguration(VSCODE_CONFIG.ROOT)
            .get<string>(CONFIG.COMMON_DATABASE_PATH, "");
          return createSharedTopicSources(configuredPath);
        })(),
      });
    const topicManager = await createTopicManager();
    lifecycle.setResources({ topicManager });
    // No workingDir here: branch detection for memory operations flows
    // through resolveMemoryHostContext (active editor / single workspace
    // folder), and the service resolves scopes before the store's own
    // detector is consulted. The store still defaults its detector to
    // process.cwd(); that fallback is unreachable from this host's memory
    // tools, but it has not been removed.
    const memoryStore = serviceFactory.createMemoryStore({
      storageDir,
      embeddingService,
      llmProvider,
      markdownPath: vscode.Uri.joinPath(context.globalStorageUri, "memories.md").fsPath,
    });
    lifecycle.setResources({ memoryStore });
    const {
      coordinator: memoryCoordinator,
      memoryService,
      graphService,
    } = createMemoryServices(memoryStore, serviceFactory);
    lifecycle.setResources({ memoryCoordinator });

    const memoryTools = runtimeFactory.registerMemoryTools(memoryService, lifecycle.run);
    lifecycle.setResources({ memoryTools });
    const graphPanel = runtimeFactory.createMemoryGraphPanel(context.extensionUri);
    lifecycle.setResources({ graphPanel });
    const graphCommand = runtimeFactory.registerMemoryGraphCommand(graphService, graphPanel, lifecycle.run);
    lifecycle.setResources({ graphCommand });
    // Registered with the other memory surfaces, not with the topic/config tree
    // views below, so a failure after this point rolls the whole section back.
    const memorySidebar = runtimeFactory.registerMemorySidebar(memoryService, lifecycle.run);
    lifecycle.setResources({ memorySidebar });
    await runtimeFactory.afterMemorySurfacesRegistered?.();

    // Start model initialization in the background — don't block activation
    const embeddingInitialization = lifecycle
      .run("embedding initialization", async (signal) => {
        signal.throwIfAborted();
        await embeddingService.initialize();
        signal.throwIfAborted();
      })
      .then(() => {
        logger.info("Embedding model initialized successfully");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Embedding model initialization deferred", { error: msg });
      });
    void embeddingInitialization;

    // Initialize GitHub token manager
    GitHubTokenManager.initialize(context);
    logger.info("GitHub token manager initialized");

    // Signal that the extension has started loading (viewsWelcome uses this)
    await vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, false);

    // Register Topics tree view
    const treeDataProvider = new TopicTreeDataProvider(topicManager);
    const treeView = vscode.window.createTreeView(VIEWS.RAG_TOPICS, {
      treeDataProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(treeDataProvider);
    lifecycle.addDisposable(treeView);
    lifecycle.addDisposable(treeDataProvider);

    // Register Configuration tree view (separate panel, always shows settings)
    const configDataProvider = new ConfigTreeDataProvider(embeddingService);
    const configView = vscode.window.createTreeView(VIEWS.RAG_CONFIG, {
      treeDataProvider: configDataProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(configView);
    context.subscriptions.push(configDataProvider);
    lifecycle.addDisposable(configView);
    lifecycle.addDisposable(configDataProvider);

    // Keep both tree views live when another window writes topics.json or a
    // documents file, or resets the storage.
    const externalChangeSubscription = wireExternalStorageChangeRefresh(
      topicManager,
      treeDataProvider,
      configDataProvider,
      (message) => {
        void vscode.window.showWarningMessage(message);
      },
    );
    context.subscriptions.push(externalChangeSubscription);
    lifecycle.addDisposable(externalChangeSubscription);

    // Register commands
    const commandRegistrations = await CommandHandler.registerCommands(
      context,
      topicManager,
      embeddingService,
      memoryStore,
      treeDataProvider,
      configDataProvider,
      lifecycle.run,
    );
    lifecycle.addDisposable(commandRegistrations);

    // Load topics with error handling
    try {
      const topics = await topicManager.getAllTopics();
      logger.info(`Loaded ${topics.length} topics`);
      await vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.HAS_TOPICS, topics.length > 0);
      await vscode.commands.executeCommand(COMMANDS.SET_CONTEXT, CONTEXT.LOADED, true);
    } catch (dbError) {
      logger.error("Failed to load topics", { error: dbError });
      await vscode.window.showErrorMessage(
        "RAGnarōk could not load the topic index safely. No data was changed. Restore a known-good backup before retrying.",
        { modal: true },
      );
      throw dbError;
    }

    // Register RAG tool for Copilot/LLM agents
    let ragToolRegistration: ReturnType<typeof RAGTool.register> | undefined;
    try {
      ragToolRegistration = RAGTool.register(context, topicManager, embeddingService, configProvider, llmProvider);
      lifecycle.setResources({ ragTool: ragToolRegistration });
      lifecycle.addDisposable(ragToolRegistration);
      lifecycle.addDisposable(TopicTool.register(context, topicManager));
      logger.info("RAG query and topic tools registered successfully");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to register RAG tool", { error: errorMessage });
      vscode.window.showWarningMessage(`RAG tool registration failed: ${errorMessage}`);
    }

    // Register configuration change listener for embedding model/backend,
    // shared topics and tree-view settings.
    const configChangeDisposable = registerConfigurationHandler({
      lifecycle,
      embeddingService,
      memoryStore,
      topicManager,
      refreshViews: () => {
        treeDataProvider.refresh();
        configDataProvider.refresh();
      },
    });
    context.subscriptions.push(configChangeDisposable);
    lifecycle.addDisposable(configChangeDisposable);

    logger.info("Extension activation complete");
    const api: RagnarokExtensionApi = {
      apiVersion: 1,
      lifecycle: {
        isAcceptingOperations: () => lifecycle.isAcceptingOperations,
        activeOperationCount: () => lifecycle.activeOperationCount,
      },
      runInstalledSmoke: () =>
        lifecycle.run("installed VSIX smoke", (signal) =>
          runInstalledSmoke({ context, topicManager, ragTool: ragToolRegistration }, signal),
        ),
    };
    const installedSmokeCommand = vscode.commands.registerCommand(COMMANDS.INSTALLED_SMOKE, () =>
      api.runInstalledSmoke(),
    );
    context.subscriptions.push(installedSmokeCommand);
    lifecycle.addDisposable(installedSmokeCommand);
    return api;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to activate extension", { error: errorMessage });
    // Before cleanup: the views are already visible, and leaving them on the
    // "starting up" text is the difference between a reported failure and a
    // hang the user cannot diagnose.
    if (error instanceof Error && error.name === "UnsupportedStorageError") {
      void vscode.window
        .showErrorMessage(
          `RAGnarōk cannot open its storage: ${storageDir} holds data from an unsupported pre-0.4 build. Move or delete that folder, then reload the window.`,
          { modal: true },
          "Reveal Folder",
        )
        .then((choice) => {
          if (choice === "Reveal Folder") {
            void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(storageDir));
          }
        });
    }
    await setActivationFailed(true);
    try {
      await lifecycle.dispose();
    } catch (cleanupError) {
      logger.error("Activation rollback cleanup failed", {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    if (activeLifecycle === lifecycle) {
      activeLifecycle = undefined;
    }
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const lifecycle = activeLifecycle;
  activeLifecycle = undefined;
  if (!lifecycle) {
    return;
  }
  await lifecycle.dispose();
  logger.info("Extension deactivation complete");
}
