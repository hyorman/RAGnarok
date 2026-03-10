/**
 * HuggingFace Transformers.js embedding backend
 *
 * Uses @huggingface/transformers with ONNX/WASM inference for local
 * embedding computation. Supports bundled, local, and remote models.
 *
 * Note: @huggingface/transformers is dynamically imported because it's an ESM-only
 * package and VS Code extensions run in CommonJS mode.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import { EmbeddingBackend } from './embeddingBackend';
import { ModelRegistry } from './modelRegistry';
import { CONFIG } from '../utils/constants';
import { Logger } from '../utils/logger';

// Type definitions for the dynamically imported transformers module
type TransformersModule = any;
type FeatureExtractionPipeline = any;

/**
 * HuggingFace Transformers.js backend implementing {@link EmbeddingBackend}.
 *
 * Loads ONNX models via WASM for cross-platform local inference.
 */
export class HuggingFaceBackend implements EmbeddingBackend {
  readonly name = 'huggingface' as const;

  private pipeline: FeatureExtractionPipeline | null = null;
  private currentModel: string;
  private lastSuccessfulModel: string | null = null;
  private initMutex: Mutex = new Mutex();
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;
  private logger: Logger;
  private transformers: TransformersModule | null = null;
  private dimension: number | null = null;

  /** Callback fired when the model changes (used by EmbeddingService for event emission). */
  public onModelChanged?: (newModel: string) => void;

  constructor(
    private modelRegistry: ModelRegistry,
    initialModel?: string,
  ) {
    this.currentModel = initialModel ?? modelRegistry.getDefaultModel();
    this.logger = new Logger('HuggingFaceBackend');
  }

