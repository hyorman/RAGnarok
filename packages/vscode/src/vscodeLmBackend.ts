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

interface EmbeddingResult {
  values: number[];
}

/**
 * The proposed `vscode.lm` embeddings surface. It is missing from the public
 * `vscode` typings, so the shape this backend relies on is declared here.
 */
export interface LmEmbeddingsApi {
  /**
   * Resolves to one result for a string input and an array of results for an array input. The proposal declares
   * that as two overloads; this is one signature so a test double can implement it with a single function, which
   * leaves callers to narrow the union by the shape of the input they passed.
   */
  computeEmbeddings(modelId: string, input: string | string[]): Promise<EmbeddingResult | EmbeddingResult[]>;
  embeddingModels?: string[];
}

/** An error's `message` when it has one, otherwise the thrown value itself (for logs and 429 detection). */
function messageOrError(error: unknown): unknown {
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  return message ?? error;
}

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
  private switchSnapshot: {
    configuredModelId: string;
    resolvedModelId: string;
    dimension: number | null;
    initialized: boolean;
  } | null = null;
  private readonly modelIdResolver?: () => string | undefined | null;

  /** The LM API surface — defaults to `vscode.lm`, injectable for testing; undefined outside the extension host. */
  private readonly lmApi: LmEmbeddingsApi | undefined;

  constructor(
    modelId?: string,
    options?: { lmApi?: LmEmbeddingsApi; modelIdResolver?: () => string | undefined | null },
  ) {
    this.configuredModelId = modelId ?? "";
    this.resolvedModelId = modelId ?? "";
    this.modelIdResolver = options?.modelIdResolver;
    // `vscode.lm` is only typed as the public API (the proposed embeddings surface is not), and `vscodeApi` is
    // undefined when the module cannot be required, so the result may be undefined: the availability probe guards.
    this.lmApi = options?.lmApi ?? (vscodeApi?.lm as unknown as LmEmbeddingsApi | undefined);
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
    } catch (error) {
      this.logger.debug("Error probing VS Code LM availability:", messageOrError(error));
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(modelName?: string): Promise<void> {
    const previousConfigured = this.configuredModelId;
    const previousResolved = this.resolvedModelId;
    const previousInitialized = this.initialized;
    const requestedModelId = this.getRequestedModelId(modelName);
    const available = await this.isAvailableForModel(requestedModelId);
    if (!available) {
      // Availability probing may auto-resolve a model. Restore the complete
      // prior generation when a requested switch cannot be validated.
      this.configuredModelId = previousConfigured;
      this.resolvedModelId = previousResolved;
      this.initialized = previousInitialized;
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

    if (modelName !== undefined) {
      this.configuredModelId = modelName;
    }
    this.initialized = true;
    this.logger.info(`VS Code LM embedding backend initialized (model: ${this.getResolvedModelId()})`);
  }

  beginSwitchTransaction(): void {
    this.switchSnapshot = {
      configuredModelId: this.configuredModelId,
      resolvedModelId: this.resolvedModelId,
      dimension: this.dimension,
      initialized: this.initialized,
    };
  }

  commitSwitchTransaction(): void {
    this.switchSnapshot = null;
  }

  rollbackSwitchTransaction(): void {
    if (!this.switchSnapshot) {
      return;
    }
    this.configuredModelId = this.switchSnapshot.configuredModelId;
    this.resolvedModelId = this.switchSnapshot.resolvedModelId;
    this.dimension = this.switchSnapshot.dimension;
    this.initialized = this.switchSnapshot.initialized;
    this.switchSnapshot = null;
  }

  // ---------------------------------------------------------------------------
  // Single embedding
  // ---------------------------------------------------------------------------

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // A string input resolves to a single result: the proposal's overload
      // `computeEmbeddings(embeddingsModel: string, input: string, token?): Thenable<Embedding>`,
      // which LmEmbeddingsApi's one union signature cannot express.
      const result = (await this.requireLmApi().computeEmbeddings(this.getResolvedModelId(), text)) as EmbeddingResult;
      signal?.throwIfAborted();

      const values = result.values;
      if (!values || values.length === 0) {
        throw new Error("Received empty embedding from VS Code LM");
      }

      this.dimension = values.length;
      return values;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      this.logger.error(`VS Code LM embed failed: ${messageOrError(error)}`);
      throw new Error(`VS Code LM embedding failed: ${messageOrError(error)}`);
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

  async embedBatch(
    texts: string[],
    progressCallback?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    signal?.throwIfAborted();
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
        signal?.throwIfAborted();
        const window = batches.slice(w, w + VscodeLmBackend.CONCURRENCY);

        if (texts.length > 100) {
          const scheduled = Math.min((w + VscodeLmBackend.CONCURRENCY) * VscodeLmBackend.BATCH_SIZE, texts.length);
          const progressPercent = Math.round((scheduled / texts.length) * 100);
          this.logger.info(`Generating embeddings: ${scheduled}/${texts.length} (${progressPercent}%)`);
        }

        const windowResults = await Promise.all(
          window.map((batch) => this.embedBatchWithRetry(batch.texts, batch.startIdx, signal)),
        );
        signal?.throwIfAborted();

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
          signal?.throwIfAborted();
        }
      }

      // Validate uniform dimensions
      this.validateDimensions(allEmbeddings);

      this.logger.debug(`Batch embedding complete: ${allEmbeddings.length} vectors, dim=${this.dimension}`);
      return allEmbeddings;
    } catch (batchError) {
      // Fallback: process only the remaining un-embedded texts sequentially
      const remaining = texts.length - completedCount;
      this.logger.warn(
        `Batch embedding failed at ${completedCount}/${texts.length} (${messageOrError(batchError)}), ` +
          `falling back to sequential processing for ${remaining} remaining texts`,
      );

      for (let i = 0; i < texts.length; i++) {
        signal?.throwIfAborted();
        if (allEmbeddings[i]) {
          continue; // Already embedded in the batch phase
        }
        allEmbeddings[i] = await this.embedWithRetry(texts[i], signal);
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
    signal?: AbortSignal,
  ): Promise<Array<{ globalIdx: number; values: number[] }>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= VscodeLmBackend.MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      try {
        // An array input resolves to an array of results: the proposal's overload
        // `computeEmbeddings(embeddingsModel: string, input: string[], token?): Thenable<Embedding[]>`,
        // which LmEmbeddingsApi's one union signature cannot express.
        const results = (await this.requireLmApi().computeEmbeddings(
          this.getResolvedModelId(),
          batchTexts,
        )) as EmbeddingResult[];
        signal?.throwIfAborted();
        return results.map((r, idx) => {
          if (!r.values || r.values.length === 0) {
            throw new Error(`Empty embedding at index ${startIdx + idx}`);
          }
          return { globalIdx: startIdx + idx, values: r.values };
        });
      } catch (error) {
        lastError = error;
        const msg = String(messageOrError(error));
        if (msg.includes("429") && attempt < VscodeLmBackend.MAX_RETRIES) {
          const backoff = VscodeLmBackend.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limited on batch at ${startIdx} (attempt ${attempt + 1}/${VscodeLmBackend.MAX_RETRIES}), retrying in ${backoff}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          signal?.throwIfAborted();
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
  private async embedWithRetry(text: string, signal?: AbortSignal): Promise<number[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= VscodeLmBackend.MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.embed(text, signal);
      } catch (error) {
        lastError = error;
        const msg = String(messageOrError(error));
        if (msg.includes("429") && attempt < VscodeLmBackend.MAX_RETRIES) {
          const backoff = VscodeLmBackend.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limited (attempt ${attempt + 1}/${VscodeLmBackend.MAX_RETRIES}), retrying in ${backoff}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          signal?.throwIfAborted();
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

  /** The LM API, for calls that only run once `initialize()` has proven it present. */
  private requireLmApi(): LmEmbeddingsApi {
    if (!this.lmApi) {
      throw new Error("The VS Code LM embeddings API is not available");
    }
    return this.lmApi;
  }

  private getResolvedModelId(): string {
    const modelId = this.resolvedModelId || this.getRequestedModelId();
    if (!modelId) {
      throw new Error("No VS Code LM embedding model has been resolved");
    }
    return modelId;
  }
}
