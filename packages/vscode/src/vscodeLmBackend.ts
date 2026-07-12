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

import type * as VSCode from "vscode";
import { EmbeddingBackend, Logger } from "@ragnarok/core";

// Allow pure unit tests to inject an lmApi without requiring the VS Code runtime module.
const vscodeApi = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the vscode module only exists inside the extension host; a static import would break unit tests, and dynamic import() cannot resolve it synchronously here
    return require("vscode") as typeof VSCode;
  } catch {
    return undefined;
  }
})();

/**
 * Thin wrapper around `vscode.lm.computeEmbeddings` that implements
 * the {@link EmbeddingBackend} interface.
 */
export class VscodeLmBackend implements EmbeddingBackend {
  readonly name = "vscodeLM" as const;

  private configuredModelId: string;
  private resolvedModelId: string;
  private readonly logger: Logger;
  private dimension: number | null = null;
  private initialized = false;
  private readonly modelIdResolver?: () => string | undefined | null;

  /** The LM API surface — defaults to `vscode.lm`, injectable for testing. */
  private readonly lmApi: any;

  constructor(modelId?: string, options?: { lmApi?: any; modelIdResolver?: () => string | undefined | null }) {
    this.configuredModelId = modelId ?? "";
    this.resolvedModelId = modelId ?? "";
    this.modelIdResolver = options?.modelIdResolver;
    this.lmApi = options?.lmApi ?? (vscodeApi?.lm as any);
    this.logger = new Logger("VscodeLmBackend");
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    return this.isAvailableForModel();
  }

