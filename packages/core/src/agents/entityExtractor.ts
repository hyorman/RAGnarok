/**
 * Entity Extractor — LLM-powered extraction of entities and relationships from document chunks.
 * Processes chunks in batches, validates with Zod, implements circuit breaker + progress tracking.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { ILLMMessage, ILLMProvider } from "../interfaces";
import { Logger } from "../logger";
import {
  ExtractionResultSchema,
  EntitySchema,
  RelationshipSchema,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  EntityExtractorOptions,
} from "./entityExtractorTypes";

const EXTRACTION_TIMEOUT_MS = 30_000;
const MAX_CHUNK_LENGTH = 2000;

export class EntityExtractor {
  private logger: Logger;

  constructor(private llmProvider: ILLMProvider) {
    this.logger = new Logger("EntityExtractor");
    this.logger.info("EntityExtractor initialized");
  }

  /**
   * Extract entities and relationships from document chunks.
   * Processes in batches with circuit breaker + progress tracking.
   */
  async extractFromChunks(chunks: LangChainDocument[], options: EntityExtractorOptions): Promise<ExtractionResult> {
    const allEntities: ExtractedEntity[] = [];
    const allRelationships: ExtractedRelationship[] = [];
    let consecutiveFailures = 0;
    let processedChunks = 0;
    let failedChunks = 0;
    const startIndex = options.lastProcessedIndex ?? 0;

    this.logger.info("Starting entity extraction", {
      totalChunks: chunks.length,
      batchSize: options.batchSize,
      startIndex,
    });

    // Check LLM availability
    const model = await this.llmProvider.selectModel();
    if (!model) {
      this.logger.debug("No language models available, skipping entity extraction");
      return { entities: [], relationships: [] };
    }

    // Process chunks in batches
    for (let i = startIndex; i < chunks.length; i += options.batchSize) {
      // Check cancellation
      if (options.signal?.aborted) {
        this.logger.info("Entity extraction cancelled");
        break;
      }

      // Circuit breaker
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        this.logger.error("Circuit breaker triggered", {
          consecutiveFailures,
          processedChunks,
          totalChunks: chunks.length,
        });
        break;
      }

      const batch = chunks.slice(i, i + options.batchSize);

      try {
        const result = await this.extractBatch(batch, model, options);
        allEntities.push(...result.entities);
        allRelationships.push(...result.relationships);
        consecutiveFailures = 0;
        processedChunks += batch.length;
      } catch (error) {
        // AbortError should propagate
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        consecutiveFailures++;
        failedChunks += batch.length;
        this.logger.warn("Batch extraction failed", {
          batchStart: i,
          batchSize: batch.length,
          consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Report progress
      options.onProgress?.({
        totalChunks: chunks.length,
        processedChunks,
        entitiesFound: allEntities.length,
        relationshipsFound: allRelationships.length,
        failedChunks,
        skippedChunks: startIndex,
      });

      // Rate limiting (skip on last batch)
      if (i + options.batchSize < chunks.length && options.rateLimitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.rateLimitMs));
      }
    }

    // Merge duplicates
    const entities = this.mergeEntities(allEntities);
    const relationships = this.mergeRelationships(allRelationships);

    this.logger.info("Entity extraction complete", {
      rawEntities: allEntities.length,
      mergedEntities: entities.length,
      rawRelationships: allRelationships.length,
      mergedRelationships: relationships.length,
      failedChunks,
    });

    return { entities, relationships };
  }

  /**
   * Extract entities from a single batch of chunks via LLM.
   */
  private async extractBatch(
    chunks: LangChainDocument[],
    model: { sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> },
    options: EntityExtractorOptions,
  ): Promise<ExtractionResult> {
    const systemPrompt = this.buildSystemPrompt(options.entityTypes);
    const userPrompt = this.buildUserPrompt(chunks);

    const messages: ILLMMessage[] = [{ role: "user", content: `${systemPrompt}\n\n${userPrompt}` }];

    // AbortController with timeout + external signal forwarding
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);

    let responseText = "";
    try {
      const response = await model.sendRequest(messages, controller.signal);
      for await (const chunk of response) {
        responseText += chunk;
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const jsonText = jsonMatch ? jsonMatch[1] : responseText;
    let cleanedJson = jsonText.trim();
    try {
      JSON.parse(cleanedJson);
    } catch {
      const match = cleanedJson.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("No valid JSON object found in LLM response");
      }
      cleanedJson = match[0];
    }
    const parsedJSON = JSON.parse(cleanedJson);

    // Validate with Zod — try full schema first, then partial salvage
    try {
      return ExtractionResultSchema.parse(parsedJSON);
    } catch {
      this.logger.debug("Full schema validation failed, attempting partial salvage");
      // Try to salvage entities and relationships independently
      const entities: ExtractedEntity[] = [];
      const relationships: ExtractedRelationship[] = [];

      if (Array.isArray(parsedJSON.entities)) {
        for (const e of parsedJSON.entities) {
          try {
            entities.push(EntitySchema.parse(e));
          } catch {
            // Skip invalid entity
          }
        }
      }
      if (Array.isArray(parsedJSON.relationships)) {
        for (const r of parsedJSON.relationships) {
          try {
            relationships.push(RelationshipSchema.parse(r));
          } catch {
            // Skip invalid relationship
          }
        }
      }

      if (entities.length === 0 && relationships.length === 0) {
        throw new Error("Failed to salvage any entities or relationships from response");
      }

      return { entities, relationships };
    }
  }

  /**
   * Merge duplicate entities (same name + type, case-insensitive).
   */
  mergeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
    const groups = new Map<string, ExtractedEntity[]>();
    for (const entity of entities) {
      const key = `${entity.name.toLowerCase()}::${entity.type.toLowerCase()}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(entity);
    }

    return Array.from(groups.values()).map((group) => {
      const first = group[0];
      // Merge descriptions: unique sentences, capped at 500 chars
      const descriptions = new Set<string>();
      for (const e of group) {
        for (const sentence of e.description.split(/[.!?]+/).filter(Boolean)) {
          descriptions.add(sentence.trim());
        }
      }
      const mergedDescription = Array.from(descriptions).join(". ").slice(0, 500);

      return {
        name: first.name,
        type: first.type,
        description: mergedDescription || first.description,
      };
    });
  }

  /**
   * Merge duplicate relationships (same source + target + type, case-insensitive).
   */
  mergeRelationships(relationships: ExtractedRelationship[]): ExtractedRelationship[] {
    const groups = new Map<string, ExtractedRelationship[]>();
    for (const rel of relationships) {
      const key = `${rel.source.toLowerCase()}::${rel.target.toLowerCase()}::${rel.type.toLowerCase()}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(rel);
    }

    return Array.from(groups.values()).map((group) => {
      const first = group[0];
      const descriptions = new Set<string>();
      for (const r of group) {
        for (const sentence of r.description.split(/[.!?]+/).filter(Boolean)) {
          descriptions.add(sentence.trim());
        }
      }
      const mergedDescription = Array.from(descriptions).join(". ").slice(0, 500);
      const totalWeight = group.reduce((sum, r) => sum + (r.weight ?? 1), 0);

      return {
        source: first.source,
        target: first.target,
        type: first.type,
        description: mergedDescription || first.description,
        weight: Math.min(totalWeight, 10), // Cap at 10
      };
    });
  }

  /**
   * Embed entity descriptions using the embedding service.
   */
  async embedEntities(
    entities: ExtractedEntity[],
    embeddingService: { embedBatch(texts: string[]): Promise<number[][]> },
  ): Promise<Map<string, number[]>> {
    if (entities.length === 0) {
      return new Map();
    }

    const descriptions = entities.map((e) => e.description);
    const embeddings = await embeddingService.embedBatch(descriptions);

    const result = new Map<string, number[]>();
    for (let i = 0; i < entities.length; i++) {
      result.set(EntityExtractor.embeddingKey(entities[i]), embeddings[i]);
    }
    return result;
  }

  /** Stable key for the entity embedding map: "name::type" (lowercased). */
  static embeddingKey(entity: { name: string; type: string }): string {
    return `${entity.name.toLowerCase()}::${entity.type.toLowerCase()}`;
  }

  // ── Private prompt builders ────────────────────────────────────────

  private buildSystemPrompt(entityTypes: string[]): string {
    return `You are a knowledge graph entity extractor. Your task is to extract entities and relationships from text.

## Entity Types
Extract entities of these types: ${entityTypes.join(", ")}

## Relationship Types
Use these relationship types when applicable: calls, imports, inherits, implements, references, contains, related_to, depends_on, similar_to, extends, derives, uses

## Content-specific guidance
- **Code**: Extract classes, functions, modules as entities. Extract imports, calls, inheritance as relationships.
- **Documentation/Markdown**: Extract concepts, technologies, people as entities. Extract "explains", "references", "uses" as relationships.
- **General text**: Extract key nouns as entities. Use verbs and prepositions as relationship hints.

## Output Format
Respond with ONLY a JSON object matching this exact schema:
{
  "entities": [
    { "name": "EntityName", "type": "entity_type", "description": "Brief description" }
  ],
  "relationships": [
    { "source": "SourceEntity", "target": "TargetEntity", "type": "relationship_type", "description": "Brief description", "weight": 1 }
  ]
}

## Examples

Input: "The AuthService class uses JwtTokenProvider to generate tokens"
Output:
{
  "entities": [
    { "name": "AuthService", "type": "class", "description": "Authentication service class" },
    { "name": "JwtTokenProvider", "type": "class", "description": "JWT token generation provider" }
  ],
  "relationships": [
    { "source": "AuthService", "target": "JwtTokenProvider", "type": "uses", "description": "Uses JwtTokenProvider to generate tokens", "weight": 1 }
  ]
}

Input: "React components use hooks for state management"
Output:
{
  "entities": [
    { "name": "React", "type": "technology", "description": "UI framework for building components" },
    { "name": "hooks", "type": "concept", "description": "React state management pattern" }
  ],
  "relationships": [
    { "source": "React", "target": "hooks", "type": "uses", "description": "Components use hooks for state management", "weight": 1 }
  ]
}

## Rules
- Do NOT include entities with empty names or descriptions
- Keep descriptions concise (1-2 sentences)
- Use the most specific entity type that applies
- Only extract clearly stated relationships, do not infer speculative ones`;
  }

  private buildUserPrompt(chunks: LangChainDocument[]): string {
    const parts: string[] = ["Extract entities and relationships from the following text chunks:\n"];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const source = chunk.metadata?.source ?? "unknown";
      let text = chunk.pageContent;
      if (text.length > MAX_CHUNK_LENGTH) {
        text = text.slice(0, MAX_CHUNK_LENGTH) + "\n[...truncated]";
      }
      parts.push(`--- Chunk ${i + 1} (source: ${source}) ---`);
      parts.push(text);
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * Classify extracted entities into memory types (fact/preference/episode).
   *
   * Rules:
   * - Statements of truth, definitions, specifications → fact
   * - Repeated patterns, style guidelines, conventions → preference
   * - Dated events, version releases, deployment records → episode
   */
  classifyMemoryType(entity: { name: string; description: string }): "fact" | "preference" | "episode" {
    const desc = entity.description.toLowerCase();

    // Episode indicators: dates, temporal words, event language
    const episodePatterns =
      /\b(on \d|in \d{4}|released|deployed|happened|occurred|event|incident|outage|migration|v\d+\.\d+)\b/;
    if (episodePatterns.test(desc)) {
      return "episode";
    }

    // Preference indicators: should, prefer, convention, always, never, style
    const preferencePatterns =
      /\b(prefer|should|always|never|convention|style|practice|guideline|pattern|rule|avoid|recommend)\b/;
    if (preferencePatterns.test(desc)) {
      return "preference";
    }

    // Default: fact
    return "fact";
  }
}
