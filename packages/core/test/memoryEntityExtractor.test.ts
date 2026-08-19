import { expect } from "chai";
import { ILLMProvider, ILLMMessage } from "../src/index";
import {
  MemoryEntityExtractor,
  ExtractedMemoryEntity,
  ExtractedMemoryRelationship,
} from "../src/memory/memoryEntityExtractor";

// ── Mock helpers ─────────────────────────────────────────────────────

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

function createFailingLLMProvider(error?: Error): ILLMProvider {
  return {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async () => {
        throw error ?? new Error("LLM request failed");
      },
    }),
    isAvailable: async () => true,
  };
}

function createSlowLLMProvider(delayMs: number): ILLMProvider {
  return {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async (_messages: ILLMMessage[], signal?: AbortSignal) => {
        async function* generate() {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
          yield "{}";
        }
        return generate();
      },
    }),
    isAvailable: async () => true,
  };
}

const validResponse = JSON.stringify({
  entities: [
    { name: "TypeScript", type: "tool", description: "Programming language" },
    { name: "React", type: "tool", description: "UI framework" },
    { name: "Alice", type: "person", description: "Team lead" },
  ],
  relationships: [
    {
      source: "React",
      target: "TypeScript",
      type: "uses",
      description: "React uses TypeScript",
      weight: 0.9,
    },
    {
      source: "Alice",
      target: "React",
      type: "prefers",
      description: "Alice prefers React",
      weight: 0.8,
    },
  ],
});

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryEntityExtractor", function () {
  describe("extract()", function () {
    it("should extract entities and relationships from valid LLM response", async function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(validResponse));
      const result = await extractor.extract("Alice leads the React TypeScript project");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);

      const names = result.entities.map((e) => e.name);
      expect(names).to.include("TypeScript");
      expect(names).to.include("React");
      expect(names).to.include("Alice");

      const ts = result.entities.find((e) => e.name === "TypeScript")!;
      expect(ts.type).to.equal("tool");
      expect(ts.description).to.equal("Programming language");

      const usesRel = result.relationships.find((r) => r.type === "uses")!;
      expect(usesRel.source).to.equal("React");
      expect(usesRel.target).to.equal("TypeScript");
      expect(usesRel.weight).to.equal(0.9);
    });

    it("should handle JSON wrapped in markdown code blocks", async function () {
      const wrappedResponse = "```json\n" + validResponse + "\n```";
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(wrappedResponse));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);
    });

    // Copilot and other chat models routinely wrap the JSON in prose or put the
    // fence somewhere other than offset 0. Anchoring the fence-strip at the
    // start of the response made every such reply parse-fail, which silently
    // produced a memory with no entities and an empty graph.
    it("should handle a fenced block preceded by prose", async function () {
      const response = "Here's the extracted data:\n\n```json\n" + validResponse + "\n```";
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);
    });

    it("should handle a fenced block followed by prose", async function () {
      const response = "```json\n" + validResponse + "\n```\n\nLet me know if you need more detail.";
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);
    });

    it("should handle a bare JSON object surrounded by prose", async function () {
      const response = "Sure! The entities are:\n" + validResponse + "\nThat covers everything.";
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);
    });

    it("should handle a fence with no newline before the closing marker", async function () {
      const response = "```" + validResponse + "```";
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(3);
      expect(result.relationships).to.have.length(2);
    });

    it("should not mistake a brace inside a string for the end of the object", async function () {
      const response =
        'Result:\n{"entities":[{"name":"a}b","type":"tool","description":"has } brace"}],"relationships":[]}';
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(1);
      expect(result.entities[0].name).to.equal("a}b");
    });

    it("should return empty on malformed LLM response", async function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider("this is not json at all!!!"));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should return empty when LLM throws an error", async function () {
      const extractor = new MemoryEntityExtractor(createFailingLLMProvider());
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should return empty when LLM times out", async function () {
      this.timeout(20000);
      // The extractor uses a 15s timeout; use a delay well beyond that
      const extractor = new MemoryEntityExtractor(createSlowLLMProvider(30000));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should propagate caller cancellation instead of degrading it", async function () {
      const extractor = new MemoryEntityExtractor(createSlowLLMProvider(30_000));
      const controller = new AbortController();
      const extraction = extractor.extract("Some memory text", controller.signal);
      controller.abort(new Error("cancel memory extraction"));

      let caught: unknown;
      try {
        await extraction;
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(controller.signal.aborted).to.equal(true);
    });

    it("should return empty when LLM is not available", async function () {
      const provider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => false,
      };
      const extractor = new MemoryEntityExtractor(provider);
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should return empty when no model is available", async function () {
      const provider: ILLMProvider = {
        selectModel: async () => null,
        isAvailable: async () => true,
      };
      const extractor = new MemoryEntityExtractor(provider);
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it("should default invalid entity types to 'other'", async function () {
      const response = JSON.stringify({
        entities: [{ name: "Foo", type: "invalid_type", description: "Some entity" }],
        relationships: [],
      });
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.entities).to.have.length(1);
      expect(result.entities[0].type).to.equal("other");
    });

    it("should default invalid relationship types to 'related_to'", async function () {
      const response = JSON.stringify({
        entities: [
          { name: "A", type: "concept", description: "Entity A" },
          { name: "B", type: "concept", description: "Entity B" },
        ],
        relationships: [{ source: "A", target: "B", type: "invalid_rel", description: "A to B", weight: 1 }],
      });
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some memory text");

      expect(result.relationships).to.have.length(1);
      expect(result.relationships[0].type).to.equal("related_to");
    });

    it("should clamp relationship weight to [0, 1]", async function () {
      const response = JSON.stringify({
        entities: [
          { name: "X", type: "tool", description: "Tool X" },
          { name: "Y", type: "tool", description: "Tool Y" },
        ],
        relationships: [{ source: "X", target: "Y", type: "uses", description: "X uses Y", weight: 5 }],
      });
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(response));
      const result = await extractor.extract("Some text");

      expect(result.relationships[0].weight).to.equal(1);
    });
  });

  describe("mergeEntities()", function () {
    it("should deduplicate entities by name+type (case insensitive)", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const entities: ExtractedMemoryEntity[] = [
        { name: "TypeScript", type: "tool", description: "A language" },
        { name: "typescript", type: "tool", description: "A typed language" },
        { name: "React", type: "tool", description: "UI framework" },
      ];

      const merged = extractor.mergeEntities(entities);

      expect(merged).to.have.length(2);
      const tsEntity = merged.find((e) => e.name.toLowerCase() === "typescript")!;
      expect(tsEntity.description).to.include("A language");
      expect(tsEntity.description).to.include("A typed language");
    });

    it("should keep entities with same name but different type", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const entities: ExtractedMemoryEntity[] = [
        { name: "React", type: "tool", description: "A framework" },
        { name: "React", type: "concept", description: "Component model" },
      ];

      const merged = extractor.mergeEntities(entities);
      expect(merged).to.have.length(2);
    });

    it("should not duplicate description when merging identical descriptions", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const entities: ExtractedMemoryEntity[] = [
        { name: "Node", type: "tool", description: "JS runtime" },
        { name: "node", type: "tool", description: "JS runtime" },
      ];

      const merged = extractor.mergeEntities(entities);
      expect(merged).to.have.length(1);
      expect(merged[0].description).to.equal("JS runtime");
    });

    it("should return empty array for empty input", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const merged = extractor.mergeEntities([]);
      expect(merged).to.have.length(0);
    });
  });

  describe("mergeRelationships()", function () {
    it("should deduplicate relationships by source+target+type (case insensitive)", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const relationships: ExtractedMemoryRelationship[] = [
        { source: "React", target: "TypeScript", type: "uses", description: "Uses TS", weight: 1 },
        { source: "react", target: "typescript", type: "uses", description: "Also uses TS", weight: 0.5 },
        { source: "Alice", target: "React", type: "prefers", description: "Likes React", weight: 0.8 },
      ];

      const merged = extractor.mergeRelationships(relationships);

      expect(merged).to.have.length(2);
    });

    it("should keep relationships with same source+target but different type", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const relationships: ExtractedMemoryRelationship[] = [
        { source: "A", target: "B", type: "uses", description: "A uses B", weight: 1 },
        { source: "A", target: "B", type: "depends_on", description: "A depends on B", weight: 1 },
      ];

      const merged = extractor.mergeRelationships(relationships);
      expect(merged).to.have.length(2);
    });

    it("should keep first occurrence when deduplicating", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const relationships: ExtractedMemoryRelationship[] = [
        { source: "X", target: "Y", type: "related_to", description: "First", weight: 0.9 },
        { source: "x", target: "y", type: "related_to", description: "Second", weight: 0.1 },
      ];

      const merged = extractor.mergeRelationships(relationships);
      expect(merged).to.have.length(1);
      expect(merged[0].description).to.equal("First");
      expect(merged[0].weight).to.equal(0.9);
    });

    it("should return empty array for empty input", function () {
      const extractor = new MemoryEntityExtractor(createMockLLMProvider(""));
      const merged = extractor.mergeRelationships([]);
      expect(merged).to.have.length(0);
    });
  });
});
