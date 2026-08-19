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

  async extract(text: string, signal?: AbortSignal): Promise<ExtractionResult> {
    try {
      signal?.throwIfAborted();
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
      const timeoutSignal = AbortSignal.timeout(15_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        requestSignal.throwIfAborted();
        const stream = await model.sendRequest([{ role: "user", content: prompt }], requestSignal);
        requestSignal.throwIfAborted();

        let response = "";
        for await (const chunk of stream) {
          requestSignal.throwIfAborted();
          response += chunk;
        }

        return this.parseResponse(response);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        this.logger.warn("Entity extraction LLM call failed", error as Error);
        return { entities: [], relationships: [] };
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
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

  /**
   * Chat models rarely return the bare object the prompt asks for: they open
   * with a sentence of prose, wrap the JSON in a fence, or append a closing
   * remark. Anchoring the fence-strip at offset 0 lost every such reply, and
   * because extraction degrades silently the only visible symptom was a memory
   * that never gained entities and a graph that stayed empty forever.
   *
   * Read the strict form first, then a fenced block anywhere in the text, then
   * the first balanced object — so a well-behaved model still takes the cheap
   * path and a chatty one still parses.
   */
  private parseResponse(response: string): ExtractionResult {
    const parsed = this.parseJsonPayload(response);
    if (!parsed) {
      // The raw text is logged (truncated) because a bare Error serialised to
      // `{}` in the VS Code output channel, leaving parse failures undebuggable.
      this.logger.warn(
        `Failed to parse entity extraction response: no JSON object in ${response.length} chars; ` +
          `starts with ${JSON.stringify(response.slice(0, 300))}`,
      );
      return { entities: [], relationships: [] };
    }

    try {
      const entities: ExtractedMemoryEntity[] = [];
      const rawEntities: unknown = (parsed as { entities?: unknown }).entities;
      if (Array.isArray(rawEntities)) {
        for (const e of rawEntities) {
          if (
            e &&
            typeof e === "object" &&
            typeof (e as any).name === "string" &&
            typeof (e as any).description === "string"
          ) {
            const candidate = e as { name: string; type: unknown; description: string };
            const type = VALID_MEMORY_ENTITY_TYPES.has(candidate.type as MemoryEntityType)
              ? (candidate.type as MemoryEntityType)
              : "other";
            entities.push({ name: candidate.name, type, description: candidate.description });
          }
        }
      }

      const relationships: ExtractedMemoryRelationship[] = [];
      const rawRelationships: unknown = (parsed as { relationships?: unknown }).relationships;
      if (Array.isArray(rawRelationships)) {
        for (const r of rawRelationships) {
          if (
            r &&
            typeof r === "object" &&
            typeof (r as any).source === "string" &&
            typeof (r as any).target === "string"
          ) {
            const candidate = r as {
              source: string;
              target: string;
              type: unknown;
              description?: string;
              weight?: unknown;
            };
            const type = VALID_MEMORY_RELATIONSHIP_TYPES.has(candidate.type as MemoryRelationshipType)
              ? (candidate.type as MemoryRelationshipType)
              : "related_to";
            relationships.push({
              source: candidate.source,
              target: candidate.target,
              type,
              description: candidate.description ?? "",
              weight: typeof candidate.weight === "number" ? Math.min(1, Math.max(0, candidate.weight)) : 1,
            });
          }
        }
      }

      return {
        entities: this.mergeEntities(entities),
        relationships: this.mergeRelationships(relationships),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to read entity extraction payload: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { entities: [], relationships: [] };
    }
  }

  /** First candidate substring that parses as a JSON object, or null. */
  private parseJsonPayload(response: string): Record<string, unknown> | null {
    for (const candidate of this.jsonCandidates(response)) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Try the next, broader candidate.
      }
    }
    return null;
  }

  private *jsonCandidates(response: string): Generator<string> {
    const trimmed = response.trim();
    if (trimmed) {
      yield trimmed;
    }

    const fence = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(trimmed)) !== null) {
      const body = match[1].trim();
      if (body) {
        yield body;
      }
    }

    const balanced = this.firstBalancedObject(trimmed);
    if (balanced) {
      yield balanced;
    }
  }

  /**
   * Slice the first brace-balanced object, tracking string literals so a `}`
   * inside a name or description does not end the scan early.
   */
  private firstBalancedObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }
}
