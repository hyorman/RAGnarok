/**
 * Types and Zod schemas for entity extraction from document chunks.
 */

import { z } from "zod";

// ── Zod Schemas ──────────────────────────────────────────────────────

export const EntitySchema = z.object({
  name: z.string().describe("Canonical entity name"),
  type: z.string().describe("Entity type classification"),
  description: z.string().describe("Natural language description of the entity"),
});

export const RelationshipSchema = z.object({
  source: z.string().describe("Source entity name"),
  target: z.string().describe("Target entity name"),
  type: z.string().describe("Relationship type"),
  description: z.string().describe("Description of the relationship"),
  weight: z.number().optional().default(1),
});

export const ExtractionResultSchema = z.object({
  entities: z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
});

// ── Inferred TypeScript types ────────────────────────────────────────

export type ExtractedEntity = z.infer<typeof EntitySchema>;
export type ExtractedRelationship = z.infer<typeof RelationshipSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// ── Progress & Options ───────────────────────────────────────────────

/** Progress tracker for entity extraction */
export interface ExtractionProgress {
  totalChunks: number;
  processedChunks: number;
  entitiesFound: number;
  relationshipsFound: number;
  failedChunks: number;
  skippedChunks: number;
}

/** Options for the EntityExtractor */
export interface EntityExtractorOptions {
  /** Chunks per LLM call (default: 5) */
  batchSize: number;
  /** Delay between LLM calls in ms (default: 200) */
  rateLimitMs: number;
  /** Circuit breaker threshold (default: 5) */
  maxConsecutiveFailures: number;
  /** Which entity types to extract */
  entityTypes: string[];
  /** Cancellation signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (progress: ExtractionProgress) => void;
  /** Resume from this chunk index (simple checkpointing) */
  lastProcessedIndex?: number;
}

/** Default entity extractor options */
export const DEFAULT_ENTITY_EXTRACTOR_OPTIONS = {
  batchSize: 5,
  rateLimitMs: 200,
  maxConsecutiveFailures: 5,
  entityTypes: [
    "class",
    "function",
    "module",
    "technology",
    "concept",
    "person",
    "organization",
    "location",
    "event",
  ] as string[],
} as const;
