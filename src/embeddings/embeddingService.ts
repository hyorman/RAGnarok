/**
 * Embedding service — high-level router over pluggable backends
 *
 * Supported backends:
 * - **HuggingFace Transformers.js** – local ONNX/WASM inference (default)
 * - **VS Code Language Model API** – proposed `vscode.lm.computeEmbeddings`
 *
 * Backend selection is controlled by the `ragnarok.embeddingBackend` setting:
 * - `auto`        – Try VS Code LM first; fall back to HuggingFace.
 * - `vscodeLM`    – Force VS Code LM (errors if unavailable).
 * - `huggingface` – Force local HuggingFace.
 *
 * This class is a thin singleton router. The heavy lifting is in:
 * - {@link HuggingFaceBackend} – local ONNX pipeline
 * - {@link VscodeLmBackend} – VS Code LM embeddings
 * - {@link ModelRegistry} – model discovery and path resolution
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { CONFIG } from '../utils/constants';
import { Logger } from '../utils/logger';
import { EmbeddingBackend, EmbeddingBackendType } from './embeddingBackend';
import { VscodeLmBackend } from './vscodeLmBackend';
import { HuggingFaceBackend } from './huggingFaceBackend';
import { ModelRegistry, AvailableModel } from './modelRegistry';
import { cosineSimilarity as langchainCosineSimilarity } from '@langchain/core/utils/math';

// Re-export for consumers that imported AvailableModel from here
export type { AvailableModel } from './modelRegistry';

export class EmbeddingService {
  private static instance: EmbeddingService;

  private logger: Logger;
  private modelRegistry: ModelRegistry;

  // ---- Backend instances ----
  private activeBackend: EmbeddingBackend | null = null;
  private activeBackendType: 'vscodeLM' | 'huggingface' = 'huggingface';
  private backendResolved = false;

  /** Concrete HuggingFace backend (lazy, may be null if vscodeLM is forced). */
  private hfBackend: HuggingFaceBackend | null = null;

  /** Promise-based lock to prevent concurrent ensureBackend() initialization. */
  private initPromise: Promise<void> | null = null;

  /** Flag indicating an ingestion pipeline is actively using the backend. */
  private _processing = false;

  public get isProcessing(): boolean {
    return this._processing;
  }

  public setProcessing(value: boolean): void {
    this._processing = value;
  }

  // Event emitter for model changes
  private static readonly _onModelChanged = new EventEmitter();

  public static readonly onModelChanged = {
    subscribe(listener: (newModel: string) => void): vscode.Disposable {
      EmbeddingService._onModelChanged.on('modelChanged', listener);
      return new vscode.Disposable(() => {
        EmbeddingService._onModelChanged.off('modelChanged', listener);
      });
    }
  };

  private constructor() {
    this.logger = new Logger('EmbeddingService');
    this.modelRegistry = ModelRegistry.getInstance();
  }

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  // ---------------------------------------------------------------------------
  // Backend resolution
  // ---------------------------------------------------------------------------

  private async resolveBackend(): Promise<'vscodeLM' | 'huggingface'> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const setting = config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, 'auto');
    const vscodeLmModelId = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, '');

    if (setting === 'huggingface') {
      this.logger.info('Embedding backend forced to HuggingFace by configuration');
      return 'huggingface';
    }

    if (setting === 'vscodeLM') {
      this.logger.info('Embedding backend forced to VS Code LM by configuration');
      return 'vscodeLM';
    }

    // auto: try VS Code LM first
    const probe = new VscodeLmBackend(vscodeLmModelId || undefined);
    if (await probe.isAvailable()) {
      this.logger.info(
        `Auto-resolved embedding backend to VS Code LM (model: ${vscodeLmModelId || probe['modelId'] || 'auto'})`
      );
      return 'vscodeLM';
    }

    this.logger.info('VS Code LM embeddings not available; falling back to HuggingFace');
    return 'huggingface';
  }

  private async ensureBackend(): Promise<void> {
    if (this.backendResolved) return;
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
    if (this.backendResolved) return;

    const resolved = await this.resolveBackend();
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const vscodeLmModelId = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, '');

    if (resolved === 'vscodeLM') {
      const backend = new VscodeLmBackend(vscodeLmModelId || undefined);
      await backend.initialize();
      this.activeBackend = backend;
      this.activeBackendType = 'vscodeLM';

      const modelDesc = backend['modelId'] || vscodeLmModelId || 'auto';
      this.logger.info(`Using VS Code LM embeddings (model: ${modelDesc})`);
      vscode.window.showInformationMessage(
        `RAGnarōk: Using VS Code LM embeddings (model: ${modelDesc})`
      );
    } else {
      this.activeBackendType = 'huggingface';
      this.hfBackend = this.getOrCreateHfBackend();
      this.activeBackend = this.hfBackend;
      this.logger.info('Using HuggingFace Transformers.js embeddings');
    }

    this.backendResolved = true;
  }

  private getOrCreateHfBackend(): HuggingFaceBackend {
    if (!this.hfBackend) {
      this.hfBackend = new HuggingFaceBackend(this.modelRegistry);
      this.hfBackend.onModelChanged = (newModel) => {
        EmbeddingService._onModelChanged.emit('modelChanged', newModel);
      };
    }
    return this.hfBackend;
  }

  public resetBackendSelection(): void {
    this.backendResolved = false;
    if (this.activeBackend && this.activeBackendType === 'vscodeLM') {
      this.activeBackend.dispose();
    }
    this.activeBackend = null;
    this.activeBackendType = 'huggingface';
    this.logger.info('Backend selection reset; will re-resolve on next initialization');
  }

  public getActiveBackendType(): 'vscodeLM' | 'huggingface' {
    return this.activeBackendType;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  public async initialize(modelName?: string): Promise<void> {
    try {
      await this.ensureBackend();
    } catch (backendError: any) {
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const setting = config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, 'auto');
      if (setting === 'vscodeLM') {
        throw backendError;
      }
      this.logger.warn(
        `VS Code LM backend initialization failed, falling back to HuggingFace: ${backendError?.message ?? backendError}`
      );
      vscode.window.showWarningMessage(
        `RAGnarōk: VS Code LM embeddings unavailable — falling back to HuggingFace. Reason: ${backendError?.message ?? backendError}`
      );
      this.activeBackendType = 'huggingface';
      this.hfBackend = this.getOrCreateHfBackend();
      this.activeBackend = this.hfBackend;
      this.backendResolved = true;
    }

    // If VS Code LM is active, it's already initialized — done.
    if (this.activeBackendType === 'vscodeLM' && this.activeBackend) {
      this.logger.debug('VS Code LM backend is active; skipping HuggingFace pipeline initialization');
      return;
    }

    // HuggingFace path
    await this.activeBackend!.initialize(modelName);
  }

  // ---------------------------------------------------------------------------
  // Embedding operations (polymorphic dispatch)
  // ---------------------------------------------------------------------------

  public async embed(text: string): Promise<number[]> {
    return this.executeWithFallback(
      (backend) => backend.embed(text),
      'embed'
    );
  }

  public async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void
  ): Promise<number[][]> {
    return this.executeWithFallback(
      (backend) => backend.embedBatch(texts, progressCallback),
      'embedBatch'
    );
  }

  private async executeWithFallback<T>(
    operation: (backend: EmbeddingBackend) => Promise<T>,
    operationName: string
  ): Promise<T> {
    if (this.activeBackendType === 'vscodeLM' && this.activeBackend) {
      try {
        return await operation(this.activeBackend);
      } catch (error: any) {
        if (await this.shouldFallbackToHuggingFace(error)) {
          this.logger.warn(`VS Code LM ${operationName} failed at runtime, falling back to HuggingFace: ${error?.message}`);
          vscode.window.showWarningMessage(
            `RAGnarōk: VS Code LM ${operationName} failed — falling back to HuggingFace. Reason: ${error?.message ?? error}`
          );
          await this.switchToHuggingFace();
        } else {
          throw error;
        }
      }
    }

    if (!this.activeBackend) {
      await this.initialize();
    }
    return operation(this.activeBackend!);
  }

  // ---------------------------------------------------------------------------
  // Similarity helpers
  // ---------------------------------------------------------------------------

  public cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimension');
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
    if (this.activeBackendType === 'vscodeLM' && this.activeBackend) {
      return `vscodeLM:${(this.activeBackend as VscodeLmBackend)['modelId'] || 'auto'}`;
    }
    if (this.hfBackend) {
      return this.hfBackend.getCurrentModel();
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
    return this.modelRegistry.listAvailableModels();
  }

  // ---------------------------------------------------------------------------
  // Cache / lifecycle
  // ---------------------------------------------------------------------------

  public async clearCache(): Promise<void> {
    this.logger.info('Clearing embedding model cache');

    if (this.hfBackend) {
      this.hfBackend.dispose();
      this.hfBackend = null;
    }

    this.resetBackendSelection();

    this.logger.info('Embedding model cache cleared successfully');
    vscode.window.showInformationMessage('Embedding model cache cleared. Model will reload on next use.');
  }

  public dispose(): void {
    this.logger.info('Disposing EmbeddingService');

    if (this.activeBackend) {
      this.activeBackend.dispose();
      this.activeBackend = null;
    }
    if (this.hfBackend) {
      this.hfBackend.dispose();
      this.hfBackend = null;
    }

    this.backendResolved = false;
    this.activeBackendType = 'huggingface';
    this.logger.info('EmbeddingService disposed');
  }

  // ---------------------------------------------------------------------------
  // Runtime fallback helpers
  // ---------------------------------------------------------------------------

  private async shouldFallbackToHuggingFace(_error: any): Promise<boolean> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const setting = config.get<EmbeddingBackendType>(CONFIG.EMBEDDING_BACKEND, 'auto');
    return setting === 'auto';
  }

  private async switchToHuggingFace(): Promise<void> {
    if (this.activeBackend && this.activeBackendType === 'vscodeLM') {
      this.activeBackend.dispose();
    }
    this.activeBackendType = 'huggingface';
    this.hfBackend = this.getOrCreateHfBackend();
    this.activeBackend = this.hfBackend;

    const newModelId = this.hfBackend.getCurrentModel();
    EmbeddingService._onModelChanged.emit('modelChanged', newModelId);
  }
}
