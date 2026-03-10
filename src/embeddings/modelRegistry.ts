/**
 * Model registry for embedding models
 *
 * Handles model discovery, path resolution, and curated model lists.
 * Shared by EmbeddingService and HuggingFaceBackend.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG, DEFAULTS } from '../utils/constants';
import { Logger } from '../utils/logger';

export type AvailableModel = {
  name: string;
  source: 'curated' | 'local';
  downloaded?: boolean;
};

export class ModelRegistry {
  private static instance: ModelRegistry;

  private logger: Logger;
  private resolvedLocalModelPath: string | null = null;
  private bundledModelsRoot: string | null = null;
  private bundledModelsRootChecked: boolean = false;

  // Lazily loaded transformers cache dir (set by HuggingFaceBackend after import)
  private transformersCacheDir: string | null = null;

  static readonly CURATED_MODELS = [
    // Xenova/ namespace — pre-converted ONNX models (most reliable)
    'Xenova/all-MiniLM-L6-v2',           // 384-dim, 23 MB – fast & popular
    'Xenova/all-MiniLM-L12-v2',          // 384-dim, 33 MB – more accurate
    'Xenova/paraphrase-MiniLM-L6-v2',    // 384-dim, 23 MB – paraphrasing
    'Xenova/multi-qa-MiniLM-L6-cos-v1',  // 384-dim, 23 MB – QA / retrieval
    'Xenova/all-distilroberta-v1',        // 768-dim, 82 MB – higher quality
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2', // 384-dim – multilingual
    'Xenova/multi-qa-distilbert-cos-v1',  // 768-dim – QA / retrieval
    'Xenova/bge-small-en-v1.5',           // 384-dim, 33 MB – BAAI
    'Xenova/bge-base-en-v1.5',            // 768-dim, 109 MB – BAAI
    'Xenova/e5-small-v2',                 // 384-dim, 33 MB – Microsoft
    'Xenova/gte-small',                   // 384-dim, 33 MB – Alibaba
    'nomic-ai/nomic-embed-text-v1',       // 768-dim – strong general-purpose (ONNX included)
  ];

  private static readonly DEFAULT_MODEL = ModelRegistry.resolveDefaultModel();

  private constructor() {
    this.logger = new Logger('ModelRegistry');
  }

  public static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  // ---------------------------------------------------------------------------
  // Default model resolution
  // ---------------------------------------------------------------------------

  private static resolveDefaultModel(): string {
    const curatedDefault = ModelRegistry.CURATED_MODELS[0];
    const bundledRoot = path.resolve(__dirname, '../../../assets/models');

    const curatedBundledPath = path.join(bundledRoot, curatedDefault);
    if (fs.existsSync(curatedBundledPath)) {
      return curatedDefault;
    }

    if (fs.existsSync(bundledRoot)) {
      try {
        const owners = fs.readdirSync(bundledRoot, { withFileTypes: true });
        for (const owner of owners) {
          if (!owner.isDirectory()) continue;
          const ownerPath = path.join(bundledRoot, owner.name);
          if (fs.existsSync(path.join(ownerPath, 'config.json')) || fs.existsSync(path.join(ownerPath, 'model.onnx'))) {
            return owner.name;
          }
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
        // Ignore and fall back to curated default
      }
    }

    return curatedDefault;
  }

  public getDefaultModel(): string {
    return ModelRegistry.DEFAULT_MODEL;
  }

  // ---------------------------------------------------------------------------
  // Path resolution
  // ---------------------------------------------------------------------------

  public getBundledModelsRoot(): string | null {
    if (this.bundledModelsRootChecked) {
      return this.bundledModelsRoot;
    }

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
   * If the requested model is bundled with the extension, return its absolute path.
   * Otherwise, return the original model identifier.
   */
  public resolveModelIdentifier(modelName: string): string {
    const bundledRoot = this.getBundledModelsRoot();
    if (bundledRoot) {
      const bundledPath = path.join(bundledRoot, modelName);
      const resolvedBundled = path.resolve(bundledPath);
      const resolvedRoot = path.resolve(bundledRoot);
      if (!resolvedBundled.startsWith(resolvedRoot + path.sep) && resolvedBundled !== resolvedRoot) {
        return modelName; // Don't use bundled path for suspicious model names
      }
      if (fs.existsSync(bundledPath)) {
        this.logger.debug(`Using bundled model for ${modelName} at ${bundledPath}`);
        return bundledPath;
      }
    }
    return modelName;
  }

  /**
   * Resolve the configured local model path (if provided).
   */
  public resolveLocalModelPath(config?: vscode.WorkspaceConfiguration): string | null {
    const cfg = config ?? vscode.workspace.getConfiguration(CONFIG.ROOT);
    const configuredPath = (cfg.get<string>(CONFIG.LOCAL_MODEL_PATH, DEFAULTS.LOCAL_MODEL_PATH) ?? '').trim();
    if (!configuredPath) {
      return null;
    }

    const expandedPath = configuredPath.replace(/^~(?=$|\/|\\)/, os.homedir());
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalizedPath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(workspaceFolder ?? process.cwd(), expandedPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Local embedding model path "${configuredPath}" does not exist (resolved to "${normalizedPath}")`);
    }

    this.resolvedLocalModelPath = normalizedPath;
    return normalizedPath;
  }

  /**
   * Invalidate the cached local model path so it is re-resolved on next access.
   */
  public invalidateLocalModelPathCache(): void {
    this.resolvedLocalModelPath = null;
  }

  /**
   * Get the currently resolved local model path, or null.
   */
  public getResolvedLocalModelPath(): string | null {
    if (this.resolvedLocalModelPath) return this.resolvedLocalModelPath;
    try {
      return this.resolveLocalModelPath();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------

  private isModelDirectory(dir: string): boolean {
    const markerFiles = ['config.json', 'tokenizer.json', 'pytorch_model.bin', 'model.onnx'];
    return markerFiles.some((file) => fs.existsSync(path.join(dir, file)));
  }

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

  public async listLocalModels(): Promise<string[]> {
    try {
      const resolved = this.resolveLocalModelPath();
      if (!resolved) return [];
      return await this.discoverModels(resolved);
    } catch (err: any) {
      this.logger.warn('Failed to list local models', err?.message ?? err);
      return [];
    }
  }

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
   * Set the transformers cache directory (called by HuggingFaceBackend after loading transformers).
   */
  public setTransformersCacheDir(dir: string | null): void {
    this.transformersCacheDir = dir;
  }

  private async listDownloadedRemoteModels(): Promise<string[]> {
    try {
      const cacheDir = this.transformersCacheDir;
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
   * Combine curated, bundled, local, and downloaded models into a unified list.
   */
  public async listAvailableModels(): Promise<AvailableModel[]> {
    const available: AvailableModel[] = [];
    const downloaded = new Set(await this.listDownloadedRemoteModels());
    const bundled = new Set(await this.listBundledModels());
    const localModels = new Set(await this.listLocalModels());

    for (const name of ModelRegistry.CURATED_MODELS) {
      const isBundled = bundled.has(name);
      const isLocal = localModels.has(name);
      available.push({
        name,
        source: isBundled || isLocal ? 'local' : 'curated',
        downloaded: downloaded.has(name) || isBundled || isLocal,
      });
    }

    for (const name of bundled) {
      if (ModelRegistry.CURATED_MODELS.includes(name)) continue;
      available.push({ name, source: 'local', downloaded: true });
    }

    for (const name of localModels) {
      if (available.some((m) => m.name === name)) continue;
      available.push({ name, source: 'local', downloaded: true });
    }

    return available;
  }
}
