import type { RAGQueryService } from "../agents/ragQueryService";
// Imported from the leaf module, not from ragQueryService: this is the only value
// import in the tools module, so routing it through the service would drag the whole
// agent stack into anyone importing the contracts.
import { TopicEmptyError } from "../agents/topicEmptyError";
import type { RAGQueryResult, RetrievalStrategy } from "../utils/types";
import { TOOL_LIMITS } from "./toolContracts";

export interface QueryToolInput {
  topic: string;
  query: string;
  topK?: number;
  retrievalStrategy?: string;
}

export interface QueryToolDeps {
  ragQueryService: RAGQueryService;
  /** VS Code supplies editor context; MCP omits it. */
  workspaceContext?: string;
}

/**
 * What a topic with no indexed documents returns. `results` stays an array so
 * callers iterating it still work, but no agenticMetadata is invented for a
 * retrieval run that never happened.
 */
export interface EmptyTopicPayload {
  query: string;
  topicName: string;
  topicMatched: "fallback";
  results: [];
  empty: true;
  message: string;
}

/**
 * NOT a discriminated union: `EmptyTopicPayload` is structurally assignable to
 * `RAGQueryResult`, so TypeScript silently accepts an empty payload wherever a
 * full result is expected. Narrow with `"empty" in payload` — nothing else is
 * safe.
 */
export type QueryToolPayload = RAGQueryResult | EmptyTopicPayload;

class QueryInputError extends Error {}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new QueryInputError(`Query tool '${field}' must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new QueryInputError(`Query tool '${field}' must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new QueryInputError(`Query tool '${field}' must not exceed ${maxLength} characters`);
  }
  return normalized;
}

export async function executeQueryTool(
  input: QueryToolInput,
  deps: QueryToolDeps,
  signal?: AbortSignal,
): Promise<QueryToolPayload> {
  const topic = requiredString(input.topic, "topic", TOOL_LIMITS.topicName);
  const query = requiredString(input.query, "query", TOOL_LIMITS.query);

  if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20)) {
    throw new QueryInputError("Query tool 'topK' must be an integer between 1 and 20");
  }
  if (input.retrievalStrategy !== undefined && !["vector", "hybrid", "bm25"].includes(input.retrievalStrategy)) {
    throw new QueryInputError("Query tool 'retrievalStrategy' must be 'vector', 'hybrid', or 'bm25'");
  }

  const params = {
    topic,
    query,
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    ...(input.retrievalStrategy === undefined
      ? {}
      : { retrievalStrategy: input.retrievalStrategy as RetrievalStrategy }),
  };

  try {
    return await deps.ragQueryService.executeQuery(params, deps.workspaceContext, signal);
  } catch (error) {
    if (error instanceof TopicEmptyError) {
      return {
        query,
        topicName: error.topicName,
        topicMatched: "fallback",
        results: [],
        empty: true,
        message: error.message,
      };
    }
    throw error;
  }
}
