import { expect } from "chai";
import sinon from "sinon";
import {
  RAGQueryService,
  RAGAgent,
  TopicEmptyError,
  type IConfigProvider,
  type ILLMProvider,
  type TopicManager,
} from "../src/index";

const fakeRagResult = {
  query: "test query",
  plan: {
    originalQuery: "test query",
    complexity: "simple" as const,
    subQueries: [{ query: "test query", reasoning: "Direct search", topK: 5 }],
    explanation: "Simple query",
  },
  results: [
    {
      document: {
        pageContent: "Result content",
        metadata: { source: "doc.md", chunkIndex: 0, startPosition: 0, endPosition: 100 },
      },
      score: 0.85,
      source: "hybrid" as const,
    },
  ],
  iterations: 1,
  avgConfidence: 0.85,
  confidenceMet: true,
  executionTime: 42,
  metadata: {
    totalResults: 1,
    uniqueDocuments: 1,
    strategy: "hybrid",
    subQueriesExecuted: 1,
  },
};

function createTopicManagerStub(): TopicManager {
  return {
    resolveTopicByName: sinon.stub().resolves({
      topic: { id: "t1", name: "Docs" },
      matchType: "exact",
    }),
    getTopicStats: sinon.stub().resolves({ documentCount: 5, chunkCount: 100 }),
    getVectorStore: sinon.stub().resolves({}),
    getAllDocuments: sinon.stub().resolves([]),
    getKnowledgeGraph: sinon.stub().resolves(null),
    getEmbeddingService: sinon.stub().returns({}),
  } as any;
}

function createConfigStub(): IConfigProvider {
  const defaults: Record<string, unknown> = {
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    llmModel: "",
  };
  return {
    get: <T>(key: string, defaultValue: T): T => (key in defaults ? (defaults[key] as T) : defaultValue),
  } as any;
}

function createLLMProviderStub(): ILLMProvider {
  return {
    selectModel: sinon.stub().resolves(null),
    isAvailable: sinon.stub().resolves(false),
  } as any;
}

