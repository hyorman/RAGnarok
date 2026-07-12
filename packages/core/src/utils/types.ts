/**
 * Core types for the RAG extension
 */

/**
 * Retrieval strategies for RAG queries
 */
export enum RetrievalStrategy {
  VECTOR = "vector",
  HYBRID = "hybrid",
  ENSEMBLE = "ensemble",
  BM25 = "bm25",
  GRAPH = "graph",
  GRAPH_HYBRID = "graph_hybrid",
}

/**
 * Topic source - indicates where the topic originates from
 */
export type TopicSource = "local" | "common";

export interface Topic {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  documentCount: number;
  /** Source of the topic - 'local' (default) or 'common' (read-only shared database) */
  source?: TopicSource;
}

export interface Document {
  id: string;
  topicId: string;
  name: string;
  filePath: string;
  fileType: "pdf" | "markdown" | "html" | "text" | "web" | "github";
  source?: DocumentSource;
  addedAt: number;
  chunkCount: number;
}

export type DocumentSource =
  | { type: "file"; path: string }
  | { type: "url"; url: string }
  | { type: "github"; url: string; branch?: string };

export interface TextChunk {
  id: string;
  documentId: string;
  topicId: string;
  text: string;
  embedding: number[];
  metadata: {
    documentName: string;
    chunkIndex: number;
    startPosition: number;
    endPosition: number;
    headingPath?: string[]; // Hierarchical path: ["Memory Allocation", "Malloc"]
    headingLevel?: number; // Heading level (1-6)
    sectionTitle?: string; // Direct parent heading
  };
}

// Per-topic storage structure
export interface TopicData {
  topic: Topic;
  documents: { [documentId: string]: Document };
  chunks: { [chunkId: string]: TextChunk };
  modelName: string;
  lastUpdated: number;
}

// Topics index file
export interface TopicsIndex {
  topics: { [topicId: string]: Topic };
  modelName: string;
  lastUpdated: number;
}

export interface SearchResult {
  chunk: TextChunk;
  similarity: number;
  documentName: string;
}

export interface RAGQueryParams {
  topic: string;
  query: string;
  topK?: number;
  retrievalStrategy?: RetrievalStrategy;
}

export interface RAGQueryResult {
  results: Array<{
    text: string;
    documentName: string;
    similarity: number;
    retrievalStrategy: string;
    metadata: {
      chunkIndex: number;
      position: string;
      headingPath?: string; // e.g., "Memory Allocation → Malloc"
      sectionTitle?: string;
    };
  }>;
  query: string;
  topicName: string;
  topicMatched: "exact" | "similar" | "fallback";
  requestedTopic?: string;
  availableTopics?: string[];
  graphUsed?: boolean;
  fallbackReason?: string;
  matchedEntities?: string[];
  hopDepth?: number;
  // Agentic RAG results
  agenticMetadata?: {
    mode: "simple" | "agentic";
    steps?: Array<{
      stepNumber: number;
      query: string;
      resultsCount: number;
      confidence: number;
      reasoning: string;
    }>;
    totalIterations?: number;
    queryComplexity?: "simple" | "moderate" | "complex";
    confidence?: number;
  };
}

/**
 * Result of resolving a user-supplied topic name to a concrete Topic.
 * Returned by TopicManager.resolveTopicByName().
 */
export interface TopicMatch {
  topic: Topic;
  matchType: "exact" | "similar" | "fallback";
  /** All available topic names — included when the match is not exact */
  availableTopics?: string[];
}

/**
 * Exported topic data format for import/export functionality
 * Used when exporting a topic to a .rag file (ZIP archive)
 */
export interface ExportedTopicData {
  /** Format version for future compatibility */
  version: string;
  /** Topic metadata (without source field - always becomes 'local' on import) */
  topic: Omit<Topic, "source">;
  /** Document metadata array */
  documents: Document[];
  /** Embedding model used to generate vectors */
  embeddingModel: string;
  /** Export timestamp */
  exportedAt: number;
}
