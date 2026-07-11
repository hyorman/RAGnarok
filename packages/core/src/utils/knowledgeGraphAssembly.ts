import { createHash } from "crypto";
import { Document as LangChainDocument } from "@langchain/core/documents";
import type { ExtractedEntity, ExtractedRelationship } from "../agents/entityExtractorTypes";
import { KnowledgeGraph } from "../stores/knowledgeGraph";
import { GraphEntity, GraphRelationship, VALID_ENTITY_TYPES, VALID_RELATIONSHIP_TYPES } from "./graphTypes";

export interface UpsertKnowledgeGraphResult {
  entityCount: number;
  relationshipCount: number;
  entitiesAdded: number;
  entitiesUpdated: number;
  relationshipsAdded: number;
  relationshipsUpdated: number;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function stableId(prefix: string, payload: string): string {
  const hash = createHash("sha256").update(payload).digest("hex");
  return `${prefix}-${hash.slice(0, 16)}`;
}

function mergeUniqueStrings(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right]));
}

function mergeDescriptions(...descriptions: Array<string | undefined>): string {
  const sentences = new Set<string>();

  for (const description of descriptions) {
    if (!description) {
      continue;
    }
    for (const sentence of description
      .split(/[.!?]+/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      sentences.add(sentence);
    }
  }

  return Array.from(sentences).join(". ").slice(0, 500);
}

function getChunkId(chunk: LangChainDocument): string | null {
  const rawChunkId = chunk.metadata?.chunkId;
  if (typeof rawChunkId === "string" || typeof rawChunkId === "number") {
    return String(rawChunkId);
  }
  return null;
}

function collectSourceChunkIds(
  chunks: LangChainDocument[],
  predicate: (normalizedContent: string) => boolean,
): string[] {
  const chunkIds: string[] = [];

  for (const chunk of chunks) {
    const chunkId = getChunkId(chunk);
    if (!chunkId) {
      continue;
    }

    const normalizedContent = chunk.pageContent.toLowerCase();
    if (predicate(normalizedContent)) {
      chunkIds.push(chunkId);
    }
  }

  return chunkIds;
}

export function entityEmbeddingKey(entity: { name: string; type: string }): string {
  return `${entity.name.toLowerCase()}::${entity.type.toLowerCase()}`;
}

export function normalizeGraphEntityType(rawType: string): GraphEntity["type"] {
  const normalized = normalizeType(rawType);
  return VALID_ENTITY_TYPES.has(normalized) ? (normalized as GraphEntity["type"]) : "other";
}

export function normalizeGraphRelationshipType(rawType: string): GraphRelationship["type"] {
  const normalized = normalizeType(rawType);
  return VALID_RELATIONSHIP_TYPES.has(normalized) ? (normalized as GraphRelationship["type"]) : "other";
}

export function createGraphEntityId(name: string, type: GraphEntity["type"]): string {
  return stableId("ent", `${normalizeName(name)}::${type}`);
}

export function createGraphRelationshipId(sourceId: string, targetId: string, type: GraphRelationship["type"]): string {
  return stableId("rel", `${sourceId}::${type}::${targetId}`);
}

export function collectEntitySourceChunkIds(entityName: string, chunks: LangChainDocument[]): string[] {
  const normalizedName = normalizeName(entityName);
  if (!normalizedName) {
    return [];
  }

  return collectSourceChunkIds(chunks, (content) => content.includes(normalizedName));
}

export function collectRelationshipSourceChunkIds(
  sourceName: string,
  targetName: string,
  chunks: LangChainDocument[],
): string[] {
  const normalizedSource = normalizeName(sourceName);
  const normalizedTarget = normalizeName(targetName);
  if (!normalizedSource || !normalizedTarget) {
    return [];
  }

  return collectSourceChunkIds(
    chunks,
    (content) => content.includes(normalizedSource) && content.includes(normalizedTarget),
  );
}

export function upsertExtractedGraphData(params: {
  knowledgeGraph: KnowledgeGraph;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  entityEmbeddings: Map<string, number[]>;
  chunks: LangChainDocument[];
  timestamp?: number;
}): UpsertKnowledgeGraphResult {
  const { knowledgeGraph, entities, relationships, entityEmbeddings, chunks, timestamp = Date.now() } = params;

  let entitiesAdded = 0;
  let entitiesUpdated = 0;
  let relationshipsAdded = 0;
  let relationshipsUpdated = 0;

  for (const entity of entities) {
    const validatedType = normalizeGraphEntityType(entity.type);
    const preferredId = createGraphEntityId(entity.name, validatedType);
    const vector = entityEmbeddings.get(entityEmbeddingKey(entity)) ?? [];
    const sourceChunkIds = collectEntitySourceChunkIds(entity.name, chunks);

    const existing =
      knowledgeGraph.getEntity(preferredId) ??
      knowledgeGraph.findEntitiesByExactName(entity.name).find((candidate) => candidate.type === validatedType) ??
      null;

    if (existing) {
      knowledgeGraph.updateEntity(existing.id, {
        description: mergeDescriptions(existing.description, entity.description),
        vector: vector.length > 0 ? vector : existing.vector,
        sourceChunkIds: mergeUniqueStrings(existing.sourceChunkIds, sourceChunkIds),
        lastAccessedAt: timestamp,
      });
      entitiesUpdated++;
      continue;
    }

    knowledgeGraph.addEntity({
      id: preferredId,
      name: entity.name,
      type: validatedType,
      description: entity.description,
      vector,
      sourceChunkIds,
      confidence: 1.0,
      strength: 0.5,
      lastAccessedAt: timestamp,
      metadata: {},
    });
    entitiesAdded++;
  }

  for (const relationship of relationships) {
    const sourceEntity = knowledgeGraph.findEntitiesByExactName(relationship.source)[0];
    const targetEntity = knowledgeGraph.findEntitiesByExactName(relationship.target)[0];
    if (!sourceEntity || !targetEntity || sourceEntity.id === targetEntity.id) {
      continue;
    }

    const validatedType = normalizeGraphRelationshipType(relationship.type);
    const preferredId = createGraphRelationshipId(sourceEntity.id, targetEntity.id, validatedType);
    const sourceChunkIds = collectRelationshipSourceChunkIds(relationship.source, relationship.target, chunks);

    const existing =
      knowledgeGraph.getRelationship(preferredId) ??
      knowledgeGraph
        .getRelationshipsBetween(sourceEntity.id, targetEntity.id)
        .find((candidate) => candidate.type === validatedType) ??
      null;

    if (existing) {
      knowledgeGraph.updateRelationship(existing.id, {
        weight: Math.max(existing.weight, relationship.weight ?? existing.weight),
        description: mergeDescriptions(existing.description, relationship.description),
        sourceChunkIds: mergeUniqueStrings(existing.sourceChunkIds, sourceChunkIds),
        confidence: 1.0,
      });
      relationshipsUpdated++;
      continue;
    }

    knowledgeGraph.addRelationship({
      id: preferredId,
      sourceId: sourceEntity.id,
      targetId: targetEntity.id,
      type: validatedType,
      weight: relationship.weight ?? 0.5,
      description: relationship.description,
      sourceChunkIds,
      confidence: 1.0,
      metadata: {},
    });
    relationshipsAdded++;
  }

  return {
    entityCount: knowledgeGraph.getAllEntities().length,
    relationshipCount: knowledgeGraph.getAllRelationships().length,
    entitiesAdded,
    entitiesUpdated,
    relationshipsAdded,
    relationshipsUpdated,
  };
}
