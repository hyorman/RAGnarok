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

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_MAX_CANDIDATES = 20;
const MAX_DOCUMENT_CHARS = 1500; // ~375 tokens at 4 chars/token, leaving room for query

export class CrossEncoderReranker implements Reranker {
  private model: any = null;
  private tokenizer: any = null;
  private transformers: TransformersModule | null = null;
  private initMutex = new Mutex();
  private initPromise: Promise<void> | null = null;
  private logger: Logger;
  private modelName: string;
  private maxCandidates: number;
  private registry: RerankerModelRegistry;

  constructor(modelName?: string, options?: RerankerOptions & { registry?: RerankerModelRegistry }) {
    this.logger = new Logger("CrossEncoderReranker");
    this.registry = options?.registry ?? RerankerModelRegistry.getInstance();
    this.modelName = modelName ?? this.registry.getDefaultModel();
    this.maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  async initialize(): Promise<void> {
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
    return this.model !== null && this.tokenizer !== null;
  }

  async rerank(query: string, candidates: ScoredDocument[], topK: number): Promise<ScoredDocument[]> {
    if (candidates.length === 0) {
      return [];
    }

    // Ensure model is loaded
    if (!this.isAvailable()) {
      await this.initialize();
    }

    // Cap candidates to avoid O(N) blowup
    const capped = candidates.slice(0, this.maxCandidates);

    this.logger.info("Reranking candidates", {
      query: query.substring(0, 80),
      candidates: capped.length,
      topK,
    });

    const startTime = Date.now();

    try {
      // Score all (query, document) pairs
      const scores = await this.scorePairs(query, capped);

      // Combine scores with documents, preserving original scores
      const reranked: ScoredDocument[] = capped.map((candidate, i) => ({
        document: candidate.document,
        score: scores[i],
        originalScore: candidate.score,
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
      this.logger.error("Reranking failed, returning original order", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Graceful degradation: return original candidates in order
      return candidates.slice(0, topK);
    }
  }

  dispose(): void {
    this.model = null;
    this.tokenizer = null;
    this.transformers = null;
    this.logger.info("CrossEncoderReranker disposed");
  }

  getCurrentModel(): string {
    return this.modelName;
  }

  async switchModel(modelName: string): Promise<void> {
    // Validate model name — the registry's resolveModelIdentifier handles
    // path traversal checks (blocks "..", absolute paths including Windows drive letters)
    try {
      this.registry.resolveModelIdentifier(modelName);
    } catch (err) {
      throw new Error(`Invalid model name: ${modelName}`);
    }
    if (!modelName.includes("/")) {
      throw new Error(`Model name must include namespace (e.g., Xenova/model-name): ${modelName}`);
    }

    if (modelName === this.modelName && this.isAvailable()) {
      this.logger.info("Model already loaded", { model: modelName });
      return;
    }

    this.logger.info("Switching reranker model", { from: this.modelName, to: modelName });

    // Dispose current model
    this.model = null;
    this.tokenizer = null;
    this.initPromise = null;

    // Set new model name and reload
    this.modelName = modelName;
    await this.initialize();
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

  private async scorePairs(query: string, candidates: ScoredDocument[]): Promise<number[]> {
    const texts = candidates.map((c) => {
      const content = c.document.pageContent;
      // Truncate long documents to fit model context window
      return content.length > MAX_DOCUMENT_CHARS ? content.substring(0, MAX_DOCUMENT_CHARS) : content;
    });

    // Tokenize all pairs at once — text_pair must be passed as an option
    // in @huggingface/transformers (v3), not as a positional argument
    const inputs = this.tokenizer(Array(texts.length).fill(query), {
      text_pair: texts,
      padding: true,
      truncation: true,
    });

    // Forward pass — get logits
    const output = await this.model(inputs);

    // Extract scores: output.logits is a Tensor of shape [N, 1] or [N, 2]
    const logits = output.logits;
    const scores: number[] = [];

    for (let i = 0; i < candidates.length; i++) {
      // For binary classification models, use the positive class logit
      // For single-logit models, use the raw logit
      const dims = logits.dims;
      let rawScore: number;
      if (dims.length === 2 && dims[1] === 1) {
        // Single logit output [N, 1]
        rawScore = logits.data[i];
      } else if (dims.length === 2 && dims[1] >= 2) {
        // Two-class output [N, 2] — use positive class
        rawScore = logits.data[i * dims[1] + 1];
      } else {
        // Fallback: flat array
        rawScore = logits.data[i];
      }
      scores.push(sigmoid(rawScore));
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

    this.tokenizer = await AutoTokenizer.from_pretrained(resolvedModel);
    this.model = await AutoModelForSequenceClassification.from_pretrained(resolvedModel, {
      quantized: true,
    });

    const elapsed = Date.now() - startTime;
    this.logger.info("Cross-encoder model loaded", { model: this.modelName, elapsed });
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
}
