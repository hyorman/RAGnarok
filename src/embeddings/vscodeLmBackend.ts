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

  /** The LM API surface — defaults to `vscode.lm`, injectable for testing. */
  private lmApi: any;

  constructor(modelId?: string, options?: { lmApi?: any }) {
    this.modelId = modelId ?? '';
    this.lmApi = options?.lmApi ?? (vscode.lm as any);
    this.logger = new Logger('VscodeLmBackend');
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const lm = this.lmApi;

      // 1. Is the proposed API surface present?
      if (!lm || typeof lm.computeEmbeddings !== 'function') {
        this.logger.debug('vscode.lm.computeEmbeddings API is not available');
        return false;
      }

      // 2. Are there any registered embedding models?
      const models: string[] | undefined = lm.embeddingModels;
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
      let registeredModels: string[] = [];
      try {
        registeredModels = this.lmApi?.embeddingModels ?? [];
      } catch {
        // API may throw if the proposed embeddings API is not enabled
      }
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
      const result: { values: number[] } = await this.lmApi.computeEmbeddings(
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

  private static readonly BATCH_SIZE = 500;
  private static readonly CONCURRENCY = 3;
  private static readonly MAX_RETRIES = 5;
  private static readonly INITIAL_BACKOFF_MS = 1000;

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

    const allEmbeddings: number[][] = new Array(texts.length);
    let completedCount = 0;

    try {
      // Split texts into batches
      const batches: { texts: string[]; startIdx: number }[] = [];
      for (let i = 0; i < texts.length; i += VscodeLmBackend.BATCH_SIZE) {
        batches.push({ texts: texts.slice(i, i + VscodeLmBackend.BATCH_SIZE), startIdx: i });
      }

      // Process batches with bounded concurrency
      for (let w = 0; w < batches.length; w += VscodeLmBackend.CONCURRENCY) {
        const window = batches.slice(w, w + VscodeLmBackend.CONCURRENCY);

        if (texts.length > 100) {
          const scheduled = Math.min((w + VscodeLmBackend.CONCURRENCY) * VscodeLmBackend.BATCH_SIZE, texts.length);
          const progressPercent = Math.round((scheduled / texts.length) * 100);
          this.logger.info(`Generating embeddings: ${scheduled}/${texts.length} (${progressPercent}%)`);
        }

        const windowResults = await Promise.all(
          window.map(async (batch) => {
            const results: Array<{ values: number[] }> = await this.lmApi.computeEmbeddings(
              this.modelId,
              batch.texts
            );
            return results.map((r, idx) => {
              if (!r.values || r.values.length === 0) {
                throw new Error(`Empty embedding at index ${batch.startIdx + idx}`);
              }
              return { globalIdx: batch.startIdx + idx, values: r.values };
            });
          })
        );

        for (const batchResults of windowResults) {
          for (const result of batchResults) {
            allEmbeddings[result.globalIdx] = result.values;
          }
          completedCount += batchResults.length;
        }

        progressCallback?.(Math.min(1.0, completedCount / texts.length));
      }

      // Validate uniform dimensions
      this.validateDimensions(allEmbeddings);

      this.logger.debug(
        `Batch embedding complete: ${allEmbeddings.length} vectors, dim=${this.dimension}`
      );
      return allEmbeddings;
    } catch (batchError: any) {
      // Fallback: process only the remaining un-embedded texts sequentially
      const remaining = texts.length - completedCount;
      this.logger.warn(
        `Batch embedding failed at ${completedCount}/${texts.length} (${batchError?.message}), ` +
        `falling back to sequential processing for ${remaining} remaining texts`
      );

      for (let i = 0; i < texts.length; i++) {
        if (allEmbeddings[i]) {
          continue; // Already embedded in the batch phase
        }
        allEmbeddings[i] = await this.embedWithRetry(texts[i]);
        completedCount++;
        progressCallback?.(completedCount / texts.length);
      }
      return allEmbeddings;
    }
  }

  /**
   * Embed a single text with exponential backoff for rate-limit (429) errors.
   */
  private async embedWithRetry(text: string): Promise<number[]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VscodeLmBackend.MAX_RETRIES; attempt++) {
      try {
        return await this.embed(text);
      } catch (error: any) {
        lastError = error;
        const msg = error?.message ?? String(error);
        if (msg.includes('429') && attempt < VscodeLmBackend.MAX_RETRIES) {
          const backoff = VscodeLmBackend.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(`Rate limited (attempt ${attempt + 1}/${VscodeLmBackend.MAX_RETRIES}), retrying in ${backoff}ms`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
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
