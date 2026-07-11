/**
 * LLM-powered entity extraction for the standalone memory module.
 * Extracts facts, preferences, concepts, people, tools, projects from raw memory content.
 * Gracefully degrades to no-op if LLM is unavailable.
 */

import { ILLMProvider } from "../interfaces";
import { Logger } from "../logger";
import {
  MemoryEntityType,
  MemoryRelationshipType,
  VALID_MEMORY_ENTITY_TYPES,
  VALID_MEMORY_RELATIONSHIP_TYPES,
} from "./types";

/** Extracted raw entity (pre-embedding, pre-ID) */
export interface ExtractedMemoryEntity {
  name: string;
  type: MemoryEntityType;
  description: string;
}

/** Extracted raw relationship (pre-ID, uses entity names) */
export interface ExtractedMemoryRelationship {
  source: string;
  target: string;
  type: MemoryRelationshipType;
  description: string;
  weight: number;
}

export interface ExtractionResult {
  entities: ExtractedMemoryEntity[];
  relationships: ExtractedMemoryRelationship[];
}

const EXTRACTION_PROMPT = `You extract structured entities and relationships from memory text that a developer has stored.

## Entity Types
- fact: Verified information, specifications, definitions
- preference: Coding conventions, style preferences, tool choices
- concept: Technical concepts, patterns, architectures
- person: People, team members, collaborators
- tool: Software tools, libraries, frameworks, services
- project: Projects, repositories, products
- convention: Naming conventions, coding standards, workflow rules
- other: Anything that doesn't fit above

## Relationship Types
- related_to, depends_on, part_of, uses, prefers, contradicts, updates, other

## Output Format
Respond with ONLY a JSON object:
{
  "entities": [{ "name": "...", "type": "...", "description": "..." }],
  "relationships": [{ "source": "...", "target": "...", "type": "...", "description": "...", "weight": 1 }]
}

## Rules
- Extract specific, named entities (not generic concepts like "code" or "software")
- Prefer lowercase canonical names for conventions/preferences
- Keep descriptions concise (1 sentence)
- Only extract clearly stated relationships
- relationship source and target must reference extracted entity names exactly

## Memory text:
`;

export class MemoryEntityExtractor {
  private logger = new Logger("MemoryEntityExtractor");

  constructor(private llmProvider: ILLMProvider) {}

  async extract(text: string): Promise<ExtractionResult> {
    try {
      const isAvailable = await this.llmProvider.isAvailable();
      if (!isAvailable) {
        this.logger.debug("LLM not available, skipping entity extraction");
        return { entities: [], relationships: [] };
      }

      const model = await this.llmProvider.selectModel();
      if (!model) {
        this.logger.debug("No LLM model available, skipping entity extraction");
        return { entities: [], relationships: [] };
      }

      const prompt = EXTRACTION_PROMPT + text;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const stream = await model.sendRequest([{ role: "user", content: prompt }], controller.signal);

        let response = "";
        for await (const chunk of stream) {
          response += chunk;
        }
        clearTimeout(timeout);

        return this.parseResponse(response);
      } catch (error) {
        clearTimeout(timeout);
        this.logger.warn("Entity extraction LLM call failed", error as Error);
        return { entities: [], relationships: [] };
      }
    } catch (error) {
      this.logger.warn("Entity extraction failed", error as Error);
      return { entities: [], relationships: [] };
    }
  }

  mergeEntities(entities: ExtractedMemoryEntity[]): ExtractedMemoryEntity[] {
    const seen = new Map<string, ExtractedMemoryEntity>();

    for (const entity of entities) {
      const key = `${entity.name.toLowerCase()}::${entity.type}`;
      const existing = seen.get(key);

      if (existing) {
        // Merge descriptions if different
        if (!existing.description.includes(entity.description)) {
          existing.description = `${existing.description}; ${entity.description}`;
        }
      } else {
        seen.set(key, { ...entity });
      }
    }

    return Array.from(seen.values());
  }

  mergeRelationships(relationships: ExtractedMemoryRelationship[]): ExtractedMemoryRelationship[] {
    const seen = new Map<string, ExtractedMemoryRelationship>();

    for (const rel of relationships) {
      const key = `${rel.source.toLowerCase()}::${rel.target.toLowerCase()}::${rel.type}`;
      if (!seen.has(key)) {
        seen.set(key, { ...rel });
      }
    }

    return Array.from(seen.values());
  }

  private parseResponse(response: string): ExtractionResult {
    try {
      // Strip markdown code blocks if present
      let json = response.trim();
      if (json.startsWith("```")) {
        json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      const parsed = JSON.parse(json);

      // Validate entities
      const entities: ExtractedMemoryEntity[] = [];
      if (Array.isArray(parsed.entities)) {
        for (const e of parsed.entities) {
          if (typeof e.name === "string" && typeof e.description === "string") {
            const type = VALID_MEMORY_ENTITY_TYPES.has(e.type) ? e.type : "other";
            entities.push({ name: e.name, type, description: e.description });
          }
        }
      }

      // Validate relationships
      const relationships: ExtractedMemoryRelationship[] = [];
      if (Array.isArray(parsed.relationships)) {
        for (const r of parsed.relationships) {
          if (typeof r.source === "string" && typeof r.target === "string") {
            const type = VALID_MEMORY_RELATIONSHIP_TYPES.has(r.type) ? r.type : "related_to";
            relationships.push({
              source: r.source,
              target: r.target,
              type,
              description: r.description ?? "",
              weight: typeof r.weight === "number" ? Math.min(1, Math.max(0, r.weight)) : 1,
            });
          }
        }
      }

      return {
        entities: this.mergeEntities(entities),
        relationships: this.mergeRelationships(relationships),
      };
    } catch (error) {
      this.logger.warn("Failed to parse entity extraction response", error as Error);
      return { entities: [], relationships: [] };
    }
  }
}
