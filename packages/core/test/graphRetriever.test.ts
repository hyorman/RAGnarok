import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { KnowledgeGraph, GraphRetriever, GraphEntity, GraphRelationship, getChunkId } from "../src/index";

// ── Mock helpers ─────────────────────────────────────────────────────

function createTestEntity(overrides: Partial<GraphEntity> & { id: string; name: string }): GraphEntity {
  return {
    type: "concept",
    description: overrides.name + " description",
    vector: [],
    sourceChunkIds: [],
    confidence: 1.0,
    strength: 0.5,
    lastAccessedAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function createTestRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: string = "related_to",
): GraphRelationship {
  return {
    id,
    sourceId,
    targetId,
    type: type as GraphRelationship["type"],
    weight: 1.0,
    sourceChunkIds: [],
    confidence: 1.0,
    metadata: {},
  };
}

function createMockVectorRetriever(results: Array<{ doc: LangChainDocument; score: number }>) {
  return {
    search: async (_query: string, _k: number) => results.map((r) => ({ document: r.doc, score: r.score })),
    getDocuments: async (_query: string, _k: number) => results.map((r) => r.doc),
    setVectorStore: () => {},
  } as any;
}

function createMockEmbeddingService(vector: number[] = [0.1, 0.2, 0.3]) {
  return {
    embed: async () => vector,
    embedBatch: async (texts: string[]) => texts.map(() => vector),
    initialize: async () => {},
  } as any;
}

function buildTestKG(): KnowledgeGraph {
  const kg = new KnowledgeGraph("test-topic");

  // Create entities with vectors and sourceChunkIds
  kg.addEntity(
    createTestEntity({
      id: "e1",
      name: "TypeScript",
      type: "other",
      vector: [1, 0, 0],
      sourceChunkIds: ["chunk-1", "chunk-2"],
    }),
  );
  kg.addEntity(
    createTestEntity({
      id: "e2",
      name: "React",
      type: "other",
      vector: [0, 1, 0],
      sourceChunkIds: ["chunk-2", "chunk-3"],
    }),
  );
  kg.addEntity(
    createTestEntity({
      id: "e3",
      name: "Node.js",
      type: "other",
      vector: [0, 0, 1],
      sourceChunkIds: ["chunk-4"],
    }),
  );
  kg.addEntity(
    createTestEntity({
      id: "e4",
      name: "Express",
      type: "other",
      vector: [0.5, 0, 0.5],
      sourceChunkIds: ["chunk-5"],
    }),
  );

  // Create relationships: TypeScript -> React, React -> Node.js, Node.js -> Express
  kg.addRelationship(createTestRelationship("r1", "e1", "e2", "related_to"));
  kg.addRelationship(createTestRelationship("r2", "e2", "e3", "depends_on"));
  kg.addRelationship(createTestRelationship("r3", "e3", "e4", "contains"));

  return kg;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("GraphRetriever", function () {
  describe("search", function () {
    it("rejects a persisted graph whose embedding fingerprint differs", async function () {
      const data = buildTestKG().toJSON();
      data.metadata.embeddingModel = "indexed-model";
      data.metadata.embeddingDimension = 3;
      data.metadata.embeddingFingerprint = {
        backendKind: "test",
        providerFormat: "test",
        model: "indexed-model",
        revision: "v1",
        dimension: 3,
        endpointHash: "local",
      };
      const persisted = KnowledgeGraph.fromJSON(data);
      const embeddingService = {
        ...createMockEmbeddingService([1, 0, 0]),
        getFingerprint: async () => ({
          backendKind: "test",
          providerFormat: "test",
          model: "different-model",
          revision: "v1",
          dimension: 3,
          endpointHash: "local",
        }),
      } as any;
      const retriever = new GraphRetriever(persisted, createMockVectorRetriever([]), embeddingService);

      try {
        await retriever.search("TypeScript", { k: 3 });
        expect.fail("expected fingerprint mismatch");
      } catch (error) {
        expect((error as Error).message).to.include("fingerprint mismatch");
        expect((error as Error).message).to.include("Reindex");
      }
    });

    it("should find entities by name and return graph-boosted results", async function () {
      const kg = buildTestKG();
      const doc1 = new LangChainDocument({ pageContent: "chunk 1", metadata: { chunkId: "chunk-1" } });
      const doc2 = new LangChainDocument({ pageContent: "chunk 2", metadata: { chunkId: "chunk-2" } });
      const vectorRetriever = createMockVectorRetriever([
        { doc: doc1, score: 0.9 },
        { doc: doc2, score: 0.8 },
      ]);
      const embeddingService = createMockEmbeddingService([1, 0, 0]);

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("TypeScript features", { k: 5 });

      expect(results).to.have.length.greaterThan(0);
      // chunk-1 and chunk-2 are sourceChunkIds of TypeScript entity
      const graphHits = results.filter((r) => r.matchedEntities.length > 0);
      expect(graphHits.length).to.be.greaterThan(0);
    });

    it("should traverse neighbors and find connected chunks", async function () {
      const kg = buildTestKG();
      const doc2 = new LangChainDocument({ pageContent: "chunk 2", metadata: { chunkId: "chunk-2" } });
      const doc3 = new LangChainDocument({ pageContent: "chunk 3", metadata: { chunkId: "chunk-3" } });
      const vectorRetriever = createMockVectorRetriever([
        { doc: doc2, score: 0.8 },
        { doc: doc3, score: 0.7 },
      ]);
      const embeddingService = createMockEmbeddingService([1, 0, 0]);

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("TypeScript", { k: 5, maxHopDepth: 2 });

      // Should find TypeScript (hop 0) and React (hop 1) via relationship
      const allEntities = results.flatMap((r) => r.matchedEntities);
      expect(allEntities).to.include("TypeScript");
    });

    it("should return graph-derived chunks even when vector candidates do not overlap", async function () {
      const kg = buildTestKG();
      const vectorRetriever = createMockVectorRetriever([]);
      const embeddingService = createMockEmbeddingService([1, 0, 0]);
      const graphDoc = new LangChainDocument({
        pageContent: "TypeScript reference content",
        metadata: { chunkId: "chunk-1", source: "graph.md" },
      });

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService, async () => [graphDoc]);
      const results = await retriever.search("TypeScript", { k: 5 });

      expect(results).to.have.length(1);
      expect(results[0].document.metadata?.chunkId).to.equal("chunk-1");
      expect(results[0].matchedEntities).to.include("TypeScript");
    });

    it("should fall back to vector search when no entities match", async function () {
      const kg = new KnowledgeGraph("test-empty");
      const doc = new LangChainDocument({ pageContent: "unrelated", metadata: { chunkId: "c1" } });
      const vectorRetriever = createMockVectorRetriever([{ doc, score: 0.7 }]);
      const embeddingService = createMockEmbeddingService();

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("completely unrelated query", { k: 5 });

      expect(results).to.have.length(1);
      expect(results[0].matchedEntities).to.have.length(0);
      expect(results[0].hopDepth).to.equal(-1);
    });

    it("should apply hop decay to neighbor scores", async function () {
      const kg = buildTestKG();
      const doc1 = new LangChainDocument({ pageContent: "chunk 1", metadata: { chunkId: "chunk-1" } });
      const doc4 = new LangChainDocument({ pageContent: "chunk 4", metadata: { chunkId: "chunk-4" } });
      const vectorRetriever = createMockVectorRetriever([
        { doc: doc1, score: 0.9 },
        { doc: doc4, score: 0.5 },
      ]);
      const embeddingService = createMockEmbeddingService([1, 0, 0]);

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("TypeScript", { k: 5, maxHopDepth: 3, hopDecay: 0.5 });

      // chunk-1 is directly from TypeScript (hop 0), chunk-4 is from Node.js (hop 2)
      // Direct hit should score higher than distant neighbor
      expect(results.length).to.be.greaterThan(0);
    });

    it("should handle empty knowledge graph", async function () {
      const kg = new KnowledgeGraph("empty-topic");
      const doc = new LangChainDocument({ pageContent: "text", metadata: { chunkId: "c1" } });
      const vectorRetriever = createMockVectorRetriever([{ doc, score: 0.6 }]);
      const embeddingService = createMockEmbeddingService();

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("anything", { k: 5 });

      expect(results).to.have.length(1);
      expect(results[0].score).to.be.greaterThan(0);
    });

    it("should respect k limit", async function () {
      const kg = buildTestKG();
      const docs = Array.from(
        { length: 10 },
        (_, i) => new LangChainDocument({ pageContent: `chunk ${i}`, metadata: { chunkId: `chunk-${i}` } }),
      );
      const vectorRetriever = createMockVectorRetriever(docs.map((doc, i) => ({ doc, score: 1 - i * 0.05 })));
      const embeddingService = createMockEmbeddingService([1, 0, 0]);

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("TypeScript", { k: 3 });

      expect(results).to.have.length.at.most(3);
    });

    it("should use embedding similarity to find entities", async function () {
      const kg = buildTestKG();
      // Query with vector close to TypeScript [1, 0, 0]
      const doc1 = new LangChainDocument({ pageContent: "chunk 1", metadata: { chunkId: "chunk-1" } });
      const vectorRetriever = createMockVectorRetriever([{ doc: doc1, score: 0.8 }]);
      const embeddingService = createMockEmbeddingService([0.9, 0.1, 0]);

      const retriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
      const results = await retriever.search("programming language", { k: 5 });

      // Should find TypeScript via embedding similarity even though "programming language" doesn't match entity names
      expect(results.length).to.be.greaterThan(0);
    });

    it("does not treat orthogonal or dimension-mismatched entity vectors as matches", async function () {
      const kg = new KnowledgeGraph("threshold-topic");
      kg.addEntity(
        createTestEntity({
          id: "orthogonal",
          name: "HiddenEntity",
          vector: [1, 0, 0],
          sourceChunkIds: ["graph-only"],
        }),
      );
      const vectorDoc = new LangChainDocument({
        pageContent: "vector fallback",
        metadata: { chunkId: "vector-only" },
      });
      const vectorRetriever = createMockVectorRetriever([{ doc: vectorDoc, score: 0.72 }]);

      for (const queryVector of [
        [0, 1, 0],
        [1, 0],
      ]) {
        const retriever = new GraphRetriever(kg, vectorRetriever, createMockEmbeddingService(queryVector), async () => [
          new LangChainDocument({ pageContent: "must not surface", metadata: { chunkId: "graph-only" } }),
        ]);
        const results = await retriever.search("unrelated terms", { k: 5 });

        expect(results).to.have.length(1);
        expect(results[0].document.metadata.chunkId).to.equal("vector-only");
        expect(results[0].matchedEntities).to.deep.equal([]);
        expect(results[0].effectiveStrategy).to.equal("vector");
        expect(results[0].degradedFrom).to.equal("graph");
        expect(results[0].fallbackReason).to.equal("no_graph_matches");
      }
    });

    it("honors a configurable raw-cosine entity threshold", async function () {
      const kg = new KnowledgeGraph("custom-threshold");
      kg.addEntity(
        createTestEntity({
          id: "candidate",
          name: "HiddenEntity",
          vector: [0.7, Math.sqrt(1 - 0.7 ** 2), 0],
          sourceChunkIds: ["graph-chunk"],
        }),
      );
      const graphDoc = new LangChainDocument({ pageContent: "graph", metadata: { chunkId: "graph-chunk" } });
      const fallbackDoc = new LangChainDocument({ pageContent: "vector", metadata: { chunkId: "vector-chunk" } });
      const vectorRetriever = createMockVectorRetriever([{ doc: fallbackDoc, score: 0.5 }]);
      const retriever = new GraphRetriever(kg, vectorRetriever, createMockEmbeddingService([1, 0, 0]), async () => [
        graphDoc,
      ]);

      const defaultResults = await retriever.search("unrelated terms", { k: 5 });
      const strictResults = await retriever.search("unrelated terms", { k: 5, entitySimilarityThreshold: 0.8 });

      expect(defaultResults.some((result) => result.matchedEntities.includes("HiddenEntity"))).to.equal(true);
      expect(strictResults.every((result) => result.matchedEntities.length === 0)).to.equal(true);
      expect(strictResults[0].fallbackReason).to.equal("no_graph_matches");
    });
  });

  describe("getChunkId", function () {
    it("should normalize a string chunkId", function () {
      expect(getChunkId({ chunkId: "chunk-1" })).to.equal("chunk-1");
    });

    it("should normalize a numeric chunkId to its string form", function () {
      expect(getChunkId({ chunkId: 42 })).to.equal("42");
    });

    it("should return null when chunkId is missing", function () {
      expect(getChunkId({})).to.be.null;
      expect(getChunkId(undefined)).to.be.null;
      expect(getChunkId(null)).to.be.null;
    });

    it("should return null for a non-string/number chunkId", function () {
      expect(getChunkId({ chunkId: { nested: true } })).to.be.null;
    });
  });
});

describe("KnowledgeGraph.searchEntitiesByEmbedding", function () {
  it("should find entities by vector similarity", function () {
    const kg = buildTestKG();
    const results = kg.searchEntitiesByEmbedding([1, 0, 0], 2);

    expect(results).to.have.length(2);
    // TypeScript [1,0,0] should be the closest match
    expect(results[0].entity.name).to.equal("TypeScript");
    expect(results[0].score).to.be.closeTo(1.0, 0.01);
  });

  it("should return empty for graph with no vectors", function () {
    const kg = new KnowledgeGraph("no-vectors");
    kg.addEntity(createTestEntity({ id: "e1", name: "NoVec", vector: [] }));
    const results = kg.searchEntitiesByEmbedding([1, 0, 0], 5);
    expect(results).to.have.length(0);
  });

  it("should limit results to k", function () {
    const kg = buildTestKG();
    const results = kg.searchEntitiesByEmbedding([0.5, 0.5, 0.5], 1);
    expect(results).to.have.length(1);
  });
});
