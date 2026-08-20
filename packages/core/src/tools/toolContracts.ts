/**
 * Canonical tool input contracts.
 *
 * Plain JSON Schema, not Zod: @langchain/core pins zod 3 while the MCP SDK
 * uses zod 4, so a shared Zod schema would force one major on both hosts.
 * The VS Code manifest is generated from these; the MCP server's Zod schemas
 * are asserted equivalent by a contract test.
 */

export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: JsonSchemaProperty;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * topicName and query must agree with the MCP server's MCP_LIMITS
 * (packages/mcp-server/src/tools.ts); the memory bounds mirror
 * validateCommonInput in ../memory/memoryService.ts.
 */
export const TOOL_LIMITS = Object.freeze({
  topicName: 200,
  query: 20_000,
  memoryQuery: 10_000,
  memoryContent: 50_000,
  memoryId: 1_000,
  branch: 255,
  tag: 100,
  tags: 20,
  ids: 500,
});

export const RAG_QUERY_INPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.topicName,
      description:
        "The name of the topic to search within. If no exact match is found, the most semantically similar topic is used.",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.query,
      description: "The search query or question to find relevant information",
    },
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Number of top results to return. Optional - uses the configured value when omitted.",
    },
    retrievalStrategy: {
      type: "string",
      enum: ["vector", "hybrid", "bm25"],
      description:
        "Retrieval strategy: 'vector' (semantic only), 'hybrid' (semantic + keyword), or 'bm25' (keyword only). Optional - uses the configured value when omitted.",
    },
  },
  required: ["topic", "query"],
};

export const RAG_MEMORY_INPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["store", "recall", "forget", "stats", "list", "decay", "history", "promote", "links", "communities"],
      description: "The memory operation to perform",
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.memoryContent,
      description: "Memory content to store (required for 'store')",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.memoryQuery,
      description: "Search query (required for 'recall')",
    },
    topK: { type: "integer", minimum: 1, maximum: 50, description: "Maximum memories to recall (default 10)" },
    includeEntities: { type: "boolean", description: "Include extracted entities in recall results" },
    id: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.memoryId,
      description: "Memory id (used by 'forget', 'history', and 'promote')",
    },
    olderThan: { type: "integer", minimum: 1, maximum: 3650, description: "Forget memories older than N days" },
    expired: { type: "boolean", description: "Forget expired memories" },
    scope: { type: "string", enum: ["workspace", "branch"], description: "Memory scope" },
    branch: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.branch,
      description: "Branch name; auto-detected for branch scope when omitted",
    },
    tags: {
      type: "array",
      maxItems: TOOL_LIMITS.tags,
      items: { type: "string", minLength: 1, maxLength: TOOL_LIMITS.tag },
      description: "Tags to attach when storing",
    },
    ttlDays: { type: "number", exclusiveMinimum: 0, maximum: 3650, description: "Time to live in days" },
    includeAuto: { type: "boolean", description: "Include reserved automatic memories" },
    reinforce: { type: "boolean", description: "Reinforce recalled memories (turns recall into a mutation)" },
    ids: {
      type: "array",
      maxItems: TOOL_LIMITS.ids,
      items: { type: "string", minLength: 1, maxLength: TOOL_LIMITS.memoryId },
      description: "Memory ids to promote",
    },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum memories to list (default 50)" },
  },
  required: ["action"],
};

export const RAG_TOPIC_READ_INPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "stats"],
      description: "'list' returns every topic; 'stats' returns one topic's statistics and indexed documents",
    },
    topic: {
      type: "string",
      minLength: 1,
      maxLength: TOOL_LIMITS.topicName,
      description: "Topic name (required for 'stats')",
    },
  },
  required: ["action"],
};
