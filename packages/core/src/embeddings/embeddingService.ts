/**
 * Embedding service — high-level router over pluggable backends
 *
 * All backends are registered externally via {@link registerBackend}.
 *
 * Backend selection is controlled by the `ragnarok.embeddingBackend` setting:
 * - `auto`        – Try registered backends in order; use first available.
 * - Any other value forces the backend whose `name` matches.
 *
 * This class is a thin router. The heavy lifting is in:
 * - Individual {@link EmbeddingBackend} implementations
 * - {@link ModelRegistry} – model discovery and path resolution
 */

import { EventEmitter } from "events";
import { CONFIG } from "../constants";
import { Logger } from "../logger";
import { IConfigProvider, INotifier } from "../interfaces";
import { EmbeddingBackend, EmbeddingBackendType, EmbeddingFingerprint } from "./embeddingBackend";
import { ModelRegistry, AvailableModel } from "../models/modelRegistry.js";
import { cosineSimilarity as langchainCosineSimilarity } from "@langchain/core/utils/math";

// Re-export for consumers that imported AvailableModel from here
export type { AvailableModel } from "../models/modelRegistry.js";

export class EmbeddingService {
  private logger: Logger;
  private modelRegistry: ModelRegistry;
  private config: IConfigProvider;
  private notifier: INotifier;

  // ---- Backend instances ----
  private activeBackend: EmbeddingBackend | null = null;
  private activeBackendType: string = "";
  private backendResolved = false;

  /** Promise-based lock to prevent concurrent ensureBackend() initialization. */
  private initPromise: Promise<void> | null = null;

  /** Flag indicating an ingestion pipeline is actively using the backend. */
  private _processing = false;

  /** Registered backends. */
  private registeredBackends: EmbeddingBackend[] = [];

  public get isProcessing(): boolean {
    return this._processing;
  }

  public setProcessing(value: boolean): void {
    this._processing = value;
  }

  // Event emitter for model changes
  private static readonly _onModelChanged = new EventEmitter();

  public static readonly onModelChanged = {
    subscribe(listener: (newModel: string) => void): { unsubscribe(): void } {
      EmbeddingService._onModelChanged.on("modelChanged", listener);
      return {
        unsubscribe() {
          EmbeddingService._onModelChanged.off("modelChanged", listener);
        },
      };
    },
  };

  constructor({ config, notifier }: { config: IConfigProvider; notifier: INotifier }) {
    this.config = config;
    this.notifier = notifier;
    this.logger = new Logger("EmbeddingService");
    this.modelRegistry = ModelRegistry.getInstance();
  }