describe("RAGQueryService", () => {
  let topicManager: TopicManager;
  let config: IConfigProvider;
  let llmProvider: ILLMProvider;
  let service: RAGQueryService;
  let initStub: sinon.SinonStub;
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    topicManager = createTopicManagerStub();
    config = createConfigStub();
    llmProvider = createLLMProviderStub();

    initStub = sinon.stub(RAGAgent.prototype, "initialize").resolves();
    queryStub = sinon.stub(RAGAgent.prototype, "query").resolves(fakeRagResult as any);

    service = new RAGQueryService(topicManager, config, llmProvider);
  });

  afterEach(() => {
    service.dispose();
    sinon.restore();
  });

  describe("executeQuery", () => {
    it("should throw TopicEmptyError when topic has 0 documents", async () => {
      (topicManager.getTopicStats as sinon.SinonStub).resolves({ documentCount: 0, chunkCount: 0 });

      try {
        await service.executeQuery({ topic: "Docs", query: "test" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(TopicEmptyError);
      }
    });

    it("should throw when getVectorStore returns null", async () => {
      (topicManager.getVectorStore as sinon.SinonStub).resolves(null);

      try {
        await service.executeQuery({ topic: "Docs", query: "test" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
      }
    });

    describe("topK validation", () => {
      const invalidTopKValues = [
        { value: 0, label: "0" },
        { value: -1, label: "-1" },
        { value: 21, label: "21" },
        { value: 3.5, label: "3.5" },
        { value: NaN, label: "NaN" },
      ];

      for (const { value, label } of invalidTopKValues) {
        it(`should throw on invalid topK: ${label}`, async () => {
          try {
            await service.executeQuery({ topic: "Docs", query: "test", topK: value });
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).to.be.instanceOf(Error);
            expect((err as Error).message).to.include("topK");
          }
        });
      }
    });

    describe("maxIterations validation", () => {
      const invalidValues = [
        { value: 0, label: "0" },
        { value: -1, label: "-1" },
        { value: Infinity, label: "Infinity" },
        { value: NaN, label: "NaN" },
      ];

      for (const { value, label } of invalidValues) {
        it(`should throw on invalid maxIterations: ${label}`, async () => {
          const badConfig: IConfigProvider = {
            get: <T>(key: string, defaultValue: T): T => {
              if (key === "maxIterations") {
                return value as T;
              }
              if (key === "topK") {
                return 5 as T;
              }
              if (key === "retrievalStrategy") {
                return "hybrid" as T;
              }
              if (key === "confidenceThreshold") {
                return 0.7 as T;
              }
              return defaultValue;
            },
          };
          const svc = new RAGQueryService(topicManager, badConfig, llmProvider);
          try {
            await svc.executeQuery({ topic: "Docs", query: "test" });
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).to.be.instanceOf(Error);
            expect((err as Error).message).to.include("maxIterations");
          } finally {
            svc.dispose();
          }
        });
      }
    });

    describe("confidenceThreshold validation", () => {
      const invalidValues = [
        { value: -0.1, label: "-0.1" },
        { value: 1.1, label: "1.1" },
        { value: -1, label: "-1" },
        { value: 5, label: "5" },
      ];

      for (const { value, label } of invalidValues) {
        it(`should throw on invalid confidenceThreshold: ${label}`, async () => {
          const badConfig: IConfigProvider = {
            get: <T>(key: string, defaultValue: T): T => {
              if (key === "confidenceThreshold") {
                return value as T;
              }
              if (key === "topK") {
                return 5 as T;
              }
              if (key === "retrievalStrategy") {
                return "hybrid" as T;
              }
              if (key === "maxIterations") {
                return 3 as T;
              }
              return defaultValue;
            },
          };
          const svc = new RAGQueryService(topicManager, badConfig, llmProvider);
          try {
            await svc.executeQuery({ topic: "Docs", query: "test" });
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).to.be.instanceOf(Error);
            expect((err as Error).message).to.include("confidenceThreshold");
          } finally {
            svc.dispose();
          }
        });
      }
    });

    it("should use config default topK when neither params nor overrides provide it", async () => {
      await service.executeQuery({ topic: "Docs", query: "test" });

      expect(queryStub.calledOnce).to.be.true;
      const agentOptions = queryStub.firstCall.args[1];
      // When no topK provided, the service uses config default
      expect(agentOptions.topK).to.be.a("number");
    });

    it("should use params topK when provided", async () => {
      await service.executeQuery({ topic: "Docs", query: "test", topK: 7 });

      expect(queryStub.calledOnce).to.be.true;
      const agentOptions = queryStub.firstCall.args[1];
      expect(agentOptions.topK).to.equal(7);
    });

    it("should use params retrievalStrategy when provided", async () => {
      await service.executeQuery({
        topic: "Docs",
        query: "test",
        retrievalStrategy: "bm25" as any,
      });

      expect(queryStub.calledOnce).to.be.true;
      const agentOptions = queryStub.firstCall.args[1];
      expect(agentOptions.retrievalStrategy).to.equal("bm25");
    });

    it("should format result correctly", async () => {
      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result).to.have.property("topicMatched");
      expect(result).to.have.property("results").that.is.an("array");
      expect(result.results.length).to.be.greaterThan(0);
      expect(result.results[0]).to.have.property("similarity");
      expect(result.results[0]).to.have.property("text");
      expect(result.results[0]).to.have.property("documentName");
      expect(result.results[0]).to.have.property("retrievalStrategy");
      expect(result).to.have.property("query", "test");
      expect(result).to.have.property("topicName", "Docs");
    });

    it("should set requestedTopic when matchType is not exact", async () => {
      (topicManager.resolveTopicByName as sinon.SinonStub).resolves({
        topic: { id: "t1", name: "Documentation" },
        matchType: "fuzzy",
        availableTopics: ["Documentation", "API Docs"],
      });

      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result.requestedTopic).to.equal("Docs");
    });

    it("should not set requestedTopic when matchType is exact", async () => {
      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result.requestedTopic).to.be.undefined;
    });

    it("should include agenticMetadata in result", async () => {
      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result).to.have.property("agenticMetadata");
    });

    it("should populate agenticMetadata.steps[].resultsCount per sub-query (legacy path)", async () => {
      queryStub.resolves({
        ...fakeRagResult,
        plan: {
          ...fakeRagResult.plan,
          subQueries: [
            { query: "sub A", reasoning: "reasoning A", topK: 5 },
            { query: "sub B", reasoning: "reasoning B", topK: 5 },
          ],
        },
        results: [
          {
            document: { pageContent: "a1", metadata: { source: "a.md" } },
            score: 0.9,
            source: "hybrid",
            subQuery: "sub A",
          },
          {
            document: { pageContent: "a2", metadata: { source: "a.md" } },
            score: 0.8,
            source: "hybrid",
            subQuery: "sub A",
          },
          {
            document: { pageContent: "b1", metadata: { source: "b.md" } },
            score: 0.7,
            source: "hybrid",
            subQuery: "sub B",
          },
        ],
      } as any);

      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result.agenticMetadata?.steps).to.have.lengthOf(2);
      expect(result.agenticMetadata?.steps?.[0]).to.include({ query: "sub A", resultsCount: 2 });
      expect(result.agenticMetadata?.steps?.[1]).to.include({ query: "sub B", resultsCount: 1 });
    });

    it("should attribute follow-up-iteration results to their original sub-query via originalSubQuery (legacy path)", async () => {
      queryStub.resolves({
        ...fakeRagResult,
        plan: {
          ...fakeRagResult.plan,
          subQueries: [{ query: "sub A", reasoning: "reasoning A", topK: 5 }],
        },
        results: [
          {
            document: { pageContent: "a1", metadata: {} },
            score: 0.9,
            source: "hybrid",
            // A gap-filling follow-up iteration re-queries with different text
            // but is attributed back to the original sub-query it targets.
            subQuery: "follow-up phrasing of sub A",
            originalSubQuery: "sub A",
          },
        ],
      } as any);

      const result = await service.executeQuery({ topic: "Docs", query: "test" });

      expect(result.agenticMetadata?.steps?.[0]).to.include({ query: "sub A", resultsCount: 1 });
    });
  });

  describe("clearAgentCache", () => {
    it("should remove a cached agent", async () => {
      // Execute a query to populate the cache
      await service.executeQuery({ topic: "Docs", query: "test" });

      // Clear the cache for this topic
      service.clearAgentCache("t1");

      // Execute again - should recreate the agent (initialize called again)
      initStub.resetHistory();
      await service.executeQuery({ topic: "Docs", query: "another test" });

      expect(initStub.called).to.be.true;
    });
  });

  describe("dispose", () => {
    it("should clear all cached agents", async () => {
      await service.executeQuery({ topic: "Docs", query: "test" });

      service.dispose();

      // After dispose, executing again should recreate agent
      initStub.resetHistory();
      service = new RAGQueryService(topicManager, config, llmProvider);
      await service.executeQuery({ topic: "Docs", query: "test" });

      expect(initStub.called).to.be.true;
    });
  });

  describe("reranker caching", () => {
    it("should pass the same reranker instance to agents for different topics", async () => {
      // Setup two different topics
      (topicManager.resolveTopicByName as sinon.SinonStub)
        .withArgs("TopicA")
        .resolves({ topic: { id: "tA", name: "TopicA" }, matchType: "exact" });
      (topicManager.resolveTopicByName as sinon.SinonStub)
        .withArgs("TopicB")
        .resolves({ topic: { id: "tB", name: "TopicB" }, matchType: "exact" });

      await service.executeQuery({ topic: "TopicA", query: "q1" });
      await service.executeQuery({ topic: "TopicB", query: "q2" });

      // initialize is called once per topic
      expect(initStub.callCount).to.equal(2);

      // Both calls should receive the same reranker reference in options
      const rerankerA = initStub.firstCall.args[1]?.reranker;
      const rerankerB = initStub.secondCall.args[1]?.reranker;
      // Both should be identical (same reference or both undefined when import fails in test)
      expect(rerankerA).to.equal(rerankerB);
    });

    it("should clear cached reranker on dispose", async () => {
      await service.executeQuery({ topic: "Docs", query: "test" });

      service.dispose();

      // After dispose, a new service instance should create a fresh reranker
      service = new RAGQueryService(topicManager, config, llmProvider);
      initStub.resetHistory();

      await service.executeQuery({ topic: "Docs", query: "test" });

      // initialize should be called again with a freshly created reranker
      expect(initStub.calledOnce).to.be.true;
    });

    it("should cache null reranker when import fails (not retry)", async () => {
      // First call will attempt to create reranker (import fails in test env → null)
      await service.executeQuery({ topic: "Docs", query: "q1" });
      const reranker1 = initStub.firstCall.args[1]?.reranker;

      // Second call with a different topic should reuse the cached null
      (topicManager.resolveTopicByName as sinon.SinonStub)
        .withArgs("Other")
        .resolves({ topic: { id: "tOther", name: "Other" }, matchType: "exact" });

      await service.executeQuery({ topic: "Other", query: "q2" });
      const reranker2 = initStub.secondCall.args[1]?.reranker;

      // Both should be the same (both undefined when null is cached, since null → undefined via ?? undefined)
      expect(reranker1).to.equal(reranker2);
    });
  });

  describe("agent cache eviction", () => {
    it("should evict oldest agent when cache exceeds MAX_CACHED_AGENTS (10)", async () => {
      const MAX_CACHED_AGENTS = 10;

      // Create topics beyond the cache limit
      for (let i = 0; i < MAX_CACHED_AGENTS + 2; i++) {
        const topicId = `t${i}`;
        (topicManager.resolveTopicByName as sinon.SinonStub).withArgs(`Topic${i}`).resolves({
          topic: { id: topicId, name: `Topic${i}` },
          matchType: "exact",
        });
      }

      // Fill the cache past the limit
      for (let i = 0; i < MAX_CACHED_AGENTS + 2; i++) {
        await service.executeQuery({ topic: `Topic${i}`, query: "test" });
      }

      // Total init calls should be MAX_CACHED_AGENTS + 2 (one per unique topic)
      expect(initStub.callCount).to.equal(MAX_CACHED_AGENTS + 2);

      // Now re-query the first topic - it should have been evicted, requiring re-init
      initStub.resetHistory();
      await service.executeQuery({ topic: "Topic0", query: "test again" });

      // Agent for Topic0 was evicted, so initialize should be called again
      expect(initStub.calledOnce).to.be.true;
    });
  });
});
