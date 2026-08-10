/**
 * Entity-relationship types consumed by the graph visualization projection.
 */

/**
 * Entity type classification.
 * String union for extensibility — allows future types (e.g., memory types) without breaking changes.
 */
export type EntityType =
  | "class"
  | "function"
  | "module"
  | "technology"
  | "concept"
  | "person"
  | "organization"
  | "location"
  | "event"
  | "fact"
  | "preference"
  | "episode"
  | "other";

/**
 * Relationship type between entities.
 * String union for extensibility.
 */
export type RelationshipType =
  | "calls"
  | "imports"
  | "inherits"
  | "implements"
  | "references"
  | "contains"
  | "uses"
  | "explains"
  | "related_to"
  | "depends_on"
  | "similar_to"
  | "contradicts"
  | "updates"
  | "extends"
  | "derives"
  | "other";

/** A node in the graph */
export interface GraphEntity {
  /** Unique entity ID */
  id: string;
  /** Canonical entity name */
  name: string;
  /** Entity classification */
  type: EntityType;
  /** Natural language description (embedded for vector search) */
  description: string;
  /** Embedding of description (same model as topic's chunks) */
  vector: number[];
  /** Provenance: which TextChunks mentioned this entity */
  sourceChunkIds: string[];
  /** Extraction confidence, 0-1 (default 1.0) */
  confidence: number;
  /** Prominence/importance score, 0-1 (default 0.5) */
  strength: number;
  /** Timestamp for future LRU/decay (epoch ms) */
  lastAccessedAt: number;
  /** Extensible metadata bag */
  metadata: Record<string, unknown>;
}

/** A directed edge in the knowledge graph */
export interface GraphRelationship {
  /** Unique edge ID */
  id: string;
  /** Source entity ID */
  sourceId: string;
  /** Target entity ID */
  targetId: string;
  /** Relationship classification */
  type: RelationshipType;
  /** Relationship strength, 0-1 (default 0.5) */
  weight: number;
  /** Optional natural language description of the relationship */
  description?: string;
  /** Provenance: which TextChunks produced this edge */
  sourceChunkIds: string[];
  /** Extraction confidence, 0-1 (default 1.0) */
  confidence: number;
  /** Extensible metadata bag */
  metadata: Record<string, unknown>;
}
