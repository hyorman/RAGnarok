/**
 * Model registry for cross-encoder reranker models
 *
 * Handles model discovery, path resolution, and curated model lists.
 */

import * as fs from "fs";
import * as path from "path";
import { Logger } from "../logger.js";
import { findAssetsModelsDir, isModelDirectory } from "./findAssetsModelsDir.js";

export type AvailableRerankerModel = {
  name: string;
  source: "curated" | "bundled";
  downloaded?: boolean;
};

export class RerankerModelRegistry {
  private static instance: RerankerModelRegistry;
  private logger: Logger;
  private bundledModelsRoot: string | null = null;
  private bundledModelsRootChecked = false;

  /**
   * Curated list of known cross-encoder reranker models.
   * Ordered by recommended default first.
   */
  static readonly CURATED_MODELS: string[] = [
    "Xenova/ms-marco-MiniLM-L-6-v2", // Default — 23 MB, fast, good accuracy
    "Xenova/ms-marco-MiniLM-L-12-v2", // 33 MB, better accuracy, slower
    "Xenova/ms-marco-TinyBERT-L-2-v2", // ~11 MB, fastest, lower accuracy
    "cross-encoder/ms-marco-MiniLM-L-6-v2", // Original HF namespace
  ];

  private constructor() {
    this.logger = new Logger("RerankerModelRegistry");
  }

  static getInstance(): RerankerModelRegistry {
    if (!RerankerModelRegistry.instance) {
      RerankerModelRegistry.instance = new RerankerModelRegistry();
    }
    return RerankerModelRegistry.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    RerankerModelRegistry.instance = undefined as any;
  }

  getDefaultModel(): string {
    // Prefer first bundled model, fall back to first curated
    const bundled = this.listBundledModels();
    if (bundled.length > 0) {
      return bundled[0];
    }
    return RerankerModelRegistry.CURATED_MODELS[0];
  }

  getBundledModelsRoot(): string | null {
    if (this.bundledModelsRootChecked) {
      return this.bundledModelsRoot;
    }
    this.bundledModelsRoot = findAssetsModelsDir();
    this.bundledModelsRootChecked = true;
    if (this.bundledModelsRoot) {
      this.logger.info(`Bundled models root: ${this.bundledModelsRoot}`);
    }
    return this.bundledModelsRoot;
  }

  /**
   * Resolve a model identifier to a local path if bundled, else return as-is.
   * Throws on path traversal attempts.
   */
  resolveModelIdentifier(modelName: string): string {
    if (modelName.includes("..") || path.isAbsolute(modelName)) {
      throw new Error(`Invalid model name (path traversal blocked): ${modelName}`);
    }

    const root = this.getBundledModelsRoot();
    if (root) {
      const localPath = path.join(root, modelName);
      if (fs.existsSync(localPath) && isModelDirectory(localPath)) {
        this.logger.info("Resolved to bundled model", { modelName, path: localPath });
        return localPath;
      }
    }
    return modelName;
  }

  /**
   * List models bundled in assets/models/ that look like cross-encoder models.
   * Cross-encoder models are identified by having a config.json with
   * "ForSequenceClassification" in the architectures field.
   */
  listBundledModels(): string[] {
    const root = this.getBundledModelsRoot();
    if (!root) {
      return [];
    }

    const models: string[] = [];
    try {
      // Scan org-name/model-name structure (e.g., Xenova/ms-marco-MiniLM-L-6-v2)
      const orgs = fs.readdirSync(root);
      for (const org of orgs) {
        const orgPath = path.join(root, org);
        if (!fs.statSync(orgPath).isDirectory()) continue;

        const entries = fs.readdirSync(orgPath);
        for (const entry of entries) {
          const entryPath = path.join(orgPath, entry);
          if (!fs.statSync(entryPath).isDirectory()) continue;
          if (!isModelDirectory(entryPath)) continue;

          // Check if it's a cross-encoder (sequence classification) model
          const configPath = path.join(entryPath, "config.json");
          if (fs.existsSync(configPath)) {
            try {
              const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
              const archs = config.architectures ?? [];
              if (archs.some((a: string) => a.includes("ForSequenceClassification"))) {
                models.push(`${org}/${entry}`);
              }
            } catch {
              // Skip malformed config
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn("Failed to scan bundled models", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return models;
  }

  /**
   * List all available reranker models (curated + bundled).
   */
  listAvailableModels(): AvailableRerankerModel[] {
    const models: AvailableRerankerModel[] = [];
    const seen = new Set<string>();

    // Add bundled models first (they're ready to use)
    const bundled = this.listBundledModels();
    for (const name of bundled) {
      if (!seen.has(name)) {
        seen.add(name);
        models.push({ name, source: "bundled", downloaded: true });
      }
    }

    // Add curated models
    for (const name of RerankerModelRegistry.CURATED_MODELS) {
      if (!seen.has(name)) {
        seen.add(name);
        models.push({ name, source: "curated", downloaded: false });
      }
    }

    return models;
  }
}