  async isAvailableForModel(modelName?: string): Promise<boolean> {
    try {
      const lm = this.lmApi;
      const requestedModelId = this.getRequestedModelId(modelName);

      // 1. Is the proposed API surface present?
      if (!lm || typeof lm.computeEmbeddings !== "function") {
        this.logger.debug("vscode.lm.computeEmbeddings API is not available");
        return false;
      }

      // 2. Are there any registered embedding models?
      const models: string[] | undefined = lm.embeddingModels;
      if (!models || models.length === 0) {
        this.logger.debug("No embedding models registered with vscode.lm");
        return false;
      }

      // 3. If a specific model was requested, is it listed?
      if (requestedModelId && !models.includes(requestedModelId)) {
        this.logger.debug(
          `Configured model "${requestedModelId}" not found in registered models: [${models.join(", ")}]`,
        );
        return false;
      }

      // 4. Auto-select first model when none is configured
      if (!requestedModelId) {
        this.resolvedModelId = models[0];
        this.logger.info(`Auto-selected VS Code LM embedding model: ${this.resolvedModelId}`);
      } else {
        this.resolvedModelId = requestedModelId;
      }

      return true;
    } catch (error: any) {
      this.logger.debug("Error probing VS Code LM availability:", error?.message ?? error);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(modelName?: string): Promise<void> {
    if (modelName !== undefined) {
      this.configuredModelId = modelName;
    }

    const requestedModelId = this.getRequestedModelId(modelName);
    const available = await this.isAvailableForModel(requestedModelId);
    if (!available) {
      let registeredModels: string[] = [];
      try {
        registeredModels = this.lmApi?.embeddingModels ?? [];
      } catch {
        // API may throw if the proposed embeddings API is not enabled
      }
      throw new Error(
        `VS Code LM embedding backend is not available. ` +
          `Use VS Code Insiders (or another build exposing the proposal), start it with ` +
          `"--enable-proposed-api=hyorman.ragnarok", and ensure an embeddings provider is registered. ` +
          `Registered models: [${registeredModels.join(", ") || "none"}]` +
          (requestedModelId ? `. Requested model: "${requestedModelId}"` : ""),
      );
    }

    this.initialized = true;
    this.logger.info(`VS Code LM embedding backend initialized (model: ${this.getResolvedModelId()})`);
  }

  // ---------------------------------------------------------------------------
  // Single embedding
  // ---------------------------------------------------------------------------

  async embed(text: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result: { values: number[] } = await this.lmApi.computeEmbeddings(this.getResolvedModelId(), text);

      const values = result.values;
      if (!values || values.length === 0) {
        throw new Error("Received empty embedding from VS Code LM");
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

  private static readonly BATCH_SIZE = 250;
  private static readonly CONCURRENCY = 2;
  private static readonly MAX_RETRIES = 5;
  private static readonly INITIAL_BACKOFF_MS = 1000;
  /** Delay between batch windows to avoid hammering the API. */
  private static readonly INTER_WINDOW_DELAY_MS = 200;

  async embedBatch(texts: string[], progressCallback?: (progress: number) => void): Promise<number[][]> {
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
          window.map((batch) => this.embedBatchWithRetry(batch.texts, batch.startIdx)),
        );

        for (const batchResults of windowResults) {
          for (const result of batchResults) {
            allEmbeddings[result.globalIdx] = result.values;
          }
          completedCount += batchResults.length;
        }

        progressCallback?.(Math.min(1.0, completedCount / texts.length));

        // Brief pause between windows to reduce rate-limit pressure
        if (w + VscodeLmBackend.CONCURRENCY < batches.length) {
          await new Promise((resolve) => setTimeout(resolve, VscodeLmBackend.INTER_WINDOW_DELAY_MS));
        }
      }

      // Validate uniform dimensions
      this.validateDimensions(allEmbeddings);

      this.logger.debug(`Batch embedding complete: ${allEmbeddings.length} vectors, dim=${this.dimension}`);
      return allEmbeddings;
    } catch (batchError: any) {
      // Fallback: process only the remaining un-embedded texts sequentially
      const remaining = texts.length - completedCount;
      this.logger.warn(
        `Batch embedding failed at ${completedCount}/${texts.length} (${batchError?.message}), ` +
          `falling back to sequential processing for ${remaining} remaining texts`,
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
   * Attempt a batch embedding with retries on 429 errors.
   * Returns the mapped results with global indices.
   */
  private async embedBatchWithRetry(
    batchTexts: string[],
    startIdx: number,
  ): Promise<Array<{ globalIdx: number; values: number[] }>> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VscodeLmBackend.MAX_RETRIES; attempt++) {
      try {
        const results: Array<{ values: number[] }> = await this.lmApi.computeEmbeddings(
          this.getResolvedModelId(),
          batchTexts,
        );
        return results.map((r, idx) => {
          if (!r.values || r.values.length === 0) {
            throw new Error(`Empty embedding at index ${startIdx + idx}`);
          }
          return { globalIdx: startIdx + idx, values: r.values };
        });
      } catch (error: any) {
        lastError = error;
        const msg = error?.message ?? String(error);
        if (msg.includes("429") && attempt < VscodeLmBackend.MAX_RETRIES) {
          const backoff = VscodeLmBackend.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limited on batch at ${startIdx} (attempt ${attempt + 1}/${VscodeLmBackend.MAX_RETRIES}), retrying in ${backoff}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
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
        if (msg.includes("429") && attempt < VscodeLmBackend.MAX_RETRIES) {
          const backoff = VscodeLmBackend.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limited (attempt ${attempt + 1}/${VscodeLmBackend.MAX_RETRIES}), retrying in ${backoff}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
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
          `Inconsistent embedding dimensions: expected ${dim}, got ${embeddings[i].length} at index ${i}`,
        );
      }
    }
    this.dimension = dim;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  getModelId(): string | null {
    return this.resolvedModelId || this.getRequestedModelId() || null;
  }

  dispose(): void {
    this.initialized = false;
    this.dimension = null;
    this.resolvedModelId = "";
    this.logger.info("VscodeLmBackend disposed");
  }

  private getRequestedModelId(modelName?: string): string {
    if (modelName !== undefined) {
      return modelName;
    }

    const resolvedFromConfig = this.modelIdResolver?.();
    if (typeof resolvedFromConfig === "string") {
      return resolvedFromConfig;
    }

    return this.configuredModelId;
  }

  private getResolvedModelId(): string {
    const modelId = this.resolvedModelId || this.getRequestedModelId();
    if (!modelId) {
      throw new Error("No VS Code LM embedding model has been resolved");
    }
    return modelId;
  }
}
