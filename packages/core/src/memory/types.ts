/**
 * Standalone Memory Module — Type Definitions
 *
 * Zero dependency on RAG core types (GraphEntity, memoryTypes.ts, etc.).
 * This module defines its own entity, relationship, and operation types.
 */

// ── Scope ────────────────────────────────────────────────────────────

/** Memory scope: workspace-level or branch-level */
export type MemoryScope = "workspace" | "branch";

// ── Memory Entry ─────────────────────────────────────────────────────

/** A raw memory entry stored by the user */
export interface MemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  branch?: string;
  vector: number[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  tags: string[];
  entityIds: string[];
  metadata: Record<string, unknown>;
  /** Optional TTL (epoch ms) — entry auto-expires after this time */
  expiresAt?: number;
  /** 0-1 confidence score, subject to decay (default 1.0) */
  confidence?: number;
  /** true = current version (default true for backward compat) */
  isLatest?: boolean;
  /** ID of the entry that superseded this one */
  supersededBy?: string;
  /** ID of the entry this supersedes (back-link) */
  previousVersionId?: string;
  /** Version number (starts at 1) */
  version?: number;
}

// ── Memory Entity (graph node) ───────────────────────────────────────

/** Entity types for memory graph nodes */
export type MemoryEntityType =
  | "fact"
  | "preference"
  | "concept"
  | "person"
  | "tool"
  | "project"
  | "convention"
  | "other";

export const VALID_MEMORY_ENTITY_TYPES = new Set<MemoryEntityType>([
  "fact",
  "preference",
  "concept",
  "person",
  "tool",
  "project",
  "convention",
  "other",
]);

/** A node in the memory entity graph */
export interface MemoryEntity {
  id: string;
  name: string;
  type: MemoryEntityType;
  description: string;
  vector: number[];
  scope: MemoryScope;
  branch?: string;
  confidence: number;
  strength: number;
  createdAt: number;
  updatedAt: number;
  sourceMemoryIds: string[];
  metadata: Record<string, unknown>;
}

// ── Memory Relationship (graph edge) ─────────────────────────────────

/** Relationship types for memory entity edges */
export type MemoryRelationshipType =
  | "related_to"
  | "depends_on"
  | "part_of"
  | "uses"
  | "prefers"
  | "contradicts"
  | "updates"
  | "other";

export const VALID_MEMORY_RELATIONSHIP_TYPES = new Set<MemoryRelationshipType>([
  "related_to",
  "depends_on",
  "part_of",
  "uses",
  "prefers",
  "contradicts",
  "updates",
  "other",
]);

/** An edge in the memory entity graph */
export interface MemoryRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: MemoryRelationshipType;
  description: string;
  weight: number;
  scope: MemoryScope;
  branch?: string;
  metadata: Record<string, unknown>;
}

// ── Operation Types ──────────────────────────────────────────────────

export interface StoreOptions {
  content: string;
  scope?: MemoryScope;
  branch?: string;
  tags?: string[];
  /** Optional time-to-live in days. */
  ttlDays?: number;
  /** Abort long-running embedding/extraction work before persistence. */
  signal?: AbortSignal;
}

export interface RecallOptions {
  query: string;
  scope?: MemoryScope;
  branch?: string;
  topK?: number;
  includeEntities?: boolean;
  /** Include reserved auto-generated entries (tags beginning with auto:). */
  includeAuto?: boolean;
  /** Update access counters. HTTP reader sessions force this to false. */
  reinforce?: boolean;
  /** Abort the embedding/search operation. */
  signal?: AbortSignal;
}

export interface RecallResult {
  memories: Array<{
    entry: MemoryEntry;
    score: number;
  }>;
  entities: Array<{
    entity: MemoryEntity;
    score: number;
  }>;
}

export interface ForgetOptions {
  id?: string;
  scope?: MemoryScope;
  branch?: string;
  olderThan?: number;
  /** If true, forget all expired entries (expiresAt < now OR confidence < threshold) */
  expired?: boolean;
}

export interface MemoryStats {
  totalMemories: number;
  totalEntities: number;
  totalRelationships: number;
  byScope: {
    workspace: number;
    branch: number;
  };
  branches: string[];
  entityTypes: Record<string, number>;
  lastUpdated: number;
}

// ── Serialization ────────────────────────────────────────────────────

export interface MemoryGraphData {
  entities: MemoryEntity[];
  relationships: MemoryRelationship[];
}

export interface MemoryGraphSnapshot {
  entities: Array<Omit<MemoryEntity, "vector">>;
  relationships: MemoryRelationship[];
}

// ── Scope Linking ────────────────────────────────────────────────────

/** A cross-scope link between two matching entities */
export interface ScopeLink {
  sourceScope: string;
  targetScope: string;
  sourceEntityId: string;
  targetEntityId: string;
  entityName: string;
  entityType: string;
  /** Name similarity score (1.0 = exact match) */
  confidence: number;
}

// ── Decay Status ─────────────────────────────────────────────────────

export interface DecayStatus {
  totalEntries: number;
  /** Entries whose confidence was reduced */
  decayedCount: number;
  /** Entries removed due to low confidence or TTL */
  expiredCount: number;
  /** Entries with confidence < 2× threshold (at risk) */
  nearThresholdCount: number;
}

// ── Constants ────────────────────────────────────────────────────────

export const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;
export const DEFAULT_TOP_K = 10;
export const MEMORY_TABLE_PREFIX = "_memory";

/** Decay rate (higher = faster decay) */
export const DECAY_LAMBDA = 0.05;
/** Below this confidence, entry is considered expired */
export const MIN_CONFIDENCE_THRESHOLD = 0.1;
/** Default auto-decay interval: 1 hour */
export const DECAY_INTERVAL_MS = 60 * 60 * 1000;
