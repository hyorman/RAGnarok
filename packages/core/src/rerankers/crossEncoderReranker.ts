/**
 * Cross-encoder reranker using @huggingface/transformers
 *
 * Loads an ONNX cross-encoder model (e.g., Xenova/ms-marco-MiniLM-L-6-v2)
 * for sequence classification. Scores (query, document) pairs jointly for
 * more accurate relevance scoring than bi-encoder retrieval.
 *
 * Uses the same dynamic import pattern as HuggingFaceBackend since
 * @huggingface/transformers is ESM-only.
 */

import { Mutex } from "async-mutex";
import { Logger } from "../logger";
import { findAssetsModelsDir } from "../models/findAssetsModelsDir.js";
import { RerankerModelRegistry } from "../models/rerankerModelRegistry.js";
import type { AvailableRerankerModel } from "../models/rerankerModelRegistry.js";
import type { Reranker, ScoredDocument, RerankerOptions } from "./reranker";
import { sigmoid } from "./reranker";

// Dynamic import types — @huggingface/transformers is ESM-only
type TransformersModule = any;

const DEFAULT_MAX_CANDIDATES = 20;
// Cross-encoder activations scale with both token count and batch width. Four
// pairs keeps the default bounded for long documents while still amortizing
// tokenizer/model-call overhead. Callers with a measured memory budget can
// continue to override this through RerankerOptions.batchSize.
const DEFAULT_BATCH_SIZE = 4;
const MAX_DOCUMENT_CHARS = 1500; // ~375 tokens at 4 chars/token, leaving room for query

interface ModelLease {
  model: any;
  tokenizer: any;
}

