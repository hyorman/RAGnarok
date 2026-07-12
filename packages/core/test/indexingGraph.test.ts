/**
 * Unit Tests for LangGraph Indexing Pipeline
 * Tests graph structure, pipeline flow with/without LLM, and error handling.
 */

import { expect } from "chai";
import sinon from "sinon";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  createIndexingGraph,
  type IndexingGraphDeps,
  type ILLMProvider,
  type ILLMModel,
  TopicManager,
  DocumentLoaderFactory,
  SemanticChunker,
  EntityExtractor,
} from "../src/index";

// ── Mock Factories ───────────────────────────────────────────────────

function createMockLLMProvider(): ILLMProvider {
  const model: ILLMModel = {
    id: "test-model",
    family: "test",
    sendRequest: async () => {
      async function* gen() {
        yield JSON.stringify({
          entities: [{ name: "TypeScript", type: "technology", description: "A typed superset of JavaScript" }],
          relationships: [
            { source: "TypeScript", target: "JavaScript", type: "extends", description: "TS extends JS", weight: 0.9 },
          ],
        });
      }
      return gen();
    },
  };
  return {
    selectModel: sinon.stub().resolves(model),
    isAvailable: sinon.stub().resolves(true),
  };
}

function createMockTopicManager() {
  return {
    storeProcessedChunks: sinon.stub().resolves(),
    getVectorStore: sinon.stub().resolves({}),
    getKnowledgeGraph: sinon.stub().resolves(null),
    getKnowledgeGraphStore: sinon.stub().returns(null),
    getEmbeddingService: sinon.stub().returns({
      embed: sinon.stub().resolves([0.1, 0.2, 0.3]),
      embedBatch: sinon.stub().resolves([[0.1, 0.2, 0.3]]),
    }),
    resolveTopicByName: sinon.stub().resolves({ topic: { id: "t1" }, matchType: "exact" }),
  } as unknown as TopicManager;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("IndexingGraph", function () {
  this.timeout(30_000);

  let loadStub: sinon.SinonStub;
  let chunkStub: sinon.SinonStub;

  const testDocs = [
    new LangChainDocument({
      pageContent: "TypeScript is a typed superset of JavaScript.",
      metadata: { source: "/test/doc.md" },
    }),
  ];

  const testChunks = [
    new LangChainDocument({
      pageContent: "TypeScript is a typed superset of JavaScript.",
      metadata: { source: "/test/doc.md", chunkIndex: 0, chunkId: "c1" },
    }),
  ];

  beforeEach(() => {
    // Stub DocumentLoaderFactory.loadDocuments to return test docs
    loadStub = sinon
      .stub(DocumentLoaderFactory.prototype, "loadDocuments")
      .resolves([{ documents: testDocs, fileType: "markdown", fileName: "doc.md", fileSize: 100, loadTime: 5 }]);

    // Stub SemanticChunker.chunkDocuments to return test chunks
    chunkStub = sinon.stub(SemanticChunker.prototype, "chunkDocuments").resolves({
      chunks: testChunks,
      chunkCount: 1,
      strategy: "semantic",
      documentCount: 1,
      processingTime: 10,
      stats: { avgChunkSize: 45, minChunkSize: 45, maxChunkSize: 45, totalCharacters: 45 },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Graph creation", () => {
    it("should create a compiled graph from deps", () => {
      const deps: IndexingGraphDeps = {
        topicManager: createMockTopicManager(),
      };
      const graph = createIndexingGraph(deps);
      expect(graph).to.be.an("object");
      expect(graph.invoke).to.be.a("function");
    });
  });

  describe("Full pipeline without LLM", () => {
    it("should run load → chunk → store → buildResult (skipping entity extraction)", async () => {
      const tm = createMockTopicManager();
      const deps: IndexingGraphDeps = {
        topicManager: tm,
        // no llmProvider — entity extraction should be skipped
      };
      const graph = createIndexingGraph(deps);

      const result = await graph.invoke({
        filePaths: ["/test/doc.md"],
        topicId: "test-topic",
      });

      // Verify pipeline stages ran — storage receives the SAME chunks the
      // chunking stage produced (single pass, no re-load/re-chunk)
      expect(loadStub.calledOnce).to.be.true;
      expect(chunkStub.calledOnce).to.be.true;
      const storeStub = tm.storeProcessedChunks as sinon.SinonStub;
      expect(storeStub.calledOnce).to.be.true;
      expect(storeStub.firstCall.args[0]).to.equal("test-topic");
      const storedChunkIds = storeStub.firstCall.args[1].map((c: LangChainDocument) => c.metadata.chunkId as string);
      expect(storedChunkIds).to.have.length(1);
      expect(storedChunkIds[0]).to.match(/^chunk-[a-f0-9]{64}$/);

      // Verify final result
      expect(result.result).to.be.an("object");
      const output = result.result as Record<string, unknown>;
      expect(output).to.have.property("success", true);
      expect(output).to.have.property("topicId", "test-topic");
      expect(output).to.have.property("documentCount", 1);
      expect(output).to.have.property("chunkCount", 1);
      // No entity extraction
      expect(output).to.have.property("entityCount", 0);
      expect(output).to.have.property("relationshipCount", 0);
      expect(result.errors).to.be.an("array").with.lengthOf(0);
    });
  });

  describe("Full pipeline with LLM", () => {
    it("should run entity extraction when llmProvider is available", async () => {
      const tm = createMockTopicManager();
      // Provide a KG store so storeEntities can persist
      const mockKgStore = {
        saveGraph: sinon.stub().resolves(),
        loadGraph: sinon.stub().resolves(null),
      };
      (tm.getKnowledgeGraphStore as sinon.SinonStub).returns(mockKgStore);

      const extractStub = sinon.stub(EntityExtractor.prototype, "extractFromChunks").resolves({
        entities: [
          { name: "TypeScript", type: "technology", description: "A typed superset of JS" },
          { name: "JavaScript", type: "technology", description: "A scripting language" },
        ],
        relationships: [
          { source: "TypeScript", target: "JavaScript", type: "extends", description: "TS extends JS", weight: 0.9 },
        ],
      });

      const embedEntitiesStub = sinon.stub(EntityExtractor.prototype, "embedEntities").resolves(
        new Map([
          ["typescript::technology", [0.1, 0.2, 0.3]],
          ["javascript::technology", [0.3, 0.2, 0.1]],
        ]),
      );

      const deps: IndexingGraphDeps = {
        topicManager: tm,
        llmProvider: createMockLLMProvider(),
      };
      const graph = createIndexingGraph(deps);

      const result = await graph.invoke({
        filePaths: ["/test/doc.md"],
        topicId: "test-topic",
      });

      // Verify entity extraction ran
      expect(extractStub.calledOnce).to.be.true;
      expect(embedEntitiesStub.calledOnce).to.be.true;

      // Verify final result includes entity counts
      const output = result.result as Record<string, unknown>;
      expect(output).to.have.property("success", true);
      expect(output).to.have.property("entityCount", 2);
      expect(output).to.have.property("relationshipCount", 1);

      expect(mockKgStore.saveGraph.calledOnce).to.be.true;
      const savedGraph = mockKgStore.saveGraph.firstCall.args[1] as {
        entities: Array<{ name: string; sourceChunkIds: string[] }>;
        relationships: Array<{ sourceChunkIds: string[] }>;
      };
      expect(savedGraph.entities).to.have.length(2);
      const storedChunkId = (tm.storeProcessedChunks as sinon.SinonStub).firstCall.args[1][0].metadata.chunkId;
      const typeScriptEntity = savedGraph.entities.find((entity) => entity.name === "TypeScript");
      expect(typeScriptEntity?.sourceChunkIds).to.deep.equal([storedChunkId]);
      expect(savedGraph.relationships[0].sourceChunkIds).to.deep.equal([storedChunkId]);
    });
  });

  describe("Error handling", () => {
    it("should capture load errors and route around dependent stages", async () => {
      loadStub.restore();
      sinon.stub(DocumentLoaderFactory.prototype, "loadDocuments").rejects(new Error("File not found"));

      const tm = createMockTopicManager();
      const deps: IndexingGraphDeps = { topicManager: tm };
      const graph = createIndexingGraph(deps);

      const result = await graph.invoke({
        filePaths: ["/nonexistent/file.md"],
        topicId: "test-topic",
      });

      expect(result.errors).to.be.an("array").with.length.greaterThan(0);
      expect(result.errors[0]).to.include("loadDocuments failed");
      // A failed load must NOT flow into chunking or storage
      expect(chunkStub.called).to.be.false;
      expect((tm.storeProcessedChunks as sinon.SinonStub).called).to.be.false;
      expect((result.result as Record<string, unknown>).success).to.equal(false);
    });

    it("should capture error when embedding/storing fails and skip extraction", async () => {
      const tm = createMockTopicManager();
      (tm.storeProcessedChunks as sinon.SinonStub).rejects(new Error("LanceDB write error"));

      const extractStub = sinon.stub(EntityExtractor.prototype, "extractFromChunks");

      const deps: IndexingGraphDeps = { topicManager: tm, llmProvider: createMockLLMProvider() };
      const graph = createIndexingGraph(deps);

      const result = await graph.invoke({
        filePaths: ["/test/doc.md"],
        topicId: "test-topic",
      });

      expect(result.errors).to.be.an("array").with.length.greaterThan(0);
      expect(result.errors.some((e: string) => e.includes("embedAndStore failed"))).to.be.true;
      // Storage failure routes to buildResult — extraction never runs
      expect(extractStub.called).to.be.false;
    });
  });

  describe("Compiled graph reuse", () => {
    it("should not leak state between invocations of the same compiled graph", async () => {
      const tm = createMockTopicManager();
      const deps: IndexingGraphDeps = { topicManager: tm };
      const graph = createIndexingGraph(deps);

      // First run succeeds
      const first = await graph.invoke({ filePaths: ["/test/doc.md"], topicId: "t1" });
      expect((first.result as Record<string, unknown>).success).to.equal(true);

      // Second run: loader now fails. With closure-based state the first
      // run's documents would leak into this run; with graph state they must not.
      loadStub.restore();
      sinon.stub(DocumentLoaderFactory.prototype, "loadDocuments").rejects(new Error("boom"));

      const storeStub = tm.storeProcessedChunks as sinon.SinonStub;
      storeStub.resetHistory();

      const second = await graph.invoke({ filePaths: ["/test/other.md"], topicId: "t1" });
      expect((second.result as Record<string, unknown>).success).to.equal(false);
      expect(storeStub.called, "stale documents from a previous run were stored").to.be.false;
    });
  });
});
