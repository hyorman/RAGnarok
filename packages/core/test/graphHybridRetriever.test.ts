import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  KnowledgeGraph,
  GraphRetriever,
  GraphHybridRetriever,
  DEFAULT_GRAPH_HYBRID_OPTIONS,
  GraphEntity,
} from "../src/index";

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

// ── Tests ────────────────────────────────────────────────────────────

describe("GraphHybridRetriever", function () {
  let kg: KnowledgeGraph;
  let doc1: LangChainDocument;
  let _doc2: LangChainDocument;
  let doc3: LangChainDocument;

  beforeEach(function () {
    kg = new KnowledgeGraph("test-topic");
    kg.addEntity(
      createTestEntity({
        id: "e1",
        name: "JavaScript",
        type: "other",
        vector: [1, 0, 0],
        sourceChunkIds: ["chunk-1"],
      }),
    );
    kg.addEntity(
      createTestEntity({
        id: "e2",
        name: "Python",
        type: "other",
        vector: [0, 1, 0],
        sourceChunkIds: ["chunk-2"],
      }),
    );

    doc1 = new LangChainDocument({ pageContent: "JS content", metadata: { chunkId: "chunk-1" } });
    _doc2 = new LangChainDocument({ pageContent: "Python content", metadata: { chunkId: "chunk-2" } });
    doc3 = new LangChainDocument({ pageContent: "Other content", metadata: { chunkId: "chunk-3" } });
  });

  it("should fuse graph and vector results", async function () {
    const vectorRetriever = createMockVectorRetriever([
      { doc: doc1, score: 0.9 },
      { doc: doc3, score: 0.7 },
    ]);
    const embeddingService = createMockEmbeddingService([1, 0, 0]);

    const graphRetriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
    const hybrid = new GraphHybridRetriever(graphRetriever, vectorRetriever);

    const results = await hybrid.search("JavaScript", { k: 5 });

    expect(results.length).to.be.greaterThan(0);
    // Results should have both graph and vector scores
    const fusedResult = results.find((r) => r.graphScore > 0 && r.vectorScore > 0);
    // doc1/chunk-1 should appear in both graph and vector results
    expect(fusedResult).to.not.be.undefined;
  });

  it("should return vector-only results when graph returns empty", async function () {
    const emptyKg = new KnowledgeGraph("empty");
    const vectorRetriever = createMockVectorRetriever([{ doc: doc1, score: 0.8 }]);
    const embeddingService = createMockEmbeddingService();

    const graphRetriever = new GraphRetriever(emptyKg, vectorRetriever, embeddingService);
    const hybrid = new GraphHybridRetriever(graphRetriever, vectorRetriever);

    const results = await hybrid.search("anything", { k: 5 });

    expect(results.length).to.be.greaterThan(0);
    // Should have vector scores from fallback
    expect(results[0].vectorScore).to.be.greaterThan(0);
  });

  it("should respect custom weights", async function () {
    const vectorRetriever = createMockVectorRetriever([{ doc: doc1, score: 0.5 }]);
    const embeddingService = createMockEmbeddingService([1, 0, 0]);

    const graphRetriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
    const hybrid = new GraphHybridRetriever(graphRetriever, vectorRetriever);

    const results1 = await hybrid.search("JavaScript", {
      k: 5,
      graphWeight: 0.9,
      vectorWeight: 0.1,
    });
    const results2 = await hybrid.search("JavaScript", {
      k: 5,
      graphWeight: 0.1,
      vectorWeight: 0.9,
    });

    // Both should return results
    expect(results1.length).to.be.greaterThan(0);
    expect(results2.length).to.be.greaterThan(0);
  });

  it("should respect k limit", async function () {
    const docs = Array.from(
      { length: 10 },
      (_, i) => new LangChainDocument({ pageContent: `doc ${i}`, metadata: { chunkId: `c-${i}` } }),
    );
    const vectorRetriever = createMockVectorRetriever(docs.map((doc, i) => ({ doc, score: 1 - i * 0.05 })));
    const embeddingService = createMockEmbeddingService([1, 0, 0]);

    const graphRetriever = new GraphRetriever(kg, vectorRetriever, embeddingService);
    const hybrid = new GraphHybridRetriever(graphRetriever, vectorRetriever);

    const results = await hybrid.search("JavaScript", { k: 3 });
    expect(results).to.have.length.at.most(3);
  });

  it("should merge graph and vector candidates for the same chunk even when chunkId types differ (string vs number)", async function () {
    // Real-world metadata can carry chunkId as either a string (LanceDB-persisted
    // chunks) or a number (in-memory chunking). Both retrieval tiers must key
    // candidates through the same normalized chunk-id accessor, or the same
    // logical chunk silently produces two unmerged candidates.
    const numericIdDoc = new LangChainDocument({ pageContent: "graph view of chunk 42", metadata: { chunkId: 42 } });
    const stringIdDoc = new LangChainDocument({ pageContent: "vector view of chunk 42", metadata: { chunkId: "42" } });

    const fakeGraphRetriever = {
      search: async () => [{ document: numericIdDoc, score: 0.6, matchedEntities: ["e1"], hopDepth: 0 }],
    } as any;
    const vectorRetriever = createMockVectorRetriever([{ doc: stringIdDoc, score: 0.8 }]);

    const hybrid = new GraphHybridRetriever(fakeGraphRetriever, vectorRetriever);
    const results = await hybrid.search("chunk 42", { k: 5 });

    expect(results).to.have.lengthOf(1);
    expect(results[0].graphScore).to.be.greaterThan(0);
    expect(results[0].vectorScore).to.be.greaterThan(0);
  });

  it("should expose default options", function () {
    expect(DEFAULT_GRAPH_HYBRID_OPTIONS.graphWeight).to.equal(0.3);
    expect(DEFAULT_GRAPH_HYBRID_OPTIONS.vectorWeight).to.equal(0.7);
    expect(DEFAULT_GRAPH_HYBRID_OPTIONS.minSimilarity).to.equal(0.0);
  });
});
