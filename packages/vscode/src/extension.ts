/**
 * Main extension entry point
 * Wires VS Code adapters to the portable @ragnarok/core engine
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import {
  TopicManager,
  EmbeddingService,
  EmbeddingServiceRegistry,
  Logger,
  setLoggerFactory,
  CONFIG,
  HuggingFaceBackend,
  ModelRegistry,
  MemoryStore,
  MemoryOperationCoordinator,
  MemoryService,
  GraphVisualizationService,
  RetrievalStrategy,
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
import { createDefaultMigrationUx, openTopicManagerWithMigration } from "./migrationUx";
import { registerMemoryTools } from "./memoryTools";
import { MemoryGraphPanel } from "./memoryGraphPanel";
import { registerMemoryGraphCommand } from "./memoryGraphCommand";
import { registerMemorySidebar } from "./memoryTreeView";

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

export function createMemoryServices(
  store: MemoryStore,
  factory: Pick<
    ActivationServiceFactory,
    "createMemoryCoordinator" | "createMemoryService" | "createGraphVisualizationService"
  >,
): {
  coordinator: MemoryOperationCoordinator;
  memoryService: MemoryService;
  graphService: GraphVisualizationService;
} {
  const coordinator = factory.createMemoryCoordinator();
  return {
    coordinator,
    memoryService: factory.createMemoryService(store, coordinator),
    graphService: factory.createGraphVisualizationService(store, coordinator),
  };
}

let activeLifecycle: ExtensionLifecycle | undefined;

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
    // Create adapter instances
    const configProvider = new VsCodeConfigProvider();
    const notifier = new VsCodeNotifier();

    // Create LLM provider
    const llmProvider = new VsCodeLLMProvider();

    // Builds a fully-backed embedding service. Every service needs the same
    // backends: one with none registered cannot initialize at all, and the
    // fallback in EmbeddingService.initialize is disabled for an empty list.
    // The backend instances are constructed per call on purpose — sharing one
    // HuggingFaceBackend across services would reintroduce the shared-model bug
    // one level down, since initializeForBackend re-points the backend itself.
    const modelRegistry = ModelRegistry.getInstance();
    const buildEmbeddingService = () => {
      const service = serviceFactory.createEmbeddingService({ config: configProvider, notifier });
      // VS Code LM embedding backend (proposed embeddings API) first; the
      // HuggingFace backend is registered last so it is the default fallback.
      service.registerBackend(
        new VscodeLmBackend(undefined, {
          modelIdResolver: () => configProvider.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, ""),
        }),
      );
      service.registerBackend(new HuggingFaceBackend(modelRegistry, notifier));
      return service;
    };

    // Initialize embedding service
    const embeddingService = buildEmbeddingService();
    lifecycle.setResources({ embeddingService });

    // One registry for the whole extension host: a registry per consumer would
    // give each its own resident models and defeat the cap. Mirrors the
    // McpConfig.maxResidentModels default; VS Code has no contributed setting.
    const embeddingRegistry = new EmbeddingServiceRegistry({
      createService: buildEmbeddingService,
      maxResidentLocal: 2,
    });
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
      });
    const topicManager = await openTopicManagerWithMigration(storageDir, createDefaultMigrationUx(createTopicManager));
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
    context.subscriptions.push(memorySidebar);
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
    const treeDataProvider = new TopicTreeDataProvider(topicManager, embeddingService);
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
        "RAGnarōk could not load the topic index safely. No data was changed. Restore a known-good backup or inspect the storage migration status before retrying.",
        { modal: true },
      );
      throw dbError;
    }

    // Register RAG tool for Copilot/LLM agents
    let ragToolRegistration: ReturnType<typeof RAGTool.register> | undefined;
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
        ragToolRegistration = RAGTool.register(context, topicManager, embeddingService, configProvider, llmProvider);
        lifecycle.setResources({ ragTool: ragToolRegistration });
        lifecycle.addDisposable(ragToolRegistration);
        // Same guard on purpose: without vscode.lm there is nothing to register.
        lifecycle.addDisposable(TopicTool.register(context, topicManager));
        logger.info("RAG query and topic tools registered successfully");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to register RAG tool", { error: errorMessage });
      vscode.window.showWarningMessage(`RAG tool registration failed: ${errorMessage}`);
    }

    // Register configuration change listener for embedding model. The last
    // successfully committed settings are restored if a transactional switch
    // or dependent-store validation fails.
    const initialConfig = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
    let committedLocalModelPath = initialConfig.get<string>(CONFIG.LOCAL_MODEL_PATH, "");
    let committedEmbeddingBackend = initialConfig.get<string>(CONFIG.EMBEDDING_BACKEND, "auto");
    let committedVscodeModel = initialConfig.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) =>
      lifecycle
        .run("configuration change", async (signal) => {
          signal.throwIfAborted();
          const localModelPathSetting = `${VSCODE_CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`;
          const treeViewConfigPaths = [
            `${VSCODE_CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
            `${VSCODE_CONFIG.ROOT}.${CONFIG.LLM_MODEL}`,
            `${VSCODE_CONFIG.ROOT}.${CONFIG.MAX_ITERATIONS}`,
            `${VSCODE_CONFIG.ROOT}.${CONFIG.CONFIDENCE_THRESHOLD}`,
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
                    await embeddingService.runTransactionalSwitch(
                      embeddingService.getActiveBackendType() || undefined,
                      undefined,
                      async () => {
                        await memoryStore.validateEmbeddingFingerprint();
                        progress.report({ message: "Reinitializing services..." });
                        await topicManager.reinitializeWithNewModel();
                      },
                    );
                  },
                );

                const model = embeddingService.getCurrentModel();
                logger.info(`Embedding model ready: ${model}`);
                vscode.window.showInformationMessage(`RAGnarōk: Embedding model set to "${model}"`);
              };

              await applyModel();
              committedLocalModelPath = vscode.workspace
                .getConfiguration(VSCODE_CONFIG.ROOT)
                .get<string>(CONFIG.LOCAL_MODEL_PATH, "");
              treeDataProvider.refresh();
              configDataProvider.refresh();
            } catch (error) {
              await vscode.workspace
                .getConfiguration(VSCODE_CONFIG.ROOT)
                .update(CONFIG.LOCAL_MODEL_PATH, committedLocalModelPath, vscode.ConfigurationTarget.Workspace);
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error("Failed to handle embedding model configuration change", {
                error: errorMessage,
              });
              vscode.window.showErrorMessage(`RAGnarōk: Failed to update embedding model: ${errorMessage}`);
            }
          }

          // Handle Embedding Backend or VS Code Model ID change
          const embeddingBackendSetting = `${VSCODE_CONFIG.ROOT}.${CONFIG.EMBEDDING_BACKEND}`;
          const embeddingVscodeModelSetting = `${VSCODE_CONFIG.ROOT}.${VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID}`;
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
              const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
              let requested = config.get<string>(CONFIG.EMBEDDING_BACKEND, "auto");
              const requestedModel = config.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");

              if (requested === "vscodeLM") {
                const probe = new VscodeLmBackend(requestedModel || undefined);
                const ok = await probe.isAvailable();
                if (!ok) {
                  logger.warn('Requested VS Code LM backend unavailable; reverting embeddingBackend setting to "auto"');
                  try {
                    await vscode.workspace
                      .getConfiguration(VSCODE_CONFIG.ROOT)
                      .update(CONFIG.EMBEDDING_BACKEND, "auto", vscode.ConfigurationTarget.Workspace);
                    requested = "auto";
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

              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `RAGnarōk: Switching embedding backend...`,
                },
                async (progress) => {
                  progress.report({ message: "Resolving backend..." });
                  await embeddingService.runTransactionalSwitch(
                    undefined,
                    requested === "vscodeLM" ? requestedModel || undefined : undefined,
                    async () => {
                      await memoryStore.validateEmbeddingFingerprint();
                      progress.report({ message: "Reinitializing services..." });
                      await topicManager.reinitializeWithNewModel();
                    },
                  );
                },
              );

              const model = embeddingService.getCurrentModel();
              const backend = embeddingService.getActiveBackendType();
              committedEmbeddingBackend = vscode.workspace
                .getConfiguration(VSCODE_CONFIG.ROOT)
                .get<string>(CONFIG.EMBEDDING_BACKEND, "auto");
              committedVscodeModel = vscode.workspace
                .getConfiguration(VSCODE_CONFIG.ROOT)
                .get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");
              logger.info(`Embedding backend switched: ${backend} (model: ${model})`);
              vscode.window.showInformationMessage(`RAGnarōk: Embedding backend set to "${backend}" (model: ${model})`);
              treeDataProvider.refresh();
              configDataProvider.refresh();
            } catch (error) {
              const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
              await config.update(
                CONFIG.EMBEDDING_BACKEND,
                committedEmbeddingBackend,
                vscode.ConfigurationTarget.Workspace,
              );
              await config.update(
                VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID,
                committedVscodeModel,
                vscode.ConfigurationTarget.Workspace,
              );
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error("Failed to switch embedding backend", {
                error: errorMessage,
              });
              vscode.window.showErrorMessage(`RAGnarōk: Failed to switch embedding backend: ${errorMessage}`);
            }
          }

          // Handle Common Database Path change
          if (event.affectsConfiguration(`${VSCODE_CONFIG.ROOT}.${CONFIG.COMMON_DATABASE_PATH}`)) {
            logger.info("Common database path configuration changed");
            await topicManager.loadCommonDatabase();
            treeDataProvider.refresh();
            configDataProvider.refresh();
            vscode.window.showInformationMessage("Common database reloaded");
          }

          const affectsTreeViewConfig = treeViewConfigPaths.some((configPath) =>
            event.affectsConfiguration(configPath),
          );
          if (affectsTreeViewConfig) {
            logger.debug("Configuration affecting tree view changed, refreshing view");
            treeDataProvider.refresh();
            configDataProvider.refresh();
          }
        })
        .catch((error) => {
          if (lifecycle.isAcceptingOperations) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Configuration change failed", { error: message });
            void vscode.window.showErrorMessage(`RAGnarōk: Configuration change failed: ${message}`);
          }
        }),
    );
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
        lifecycle.run("installed VSIX smoke", async (signal) => {
          signal.throwIfAborted();
          const smokeId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const evidenceToken = `ragnarok installed smoke evidence ${smokeId}`;
          const smokePath = vscode.Uri.joinPath(context.globalStorageUri, `installed-smoke-${smokeId}.txt`).fsPath;
          await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
          await fs.writeFile(
            smokePath,
            `This temporary document contains the unique ${evidenceToken}. It verifies installed artifact ingestion and retrieval.`,
            "utf8",
          );
          let topic: { id: string; name: string } | undefined;
          let queryExecuted = false;
          let topicDeleted = false;
          let cleanupFailure: unknown;
          try {
            signal.throwIfAborted();
            topic = await topicManager.createTopic({
              name: `RAGnarōk Installed Smoke ${smokeId}`,
              description: "Temporary topic created by the installed VSIX smoke gate",
            });
            if (!ragToolRegistration) {
              throw new Error("The RAG language-model tool is unavailable in this VS Code build");
            }
            const ingestion = await topicManager.addDocuments(topic.id, [smokePath], { signal });
            const chunksStored = ingestion.reduce(
              (total, item) => total + item.pipelineResult.metadata.chunksStored,
              0,
            );
            if (chunksStored < 1) {
              throw new Error("Installed VSIX smoke ingested no document chunks");
            }
            signal.throwIfAborted();
            const queryResult = await ragToolRegistration.tool.executeQuery(
              {
                topic: topic.name,
                query: evidenceToken,
                topK: 1,
                retrievalStrategy: RetrievalStrategy.VECTOR,
              },
              signal,
            );
            const evidence = queryResult.results.find((result) => result.text.includes(evidenceToken));
            const hasDirectVectorEvidence =
              evidence?.metadata.scoreKind === "vector_similarity" &&
              typeof evidence.metadata.componentScores?.vector === "number" &&
              Number.isFinite(evidence.metadata.componentScores.vector);
            const hasRerankedVectorEvidence =
              evidence?.metadata.scoreKind === "cross_encoder_probability" &&
              evidence.metadata.originalScoreKind === "vector_similarity" &&
              typeof evidence.metadata.originalComponentScores?.vector === "number" &&
              Number.isFinite(evidence.metadata.originalComponentScores.vector);
            if (!evidence || (!hasDirectVectorEvidence && !hasRerankedVectorEvidence)) {
              throw new Error("Installed VSIX smoke query did not return the ingested content with vector evidence");
            }
            queryExecuted = true;
          } finally {
            if (topic) {
              try {
                await topicManager.deleteTopic(topic.id);
                topicDeleted = topicManager.getTopic(topic.id) === null;
              } catch (error) {
                cleanupFailure = error;
              }
            }
            try {
              await fs.rm(smokePath, { force: true });
            } catch (error) {
              cleanupFailure ??= error;
            }
          }
          if (cleanupFailure) {
            throw cleanupFailure;
          }
          if (!topicDeleted) {
            throw new Error("Installed VSIX smoke topic remained visible after deletion");
          }
          try {
            await fs.access(smokePath);
            throw new Error("Installed VSIX smoke temporary document was not cleaned up");
          } catch (error: any) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          }
          return {
            topicCreated: true,
            queryExecuted,
            topicDeleted,
          };
        }),
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