  // ---------------------------------------------------------------------------
  // EmbeddingBackend interface
  // ---------------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    // HuggingFace/WASM is always available as a fallback
    return true;
  }

  async initialize(modelName?: string): Promise<void> {
    const targetModel =
      modelName ??
      (this.pipeline ? this.currentModel : null) ??
      this.modelRegistry.getDefaultModel();

    try {
      await this.initializeModel(targetModel);
    } catch (error) {
      const isConfigDrivenAttempt = !modelName;

      if (isConfigDrivenAttempt) {
        const fallbackModel = this.lastSuccessfulModel ?? this.modelRegistry.getDefaultModel();

        if (fallbackModel && fallbackModel !== targetModel) {
          const fallbackReason = this.lastSuccessfulModel
            ? `previously downloaded model "${fallbackModel}"`
            : `default model "${fallbackModel}"`;
          const message = `RAGnarōk: Model "${targetModel}" could not be loaded. Falling back to ${fallbackReason}.`;
          this.logger.warn(message);
          vscode.window.showWarningMessage(message);

          await this.initializeModel(fallbackModel);
          return;
        }
      }

      throw error;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    try {
      const truncatedText = this.truncateText(text);
      const output = await this.pipeline(truncatedText, {
        pooling: 'mean',
        normalize: true,
      });

      const embedding = Array.from((output as any).data) as number[];
      this.dimension = embedding.length;
      this.logger.debug(`Generated embedding with dimension: ${embedding.length}`);
      return embedding;
    } catch (error) {
      this.logger.error('Failed to generate embedding', error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void
  ): Promise<number[][]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    if (texts.length === 0) {
      return [];
    }

    this.logger.debug(`Generating embeddings for ${texts.length} texts`);

    try {
      const embeddings: number[][] = [];
      const batchSize = 1000;
      let processedCount = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);

        if (texts.length > 100) {
          const progressPercent = Math.round(((i + batch.length) / texts.length) * 100);
          this.logger.info(`Generating embeddings: ${i + batch.length}/${texts.length} (${progressPercent}%)`);
        }

        const batchPromises = batch.map(async (text) => {
          const truncatedText = this.truncateText(text);
          const output = await this.pipeline!(truncatedText, {
            pooling: 'mean',
            normalize: true,
          });
          return Array.from((output as any).data) as number[];
        });

        const batchEmbeddings = await Promise.all(batchPromises);
        embeddings.push(...batchEmbeddings);
        processedCount += batchEmbeddings.length;

        if (progressCallback) {
          progressCallback(Math.min(1.0, processedCount / texts.length));
        }

        if (i + batchSize < texts.length) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      if (embeddings.length > 0) {
        this.dimension = embeddings[0].length;
      }

      if (embeddings.length > 1) {
        const expectedDim = embeddings[0].length;
        for (let i = 1; i < embeddings.length; i++) {
          if (embeddings[i].length !== expectedDim) {
            throw new Error(
              `Inconsistent embedding dimensions: expected ${expectedDim}, got ${embeddings[i].length} at index ${i}`
            );
          }
        }
      }

      this.logger.debug(`Successfully generated ${embeddings.length} embeddings`);
      return embeddings;
    } catch (error) {
      this.logger.error('Failed to generate batch embeddings', error);
      throw new Error(`Failed to generate batch embeddings: ${error}`);
    }
  }

  getDimension(): number | null {
    return this.dimension;
  }

  dispose(): void {
    this.pipeline = null;
    this.currentModel = this.modelRegistry.getDefaultModel();
    this.lastSuccessfulModel = null;
    this.transformers = null;
    this.initPromise = null;
    this.dimension = null;
    this.logger.info('HuggingFaceBackend disposed');
  }

  // ---------------------------------------------------------------------------
  // Public accessors (used by EmbeddingService)
  // ---------------------------------------------------------------------------

  /** Get the currently loaded model identifier. */
  public getCurrentModel(): string {
    return this.currentModel;
  }

  // ---------------------------------------------------------------------------
  // Pipeline initialization
  // ---------------------------------------------------------------------------

  private async initializeModel(targetModel: string): Promise<void> {
    if (this.pipeline && this.currentModel === targetModel) {
      this.logger.debug(`Model ${targetModel} already initialized`);
      return;
    }

    await this.initMutex.runExclusive(async () => {
      if (this.initError) {
        throw this.initError;
      }

      if (this.pipeline && this.currentModel === targetModel) {
        this.logger.debug(`Model ${targetModel} initialized while waiting for lock`);
        return;
      }

      if (this.initPromise) {
        this.logger.debug('Waiting for existing initialization to complete');
        await this.initPromise;
        if (this.pipeline && this.currentModel === targetModel) {
          return;
        }
      }

      this.logger.info(`Initializing embedding model: ${targetModel}`);
      this.initPromise = this._initializePipeline(targetModel);

      try {
        await this.initPromise;
        this.logger.info(`Successfully initialized model: ${targetModel}`);
      } catch (error) {
        this.initError = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`Failed to initialize model: ${targetModel}`, error);
        throw this.initError;
      } finally {
        this.initPromise = null;
      }
    });
  }

  private async _initializePipeline(modelName: string): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    const transformers = await this.loadTransformers();
    const { pipeline } = transformers;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Loading embedding model: ${modelName}${attempt > 1 ? ` (Attempt ${attempt}/${maxRetries})` : ''}`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: 'Downloading and initializing...' });

            const resolvedModelName = this.modelRegistry.resolveModelIdentifier(modelName);

            this.pipeline = await pipeline('feature-extraction', resolvedModelName, {
              progress_callback: (progressData: any) => {
                if (progressData.status === 'progress' && progressData.progress) {
                  const percent = Math.round(progressData.progress);
                  progress.report({
                    message: `${progressData.file || 'Model'}: ${percent}%`,
                    increment: 1
                  });
                }
              }
            });

            // Validate the pipeline by testing with dummy text
            await this.pipeline('test', { pooling: 'mean', normalize: true });

            progress.report({ message: 'Model loaded successfully!' });
          }
        );

        const previousModel = this.currentModel;
        this.currentModel = modelName;
        this.lastSuccessfulModel = modelName;
        this.logger.info(`Embedding model initialized successfully: ${modelName}`);

        if (previousModel !== modelName) {
          this.logger.debug(`Model changed from "${previousModel}" to "${modelName}", firing event`);
          this.onModelChanged?.(modelName);
        }

        return;
      } catch (error: any) {
        lastError = error;
        this.logger.warn(`Initialization attempt ${attempt} failed:`, error.message);
        this.pipeline = null;

        if (attempt < maxRetries) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          this.logger.debug(`Waiting ${backoffMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    this.logger.error('All initialization attempts failed', lastError);
    const errorMsg = lastError?.message || String(lastError);
    throw new Error(`Failed to initialize embedding model "${modelName}" after ${maxRetries} attempts: ${errorMsg}`);
  }

  // ---------------------------------------------------------------------------
  // Transformers.js loader
  // ---------------------------------------------------------------------------

  private async loadTransformers(): Promise<TransformersModule> {
    if (this.transformers) {
      return this.transformers;
    }

    this.transformers = await import('@huggingface/transformers');
    this.configureTransformersEnvironment(this.transformers);

    this.logger.info('HuggingFaceBackend configured: WASM backend (ONNX)');
    return this.transformers;
  }

  private configureTransformersEnvironment(transformers: TransformersModule): void {
    const { env } = transformers;

    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;

    env.backends = {
      onnx: {
        wasm: { proxy: false, numThreads: 2 },
      }
    };

    // Set local model path from ModelRegistry
    const localModelPath = this.modelRegistry.getResolvedLocalModelPath() ?? this.modelRegistry.getBundledModelsRoot();

    if (localModelPath) {
      env.localModelPath = localModelPath;
      this.logger.info(`Transformers env.localModelPath set to ${localModelPath}`);
    }

    const cacheDir = typeof env.cacheDir === 'string' && env.cacheDir.trim().length > 0
      ? env.cacheDir
      : null;
    this.modelRegistry.setTransformersCacheDir(cacheDir);

    if (cacheDir) {
      this.logger.info(`Transformers env.cacheDir set to ${cacheDir}`);
    } else {
      this.logger.debug('Transformers env.cacheDir unavailable; downloaded-model detection may be incomplete');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private truncateText(text: string, maxChars: number = 512): string {
    if (text.length <= maxChars) {
      return text;
    }
    return text.substring(0, maxChars - 3) + '...';
  }
}
