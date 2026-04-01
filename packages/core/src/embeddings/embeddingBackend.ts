/**
 * Embedding backend abstraction layer
 *
 * Allows switching between different embedding providers.
 * Backend names are fully dynamic — whatever backends register themselves with.
 *
 * The `auto` mode tries registered backends in order and uses the first available.
 */

/**
 * Embedding backend selection mode.
 *
 * - `auto`        – Try registered backends in order; use first available.
 * - Any other string is treated as a registered backend name (e.g. `"huggingface"`, `"vscodeLM"`).
 */
export type EmbeddingBackendType = "auto" | (string & {});

/**
 * Common interface that every embedding backend must implement.
 */
export interface EmbeddingBackend {
  /** Discriminant identifying the concrete backend. */
  readonly name: string;

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
   * Return the concrete model identifier after initialization.
   * For HuggingFace this is the model name (e.g. "Xenova/all-MiniLM-L6-v2");
   * for VS Code LM, the resolved provider model ID.
   */
  getModelId?(): string | null;

  /**
   * Release any resources held by this backend.
   */
  dispose(): void;
}
