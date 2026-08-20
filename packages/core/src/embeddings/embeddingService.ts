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
import { Mutex } from "async-mutex";
import { AsyncLocalStorage } from "async_hooks";

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
  /** Serializes backend/model publication while queries use generation leases. */
  private switchMutex = new Mutex();
  private backendLeaseCounts = new Map<EmbeddingBackend, number>();
  private backendDrainWaiters = new Map<EmbeddingBackend, Array<() => void>>();
  private admissionsBlocked = false;
  private admissionWaiters: Array<() => void> = [];
  private transactionContext = new AsyncLocalStorage<boolean>();
  private deferModelEvents = false;
  private pendingModelEvent: string | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

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
    this.assertNotDisposed();
    this.registeredBackends.push(backend);
    // Wire model-change notifications if the backend supports them
    if ("onModelChanged" in backend) {
      (backend as any).onModelChanged = (newModel: string) => {
        if (this.deferModelEvents) {
          this.pendingModelEvent = newModel;
        } else {
          EmbeddingService._onModelChanged.emit("modelChanged", newModel);
        }
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
    this.assertNotDisposed();
    if (this.backendResolved) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      await this._doEnsureBackend();
    });
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

    // Scoped callers may already be using a registered backend before it is
    // globally selected. The switch mutex prevents new scoped admissions while
    // this drain and initialization are in progress.
    await this.waitForBackendDrain(registered);
    await registered.initialize();
    this.assertNotDisposed();
    this.activeBackend = registered;
    this.activeBackendType = resolved;

    const modelDesc = registered.getModelId?.() ?? "auto";
    this.logger.info(`Using ${resolved} embeddings (model: ${modelDesc})`);
    this.notifier.showInfo(`RAGnarōk: Using ${resolved} embeddings (model: ${modelDesc})`);

    this.backendResolved = true;
  }

  public async resetBackendSelection(): Promise<void> {
    this.assertNotDisposed();
    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      this.blockAdmissions();
      const previous = this.activeBackend;
      this.backendResolved = false;
      this.activeBackend = null;
      this.activeBackendType = "";
      this.initPromise = null;
      try {
        if (previous) {
          await this.waitForBackendDrain(previous);
          await previous.dispose();
        }
      } finally {
        this.unblockAdmissions();
      }
      this.logger.info("Backend selection reset; will re-resolve on next initialization");
    });
  }

  /** Resolve and initialize the configured backend before replacing the active one. */
  public async reselectBackendTransactional(modelName?: string): Promise<void> {
    this.assertNotDisposed();
    const resolved = await this.resolveBackend();
    await this.selectBackendTransactional(resolved, modelName);
  }

  public async selectBackendTransactional(backendType: string, modelName?: string): Promise<void> {
    this.assertNotDisposed();
    const replacement = this.registeredBackends.find((backend) => backend.name === backendType);
    if (!replacement) {
      throw new Error(`Embedding backend "${backendType}" not registered`);
    }
    const prefix = `${backendType}:`;
    const rawModel = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      const targetModel = rawModel || undefined;
      if (
        this.backendResolved &&
        replacement === this.activeBackend &&
        (!targetModel || replacement.getModelId?.() === targetModel)
      ) {
        return;
      }

      const previous = this.activeBackend;
      if (replacement === previous) {
        // Backends such as Transformers.js swap their own pipeline. Stop new
        // admissions and let current readers finish before asking that backend
        // to replace/dispose its internal generation.
        this.blockAdmissions();
        try {
          await this.waitForBackendDrain(replacement);
          await replacement.initialize(targetModel);
          this.activeBackendType = backendType;
          this.backendResolved = true;
        } finally {
          this.unblockAdmissions();
        }
        return;
      }

      // A different backend can be prepared while readers continue using the
      // old one. It can still have scoped readers, so drain those readers
      // before mutating its model and publish only after initialization succeeds.
      await this.waitForBackendDrain(replacement);
      await replacement.initialize(targetModel);
      this.activeBackend = replacement;
      this.activeBackendType = backendType;
      this.backendResolved = true;
      if (previous) {
        await this.waitForBackendDrain(previous);
        await previous.dispose();
      }
    });
  }

  /**
   * Keep a model/backend switch invisible until dependent managers validate
   * and rebuild. Operations spawned by `validateAndCommit` may use the
   * candidate; unrelated callers remain queued on the admission gate.
   */
  public async runTransactionalSwitch(
    backendType: string | undefined,
    modelName: string | undefined,
    validateAndCommit: () => Promise<void>,
  ): Promise<void> {
    this.assertNotDisposed();
    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      const resolvedType = backendType ?? (await this.resolveBackend());
      const replacement = this.registeredBackends.find((backend) => backend.name === resolvedType);
      if (!replacement) {
        throw new Error(`Embedding backend "${resolvedType}" not registered`);
      }
      const prefix = `${resolvedType}:`;
      const rawModel = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
      const previous = this.activeBackend;
      const previousType = this.activeBackendType;
      const previousResolved = this.backendResolved;
      const previousModel = previous?.getModelId?.() ?? undefined;

      this.blockAdmissions();
      this.deferModelEvents = true;
      this.pendingModelEvent = null;
      try {
        if (previous) {
          await this.waitForBackendDrain(previous);
        }
        if (replacement !== previous) {
          await this.waitForBackendDrain(replacement);
        }
        await replacement.beginSwitchTransaction?.();
        try {
          await replacement.initialize(rawModel || undefined);
        } catch (error) {
          await replacement.rollbackSwitchTransaction?.();
          throw error;
        }
        this.activeBackend = replacement;
        this.activeBackendType = resolvedType;
        this.backendResolved = true;

        try {
          await this.transactionContext.run(true, validateAndCommit);
        } catch (error) {
          // No unrelated operation observed the candidate, so rollback is an
          // atomic publication from their perspective.
          if (replacement.rollbackSwitchTransaction) {
            await replacement.rollbackSwitchTransaction();
          } else if (replacement === previous && previousModel) {
            await replacement.initialize(previousModel);
          }
          this.activeBackend = previous;
          this.activeBackendType = previousType;
          this.backendResolved = previousResolved;
          if (replacement !== previous) {
            await replacement.dispose();
          }
          this.pendingModelEvent = null;
          throw error;
        }

        if (previous && previous !== replacement) {
          await previous.dispose();
        }
        await replacement.commitSwitchTransaction?.();
        if (this.pendingModelEvent) {
          EmbeddingService._onModelChanged.emit("modelChanged", this.pendingModelEvent);
          this.pendingModelEvent = null;
        }
      } finally {
        this.deferModelEvents = false;
        this.pendingModelEvent = null;
        this.unblockAdmissions();
      }
    });
  }

  public getActiveBackendType(): string {
    return this.activeBackendType;
  }

  /** Stable identity for the exact semantic vector space currently in use. */
  public async getFingerprint(signal?: AbortSignal): Promise<EmbeddingFingerprint> {
    signal?.throwIfAborted();
    return this.withActiveBackend(async (backend) => {
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
    });
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  public async initialize(modelName?: string): Promise<void> {
    this.assertNotDisposed();
    if (modelName) {
      try {
        const backendType = this.backendResolved ? this.activeBackendType : await this.resolveBackend();
        await this.selectBackendTransactional(backendType, modelName);
        return;
      } catch (backendError: any) {
        const setting = this.config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, "auto");
        if (setting !== "auto" || this.registeredBackends.length === 0) {
          throw backendError;
        }
        const fallback = this.registeredBackends[this.registeredBackends.length - 1];
        this.logger.warn(
          `Backend initialization failed, falling back to "${fallback.name}": ${backendError?.message ?? backendError}`,
        );
        await this.selectBackendTransactional(fallback.name, modelName);
        return;
      }
    }
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
        await this.selectBackendTransactional(fallback.name, modelName);
        return;
      }
      throw backendError;
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
    this.assertNotDisposed();
    const registered = this.registeredBackends.find((b) => b.name === backendType);
    if (!registered) {
      throw new Error(`Backend "${backendType}" not registered`);
    }
    // Strip the backend prefix if present (e.g. "vscodeLM:model-id" → "model-id")
    const prefix = backendType + ":";
    const rawModelName = modelName?.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      if (registered === this.activeBackend) {
        this.blockAdmissions();
      }
      try {
        await this.waitForBackendDrain(registered);
        await registered.initialize(rawModelName === "auto" ? undefined : rawModelName);
      } finally {
        if (registered === this.activeBackend) {
          this.unblockAdmissions();
        }
      }
    });
  }

  /**
   * Embed a single text using a specific backend, without changing the global active backend.
   * Used when querying topics that were ingested with a different backend.
   */
  public async embedWithBackend(backendType: string, text: string): Promise<number[]> {
    this.assertNotDisposed();
    const backend = this.getBackendByType(backendType);
    return this.withScopedBackendLease(backend, () => backend.embed(text));
  }

  /**
   * Embed a batch of texts using a specific backend, without changing the global active backend.
   */
  public async embedBatchWithBackend(
    backendType: string,
    texts: string[],
    progressCallback?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    this.assertNotDisposed();
    signal?.throwIfAborted();
    const backend = this.getBackendByType(backendType);
    return this.withScopedBackendLease(backend, () => backend.embedBatch(texts, progressCallback, signal));
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
    let failedBackendType = "";
    try {
      return await this.withActiveBackend(async (backend) => {
        failedBackendType = backend.name;
        return operation(backend);
      });
    } catch (error: any) {
      if (await this.shouldFallback(error)) {
        const fallback = this.registeredBackends[this.registeredBackends.length - 1];
        if (fallback && fallback.name !== failedBackendType) {
          this.logger.warn(
            `${failedBackendType} ${operationName} failed, falling back to ${fallback.name}: ${error?.message}`,
          );
          this.notifier.showWarning(
            `RAGnarōk: ${failedBackendType} ${operationName} failed — falling back to ${fallback.name}. Reason: ${error?.message ?? error}`,
          );
          await this.switchToFallback();
          return this.withActiveBackend(operation);
        }
      }
      throw error;
    }
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
    // registry would be misleading when embeddings come from an API. Before
    // the first embed no backend is active yet, so resolve the *configured*
    // backend type to avoid advertising local models a remote-backed server
    // cannot load. Only the type is resolved here — initializing the backend
    // could download a model, which a read-only listing must never do.
    let backend = this.activeBackend;
    let backendType = this.activeBackendType;
    if (!backend) {
      const candidate = this.registeredBackends.find((b) => b.name !== "huggingface" && b.listModels);
      if (candidate && (await this.resolveBackend()) === candidate.name) {
        backend = candidate;
        backendType = candidate.name;
      }
    }
    if (backend && backendType !== "huggingface" && backend.listModels) {
      try {
        const remoteModels = await backend.listModels();
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
    await this.resetBackendSelection();
    this.logger.info("Embedding model cache cleared successfully");
    this.notifier.showInfo("Embedding model cache cleared. Model will reload on next use.");
  }

  public async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.logger.info("Disposing EmbeddingService");
    this.blockAdmissions();
    this.disposePromise = this.switchMutex.runExclusive(async () => {
      try {
        for (const backend of this.registeredBackends) {
          await this.waitForBackendDrain(backend);
          await backend.dispose();
        }
      } finally {
        this.activeBackend = null;
        this.backendResolved = false;
        this.activeBackendType = "";
        this.initPromise = null;
        // Wake callers that were queued before disposal; they fail the
        // terminal-state assertion instead of waiting forever.
        this.unblockAdmissions();
      }
      this.logger.info("EmbeddingService disposed");
    });
    return this.disposePromise;
  }

  // ---------------------------------------------------------------------------
  // Runtime fallback helpers
  // ---------------------------------------------------------------------------

  private async shouldFallback(_error: any): Promise<boolean> {
    const setting = this.config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, "auto");
    return setting === "auto";
  }

  private async switchToFallback(): Promise<void> {
    const fallback = this.registeredBackends[this.registeredBackends.length - 1];
    if (!fallback) {
      throw new Error("No fallback backend registered");
    }
    await this.selectBackendTransactional(fallback.name);

    const newModelId = fallback.getModelId?.() ?? "unknown";
    EmbeddingService._onModelChanged.emit("modelChanged", newModelId);
  }

  private async withActiveBackend<T>(operation: (backend: EmbeddingBackend) => Promise<T>): Promise<T> {
    this.assertNotDisposed();
    await this.ensureBackend();
    if (this.transactionContext.getStore()) {
      const backend = this.activeBackend;
      if (!backend) {
        throw new Error("No active embedding backend");
      }
      return this.withBackendLease(backend, () => operation(backend));
    }

    let backend: EmbeddingBackend | null = null;
    while (!backend) {
      await this.waitForAdmissions();
      backend = await this.switchMutex.runExclusive(() => {
        this.assertNotDisposed();
        if (this.admissionsBlocked) {
          return null;
        }
        const selected = this.activeBackend;
        if (!selected) {
          throw new Error("No active embedding backend");
        }
        this.acquireBackendLease(selected);
        return selected;
      });
    }
    try {
      return await operation(backend);
    } finally {
      this.releaseBackendLease(backend);
    }
  }

  private async withScopedBackendLease<T>(backend: EmbeddingBackend, operation: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      return this.withBackendLease(backend, operation);
    }
    await this.switchMutex.runExclusive(() => {
      this.assertNotDisposed();
      this.acquireBackendLease(backend);
    });
    try {
      return await operation();
    } finally {
      this.releaseBackendLease(backend);
    }
  }

  private async withBackendLease<T>(backend: EmbeddingBackend, operation: () => Promise<T>): Promise<T> {
    this.acquireBackendLease(backend);
    try {
      return await operation();
    } finally {
      this.releaseBackendLease(backend);
    }
  }

  private acquireBackendLease(backend: EmbeddingBackend): void {
    this.backendLeaseCounts.set(backend, (this.backendLeaseCounts.get(backend) ?? 0) + 1);
  }

  private releaseBackendLease(backend: EmbeddingBackend): void {
    const remaining = (this.backendLeaseCounts.get(backend) ?? 1) - 1;
    if (remaining > 0) {
      this.backendLeaseCounts.set(backend, remaining);
      return;
    }
    this.backendLeaseCounts.delete(backend);
    for (const resolve of this.backendDrainWaiters.get(backend) ?? []) {
      resolve();
    }
    this.backendDrainWaiters.delete(backend);
  }

  private async waitForBackendDrain(backend: EmbeddingBackend): Promise<void> {
    if (!this.backendLeaseCounts.has(backend)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.backendDrainWaiters.get(backend) ?? [];
      waiters.push(resolve);
      this.backendDrainWaiters.set(backend, waiters);
    });
  }

  private blockAdmissions(): void {
    this.admissionsBlocked = true;
  }

  private unblockAdmissions(): void {
    this.admissionsBlocked = false;
    for (const resolve of this.admissionWaiters.splice(0)) {
      resolve();
    }
  }

  private async waitForAdmissions(): Promise<void> {
    if (this.transactionContext.getStore()) {
      return;
    }
    while (this.admissionsBlocked) {
      await new Promise<void>((resolve) => this.admissionWaiters.push(resolve));
    }
    this.assertNotDisposed();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("EmbeddingService has been disposed");
    }
  }
}
