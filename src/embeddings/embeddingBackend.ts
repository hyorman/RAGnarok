/**
 * Embedding backend abstraction layer
 *
 * Allows switching between different embedding providers:
 * - HuggingFace Transformers.js (local ONNX/wasm inference)
 * - VS Code Language Model API (proposed vscode.lm.computeEmbeddings)
 *
 * The `auto` mode tries VS Code LM first and falls back to HuggingFace.
 */

/**
 * Supported embedding backend types.
 *
 * - `auto`        – Try VS Code LM first; fall back to HuggingFace on failure.
 * - `vscodeLM`    – Force VS Code LM embeddings (errors if unavailable).
 * - `huggingface` – Force local HuggingFace Transformers.js embeddings.
 */
export type EmbeddingBackendType = 'auto' | 'vscodeLM' | 'huggingface';

/**
 * Common interface that every embedding backend must implement.
 */
export interface EmbeddingBackend {
  /** Discriminant identifying the concrete backend. */
  readonly name: 'vscodeLM' | 'huggingface';

  /**
   * Generate an embedding vector for a single text.
   * @param text Input text to embed.
   * @returns Embedding vector (number[]).
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embedding vectors for multiple texts.
   * Implementations should try to use native batch APIs where possible.
   * @param texts Array of input texts.
   * @param progressCallback Optional callback reporting progress as a value in [0, 1].
   * @returns Array of embedding vectors in the same order as `texts`.
   */
  embedBatch(texts: string[], progressCallback?: (progress: number) => void): Promise<number[][]>;

  /**
   * Initialize the backend (load models, check provider availability, etc.).
   * May be called multiple times; implementations must be idempotent.
   * @param modelName Optional model identifier (semantics depend on backend).
   */
  initialize(modelName?: string): Promise<void>;

  /**
   * Quick check whether this backend *can* be used in the current environment.
   * Should not throw.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Return the embedding vector dimension, or `null` if not yet known
   * (i.e. before the first embedding is generated).
   */
  getDimension(): number | null;

  /**
   * Release any resources held by this backend.
   */
  dispose(): void;
}
