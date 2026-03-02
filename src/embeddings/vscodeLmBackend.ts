/**
 * VS Code Language Model embedding backend
 *
 * Uses the **proposed** `vscode.lm.computeEmbeddings` API to delegate
 * embedding computation to a registered provider (e.g. GitHub Copilot).
 *
 * Requirements:
 * - VS Code Insiders (or a build with the proposed API enabled)
 * - `"enabledApiProposals": ["embeddings"]` in package.json
 * - An EmbeddingsProvider registered for the configured model ID
 *
 * @see https://github.com/microsoft/vscode/issues/212083
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- proposed API accessed via runtime casts */

import * as vscode from 'vscode';
import { EmbeddingBackend } from './embeddingBackend';
import { Logger } from '../utils/logger';

/**
 * Thin wrapper around `vscode.lm.computeEmbeddings` that implements
 * the {@link EmbeddingBackend} interface.
 */
export class VscodeLmBackend implements EmbeddingBackend {
  readonly name = 'vscodeLM' as const;

  private modelId: string;
  private logger: Logger;
  private dimension: number | null = null;
  private initialized = false;

  constructor(modelId?: string) {
    this.modelId = modelId ?? '';
    this.logger = new Logger('VscodeLmBackend');
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      // 1. Is the proposed API surface present?
      if (!vscode.lm || typeof (vscode.lm as any).computeEmbeddings !== 'function') {
        this.logger.debug('vscode.lm.computeEmbeddings API is not available');
        return false;
      }

      // 2. Are there any registered embedding models?
      const models: string[] | undefined = (vscode.lm as any).embeddingModels;
      if (!models || models.length === 0) {
        this.logger.debug('No embedding models registered with vscode.lm');
        return false;
      }

      // 3. If a specific model was requested, is it listed?
      if (this.modelId && !models.includes(this.modelId)) {
        this.logger.debug(
          `Configured model "${this.modelId}" not found in registered models: [${models.join(', ')}]`
        );
        return false;
      }

      // 4. Auto-select first model when none is configured
      if (!this.modelId) {
        this.modelId = models[0];
        this.logger.info(`Auto-selected VS Code LM embedding model: ${this.modelId}`);
      }

      return true;
    } catch (error: any) {
      this.logger.debug('Error probing VS Code LM availability:', error?.message ?? error);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(modelName?: string): Promise<void> {
    if (modelName) {
      this.modelId = modelName;
    }

    const available = await this.isAvailable();
    if (!available) {
      const registeredModels: string[] = (vscode.lm as any)?.embeddingModels ?? [];
      throw new Error(
        `VS Code LM embedding backend is not available. ` +
        `Ensure the proposed "embeddings" API is enabled and an embeddings provider is registered. ` +
        `Registered models: [${registeredModels.join(', ') || 'none'}]` +
        (this.modelId ? `. Requested model: "${this.modelId}"` : '')
      );
    }

    this.initialized = true;
    this.logger.info(`VS Code LM embedding backend initialized (model: ${this.modelId})`);
  }

  // ---------------------------------------------------------------------------
  // Single embedding
  // ---------------------------------------------------------------------------

  async embed(text: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result: { values: number[] } = await (vscode.lm as any).computeEmbeddings(
        this.modelId,
        text
      );

      const values = result.values;
      if (!values || values.length === 0) {
        throw new Error('Received empty embedding from VS Code LM');
      }

      this.dimension = values.length;
      return values;
    } catch (error: any) {
      this.logger.error(`VS Code LM embed failed: ${error?.message ?? error}`);
      throw new Error(`VS Code LM embedding failed: ${error?.message ?? error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Batch embedding
  // ---------------------------------------------------------------------------

  async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void
  ): Promise<number[][]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (texts.length === 0) {
      return [];
    }

    this.logger.debug(`Batch-embedding ${texts.length} texts via VS Code LM`);

    try {
      // The proposed API accepts string[] and returns Embedding[]
      const results: Array<{ values: number[] }> = await (vscode.lm as any).computeEmbeddings(
        this.modelId,
        texts
      );

      const embeddings: number[][] = results.map((r, idx) => {
        if (!r.values || r.values.length === 0) {
          throw new Error(`Empty embedding at index ${idx}`);
        }
        return r.values;
      });

      // Validate uniform dimensions
      this.validateDimensions(embeddings);

      progressCallback?.(1.0);

      this.logger.debug(
        `Batch embedding complete: ${embeddings.length} vectors, dim=${this.dimension}`
      );
      return embeddings;
    } catch (batchError: any) {
      // Fallback: process texts one-by-one if the batch call fails
      this.logger.warn(
        `Batch embedding failed (${batchError?.message}), falling back to sequential processing`
      );

      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        embeddings.push(await this.embed(texts[i]));
        progressCallback?.((i + 1) / texts.length);
      }
      return embeddings;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure all embeddings share the same length and update `this.dimension`.
   */
  private validateDimensions(embeddings: number[][]): void {
    if (embeddings.length === 0) {
      return;
    }

    const dim = embeddings[0].length;
    for (let i = 1; i < embeddings.length; i++) {
      if (embeddings[i].length !== dim) {
        throw new Error(
          `Inconsistent embedding dimensions: expected ${dim}, got ${embeddings[i].length} at index ${i}`
        );
      }
    }
    this.dimension = dim;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  dispose(): void {
    this.initialized = false;
    this.dimension = null;
    this.logger.info('VscodeLmBackend disposed');
  }
}
