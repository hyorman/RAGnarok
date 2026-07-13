/**
 * Unit Tests for LangGraph Query Pipeline
 * Tests graph structure, flow, memory recall, refinement loop, and error handling.
 */

import { expect } from "chai";
import sinon from "sinon";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  createQueryGraph,
  type QueryGraphDeps,
  type IConfigProvider,
  type ILLMProvider,
  type INotifier,
  type ILLMModel,
  TopicManager,
  EmbeddingService,
  MemoryStore,
  QueryPlannerAgent,
  KnowledgeGraph,
} from "../src/index";

// ── Mock Factories ───────────────────────────────────────────────────

function createMockConfig(overrides?: Record<string, unknown>): IConfigProvider {
  const defaults: Record<string, unknown> = {
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    llmModel: "",
    gapScoreThreshold: 0.4,
    memoryConfidenceThreshold: 0.1,
    ...overrides,
  };
  return {
    get: <T>(key: string, defaultValue: T): T => (key in defaults ? (defaults[key] as T) : defaultValue),
  };
}

function createMockLLMProvider(): ILLMProvider {
  const model: ILLMModel = {
    id: "test-model",
    family: "test",
    sendRequest: async () => {
      async function* gen() {
        yield '{"originalQuery":"q","complexity":"simple","subQueries":[{"query":"q","reasoning":"direct","topK":5}],"explanation":"simple search"}';
      }
      return gen();
    },
  };
  return {
    selectModel: sinon.stub().resolves(model),
    isAvailable: sinon.stub().resolves(true),
  };
}

function createMockNotifier(): INotifier {
  return {
    showInfo: sinon.stub(),
    showWarning: sinon.stub(),
    showError: sinon.stub(),
    withProgress: sinon.stub().callsFake((_title, task) => task(() => {})),
  };
}

/** Creates a mock vector store with similaritySearchWithScore */
function createMockVectorStore(docs?: [LangChainDocument, number][]) {
  const defaultDocs: [LangChainDocument, number][] = [
    [
      new LangChainDocument({
        pageContent: "TypeScript is a typed superset of JavaScript",
        metadata: { source: "doc1.md", chunkIndex: 0 },
      }),
      0.9,
    ],
    [
      new LangChainDocument({
        pageContent: "JavaScript runs in the browser",
        metadata: { source: "doc2.md", chunkIndex: 0 },
      }),
      0.8,
    ],
  ];
  return {
    similaritySearchWithScore: sinon.stub().resolves(docs ?? defaultDocs),
  };
}

function createMockTopicManager(
  vectorStore?: any,
  options?: {
    knowledgeGraph?: KnowledgeGraph | null;
    documents?: LangChainDocument[];
  },
) {
  const defaultDocuments = options?.documents ?? [
    new LangChainDocument({
      pageContent: "TypeScript is a typed superset of JavaScript",
      metadata: { source: "doc1.md", chunkIndex: 0, chunkId: "doc1-chunk-0" },
    }),
    new LangChainDocument({
      pageContent: "JavaScript runs in the browser",
      metadata: { source: "doc2.md", chunkIndex: 0, chunkId: "doc2-chunk-0" },
    }),
  ];

  return {
    getVectorStore: sinon.stub().resolves(vectorStore ?? createMockVectorStore()),
    resolveTopicByName: sinon.stub().resolves({ topic: { id: "t1", name: "Test" }, matchType: "exact" }),
    getTopicStats: sinon.stub().resolves({ documentCount: 5, chunkCount: 100 }),
    getAllDocuments: sinon.stub().resolves(defaultDocuments),
    getKnowledgeGraph: sinon.stub().resolves(options?.knowledgeGraph ?? null),
    getKnowledgeGraphStore: sinon.stub().returns(null),
    getEmbeddingService: sinon.stub().returns({}),
  } as unknown as TopicManager;
}

function createMockEmbeddingService() {
  return {
    embed: sinon.stub().resolves([0.1, 0.2, 0.3]),
    embedBatch: sinon.stub().resolves([[0.1, 0.2, 0.3]]),
  } as unknown as EmbeddingService;
}

