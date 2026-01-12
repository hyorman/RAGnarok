/**
 * Embedding service using Transformers.js for local sentence transformers
 * Refactored with async-mutex to prevent race conditions
 *
 * Features:
 * - Local embedding generation using HuggingFace Transformers.js
 * - Multiple similarity metrics via LangChain (cosine, euclidean, inner product)
 * - Cross-platform WASM backend for ONNX models
 * - Batch processing with progress tracking
 *
 * Note: @huggingface/transformers is dynamically imported because it's an ESM-only package
 * and VS Code extensions run in CommonJS mode. Dynamic import() allows us to load ESM packages
 * at runtime without TypeScript compilation errors.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import { EventEmitter } from 'events';
// Alias LangChain math helpers to avoid name collisions with class methods
import { cosineSimilarity as langchainCosineSimilarity, euclideanDistance as langchainEuclideanDistance, innerProduct as langchainInnerProduct } from '@langchain/core/utils/math';
import { CONFIG, DEFAULTS } from '../utils/constants';
import { Logger } from '../utils/logger';

// Type definitions for the dynamically imported transformers module
type TransformersModule = any; // Dynamic import type - resolved at runtime
type FeatureExtractionPipeline = any;
export type AvailableModel = {
  name: string;
  source: 'curated' | 'local';
  downloaded?: boolean;
};

export class EmbeddingService {
  private static instance: EmbeddingService;
  private static resolveDefaultModel(): string {
    const curatedDefault = EmbeddingService.CURATED_MODELS[0];
    const bundledRoot = path.resolve(__dirname, '../../../assets/models');

    // Prefer the curated default if it is bundled with the extension
    const curatedBundledPath = path.join(bundledRoot, curatedDefault);
    if (fs.existsSync(curatedBundledPath)) {
      return curatedDefault;
    }

    // Otherwise, pick the first model folder we find under assets/models (flat or owner/model)
    if (fs.existsSync(bundledRoot)) {
      try {
        const owners = fs.readdirSync(bundledRoot, { withFileTypes: true });
        for (const owner of owners) {
          if (!owner.isDirectory()) continue;
          const ownerPath = path.join(bundledRoot, owner.name);
          // Flat layout: assets/models/<model>
          const flatPath = ownerPath;
          if (fs.existsSync(path.join(flatPath, 'config.json')) || fs.existsSync(path.join(flatPath, 'model.onnx'))) {
            return owner.name;
          }

          // Nested layout: assets/models/<owner>/<model>
          const models = fs.readdirSync(ownerPath, { withFileTypes: true });
          for (const model of models) {
            if (!model.isDirectory()) continue;
            const modelPath = path.join(ownerPath, model.name);
            if (fs.existsSync(path.join(modelPath, 'config.json')) || fs.existsSync(path.join(modelPath, 'model.onnx'))) {
              return `${owner.name}/${model.name}`;
            }
          }
        }
      } catch {
        // Ignore errors and fall back to curated default
      }
    }

    return curatedDefault;
  }
  private static readonly CURATED_MODELS = [
    'Xenova/all-MiniLM-L6-v2',
    'Xenova/all-MiniLM-L12-v2',
    'Xenova/paraphrase-MiniLM-L6-v2',
    'Xenova/multi-qa-MiniLM-L6-cos-v1',
  ];
  private static readonly DEFAULT_MODEL = EmbeddingService.resolveDefaultModel();
  private pipeline: FeatureExtractionPipeline | null = null;
  private currentModel: string = EmbeddingService.DEFAULT_MODEL;
  private lastSuccessfulModel: string | null = null;
  private initMutex: Mutex = new Mutex();
  private initPromise: Promise<void> | null = null;
  private logger: Logger;
  private transformers: TransformersModule | null = null;
  // Cache resolved local model path to avoid repeated resolution
  private resolvedLocalModelPath: string | null = null;
  // Cache bundled model root (if present in packaged extension)
  private bundledModelsRoot: string | null = null;
  private bundledModelsRootChecked: boolean = false;

  // Event emitter for model changes
  private static readonly _onModelChanged = new EventEmitter();

  /**
   * Event that fires when the embedding model changes.
   * Listeners can subscribe to refresh UI or update dependent components.
   */
  public static readonly onModelChanged = {
    /**
     * Register a listener for model change events
     * @param listener Callback that receives the new model name
     * @returns A disposable to unregister the listener
     */
    subscribe(listener: (newModel: string) => void): vscode.Disposable {
      EmbeddingService._onModelChanged.on('modelChanged', listener);
      return new vscode.Disposable(() => {
        EmbeddingService._onModelChanged.off('modelChanged', listener);
      });
    }
  };

  private constructor() {
    this.logger = new Logger('EmbeddingService');
  }

  /**
   * Get the currently configured local model base path, if any.
   * Returns null when the config is unset or invalid.
   */
  public getLocalModelPath(): string | null {
    return this.resolvedLocalModelPath;
  }

  /**
   * Resolve the path where bundled models would live inside the packaged extension
   */
  private getBundledModelsRoot(): string | null {
    if (this.bundledModelsRootChecked) {
      return this.bundledModelsRoot;
    }

    // Compiled file lives under <extensionRoot>/out/src/embeddings
    const candidate = path.resolve(__dirname, '../../../assets/models');
    this.bundledModelsRootChecked = true;

    if (fs.existsSync(candidate)) {
      this.bundledModelsRoot = candidate;
      this.logger.info(`Detected bundled models at ${candidate}`);
    } else {
      this.bundledModelsRoot = null;
      this.logger.debug(`No bundled models found at ${candidate}`);
    }

    return this.bundledModelsRoot;
  }

  /**
   * Check if a directory contains model artifacts (config/tokenizer/weights)
   */
  private isModelDirectory(dir: string): boolean {
    const markerFiles = [
      'config.json',
      'tokenizer.json',
      'pytorch_model.bin',
      'model.onnx',
    ];

    return markerFiles.some((file) => fs.existsSync(path.join(dir, file)));
  }

  /**
   * Discover models in the provided base directory.
   * Supports both flat (model/) and owner/model/ layouts.
   */
  private async discoverModels(basePath: string): Promise<string[]> {
    const models: string[] = [];
    const entries = await fs.promises.readdir(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(basePath, entry.name);

      if (this.isModelDirectory(entryPath)) {
        models.push(entry.name);
        continue;
      }

      // Look one level deeper for HuggingFace-style owner/model layout
      let subEntries: fs.Dirent[] = [];
      try {
        subEntries = await fs.promises.readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subPath = path.join(entryPath, sub.name);
        if (this.isModelDirectory(subPath)) {
          models.push(`${entry.name}/${sub.name}`);
        }
      }
    }

    return models.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Dynamically import and configure the transformers module
   * This is done lazily to avoid CommonJS/ESM compatibility issues
   */
  private async loadTransformers(): Promise<TransformersModule> {
    if (this.transformers) {
      return this.transformers;
    }

    this.transformers = await import('@huggingface/transformers');
    const { env } = this.transformers;

    // Configure transformers.js environment for cross-platform compatibility
    env.allowLocalModels = true;
    env.allowRemoteModels = true; // Allow downloading models from HuggingFace
    env.useBrowserCache = false;

    // Use WebAssembly backend for ONNX (cross-platform ML inference)
    env.backends = {
      onnx: {
        wasm: { proxy: false, numThreads: 2 }, // Increased to 2 threads for better performance
      }
    };

    // If the extension has a configured local model base path, set it so
    // transformers.js can resolve short model names (e.g. 'my-model' -> `${localModelPath}/my-model`).
    let localModelPath: string | null = null;
    try {
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      localModelPath = this.resolveLocalModelPath(config);
    } catch (err: any) {
      // Don't fail initialization just because the configured path is invalid; log and continue
      this.logger.warn('Could not set transformers env.localModelPath from config:', err?.message ?? err);
    }

    // Fallback to bundled models when no local path is configured
    if (!localModelPath) {
      localModelPath = this.getBundledModelsRoot();
    }

    if (localModelPath) {
      env.localModelPath = localModelPath;
      this.resolvedLocalModelPath = localModelPath;
      this.logger.info(`Transformers env.localModelPath set to ${localModelPath}`);
    }

    this.logger.info('EmbeddingService configured: WASM backend (ONNX), Sharp enabled (image processing)');
    return this.transformers;
  }

  /**
   * List local models inside the configured local model path.
   * Returns an array of model identifiers (directory names). If the configured
   * path is empty or invalid, returns an empty array.
   */
  public async listLocalModels(): Promise<string[]> {
    try {
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const resolved = this.resolveLocalModelPath(config);
      // Cache resolved path for other callers
      this.resolvedLocalModelPath = resolved;

      if (!resolved) return [];

      return await this.discoverModels(resolved);
    } catch (err: any) {
      this.logger.warn('Failed to list local models', err?.message ?? err);
      return [];
    }
  }

  /**
   * List models that are bundled with the extension package (if present)
   */
  private async listBundledModels(): Promise<string[]> {
    try {
      const bundledRoot = this.getBundledModelsRoot();
      if (!bundledRoot) return [];

      return await this.discoverModels(bundledRoot);
    } catch (err: any) {
      this.logger.warn('Failed to list bundled models', err?.message ?? err);
      return [];
    }
  }

  /**
   * List remote models that have already been downloaded to the transformers cache directory.
   */
  private async listDownloadedRemoteModels(): Promise<string[]> {
    try {
      const transformers = await this.loadTransformers();
      const cacheDir = transformers?.env?.cacheDir;
      if (!cacheDir) return [];

      const normalizedCacheDir = path.isAbsolute(cacheDir)
        ? cacheDir
        : path.resolve(cacheDir);

      if (!fs.existsSync(normalizedCacheDir)) {
        this.logger.debug(`Transformers cache directory not found at ${normalizedCacheDir}`);
        return [];
      }

      const ownerEntries = await fs.promises.readdir(normalizedCacheDir, { withFileTypes: true });
      const downloadedModels: string[] = [];

      for (const owner of ownerEntries) {
        if (!owner.isDirectory()) continue;

        const ownerPath = path.join(normalizedCacheDir, owner.name);
        try {
          const modelEntries = await fs.promises.readdir(ownerPath, { withFileTypes: true });
          for (const model of modelEntries) {
            if (model.isDirectory()) {
              downloadedModels.push(`${owner.name}/${model.name}`);
            }
          }
        } catch (err: any) {
          // Skip folders we cannot read but keep processing the rest
          this.logger.debug(`Unable to inspect cached models under ${ownerPath}`, err?.message ?? err);
        }
      }

      return downloadedModels.sort((a, b) => a.localeCompare(b));
    } catch (err: any) {
      this.logger.warn('Failed to list downloaded remote models', err?.message ?? err);
      return [];
    }
  }

  /**
   * Combine configured local models with any remote models already downloaded to disk.
   */
  public async listAvailableModels(): Promise<AvailableModel[]> {
    const available: AvailableModel[] = [];
    const downloaded = new Set(await this.listDownloadedRemoteModels());
    const bundled = new Set(await this.listBundledModels());
    const localModels = new Set(await this.listLocalModels());

    for (const name of EmbeddingService.CURATED_MODELS) {
      const isBundled = bundled.has(name);
      const isLocal = localModels.has(name);
      available.push({
        name,
        source: isBundled || isLocal ? 'local' : 'curated',
        downloaded: downloaded.has(name) || isBundled || isLocal,
      });
    }

    // Include any bundled models that are not part of the curated list
    for (const name of bundled) {
      if (EmbeddingService.CURATED_MODELS.includes(name)) {
        continue;
      }
      available.push({ name, source: 'local', downloaded: true });
    }

    for (const name of localModels) {
      if (available.some((m) => m.name === name)) {
        continue; // Avoid duplicates when the local model matches a curated or bundled model
      }
      available.push({ name, source: 'local', downloaded: true });
    }

    return available;
  }

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /**
   * Resolve the configured local model path (if provided)
   */
  private resolveLocalModelPath(config: vscode.WorkspaceConfiguration): string | null {
    const configuredPath = (config.get<string>(CONFIG.LOCAL_MODEL_PATH, DEFAULTS.LOCAL_MODEL_PATH) ?? '').trim();
    if (!configuredPath) {
      return null;
    }

    // Support tilde expansion for convenience
    const expandedPath = configuredPath.replace(/^~(?=$|\/|\\)/, os.homedir());

    // Relative paths are resolved against the first workspace folder if available
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalizedPath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(workspaceFolder ?? process.cwd(), expandedPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Local embedding model path "${configuredPath}" does not exist (resolved to "${normalizedPath}")`);
    }

    return normalizedPath;
  }

  /**
   * If the requested model is bundled with the extension, return its absolute path.
   * Otherwise, return the original model identifier.
   */
  private resolveModelIdentifier(modelName: string): string {
    const bundledRoot = this.getBundledModelsRoot();
    if (bundledRoot) {
      const bundledPath = path.join(bundledRoot, modelName);
      if (fs.existsSync(bundledPath)) {
        this.logger.debug(`Using bundled model for ${modelName} at ${bundledPath}`);
        return bundledPath;
      }
    }

    return modelName;
  }

  /**
   * Initialize the embedding model with mutex to prevent race conditions
   * @param modelName - Optional explicit embedding model name
   */
  public async initialize(modelName?: string): Promise<void> {

    // Priority:
    // 1. Explicit parameter (for programmatic control, tests)
    // 2. Currently loaded model (avoid unnecessary reloads)
    // 3. Default model (fallback)
    const targetModel =
      modelName ??
      (this.pipeline ? this.currentModel : null) ??
      EmbeddingService.DEFAULT_MODEL;

    try {
      await this.initializeModel(targetModel);
    } catch (error) {
      const isConfigDrivenAttempt = !modelName;

      if (isConfigDrivenAttempt) {
        const fallbackModel = this.lastSuccessfulModel ?? EmbeddingService.DEFAULT_MODEL;

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

  private async initializeModel(targetModel: string): Promise<void> {
    // Already initialized with the same model
    if (this.pipeline && this.currentModel === targetModel) {
      this.logger.debug(`Model ${targetModel} already initialized`);
      return;
    }

    // Use mutex to prevent concurrent initializations
    await this.initMutex.runExclusive(async () => {
      // Double-check after acquiring lock
      if (this.pipeline && this.currentModel === targetModel) {
        this.logger.debug(`Model ${targetModel} initialized while waiting for lock`);
        return;
      }

      // Wait for existing initialization if in progress
      if (this.initPromise) {
        this.logger.debug('Waiting for existing initialization to complete');
        await this.initPromise;
        // Check if initialization succeeded and we have the right model
        if (this.pipeline && this.currentModel === targetModel) {
          return;
        }
      }

      // Start new initialization
      this.logger.info(`Initializing embedding model: ${targetModel}`);
      this.initPromise = this._initializePipeline(targetModel);

      try {
        await this.initPromise;
        this.logger.info(`Successfully initialized model: ${targetModel}`);
      } catch (error) {
        this.logger.error(`Failed to initialize model: ${targetModel}`, error);
        throw error;
      } finally {
        this.initPromise = null;
      }
    });
  }

  private async _initializePipeline(modelName: string): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    // Load transformers module
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

            const resolvedModelName = this.resolveModelIdentifier(modelName);

            // Create the feature extraction pipeline
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

        // Notify listeners if the model actually changed
        if (previousModel !== modelName) {
          this.logger.debug(`Model changed from "${previousModel}" to "${modelName}", firing event`);
          EmbeddingService._onModelChanged.emit('modelChanged', modelName);
        }

        // Success - exit retry loop
        return;

      } catch (error: any) {
        lastError = error;
        this.logger.warn(`Initialization attempt ${attempt} failed:`, error.message);

        // Clean up failed state - keep currentModel unchanged during retries
        this.pipeline = null;

        // Don't retry on last attempt
        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          this.logger.debug(`Waiting ${backoffMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // All retries failed
    this.logger.error('All initialization attempts failed', lastError);
    const errorMsg = lastError?.message || String(lastError);
    throw new Error(`Failed to initialize embedding model "${modelName}" after ${maxRetries} attempts: ${errorMsg}`);
  }

  /**
   * Truncate text to fit within model's token limit
   * Most models use ~256 word pieces, which is roughly 512-768 characters
   * We'll be conservative and truncate at 512 characters to be safe
   */
  private truncateText(text: string, maxChars: number = 512): string {
    if (text.length <= maxChars) {
      return text;
    }

    // Truncate and add ellipsis
    return text.substring(0, maxChars - 3) + '...';
  }

  /**
   * Generate embeddings for a single text
   */
  public async embed(text: string): Promise<number[]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    try {
      // Truncate text to fit model's limit (256 word pieces ~= 512 chars)
      const truncatedText = this.truncateText(text);

      // Generate embedding
      const output = await this.pipeline(truncatedText, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert to regular array
      const embedding = Array.from((output as any).data) as number[];
      this.logger.debug(`Generated embedding with dimension: ${embedding.length}`);
      return embedding;
    } catch (error) {
      this.logger.error('Failed to generate embedding', error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in batch with progress reporting
   */
  public async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void
  ): Promise<number[][]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    this.logger.debug(`Generating embeddings for ${texts.length} texts`);

    try {
      const embeddings: number[][] = [];

      // Process in batches to avoid memory issues
      // Smaller batches but parallelized for much better performance
      const batchSize = 1000; // Process 1000 at a time in parallel

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);

        // Log progress for large batches
        if (texts.length > 100) {
          const progressPercent = Math.round(((i + batch.length) / texts.length) * 100);
          this.logger.info(`Generating embeddings: ${i + batch.length}/${texts.length} (${progressPercent}%)`);
        }

        // Process batch in parallel for MUCH faster performance
        const batchPromises = batch.map(async (text) => {
          // Truncate text to fit model's limit (256 word pieces ~= 512 chars)
          const truncatedText = this.truncateText(text);

          const output = await this.pipeline!(truncatedText, {
            pooling: 'mean',
            normalize: true,
          });
          return Array.from((output as any).data) as number[];
        });

        const batchEmbeddings = await Promise.all(batchPromises);
        embeddings.push(...batchEmbeddings);

        // Report progress
        if (progressCallback) {
          progressCallback(embeddings.length / texts.length);
        }

        // Allow garbage collection between batches
        if (i + batchSize < texts.length) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      this.logger.debug(`Successfully generated ${embeddings.length} embeddings`);
      return embeddings;
    } catch (error) {
      this.logger.error('Failed to generate batch embeddings', error);
      throw new Error(`Failed to generate batch embeddings: ${error}`);
    }
  }

  /**
   * Calculate cosine similarity between two embeddings using LangChain's implementation
   */
  public cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    // LangChain's cosineSimilarity works on matrices, so wrap vectors in arrays
    const result = langchainCosineSimilarity([a], [b]);
    return result[0][0];
  }

  /**
   * Calculate Euclidean distance between two embeddings using LangChain's implementation
    * Note: the LangChain helper is imported as `langchainEuclideanDistance` to
    * avoid confusion with this class method name.
   */
  public euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    // LangChain's euclideanDistance works on matrices, so wrap vectors in arrays
    const result = langchainEuclideanDistance([a], [b]);
    return result[0][0];
  }

  /**
   * Calculate inner product (dot product) between two embeddings using LangChain's implementation
    * Note: the LangChain helper is imported as `langchainInnerProduct` to
    * avoid confusion with this class method name.
   */
  public innerProduct(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    // LangChain's innerProduct works on matrices, so wrap vectors in arrays
    const result = langchainInnerProduct([a], [b]);
    return result[0][0];
  }

  /**
   * Get the current model name
   * Returns the name of the model that is currently loaded or will be loaded on next initialization.
   * Returns the default model name if no specific model has been set.
   */
  public getCurrentModel(): string {
    return this.currentModel;
  }

  /**
   * Clear the model cache and reset
   */
  public async clearCache(): Promise<void> {
    const previousModel = this.currentModel;
    this.logger.info('Clearing embedding model cache', { previousModel });

    this.pipeline = null;
    // Reset to default model name so next initialization knows what to use
    this.currentModel = EmbeddingService.DEFAULT_MODEL;
    this.lastSuccessfulModel = null;

    this.logger.info('Embedding model cache cleared successfully');
    vscode.window.showInformationMessage('Embedding model cache cleared. Model will reload on next use.');
  }

  /**
   * Dispose of all resources and clean up
   * Should be called when the service is no longer needed
   */
  public dispose(): void {
    this.logger.info('Disposing EmbeddingService');

    // Clear pipeline
    this.pipeline = null;
    // Reset to default model name for consistency
    this.currentModel = EmbeddingService.DEFAULT_MODEL;
    this.lastSuccessfulModel = null;

    // Clear transformers module reference
    this.transformers = null;

    // Clear initialization promise
    this.initPromise = null;

    this.logger.info('EmbeddingService disposed');
  }
}
