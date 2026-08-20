/**
 * Reranker interface — defines the contract for cross-encoder reranking
 *
 * Rerankers take a query and a set of candidate documents scored by first-stage
 * retrieval, then re-score them using a more accurate (but slower) model.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";

/** A document with its relevance score */
export interface ScoredDocument {
  document: LangChainDocument;
  score: number;
  /** Semantics of the current score. */
  scoreKind?: string;
  /** Retrieval-arm components for the current score. */
  componentScores?: { vector?: number; keyword?: number };
  /** Original first-stage retrieval score (preserved through reranking) */
  originalScore?: number;
  /** Semantics of the preserved first-stage score. */
  originalScoreKind?: string;
  /** Preserved first-stage retrieval-arm components. */
  originalComponentScores?: { vector?: number; keyword?: number };
}

/** Options for reranking */
export interface RerankerOptions {
  /** Maximum number of candidates to rerank (caps input) */
  maxCandidates?: number;
  /** Maximum number of query/document pairs in one model invocation. */
  batchSize?: number;
}

/** Reranker contract implemented by cross-encoder backends */
export interface Reranker {
  /** Re-score candidates using the cross-encoder model */
  rerank(query: string, candidates: ScoredDocument[], topK: number, signal?: AbortSignal): Promise<ScoredDocument[]>;
  /** Initialize the model (lazy — called on first rerank if not called explicitly) */
  initialize(): Promise<void>;
  /** Whether the reranker is ready for use */
  isAvailable(): boolean;
  getMaxCandidates?(): number;
  getCurrentModel?(): string;
  switchModel?(modelName: string): Promise<void>;
  /** Release resources */
  dispose(): void | Promise<void>;
}

/** Sigmoid function for normalizing logits to [0,1] */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
