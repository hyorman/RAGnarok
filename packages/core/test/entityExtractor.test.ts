import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { EntityExtractor, ILLMProvider, ILLMMessage } from "../src/index";
import type { EntityExtractorOptions, ExtractedEntity, ExtractedRelationship, ExtractionProgress } from "../src/index";

// ── Mock helpers ─────────────────────────────────────────────────────

function defaultOptions(overrides?: Partial<EntityExtractorOptions>): EntityExtractorOptions {
  return {
    batchSize: 5,
    rateLimitMs: 0, // No delay in tests
    maxConsecutiveFailures: 3,
    entityTypes: ["concept", "technology", "class"],
    ...overrides,
  };
}

function createChunk(content: string, source?: string): LangChainDocument {
  return new LangChainDocument({
    pageContent: content,
    metadata: { source: source ?? "test.ts" },
  });
}

function createMockLLMProvider(response: string): ILLMProvider {
  return {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async (_messages: ILLMMessage[], _signal?: AbortSignal) => {
        async function* generate() {
          yield response;
        }
        return generate();
      },
    }),
    isAvailable: async () => true,
  };
}

function createFailingLLMProvider(): ILLMProvider {
  return {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async () => {
        throw new Error("LLM request failed");
      },
    }),
    isAvailable: async () => true,
  };
}

const validResponse = JSON.stringify({
  entities: [
    { name: "TypeScript", type: "technology", description: "Programming language" },
    { name: "React", type: "technology", description: "UI framework" },
  ],
  relationships: [
    { source: "React", target: "TypeScript", type: "uses", description: "React uses TypeScript", weight: 1 },
  ],
});

// ── Tests ────────────────────────────────────────────────────────────

