/**
 * Proposed VS Code Embeddings API type declarations.
 *
 * These types mirror the proposed `vscode.lm` embeddings surface from:
 *   https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.embeddings.d.ts
 *
 * They are only used at *design time*; at runtime the extension accesses
 * these members via `(vscode.lm as any)` to stay compatible with stable
 * VS Code builds where the API does not yet exist.
 *
 * @see https://github.com/microsoft/vscode/issues/212083
 */

declare module 'vscode' {

  export interface Embedding {
    readonly values: number[];
  }

  export interface EmbeddingsProvider {
    provideEmbeddings(input: string[], token: CancellationToken): ProviderResult<Embedding[]>;
  }

  export namespace lm {
    /**
     * List of currently registered embedding model identifiers.
     * Empty when no provider is registered or the proposed API is not available.
     */
    export const embeddingModels: string[];

    /**
     * Fires when the set of available embedding models changes.
     */
    export const onDidChangeEmbeddingModels: Event<void>;

    /**
     * Compute an embedding for a single string.
     */
    export function computeEmbeddings(
      embeddingsModel: string,
      input: string,
      token?: CancellationToken,
    ): Thenable<Embedding>;

    /**
     * Compute embeddings for an array of strings.
     */
    export function computeEmbeddings(
      embeddingsModel: string,
      input: string[],
      token?: CancellationToken,
    ): Thenable<Embedding[]>;

    /**
     * Register an embeddings provider for the given model identifier.
     */
    export function registerEmbeddingsProvider(
      embeddingsModel: string,
      provider: EmbeddingsProvider,
    ): Disposable;
  }
}
