/**
 * Knowledge Graph types for entity-relationship modeling
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

/** Runtime set of valid EntityType values for validation */
export const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  "class",
  "function",
  "module",
  "technology",
  "concept",
  "person",
  "organization",
  "location",
  "event",
  "fact",
  "preference",
  "episode",
  "other",
]);

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

/** Runtime set of valid RelationshipType values for validation */
export const VALID_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set<RelationshipType>([
  "calls",
  "imports",
  "inherits",
  "implements",
  "references",
  "contains",
  "uses",
  "explains",
  "related_to",
  "depends_on",
  "similar_to",
  "contradicts",
  "updates",
  "extends",
  "derives",
  "other",
]);

/** A node in the knowledge graph */
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

/** A community detected by Louvain algorithm */
export interface GraphCommunity {
  /** Louvain community label (integer) */
  id: number;
  /** Entity IDs belonging to this community */
  entityIds: string[];
  /** LLM-generated summary (populated in Phase 2+) */
  summary?: string;
  /** Hierarchy level (0 = base) */
  level: number;
  /** Parent community at higher level */
  parentId?: number;
  /** Extensible metadata bag */
  metadata: Record<string, unknown>;
}

/** Serializable snapshot of a knowledge graph */
export interface KnowledgeGraphData {
  entities: GraphEntity[];
  relationships: GraphRelationship[];
  communities: GraphCommunity[];
  metadata: {
    topicId: string;
    createdAt: number;
    updatedAt: number;
    entityCount: number;
    edgeCount: number;
    communityCount: number;
    embeddingModel: string;
  };
}

/** Statistics about a knowledge graph */
export interface KnowledgeGraphStats {
  entityCount: number;
  edgeCount: number;
  averageDegree: number;
  communityCount: number;
  density: number;
  connectedComponents: number;
}
