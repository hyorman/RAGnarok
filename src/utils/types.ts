/**
 * Core types for the RAG extension
 */

/**
 * Retrieval strategies for RAG queries
 */
export enum RetrievalStrategy {
  VECTOR = 'vector',
  HYBRID = 'hybrid',
  ENSEMBLE = 'ensemble',
  BM25 = 'bm25',
}

/**
 * Topic source - indicates where the topic originates from
 */
export type TopicSource = 'local' | 'common';

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
  fileType: 'pdf' | 'markdown' | 'html';
  addedAt: number;
  chunkCount: number;
}

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
    headingPath?: string[];  // Hierarchical path: ["Memory Allocation", "Malloc"]
    headingLevel?: number;   // Heading level (1-6)
    sectionTitle?: string;   // Direct parent heading
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
  // Note: Agentic RAG configuration is controlled via VS Code settings only
  // Users cannot override agentic settings per query
  useAgenticMode?: boolean;
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
      headingPath?: string;  // e.g., "Memory Allocation → Malloc"
      sectionTitle?: string;
    };
  }>;
  query: string;
  topicName: string;
  topicMatched: 'exact' | 'similar' | 'fallback';
  requestedTopic?: string;
  availableTopics?: string[];
  // Agentic RAG results
  agenticMetadata?: {
    mode: 'simple' | 'agentic';
    steps?: Array<{
      stepNumber: number;
      query: string;
      strategy: string;
      resultsCount: number;
      confidence: number;
      reasoning: string;
    }>;
    totalIterations?: number;
    queryComplexity?: 'simple' | 'moderate' | 'complex';
    confidence?: number;
  };
}

/**
 * Exported topic data format for import/export functionality
 * Used when exporting a topic to a .rag file (ZIP archive)
 */
export interface ExportedTopicData {
  /** Format version for future compatibility */
  version: string;
  /** Topic metadata (without source field - always becomes 'local' on import) */
  topic: Omit<Topic, 'source'>;
  /** Document metadata array */
  documents: Document[];
  /** Embedding model used to generate vectors */
  embeddingModel: string;
  /** Export timestamp */
  exportedAt: number;
}