function createMockMemoryStore(memories?: Array<{ content: string }>) {
  const defaultMemories = memories ?? [{ content: "Previous insight about TypeScript" }];
  return {
    recall: sinon.stub().resolves({
      memories: defaultMemories.map((m) => ({
        entry: {
          id: "mem-1",
          content: m.content,
          scope: "global",
          vector: [0.1],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          accessCount: 1,
          lastAccessedAt: Date.now(),
          tags: [],
          entityIds: [],
          metadata: {},
        },
        score: 0.85,
      })),
      entities: [],
    }),
    store: sinon.stub().resolves({
      id: "mem-new",
      content: "stored",
      scope: "global",
      vector: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
      tags: [],
      entityIds: [],
      metadata: {},
    }),
  } as unknown as MemoryStore;
}

function buildDeps(overrides?: Partial<QueryGraphDeps>): QueryGraphDeps {
  return {
    llmProvider: createMockLLMProvider(),
    config: createMockConfig(),
    notifier: createMockNotifier(),
    embeddingService: createMockEmbeddingService(),
    topicManager: createMockTopicManager(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("QueryGraph", function () {
  this.timeout(30_000);

  let planStub: sinon.SinonStub;

  beforeEach(() => {
    // Stub QueryPlannerAgent.createPlan to return a deterministic plan
    planStub = sinon.stub(QueryPlannerAgent.prototype, "createPlan").resolves({
      originalQuery: "test query",
      complexity: "simple" as const,
      subQueries: [{ query: "test query", reasoning: "direct search", topK: 5 }],
      explanation: "Simple direct search",
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Graph creation", () => {
    it("should create a compiled graph from deps", () => {
      const deps = buildDeps();
      const graph = createQueryGraph(deps);
      expect(graph).to.be.an("object");
      expect(graph.invoke).to.be.a("function");
    });
  });

  describe("Simple query flow", () => {
    it("should flow through nodes and return a result", async () => {
      const deps = buildDeps();
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "What is TypeScript?",
        topicId: "test-topic",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "test", allowMemoryWrites: true },
        maxIterations: 3,
        confidenceThreshold: 0.5, // low threshold so it passes evaluation
      });

      expect(result.result).to.be.an("object");
      expect(result.error).to.be.null;
      expect(result.iterations).to.be.greaterThan(0);
      expect(result.retrievalResults).to.be.an("array").with.length.greaterThan(0);
      expect(result.confidence).to.be.a("number");

      // Verify plan was created
      expect(planStub.calledOnce).to.be.true;

      // Verify vector store was searched
      const tm = deps.topicManager as any;
      expect(tm.getVectorStore.calledOnce).to.be.true;
    });

    it("should use graph retrieval when strategy is graph and a knowledge graph is available", async () => {
      const vectorStore = createMockVectorStore([]);
      const knowledgeGraph = new KnowledgeGraph("t1");
      knowledgeGraph.addEntity({
        id: "ent-typescript",
        name: "TypeScript",
        type: "technology",
        description: "A typed superset of JavaScript",
        vector: [1, 0, 0],
        sourceChunkIds: ["chunk-graph-1"],
        confidence: 1,
        strength: 0.8,
        lastAccessedAt: Date.now(),
        metadata: {},
      });

      const graphDoc = new LangChainDocument({
        pageContent: "TypeScript adds static typing to JavaScript.",
        metadata: { source: "graph-doc.md", chunkId: "chunk-graph-1", chunkIndex: 0 },
      });

      const tm = createMockTopicManager(vectorStore, {
        knowledgeGraph,
        documents: [graphDoc],
      });
      const deps = buildDeps({ topicManager: tm });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "TypeScript",
        topicId: "t1",
        options: { retrievalStrategy: "graph", topK: 5, modelFamily: "test", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0,
      });

      expect((tm.getKnowledgeGraph as sinon.SinonStub).calledOnce).to.be.true;
      expect(result.retrievalResults).to.be.an("array").with.length.greaterThan(0);
      expect(result.retrievalResults[0].metadata?.retrievalStrategy).to.equal("graph");
      expect(result.retrievalResults[0].metadata?.chunkId).to.equal("chunk-graph-1");
    });

    it("should include results in formatted output", async () => {
      const deps = buildDeps();
      const graph = createQueryGraph(deps);

      const finalState = await graph.invoke({
        query: "TypeScript",
        topicId: "t1",
        options: { retrievalStrategy: "vector", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0.5,
      });

      const output = finalState.result as Record<string, unknown>;
      expect(output).to.have.property("query", "TypeScript");
      expect(output).to.have.property("results").that.is.an("array");
      expect(output).to.have.property("confidence").that.is.a("number");
      expect(output).to.have.property("metadata").that.is.an("object");
    });
  });

  describe("Memory recall integration", () => {
    it("should recall memories and add to context when memoryStore is provided", async () => {
      const memoryStore = createMockMemoryStore();
      const deps = buildDeps({ memoryStore });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "TypeScript features",
        topicId: "t1",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0.5,
      });

      expect((memoryStore.recall as sinon.SinonStub).calledOnce).to.be.true;
      expect(result.memoryContext).to.be.an("array").with.length.greaterThan(0);
      expect(result.memoryContext[0]).to.include("Previous insight about TypeScript");
    });

    it("should skip memory recall gracefully when no memoryStore", async () => {
      const deps = buildDeps({ memoryStore: undefined });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "TypeScript",
        topicId: "t1",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0.5,
      });

      // Should still complete without error
      expect(result.error).to.be.null;
      expect(result.memoryContext).to.be.an("array").with.lengthOf(0);
      expect(result.result).to.be.an("object");
    });

    it("propagates cancellation through memory, planning, retrieval, and reranking", async () => {
      const controller = new AbortController();
      const memoryStore = createMockMemoryStore();
      let rerankerSignalAborted = false;
      const rerank = sinon
        .stub()
        .callsFake(async (_query: string, _documents: LangChainDocument[], _topK: number, signal?: AbortSignal) => {
          expect(signal).to.have.property("aborted", false);
          setTimeout(() => controller.abort(new Error("cancel during graph reranking")), 0);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("reranker signal was not cancelled")), 100);
            signal?.addEventListener(
              "abort",
              () => {
                rerankerSignalAborted = true;
                clearTimeout(timeout);
                reject(signal.reason);
              },
              { once: true },
            );
          });
          return [];
        });
      const deps = buildDeps({
        memoryStore,
        reranker: { rerank, isAvailable: () => true, dispose: async () => {} } as any,
      });
      const graph = createQueryGraph(deps);

      let caught: unknown;
      try {
        await graph.invoke(
          {
            query: "TypeScript",
            topicId: "t1",
            options: { retrievalStrategy: "vector", topK: 5, modelFamily: "", allowMemoryWrites: true },
            maxIterations: 1,
            confidenceThreshold: 0.5,
          },
          { signal: controller.signal },
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(Error);
      expect((memoryStore.recall as sinon.SinonStub).firstCall.args[0].signal).to.have.property("aborted");
      expect(planStub.firstCall.args[1].signal).to.have.property("aborted");
      expect(rerank.calledOnce).to.equal(true);
      expect(rerankerSignalAborted).to.equal(true);
    });
  });

  describe("Refinement loop", () => {
    it("should refine when confidence is below threshold", async () => {
      // Create a vector store that returns low-score results
      const lowScoreDocs: [LangChainDocument, number][] = [
        [
          new LangChainDocument({
            pageContent: "Low relevance content",
            metadata: { source: "low.md" },
          }),
          0.2,
        ],
      ];
      const mockVs = createMockVectorStore(lowScoreDocs);
      const deps = buildDeps({
        topicManager: createMockTopicManager(mockVs),
      });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "obscure topic",
        topicId: "t1",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 3,
        confidenceThreshold: 0.9, // high threshold to force refinement
      });

      // Should have iterated more than once due to low confidence
      expect(result.iterations).to.be.greaterThan(1);
      // Plan should have been created initially, then refine should modify plan
      expect(planStub.calledOnce).to.be.true; // planQuery runs once; refine modifies plan directly
    });

    it("should cap iterations at maxIterations", async () => {
      const lowScoreDocs: [LangChainDocument, number][] = [
        [
          new LangChainDocument({
            pageContent: "Low relevance",
            metadata: { source: "low.md" },
          }),
          0.1,
        ],
      ];
      const mockVs = createMockVectorStore(lowScoreDocs);
      const deps = buildDeps({
        topicManager: createMockTopicManager(mockVs),
      });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "impossible match",
        topicId: "t1",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 2,
        confidenceThreshold: 0.99, // unreachable threshold
      });

      // iterations is incremented in planQuery (1) and each refine (+1 per loop)
      // maxIterations=2 means: planQuery(iter=1) → retrieve → evaluate → refine(iter=2) → retrieve → evaluate → exit
      expect(result.iterations).to.be.at.most(3);
      expect(result.result).to.be.an("object"); // Should still produce a result
    });
  });

  describe("Evaluate node confidence", () => {
    it("evaluates confidence using the pre-rerank originalScore, not the sigmoid-scaled reranked score", async () => {
      // The reranker inflates every candidate's score to 0.95 (a sigmoid-scaled
      // cross-encoder score) while the true first-stage retrieval score is ~0.3.
      // If evaluate() averaged the reranked score, 0.95 would clear a 0.6
      // threshold immediately (1 iteration, no refine). Using originalScore
      // keeps confidence at ~0.3, below threshold, forcing refinement.
      //
      // Mock scores are fed through VectorRetriever.similaritySearchWithScore
      // as raw LanceDB L2 distances, then normalized to a [0,1] similarity via
      // `1 - distance / 2` (see VectorRetriever.normalizeDistance) — so a
      // distance of 1.4 yields the ~0.3 similarity this test targets, not 0.3
      // itself. Strategy is pinned to "vector" (not "hybrid") so the mocked
      // topic manager's default keyword corpus (unrelated docs used to build
      // the BM25 index) can't blend extra candidates into the average.
      const doc = new LangChainDocument({
        pageContent: "Some content about the obscure topic",
        metadata: { source: "doc.md", chunkId: "dup-chunk" },
      });
      const lowScoreDocs: [LangChainDocument, number][] = [[doc, 1.4]];
      const mockVs = createMockVectorStore(lowScoreDocs);

      const rerank = sinon
        .stub()
        .callsFake(async (_query: string, candidates: Array<{ document: LangChainDocument; score: number }>) =>
          candidates.map((c) => ({ document: c.document, score: 0.95 })),
        );

      const deps = buildDeps({
        topicManager: createMockTopicManager(mockVs),
        reranker: { rerank, isAvailable: () => true, dispose: async () => {} } as any,
      });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "obscure topic",
        topicId: "t1",
        options: { retrievalStrategy: "vector", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 3,
        confidenceThreshold: 0.6,
      });

      expect(rerank.called).to.be.true;
      // Refinement only triggers if confidence was computed from originalScore (0.3 < 0.6).
      expect(result.iterations).to.be.greaterThan(1);
      expect(result.confidence).to.be.closeTo(0.3, 0.05);
      // The same chunk (chunkId "dup-chunk") accumulates across refine
      // iterations in state.retrievalResults; confidence staying at ~0.3
      // rather than drifting also confirms evaluate() dedups by chunk key
      // before averaging (a distinct, uncapped average would still land on
      // 0.3 here since all copies share the same originalScore — the
      // no-crash/no-NaN-with-duplicates behavior is what this covers).
      expect(result.retrievalResults.length).to.be.greaterThan(1);
    });
  });

  describe("Error handling", () => {
    it("should capture error when vector store retrieval fails", async () => {
      const failingVs = {
        similaritySearchWithScore: sinon.stub().rejects(new Error("DB connection lost")),
      };
      const deps = buildDeps({
        topicManager: createMockTopicManager(failingVs),
      });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "test",
        topicId: "t1",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0.5,
      });

      // Retrieval errors are caught per sub-query and return empty results
      // The graph should still complete (with 0 results / 0 confidence)
      expect(result.retrievalResults).to.be.an("array");
      expect(result.result).to.be.an("object");
    });

    it("should handle missing vector store for topic", async () => {
      const tm = createMockTopicManager();
      (tm.getVectorStore as sinon.SinonStub).resolves(null);
      const deps = buildDeps({ topicManager: tm });
      const graph = createQueryGraph(deps);

      const result = await graph.invoke({
        query: "test",
        topicId: "nonexistent",
        options: { retrievalStrategy: "hybrid", topK: 5, modelFamily: "", allowMemoryWrites: true },
        maxIterations: 1,
        confidenceThreshold: 0.5,
      });

      expect(result.error).to.include("Failed to load vector store");
    });
  });
});