describe("EntityExtractor", function () {
  describe("extractFromChunks", function () {
    it("should return empty result when no LLM model available", async function () {
      const noModelProvider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      const extractor = new EntityExtractor(noModelProvider);
      const result = await extractor.extractFromChunks([createChunk("Some text")], defaultOptions());
      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should extract entities from a single chunk", async function () {
      const extractor = new EntityExtractor(createMockLLMProvider(validResponse));
      const result = await extractor.extractFromChunks(
        [createChunk("TypeScript and React are popular")],
        defaultOptions(),
      );
      expect(result.entities).to.have.length(2);
      expect(result.relationships).to.have.length(1);
    });

    it("should extract entities from multiple chunks in batch", async function () {
      const extractor = new EntityExtractor(createMockLLMProvider(validResponse));
      const chunks = [
        createChunk("Chunk 1 about TypeScript"),
        createChunk("Chunk 2 about React"),
        createChunk("Chunk 3 about Node.js"),
      ];
      const result = await extractor.extractFromChunks(chunks, defaultOptions({ batchSize: 2 }));
      // Two batches: [0,1] and [2], each returns same mock response
      expect(result.entities.length).to.be.greaterThan(0);
    });

    it("should handle JSON in markdown code blocks", async function () {
      const wrappedResponse = "```json\n" + validResponse + "\n```";
      const extractor = new EntityExtractor(createMockLLMProvider(wrappedResponse));
      const result = await extractor.extractFromChunks([createChunk("Some text")], defaultOptions());
      expect(result.entities).to.have.length(2);
    });

    it("should handle extraction failures gracefully (skip batch)", async function () {
      const extractor = new EntityExtractor(createFailingLLMProvider());
      const result = await extractor.extractFromChunks(
        [createChunk("Some text")],
        defaultOptions({ maxConsecutiveFailures: 5 }),
      );
      expect(result.entities).to.have.length(0);
    });

    it("should respect circuit breaker", async function () {
      let callCount = 0;
      const provider: ILLMProvider = {
        selectModel: async () => ({
          id: "mock-model",
          family: "mock",
          sendRequest: async () => {
            callCount++;
            throw new Error("fail");
          },
        }),
        isAvailable: async () => true,
      };
      const extractor = new EntityExtractor(provider);
      const chunks = Array.from({ length: 20 }, (_, i) => createChunk(`Chunk ${i}`));
      await extractor.extractFromChunks(
        chunks,
        defaultOptions({
          batchSize: 1,
          maxConsecutiveFailures: 3,
        }),
      );
      // Should stop after 3 consecutive failures
      expect(callCount).to.equal(3);
    });

    it("should report progress correctly", async function () {
      const progressUpdates: ExtractionProgress[] = [];
      const extractor = new EntityExtractor(createMockLLMProvider(validResponse));
      await extractor.extractFromChunks(
        [createChunk("Text 1"), createChunk("Text 2")],
        defaultOptions({
          batchSize: 1,
          onProgress: (p) => progressUpdates.push({ ...p }),
        }),
      );
      expect(progressUpdates.length).to.be.greaterThan(0);
      const last = progressUpdates[progressUpdates.length - 1];
      expect(last.processedChunks).to.equal(2);
      expect(last.entitiesFound).to.be.greaterThan(0);
    });

    it("should handle empty chunks array", async function () {
      const extractor = new EntityExtractor(createMockLLMProvider(validResponse));
      const result = await extractor.extractFromChunks([], defaultOptions());
      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should resume from lastProcessedIndex", async function () {
      let callCount = 0;
      const countingProvider: ILLMProvider = {
        selectModel: async () => ({
          id: "mock-model",
          family: "mock",
          sendRequest: async () => {
            callCount++;
            async function* generate() {
              yield validResponse;
            }
            return generate();
          },
        }),
        isAvailable: async () => true,
      };
      const extractor = new EntityExtractor(countingProvider);
      const chunks = Array.from({ length: 10 }, (_, i) => createChunk(`Chunk ${i}`));
      await extractor.extractFromChunks(
        chunks,
        defaultOptions({
          batchSize: 5,
          lastProcessedIndex: 5,
        }),
      );
      // Should only process chunks 5-9 (1 batch)
      expect(callCount).to.equal(1);
    });

    it("should salvage partial results on validation failure", async function () {
      const partialResponse = JSON.stringify({
        entities: [
          { name: "Valid", type: "concept", description: "A valid entity" },
          { invalid: true }, // Missing required fields
        ],
        relationships: [],
      });
      const extractor = new EntityExtractor(createMockLLMProvider(partialResponse));
      const result = await extractor.extractFromChunks([createChunk("Some text")], defaultOptions());
      // Full schema validation fails, but partial salvage should get the valid entity
      expect(result.entities).to.have.length(1);
      expect(result.entities[0].name).to.equal("Valid");
    });
  });

  describe("Entity Merging", function () {
    let extractor: EntityExtractor;

    before(function () {
      const noModelProvider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      extractor = new EntityExtractor(noModelProvider);
    });

    it("should merge duplicate entities (same name + type)", function () {
      const entities: ExtractedEntity[] = [
        { name: "TypeScript", type: "technology", description: "A programming language." },
        { name: "typescript", type: "Technology", description: "Typed JavaScript." },
        { name: "React", type: "technology", description: "UI framework." },
      ];
      const merged = extractor.mergeEntities(entities);
      expect(merged).to.have.length(2);
      const ts = merged.find((e) => e.name.toLowerCase() === "typescript");
      expect(ts).to.not.be.undefined;
      expect(ts!.description).to.include("programming language");
    });

    it("should handle empty entity array", function () {
      expect(extractor.mergeEntities([])).to.have.length(0);
    });

    it("should handle single entity", function () {
      const entities: ExtractedEntity[] = [{ name: "Solo", type: "concept", description: "Only one." }];
      expect(extractor.mergeEntities(entities)).to.have.length(1);
    });

    it("should keep first entity name casing", function () {
      const entities: ExtractedEntity[] = [
        { name: "JavaScript", type: "technology", description: "First." },
        { name: "javaScript", type: "technology", description: "Second." },
      ];
      const merged = extractor.mergeEntities(entities);
      expect(merged[0].name).to.equal("JavaScript");
    });

    it("should cap merged description at 500 chars", function () {
      const longDesc = "A".repeat(300);
      const entities: ExtractedEntity[] = [
        { name: "E", type: "concept", description: longDesc + "." },
        { name: "e", type: "concept", description: longDesc + "." },
      ];
      const merged = extractor.mergeEntities(entities);
      expect(merged[0].description.length).to.be.at.most(500);
    });
  });

  describe("Relationship Merging", function () {
    let extractor: EntityExtractor;

    before(function () {
      const noModelProvider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      extractor = new EntityExtractor(noModelProvider);
    });

    it("should merge duplicate relationships", function () {
      const rels: ExtractedRelationship[] = [
        { source: "A", target: "B", type: "uses", description: "A uses B.", weight: 1 },
        { source: "a", target: "b", type: "Uses", description: "A depends on B.", weight: 2 },
        { source: "A", target: "C", type: "uses", description: "A uses C.", weight: 1 },
      ];
      const merged = extractor.mergeRelationships(rels);
      expect(merged).to.have.length(2);
      const ab = merged.find((r) => r.source === "A" && r.target === "B");
      expect(ab).to.not.be.undefined;
      expect(ab!.weight).to.equal(3); // 1 + 2
    });

    it("should handle empty relationship array", function () {
      expect(extractor.mergeRelationships([])).to.have.length(0);
    });

    it("should cap weight at 10", function () {
      const rels: ExtractedRelationship[] = Array.from({ length: 20 }, () => ({
        source: "A",
        target: "B",
        type: "uses",
        description: "Repeated.",
        weight: 1,
      }));
      const merged = extractor.mergeRelationships(rels);
      expect(merged[0].weight).to.equal(10);
    });
  });

  describe("Entity Embedding", function () {
    it("should embed entity descriptions", async function () {
      const noModelProvider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      const extractor = new EntityExtractor(noModelProvider);
      const mockEmbeddingService = {
        embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
      };
      const entities: ExtractedEntity[] = [
        { name: "A", type: "concept", description: "Entity A" },
        { name: "B", type: "concept", description: "Entity B" },
      ];
      const embeddings = await extractor.embedEntities(entities, mockEmbeddingService);
      expect(embeddings.size).to.equal(2);
      expect(embeddings.get("a::concept")).to.deep.equal([0.1, 0.2, 0.3]);
      expect(embeddings.get("b::concept")).to.deep.equal([0.1, 0.2, 0.3]);
    });

    it("should return empty map for empty entities", async function () {
      const noModelProvider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      const extractor = new EntityExtractor(noModelProvider);
      const mockEmbeddingService = {
        embedBatch: async () => [],
      };
      const embeddings = await extractor.embedEntities([], mockEmbeddingService);
      expect(embeddings.size).to.equal(0);
    });
  });
});