  /**
   * Register an external embedding backend (e.g., VscodeLmBackend).
   * Registered backends are considered during auto-resolution.
   */
  public registerBackend(backend: EmbeddingBackend): void {
    this.registeredBackends.push(backend);
    // Wire model-change notifications if the backend supports them
    if ("onModelChanged" in backend) {
      (backend as any).onModelChanged = (newModel: string) => {
        EmbeddingService._onModelChanged.emit("modelChanged", newModel);
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Backend resolution
  // ---------------------------------------------------------------------------

  private async resolveBackend(): Promise<string> {
    const setting = this.config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, "auto");

    if (setting !== "auto") {
      this.logger.info(`Embedding backend forced to "${setting}" by configuration`);
      return setting;
    }

    // auto: try registered backends in order, use first available
    for (const backend of this.registeredBackends) {
      if (await backend.isAvailable()) {
        this.logger.info(`Auto-resolved embedding backend to "${backend.name}"`);
        return backend.name;
      }
    }

    // Fall back to the last registered backend (callers register their default last)
    if (this.registeredBackends.length > 0) {
      const fallback = this.registeredBackends[this.registeredBackends.length - 1];
      this.logger.info(`No available backends found; falling back to "${fallback.name}"`);
      return fallback.name;
    }

    throw new Error("No embedding backends registered");
  }

  private async ensureBackend(): Promise<void> {
    if (this.backendResolved) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this._doEnsureBackend();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async _doEnsureBackend(): Promise<void> {
    if (this.backendResolved) {
      return;
    }

    const resolved = await this.resolveBackend();

    const registered = this.registeredBackends.find((b) => b.name === resolved);
    if (!registered) {
      throw new Error(`Embedding backend "${resolved}" not registered`);
    }

    await registered.initialize();
    this.activeBackend = registered;
    this.activeBackendType = resolved;

    const modelDesc = registered.getModelId?.() ?? "auto";
    this.logger.info(`Using ${resolved} embeddings (model: ${modelDesc})`);
    this.notifier.showInfo(`RAGnarōk: Using ${resolved} embeddings (model: ${modelDesc})`);

    this.backendResolved = true;
  }

  public resetBackendSelection(): void {
    this.backendResolved = false;
    if (this.activeBackend) {
      this.activeBackend.dispose();
    }
    this.activeBackend = null;
    this.activeBackendType = "";
    this.logger.info("Backend selection reset; will re-resolve on next initialization");
  }

  /** Resolve and initialize the configured backend before replacing the active one. */
  public async reselectBackendTransactional(modelName?: string): Promise<void> {
    const resolved = await this.resolveBackend();
    await this.selectBackendTransactional(resolved, modelName);
  }

  public async selectBackendTransactional(backendType: string, modelName?: string): Promise<void> {
    const replacement = this.registeredBackends.find((backend) => backend.name === backendType);
    if (!replacement) {
      throw new Error(`Embedding backend "${backendType}" not registered`);
    }
    const prefix = `${backendType}:`;
    const rawModel = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
    await replacement.initialize(rawModel || undefined);
    const previous = this.activeBackend;
    this.activeBackend = replacement;
    this.activeBackendType = backendType;
    this.backendResolved = true;
    if (previous && previous !== replacement) {
      await previous.dispose();
    }
  }

  public getActiveBackendType(): string {
    return this.activeBackendType;
  }

  /** Stable identity for the exact semantic vector space currently in use. */
  public async getFingerprint(signal?: AbortSignal): Promise<EmbeddingFingerprint> {
    signal?.throwIfAborted();
    await this.ensureBackend();
    const backend = this.activeBackend!;
    let dimension = backend.getDimension();
    if (!dimension) {
      dimension = (await backend.embed("RAGnarok embedding fingerprint probe", signal)).length;
    }
    const details = backend.getFingerprintInfo?.() ?? {};
    return {
      backendKind: backend.name,
      providerFormat: details.providerFormat ?? backend.name,
      model: backend.getModelId?.() ?? "auto",
      revision: details.revision ?? "unknown",
      dimension,
      endpointHash: details.endpointHash ?? "local",
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  public async initialize(modelName?: string): Promise<void> {
    try {
      await this.ensureBackend();
    } catch (backendError: any) {
      const setting = this.config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, "auto");
      if (setting !== "auto") {
        throw backendError;
      }
      // In auto mode, try the last registered backend as fallback
      if (this.registeredBackends.length > 0) {
        const fallback = this.registeredBackends[this.registeredBackends.length - 1];
        this.logger.warn(
          `Backend initialization failed, falling back to "${fallback.name}": ${backendError?.message ?? backendError}`,
        );
        this.notifier.showWarning(
          `RAGnarōk: Preferred embeddings unavailable — falling back to ${fallback.name}. Reason: ${backendError?.message ?? backendError}`,
        );
        // Strip backend prefix if present (e.g. "vscodeLM:model-id" → "model-id")
        const prefix = fallback.name + ":";
        const rawModelName = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
        await fallback.initialize(rawModelName);
        this.activeBackend = fallback;
        this.activeBackendType = fallback.name;
        this.backendResolved = true;
        return;
      }
      throw backendError;
    }

    // Initialize the active backend with the model name if provided
    if (modelName && this.activeBackend) {
      // Strip backend prefix if present (e.g. "huggingface:Xenova/all-MiniLM-L6-v2" → "Xenova/all-MiniLM-L6-v2")
      const prefix = this.activeBackendType + ":";
      const rawModelName = modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
      await this.activeBackend.initialize(rawModelName);
    }
  }

  // ---------------------------------------------------------------------------
  // Embedding operations (polymorphic dispatch)
  // ---------------------------------------------------------------------------

  public async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    return this.executeWithFallback((backend) => backend.embed(text, signal), "embed");
  }

  public async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    return this.executeWithFallback((backend) => backend.embedBatch(texts, progressCallback, signal), "embedBatch");
  }

  // ---------------------------------------------------------------------------
  // Scoped embedding — route to a specific backend without changing the global
  // ---------------------------------------------------------------------------

  /**
   * Initialize a specific backend for scoped queries (does not change the global active backend).
   */
  public async initializeForBackend(backendType: string, modelName?: string): Promise<void> {
    const registered = this.registeredBackends.find((b) => b.name === backendType);
    if (!registered) {
      throw new Error(`Backend "${backendType}" not registered`);
    }
    // Strip the backend prefix if present (e.g. "vscodeLM:model-id" → "model-id")
    const prefix = backendType + ":";
    const rawModelName = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
    await registered.initialize(rawModelName === "auto" ? undefined : rawModelName);
  }

  /**
   * Embed a single text using a specific backend, without changing the global active backend.
   * Used when querying topics that were ingested with a different backend.
   */
  public async embedWithBackend(backendType: string, text: string): Promise<number[]> {
    const backend = this.getBackendByType(backendType);
    return backend.embed(text);
  }

  /**
   * Embed a batch of texts using a specific backend, without changing the global active backend.
   */
  public async embedBatchWithBackend(
    backendType: string,
    texts: string[],
    progressCallback?: (progress: number) => void,
  ): Promise<number[][]> {
    const backend = this.getBackendByType(backendType);
    return backend.embedBatch(texts, progressCallback);
  }

  /**
   * Check whether a given backend type is available for use.
   */
  public async isBackendAvailable(backendType: string, _modelName?: string): Promise<boolean> {
    const registered = this.registeredBackends.find((b) => b.name === backendType);
    if (!registered) {
      return false;
    }
    if (typeof registered.isAvailableForModel === "function") {
      return registered.isAvailableForModel(_modelName);
    }
    return registered.isAvailable();
  }

  private getBackendByType(backendType: string): EmbeddingBackend {
    const registered = this.registeredBackends.find((b) => b.name === backendType);
    if (!registered) {
      throw new Error(`Backend "${backendType}" not registered`);
    }
    return registered;
  }

  private async executeWithFallback<T>(
    operation: (backend: EmbeddingBackend) => Promise<T>,
    operationName: string,
  ): Promise<T> {
    if (this.activeBackend) {
      try {
        return await operation(this.activeBackend);
      } catch (error: any) {
        if (await this.shouldFallback(error)) {
          const fallback = this.registeredBackends[this.registeredBackends.length - 1];
          if (fallback && fallback.name !== this.activeBackendType) {
            this.logger.warn(
              `${this.activeBackendType} ${operationName} failed, falling back to ${fallback.name}: ${error?.message}`,
            );
            this.notifier.showWarning(
              `RAGnarōk: ${this.activeBackendType} ${operationName} failed — falling back to ${fallback.name}. Reason: ${error?.message ?? error}`,
            );
            await this.switchToFallback();
            return operation(this.activeBackend!);
          }
        }
        throw error;
      }
    }

    await this.initialize();
    return operation(this.activeBackend!);
  }

  // ---------------------------------------------------------------------------
  // Similarity helpers
  // ---------------------------------------------------------------------------

  public cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Embeddings must have the same dimension");
    }
    const normA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
    const normB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return langchainCosineSimilarity([a], [b])[0][0];
  }