export class CrossEncoderReranker implements Reranker {
  private model: any = null;
  private tokenizer: any = null;
  private transformers: TransformersModule | null = null;
  private initMutex = new Mutex();
  private initPromise: Promise<void> | null = null;
  private logger: Logger;
  private modelName: string;
  private maxCandidates: number;
  private batchSize: number;
  private registry: RerankerModelRegistry;
  private switchMutex = new Mutex();
  private modelLeaseCounts = new Map<any, number>();
  private modelDrainWaiters = new Map<any, Array<() => void>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(modelName?: string, options?: RerankerOptions & { registry?: RerankerModelRegistry }) {
    this.logger = new Logger("CrossEncoderReranker");
    this.registry = options?.registry ?? RerankerModelRegistry.getInstance();
    this.modelName = modelName ?? this.registry.getDefaultModel();
    this.maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.batchSize = Math.max(1, Math.floor(options?.batchSize ?? DEFAULT_BATCH_SIZE));
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      await this.initializeUnlocked();
    });
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.model && this.tokenizer) {
      return;
    }

    await this.initMutex.runExclusive(async () => {
      // Double-check inside lock
      if (this.model && this.tokenizer) {
        return;
      }

      if (this.initPromise) {
        await this.initPromise;
        return;
      }

      this.initPromise = this._loadModel();
      try {
        await this.initPromise;
      } finally {
        this.initPromise = null;
      }
    });
  }

  isAvailable(): boolean {
    return !this.disposed && this.model !== null && this.tokenizer !== null;
  }

  async rerank(
    query: string,
    candidates: ScoredDocument[],
    topK: number,
    signal?: AbortSignal,
  ): Promise<ScoredDocument[]> {
    signal?.throwIfAborted();
    this.assertNotDisposed();
    if (candidates.length === 0) {
      return [];
    }

    const capped = candidates.slice(0, this.maxCandidates);

    this.logger.info("Reranking candidates", {
      query: query.substring(0, 80),
      candidates: capped.length,
      topK,
    });

    const startTime = Date.now();

    try {
      const lease = await this.switchMutex.runExclusive(async () => {
        this.assertNotDisposed();
        if (!this.isAvailable()) {
          await this.initializeUnlocked();
        }
        signal?.throwIfAborted();
        this.assertNotDisposed();
        return this.acquireModelLease();
      });
      let scores: number[];
      try {
        scores = await this.scorePairs(query, capped, lease, signal);
        signal?.throwIfAborted();
      } finally {
        this.releaseModelLease(lease.model);
      }

      // Combine scores with documents, preserving original scores
      const reranked: ScoredDocument[] = capped.map((candidate, i) => ({
        document: candidate.document,
        score: scores[i],
        scoreKind: "cross_encoder_probability",
        originalScore: candidate.score,
        originalScoreKind: candidate.scoreKind,
        originalComponentScores: candidate.componentScores,
      }));

      // Sort by reranker score descending, take topK
      reranked.sort((a, b) => b.score - a.score);
      const results = reranked.slice(0, topK);

      const elapsed = Date.now() - startTime;
      this.logger.info("Reranking complete", {
        elapsed,
        topScore: results[0]?.score.toFixed(4),
        bottomScore: results[results.length - 1]?.score.toFixed(4),
      });

      return results;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      if (this.disposed) {
        throw error;
      }
      this.logger.error("Reranking failed, returning original order", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Graceful degradation: return original candidates in order
      return candidates.slice(0, topK);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = this.switchMutex.runExclusive(async () => {
      const model = this.model;
      this.model = null;
      this.tokenizer = null;
      this.transformers = null;
      this.initPromise = null;
      await this.waitForModelDrain(model);
      await this.releaseModel(model);
      this.logger.info("CrossEncoderReranker disposed");
    });
    return this.disposePromise;
  }

  getCurrentModel(): string {
    return this.modelName;
  }

  getMaxCandidates(): number {
    return this.maxCandidates;
  }

  async switchModel(modelName: string): Promise<void> {
    this.assertNotDisposed();
    // Validate model name — the registry's resolveModelIdentifier handles
    // path traversal checks (blocks "..", absolute paths including Windows drive letters)
    try {
      this.registry.resolveModelIdentifier(modelName);
    } catch (_err) {
      throw new Error(`Invalid model name: ${modelName}`);
    }
    if (!modelName.includes("/")) {
      throw new Error(`Model name must include namespace (e.g., Xenova/model-name): ${modelName}`);
    }

    if (modelName === this.modelName && this.isAvailable()) {
      this.logger.info("Model already loaded", { model: modelName });
      return;
    }

    await this.switchMutex.runExclusive(async () => {
      this.assertNotDisposed();
      if (modelName === this.modelName && this.isAvailable()) {
        return;
      }
      this.logger.info("Switching reranker model", { from: this.modelName, to: modelName });

      // A replacement is completely initialized before the active generation
      // is published. Existing leases retain the old model until their
      // inference finishes; new calls immediately lease the replacement.
      const replacement = new CrossEncoderReranker(modelName, {
        maxCandidates: this.maxCandidates,
        batchSize: this.batchSize,
        registry: this.registry,
      });
      await replacement.initialize();
      const previousModel = this.model;
      this.model = replacement.model;
      this.tokenizer = replacement.tokenizer;
      this.transformers = replacement.transformers;
      this.modelName = replacement.modelName;
      this.initPromise = null;
      replacement.model = null;
      replacement.tokenizer = null;
      replacement.transformers = null;
      await this.waitForModelDrain(previousModel);
      await this.releaseModel(previousModel);
    });
  }

  async listAvailableModels(): Promise<AvailableRerankerModel[]> {
    const models = await this.registry.listAvailableModels();
    const currentModel = this.modelName;
    // Mark the active model
    return models.map((m) => ({
      ...m,
      downloaded: m.downloaded || m.name === currentModel,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async scorePairs(
    query: string,
    candidates: ScoredDocument[],
    lease: ModelLease,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const scores: number[] = [];

    for (let offset = 0; offset < candidates.length; offset += this.batchSize) {
      signal?.throwIfAborted();
      const batch = candidates.slice(offset, offset + this.batchSize);
      const texts = batch.map((candidate) => {
        const content = candidate.document.pageContent;
        return content.length > MAX_DOCUMENT_CHARS ? content.substring(0, MAX_DOCUMENT_CHARS) : content;
      });
      const inputs = lease.tokenizer(Array(texts.length).fill(query), {
        text_pair: texts,
        padding: true,
        truncation: true,
      });
      signal?.throwIfAborted();
      const output = await lease.model(inputs);
      signal?.throwIfAborted();
      const logits = output?.logits;
      if (!logits?.dims || !logits?.data) {
        throw new Error("Cross-encoder returned no logits");
      }
      const dims = Array.from(logits.dims) as number[];
      if (dims.length === 2 && dims[0] !== batch.length) {
        throw new Error(`Cross-encoder returned ${dims[0]} rows for a batch of ${batch.length}`);
      }
      for (let i = 0; i < batch.length; i++) {
        let probability: number;
        if (dims.length === 2 && dims[1] === 1) {
          probability = sigmoid(Number(logits.data[i]));
        } else if (dims.length === 2 && dims[1] === 2) {
          // softmax([negative, positive]).positive == sigmoid(positive-negative)
          const negative = Number(logits.data[i * 2]);
          const positive = Number(logits.data[i * 2 + 1]);
          probability = sigmoid(positive - negative);
        } else if (dims.length === 1 && dims[0] === batch.length) {
          probability = sigmoid(Number(logits.data[i]));
        } else {
          throw new Error(`Unsupported cross-encoder logits shape [${dims.join(", ")}]`);
        }
        if (!Number.isFinite(probability)) {
          throw new Error("Cross-encoder returned a non-finite score");
        }
        scores.push(probability);
      }
    }

    return scores;
  }

  private async _loadModel(): Promise<void> {
    this.logger.info("Loading cross-encoder model", { model: this.modelName });
    const startTime = Date.now();

    const transformers = await this.loadTransformers();
    const { AutoModelForSequenceClassification, AutoTokenizer } = transformers;

    // Resolve to bundled local path if available, with path traversal protection
    const resolvedModel = this.registry.resolveModelIdentifier(this.modelName);

    const tokenizer = await AutoTokenizer.from_pretrained(resolvedModel);
    const model = await AutoModelForSequenceClassification.from_pretrained(resolvedModel, {
      dtype: "q8",
    });
    this.tokenizer = tokenizer;
    this.model = model;

    const elapsed = Date.now() - startTime;
    this.logger.info("Cross-encoder model loaded", { model: this.modelName, elapsed });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("CrossEncoderReranker has been disposed");
    }
  }

  private async loadTransformers(): Promise<TransformersModule> {
    if (this.transformers) {
      return this.transformers;
    }

    this.transformers = await import("@huggingface/transformers");

    // Configure environment for WASM backend
    const { env } = this.transformers;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;

    // Set local model path so bundled models are found without network download
    const bundledRoot = findAssetsModelsDir();
    if (bundledRoot) {
      env.localModelPath = bundledRoot;
      this.logger.info("Using bundled model path", { path: bundledRoot });
    }

    return this.transformers;
  }

  private async releaseModel(model: any): Promise<void> {
    if (model && typeof model.dispose === "function") {
      await model.dispose();
    }
  }

  private acquireModelLease(): ModelLease {
    if (!this.model || !this.tokenizer) {
      throw new Error("Cross-encoder model is not initialized");
    }
    this.modelLeaseCounts.set(this.model, (this.modelLeaseCounts.get(this.model) ?? 0) + 1);
    return { model: this.model, tokenizer: this.tokenizer };
  }

  private releaseModelLease(model: any): void {
    const remaining = (this.modelLeaseCounts.get(model) ?? 1) - 1;
    if (remaining > 0) {
      this.modelLeaseCounts.set(model, remaining);
      return;
    }
    this.modelLeaseCounts.delete(model);
    for (const resolve of this.modelDrainWaiters.get(model) ?? []) {
      resolve();
    }
    this.modelDrainWaiters.delete(model);
  }

  private async waitForModelDrain(model: any): Promise<void> {
    if (!model || !this.modelLeaseCounts.has(model)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.modelDrainWaiters.get(model) ?? [];
      waiters.push(resolve);
      this.modelDrainWaiters.set(model, waiters);
    });
  }
}
