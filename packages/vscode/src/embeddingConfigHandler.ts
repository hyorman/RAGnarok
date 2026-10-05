/**
 * Reacts to VS Code configuration changes: embedding model/backend switches
 * (transactional, with rollback of the setting), the shared topics folder, and
 * the tree-view settings.
 */

import * as vscode from "vscode";
import {
  CONFIG,
  DEFAULTS,
  EmbeddingService,
  Logger,
  MemoryStore,
  TopicManager,
  createSharedTopicSources,
} from "@ragnarok/core";
import { VscodeLmBackend } from "./vscodeLmBackend";
import { VSCODE_CONFIG } from "./constants";
import { ExtensionLifecycle } from "./extensionLifecycle";

const logger = new Logger("EmbeddingConfigHandler");

export interface ConfigurationHandlerDeps {
  lifecycle: ExtensionLifecycle;
  embeddingService: EmbeddingService;
  memoryStore: Pick<MemoryStore, "validateEmbeddingFingerprint">;
  topicManager: Pick<TopicManager, "reinitializeWithNewModel" | "refreshSharedTopics">;
  refreshViews(): void;
}

/** What differs between the local-model-path switch and the backend switch. */
interface EmbeddingSwitchPlan {
  /** Shown instead of switching when an ingestion is running. */
  inProgressMessage: string;
  startLog: string;
  progressTitle: string;
  /** First progress message, before the transactional switch starts. */
  initialProgressMessage: string;
  /** Runs inside the guarded section, so a failure here rolls the setting back. */
  resolveTarget(): Promise<{ backend: string | undefined; vscodeModel: string | undefined }>;
  /** Records the now-active settings as the last committed ones. Only runs on success. */
  commit(): void;
  /** Restores the last committed settings. Runs on any failure. */
  rollback(): Promise<void>;
  successLog(): string;
  /** The whole toast text, prefix included. */
  successMessage(): string;
  failureLog: string;
  /** Prefix of the error toast; the failure message is appended after ": ". */
  failureMessagePrefix: string;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the configuration listener. The last successfully committed
 * settings are restored if a transactional switch or dependent-store
 * validation fails.
 */
export function registerConfigurationHandler(deps: ConfigurationHandlerDeps): vscode.Disposable {
  const { lifecycle, embeddingService, memoryStore, topicManager, refreshViews } = deps;

  const initialConfig = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
  let committedLocalModelPath = initialConfig.get<string>(CONFIG.LOCAL_MODEL_PATH, DEFAULTS.LOCAL_MODEL_PATH);
  let committedEmbeddingBackend = initialConfig.get<string>(CONFIG.EMBEDDING_BACKEND, DEFAULTS.EMBEDDING_BACKEND);
  let committedVscodeModel = initialConfig.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");

  /**
   * Returns false when the switch was refused because an ingestion is running;
   * the caller then stops handling the rest of the configuration event. A
   * failed switch is rolled back and reported, and still returns true.
   */
  async function switchEmbeddingTransactionally(plan: EmbeddingSwitchPlan): Promise<boolean> {
    if (embeddingService.isProcessing) {
      vscode.window.showWarningMessage(plan.inProgressMessage);
      return false;
    }

    logger.info(plan.startLog);

    try {
      const { backend, vscodeModel } = await plan.resolveTarget();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: plan.progressTitle },
        async (progress) => {
          progress.report({ message: plan.initialProgressMessage });
          await embeddingService.runTransactionalSwitch(backend, vscodeModel, async () => {
            await memoryStore.validateEmbeddingFingerprint();
            progress.report({ message: "Reinitializing services..." });
            await topicManager.reinitializeWithNewModel();
          });
        },
      );

      plan.commit();
      logger.info(plan.successLog());
      vscode.window.showInformationMessage(plan.successMessage());
      refreshViews();
    } catch (error) {
      await plan.rollback();
      const errorMessage = errorMessageOf(error);
      logger.error(plan.failureLog, { error: errorMessage });
      vscode.window.showErrorMessage(`${plan.failureMessagePrefix}: ${errorMessage}`);
    }
    return true;
  }

  async function handleLocalModelPathChange(): Promise<boolean> {
    return switchEmbeddingTransactionally({
      inProgressMessage:
        "RAGnarōk: Cannot change embedding model while ingestion is in progress. Please wait for it to finish.",
      startLog: "Embedding local model path changed",
      progressTitle: `RAGnarōk: Updating embedding model...`,
      initialProgressMessage: "Loading embedding model...",
      resolveTarget: async () => ({
        backend: embeddingService.getActiveBackendType() || undefined,
        vscodeModel: undefined,
      }),
      commit: () => {
        committedLocalModelPath = vscode.workspace
          .getConfiguration(VSCODE_CONFIG.ROOT)
          .get<string>(CONFIG.LOCAL_MODEL_PATH, DEFAULTS.LOCAL_MODEL_PATH);
      },
      rollback: async () => {
        await vscode.workspace
          .getConfiguration(VSCODE_CONFIG.ROOT)
          .update(CONFIG.LOCAL_MODEL_PATH, committedLocalModelPath, vscode.ConfigurationTarget.Workspace);
      },
      successLog: () => `Embedding model ready: ${embeddingService.getCurrentModel()}`,
      successMessage: () => `RAGnarōk: Embedding model set to "${embeddingService.getCurrentModel()}"`,
      failureLog: "Failed to handle embedding model configuration change",
      failureMessagePrefix: "RAGnarōk: Failed to update embedding model",
    });
  }

  /**
   * Falls back to "auto" when the requested VS Code LM backend is unavailable,
   * and returns the backend that should actually be requested.
   */
  async function resolveRequestedBackend(requested: string, requestedModel: string): Promise<string> {
    if (requested !== "vscodeLM") {
      return requested;
    }
    const probe = new VscodeLmBackend(requestedModel || undefined);
    if (await probe.isAvailable()) {
      return requested;
    }
    logger.warn('Requested VS Code LM backend unavailable; reverting embeddingBackend setting to "auto"');
    try {
      await vscode.workspace
        .getConfiguration(VSCODE_CONFIG.ROOT)
        .update(CONFIG.EMBEDDING_BACKEND, "auto", vscode.ConfigurationTarget.Workspace);
      vscode.window.showWarningMessage('Requested VS Code LM embedding backend is not available. Reverting to "auto".');
      return "auto";
    } catch (updateError: unknown) {
      logger.error("Failed to update embeddingBackend setting to auto", {
        error: errorMessageOf(updateError),
      });
      return requested;
    }
  }

  async function handleEmbeddingBackendChange(): Promise<boolean> {
    return switchEmbeddingTransactionally({
      inProgressMessage:
        "RAGnarōk: Cannot change embedding backend while ingestion is in progress. Please wait for it to finish.",
      startLog: "Embedding backend configuration changed",
      progressTitle: `RAGnarōk: Switching embedding backend...`,
      initialProgressMessage: "Resolving backend...",
      resolveTarget: async () => {
        const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
        const requestedModel = config.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");
        const requested = await resolveRequestedBackend(
          config.get<string>(CONFIG.EMBEDDING_BACKEND, DEFAULTS.EMBEDDING_BACKEND),
          requestedModel,
        );
        return {
          backend: undefined,
          vscodeModel: requested === "vscodeLM" ? requestedModel || undefined : undefined,
        };
      },
      commit: () => {
        const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
        committedEmbeddingBackend = config.get<string>(CONFIG.EMBEDDING_BACKEND, DEFAULTS.EMBEDDING_BACKEND);
        committedVscodeModel = config.get<string>(VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID, "");
      },
      rollback: async () => {
        const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
        await config.update(CONFIG.EMBEDDING_BACKEND, committedEmbeddingBackend, vscode.ConfigurationTarget.Workspace);
        await config.update(
          VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID,
          committedVscodeModel,
          vscode.ConfigurationTarget.Workspace,
        );
      },
      successLog: () =>
        `Embedding backend switched: ${embeddingService.getActiveBackendType()} (model: ${embeddingService.getCurrentModel()})`,
      successMessage: () =>
        `RAGnarōk: Embedding backend set to "${embeddingService.getActiveBackendType()}" (model: ${embeddingService.getCurrentModel()})`,
      failureLog: "Failed to switch embedding backend",
      failureMessagePrefix: "RAGnarōk: Failed to switch embedding backend",
    });
  }

  const treeViewConfigPaths = [
    `${VSCODE_CONFIG.ROOT}.${CONFIG.RETRIEVAL_STRATEGY}`,
    `${VSCODE_CONFIG.ROOT}.${CONFIG.LLM_MODEL}`,
    `${VSCODE_CONFIG.ROOT}.${CONFIG.MAX_ITERATIONS}`,
    `${VSCODE_CONFIG.ROOT}.${CONFIG.CONFIDENCE_THRESHOLD}`,
  ];

  return vscode.workspace.onDidChangeConfiguration((event) =>
    lifecycle
      .run("configuration change", async (signal) => {
        signal.throwIfAborted();

        if (event.affectsConfiguration(`${VSCODE_CONFIG.ROOT}.${CONFIG.LOCAL_MODEL_PATH}`)) {
          if (!(await handleLocalModelPathChange())) {
            return;
          }
        }

        if (
          event.affectsConfiguration(`${VSCODE_CONFIG.ROOT}.${CONFIG.EMBEDDING_BACKEND}`) ||
          event.affectsConfiguration(`${VSCODE_CONFIG.ROOT}.${VSCODE_CONFIG.EMBEDDING_VSCODE_MODEL_ID}`)
        ) {
          if (!(await handleEmbeddingBackendChange())) {
            return;
          }
        }

        // Handle shared topics folder change
        if (event.affectsConfiguration(`${VSCODE_CONFIG.ROOT}.${CONFIG.COMMON_DATABASE_PATH}`)) {
          logger.info("Shared topics folder configuration changed");
          const configuredPath = vscode.workspace
            .getConfiguration(VSCODE_CONFIG.ROOT)
            .get<string>(CONFIG.COMMON_DATABASE_PATH, "");
          await topicManager.refreshSharedTopics(createSharedTopicSources(configuredPath));
          refreshViews();
          vscode.window.showInformationMessage("Shared topics reloaded");
        }

        if (treeViewConfigPaths.some((configPath) => event.affectsConfiguration(configPath))) {
          logger.debug("Configuration affecting tree view changed, refreshing view");
          refreshViews();
        }
      })
      .catch((error: unknown) => {
        if (lifecycle.isAcceptingOperations) {
          const message = errorMessageOf(error);
          logger.error("Configuration change failed", { error: message });
          void vscode.window.showErrorMessage(`RAGnarōk: Configuration change failed: ${message}`);
        }
      }),
  );
}