  // ---------------------------------------------------------------------------
  // Model info (delegates to ModelRegistry / backend)
  // ---------------------------------------------------------------------------

  public getCurrentModel(): string {
    if (this.activeBackend) {
      const modelId = this.activeBackend.getModelId?.() ?? "auto";
      return this.activeBackendType ? `${this.activeBackendType}:${modelId}` : modelId;
    }
    return this.modelRegistry.getDefaultModel();
  }

  public getLocalModelPath(): string | null {
    return this.modelRegistry.getResolvedLocalModelPath();
  }

  public async listLocalModels(): Promise<string[]> {
    return this.modelRegistry.listLocalModels();
  }

  public async listAvailableModels(): Promise<AvailableModel[]> {
    // A remote backend knows its own catalogue — the local curated HF
    // registry would be misleading when embeddings come from an API.
    if (this.activeBackend && this.activeBackendType !== "huggingface" && this.activeBackend.listModels) {
      try {
        const remoteModels = await this.activeBackend.listModels();
        return remoteModels.map((m) => ({
          name: m.name || m.id,
          source: "remote" as AvailableModel["source"],
          downloaded: true,
        }));
      } catch (error) {
        this.logger.warn("Remote backend model listing failed — falling back to local registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.modelRegistry.listAvailableModels();
  }

  // ---------------------------------------------------------------------------
  // Cache / lifecycle
  // ---------------------------------------------------------------------------

  public async clearCache(): Promise<void> {
    this.logger.info("Clearing embedding model cache");
    this.resetBackendSelection();
    this.logger.info("Embedding model cache cleared successfully");
    this.notifier.showInfo("Embedding model cache cleared. Model will reload on next use.");
  }

  public async dispose(): Promise<void> {
    this.logger.info("Disposing EmbeddingService");

    for (const backend of this.registeredBackends) {
      await backend.dispose();
    }

    this.activeBackend = null;
    this.backendResolved = false;
    this.activeBackendType = "";
    this.logger.info("EmbeddingService disposed");
  }

  // ---------------------------------------------------------------------------
  // Runtime fallback helpers
  // ---------------------------------------------------------------------------

  private async shouldFallback(_error: any): Promise<boolean> {
    const setting = this.config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, "auto");
    return setting === "auto";
  }

  private async switchToFallback(): Promise<void> {
    if (this.activeBackend) {
      await this.activeBackend.dispose();
    }
    const fallback = this.registeredBackends[this.registeredBackends.length - 1];
    if (!fallback) {
      throw new Error("No fallback backend registered");
    }
    await fallback.initialize();
    this.activeBackend = fallback;
    this.activeBackendType = fallback.name;

    const newModelId = fallback.getModelId?.() ?? "unknown";
    EmbeddingService._onModelChanged.emit("modelChanged", newModelId);
  }
}
