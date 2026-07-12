/**
 * LangGraph State Schema Definitions
 * Defines state annotations for query and indexing pipelines
 */

import { Annotation } from "@langchain/langgraph";
import type { Document as LangChainDocument } from "@langchain/core/documents";
import type { ExtractedEntity, ExtractedRelationship } from "./entityExtractorTypes";

// ── Lightweight inline types to avoid heavy coupling ──

export interface RetrievalResultEntry {
  content: string;
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface QueryPipelineOptions {
  retrievalStrategy: string;
  topK: number;
  modelFamily: string;
  allowMemoryWrites: boolean;
}

export interface QueryPlanRef {
  originalQuery: string;
  complexity: "simple" | "moderate" | "complex";
  subQueries: Array<{ query: string; reasoning: string; topK?: number }>;
  explanation: string;
}

// ── Query Pipeline State ──

export const QueryPipelineState = Annotation.Root({
  // Input
  query: Annotation<string>,
  topicId: Annotation<string>,
  options: Annotation<QueryPipelineOptions>,

  // Query plan from QueryPlannerAgent
  plan: Annotation<QueryPlanRef | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // Retrieved results — accumulates across iterations
  retrievalResults: Annotation<RetrievalResultEntry[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // Memory context — accumulates recalled snippets
  memoryContext: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // Evaluation & iteration control
  confidence: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  iterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  maxIterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 3,
  }),
  confidenceThreshold: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0.7,
  }),

  // Output
  result: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

// ── Indexing Pipeline State ──

export const IndexingPipelineState = Annotation.Root({
  // Input
  filePaths: Annotation<string[]>,
  topicId: Annotation<string>,

  // Intermediate pipeline data — lives in graph state (not node closures) so
  // each invocation gets a fresh, isolated copy: a compiled graph can be
  // reused or invoked concurrently without runs leaking data into each other.
  loadedDocs: Annotation<LangChainDocument[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  chunks: Annotation<LangChainDocument[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  extractedEntities: Annotation<ExtractedEntity[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  extractedRelationships: Annotation<ExtractedRelationship[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  // Progress counters
  documentCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  chunkCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  entityCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  relationshipCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  // Stage tracking
  completedStage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  // Errors — accumulates
  errors: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // Output
  result: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

// ── Derived types for convenience ──

export type QueryPipelineStateType = typeof QueryPipelineState.State;
export type QueryPipelineUpdateType = typeof QueryPipelineState.Update;
export type IndexingPipelineStateType = typeof IndexingPipelineState.State;
export type IndexingPipelineUpdateType = typeof IndexingPipelineState.Update;
