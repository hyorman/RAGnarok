/**
 * Shared test mocks and helpers to eliminate duplication across test files.
 */

import { ILLMProvider, RetrievalStrategy } from "../../src/index";
import type { RAGAgentOptions, QueryPlannerOptions } from "../../src/index";

export const mockLLMProvider: ILLMProvider = {
  selectModel: async () => null,
  isAvailable: async () => false,
};

export function defaultQueryOptions(overrides?: Partial<RAGAgentOptions>): RAGAgentOptions {
  return {
    topicName: "",
    workspaceContext: "",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    retrievalStrategy: RetrievalStrategy.HYBRID,
    topK: 5,
    modelFamily: "gpt-4o",
    ...overrides,
  };
}

export function defaultPlannerOptions(overrides?: Partial<QueryPlannerOptions>): QueryPlannerOptions {
  return {
    topicName: "",
    workspaceContext: "",
    topK: 5,
    modelFamily: "gpt-4o",
    retrievalStrategy: RetrievalStrategy.HYBRID,
    ...overrides,
  };
}
