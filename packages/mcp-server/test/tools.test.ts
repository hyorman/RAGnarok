/**
 * Unit tests for MCP tool handlers (registerTools)
 *
 * Strategy: spy on McpServer.prototype.tool to capture each registered
 * handler callback, then invoke handlers directly with mocked dependencies.
 */

import { expect } from "chai";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools";
import type {
  TopicManager,
  EmbeddingService,
  IConfigProvider,
  ILLMProvider,
  ILLMModel,
  Topic,
} from "@ragnarok/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the JSON text from the first content entry of a tool response */
function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
}

/** Build a fake Topic object */
function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: "topic-1",
    name: "docs",
    description: "Documentation",
    createdAt: 1000,
    updatedAt: 2000,
    documentCount: 5,
    source: "local",
    ...overrides,
  } as Topic;
}

type ToolHandler = (...args: any[]) => Promise<any>;

/**
 * Register all tools on a real McpServer and capture the handler callbacks
 * keyed by tool name.
 */
function captureHandlers(deps: {
  topicManager: sinon.SinonStubbedInstance<TopicManager>;
  config: IConfigProvider;
  llmProvider: sinon.SinonStubbedInstance<ILLMProvider>;
  embeddingService: sinon.SinonStubbedInstance<EmbeddingService>;
}): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const server = new McpServer({ name: "test", version: "0.0.0" });

  // Wrap server.tool to capture the last argument (handler callback)
  const originalTool = server.tool.bind(server);
  server.tool = function (this: McpServer, ...args: any[]) {
    const name = args[0] as string;
    const handler = args[args.length - 1] as ToolHandler;
    handlers[name] = handler;
    return (originalTool as (...a: unknown[]) => unknown).apply(this, args);
  } as any;

  registerTools(
    server,
    deps.topicManager as unknown as TopicManager,
    deps.config,
    deps.llmProvider as unknown as ILLMProvider,
    deps.embeddingService as unknown as EmbeddingService,
    "/tmp/ragnarok-test",
  );

  return handlers;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP Tools (registerTools)", () => {
  let topicManager: sinon.SinonStubbedInstance<TopicManager>;
  let config: IConfigProvider;
  let llmProvider: sinon.SinonStubbedInstance<ILLMProvider>;
  let embeddingService: sinon.SinonStubbedInstance<EmbeddingService>;
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    // -- TopicManager stubs --
    topicManager = {
      getAllTopics: sinon.stub(),
      getTopicStats: sinon.stub(),
      createTopic: sinon.stub(),
      addDocuments: sinon.stub(),
    } as any;

    // -- IConfigProvider --
    config = {
      get<T>(_key: string, defaultValue: T): T {
        return defaultValue;
      },
    };

    // -- ILLMProvider stubs --
    llmProvider = {
      isAvailable: sinon.stub(),
      selectModel: sinon.stub(),
    } as any;

    // -- EmbeddingService stubs --
    embeddingService = {
      getCurrentModel: sinon.stub().returns("Xenova/all-MiniLM-L6-v2"),
      listAvailableModels: sinon.stub(),
      getActiveBackendType: sinon.stub().returns("huggingface"),
      getLocalModelPath: sinon.stub().returns("/models/all-MiniLM-L6-v2"),
      initialize: sinon.stub().resolves(),
    } as any;

    handlers = captureHandlers({ topicManager, config, llmProvider, embeddingService });
  });

  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // Registration smoke test
  // -----------------------------------------------------------------------

  it("registers all 10 expected tools", () => {
    const expected = [
      "rag_query",
      "rag_list_topics",
      "rag_topic_stats",
      "rag_create_topic",
      "rag_add_documents",
      "rag_list_embedding_models",
      "rag_embedding_info",
      "rag_switch_embedding_model",
      "rag_llm_status",
    ];
    for (const name of expected) {
      expect(handlers[name], `handler for ${name}`).to.be.a("function");
    }
  });

  // -----------------------------------------------------------------------
  // rag_query
  // -----------------------------------------------------------------------

  describe("rag_query", () => {
    it("returns error when topic is not found", async () => {
      topicManager.getAllTopics.returns([makeTopic({ name: "other" })]);

      const result = await handlers.rag_query({ topic: "missing", query: "hello" });
      const body = parseResponse(result);

      expect(body.error).to.include("not found");
      expect(body.availableTopics).to.equal("other");
    });

    it("lists all available topic names when topic is not found", async () => {
      topicManager.getAllTopics.returns([
        makeTopic({ name: "alpha" }),
        makeTopic({ name: "beta" }),
      ]);

      const result = await handlers.rag_query({ topic: "gamma", query: "q" });
      const body = parseResponse(result);

      expect(body.availableTopics).to.include("alpha");
      expect(body.availableTopics).to.include("beta");
    });

    it("returns 'No topics available' when topic list is empty", async () => {
      topicManager.getAllTopics.returns([]);

      const result = await handlers.rag_query({ topic: "x", query: "q" });
      const body = parseResponse(result);

      expect(body.availableTopics).to.equal("No topics available");
    });

    it("matches topic name case-insensitively", async () => {
      topicManager.getAllTopics.returns([makeTopic({ name: "Docs" })]);

      // The handler will try to load a vector store after matching.
      // Since VectorStoreFactory is created internally, this will fail,
      // but it proves the match succeeded (error will be about the store,
      // not "not found").
      const result = await handlers.rag_query({ topic: "docs", query: "q" });
      const body = parseResponse(result);

      // The error should NOT be "not found"  — it should be about
      // the vector store or an internal error.
      expect(body.error).to.not.include("not found");
    });

    it("sets isError on exception", async () => {
      topicManager.getAllTopics.throws(new Error("boom"));

      const result = await handlers.rag_query({ topic: "x", query: "q" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("boom");
    });
  });

  // -----------------------------------------------------------------------
  // rag_list_topics
  // -----------------------------------------------------------------------

  describe("rag_list_topics", () => {
    it("returns formatted topic list", async () => {
      const t1 = makeTopic({ name: "alpha", description: "A", documentCount: 3 });
      const t2 = makeTopic({ name: "beta", description: "B", documentCount: 7 });
      topicManager.getAllTopics.returns([t1, t2]);

      const result = await handlers.rag_list_topics({});
      const body = parseResponse(result);

      expect(body.count).to.equal(2);
      expect(body.topics).to.have.lengthOf(2);
      expect(body.topics[0].name).to.equal("alpha");
      expect(body.topics[1].name).to.equal("beta");
      expect(body.topics[0].documentCount).to.equal(3);
    });

    it("returns empty list when no topics exist", async () => {
      topicManager.getAllTopics.returns([]);

      const result = await handlers.rag_list_topics({});
      const body = parseResponse(result);

      expect(body.count).to.equal(0);
      expect(body.topics).to.deep.equal([]);
    });

    it("includes source field defaulting to 'local'", async () => {
      topicManager.getAllTopics.returns([makeTopic({ source: undefined })]);

      const result = await handlers.rag_list_topics({});
      const body = parseResponse(result);

      expect(body.topics[0].source).to.equal("local");
    });

    it("formats dates as ISO strings", async () => {
      topicManager.getAllTopics.returns([makeTopic({ createdAt: 0, updatedAt: 0 })]);

      const result = await handlers.rag_list_topics({});
      const body = parseResponse(result);

      expect(body.topics[0].createdAt).to.equal(new Date(0).toISOString());
      expect(body.topics[0].updatedAt).to.equal(new Date(0).toISOString());
    });

    it("sets isError on exception", async () => {
      topicManager.getAllTopics.throws(new Error("list failed"));

      const result = await handlers.rag_list_topics({});

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("list failed");
    });
  });

  // -----------------------------------------------------------------------
  // rag_topic_stats
  // -----------------------------------------------------------------------

  describe("rag_topic_stats", () => {
    it("returns error when topic is not found", async () => {
      topicManager.getAllTopics.returns([]);

      const result = await handlers.rag_topic_stats({ topic: "nope" });
      const body = parseResponse(result);

      expect(body.error).to.include("not found");
    });

    it("returns stats for a matched topic", async () => {
      topicManager.getAllTopics.returns([makeTopic({ id: "t1", name: "docs" })]);
      topicManager.getTopicStats.resolves({
        documentCount: 10,
        chunkCount: 200,
        lastUpdated: 9999,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      });

      const result = await handlers.rag_topic_stats({ topic: "docs" });
      const body = parseResponse(result);

      expect(body.documentCount).to.equal(10);
      expect(body.chunkCount).to.equal(200);
      expect(topicManager.getTopicStats.calledWith("t1")).to.be.true;
    });

    it("sets isError on exception", async () => {
      topicManager.getAllTopics.throws(new Error("stats boom"));

      const result = await handlers.rag_topic_stats({ topic: "x" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("stats boom");
    });
  });

  // -----------------------------------------------------------------------
  // rag_create_topic
  // -----------------------------------------------------------------------

  describe("rag_create_topic", () => {
    it("returns created topic details", async () => {
      topicManager.createTopic.resolves(
        makeTopic({ id: "new-id", name: "my-topic", description: "desc" }),
      );

      const result = await handlers.rag_create_topic({ name: "my-topic", description: "desc" });
      const body = parseResponse(result);

      expect(body.success).to.be.true;
      expect(body.topic.id).to.equal("new-id");
      expect(body.topic.name).to.equal("my-topic");
      expect(body.topic.description).to.equal("desc");
    });

    it("passes name and description to topicManager.createTopic", async () => {
      topicManager.createTopic.resolves(makeTopic());

      await handlers.rag_create_topic({ name: "n", description: "d" });

      expect(topicManager.createTopic.calledOnce).to.be.true;
      const arg = topicManager.createTopic.firstCall.args[0];
      expect(arg).to.deep.equal({ name: "n", description: "d" });
    });

    it("sets isError on exception", async () => {
      topicManager.createTopic.rejects(new Error("create failed"));

      const result = await handlers.rag_create_topic({ name: "x" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("create failed");
    });
  });

  // -----------------------------------------------------------------------
  // rag_add_documents
  // -----------------------------------------------------------------------

  describe("rag_add_documents", () => {
    it("returns error when topic is not found", async () => {
      topicManager.getAllTopics.returns([]);

      const result = await handlers.rag_add_documents({
        topic: "nope",
        filePaths: ["/a.md"],
      });
      const body = parseResponse(result);

      expect(body.error).to.include("not found");
    });

    it("adds documents and returns results", async () => {
      topicManager.getAllTopics.returns([makeTopic({ id: "t1", name: "docs" })]);
      topicManager.addDocuments.resolves([{ added: true }] as any);

      const result = await handlers.rag_add_documents({
        topic: "docs",
        filePaths: ["/a.md", "/b.md"],
      });
      const body = parseResponse(result);

      expect(body.success).to.be.true;
      expect(body.topic).to.equal("docs");
      expect(body.documentsAdded).to.equal(2);
      expect(topicManager.addDocuments.calledWith("t1", ["/a.md", "/b.md"])).to.be.true;
    });

    it("sets isError on exception", async () => {
      topicManager.getAllTopics.throws(new Error("add failed"));

      const result = await handlers.rag_add_documents({
        topic: "x",
        filePaths: ["/a"],
      });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("add failed");
    });
  });

  // -----------------------------------------------------------------------
  // rag_list_embedding_models
  // -----------------------------------------------------------------------

  describe("rag_list_embedding_models", () => {
    it("returns model list with active flag", async () => {
      embeddingService.getCurrentModel.returns("Xenova/all-MiniLM-L6-v2");
      embeddingService.listAvailableModels.resolves([
        { name: "Xenova/all-MiniLM-L6-v2", source: "bundled" as any, downloaded: true },
        { name: "Xenova/bge-small-en-v1.5", source: "curated" as any, downloaded: false },
      ]);

      const result = await handlers.rag_list_embedding_models({});
      const body = parseResponse(result);

      expect(body.currentModel).to.equal("Xenova/all-MiniLM-L6-v2");
      expect(body.count).to.equal(2);
      expect(body.models[0].active).to.be.true;
      expect(body.models[1].active).to.be.false;
      expect(body.models[0].downloaded).to.be.true;
      expect(body.models[1].downloaded).to.be.false;
    });

    it("sets isError on exception", async () => {
      embeddingService.listAvailableModels.rejects(new Error("list models failed"));

      const result = await handlers.rag_list_embedding_models({});

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("list models failed");
    });
  });

  // -----------------------------------------------------------------------
  // rag_embedding_info
  // -----------------------------------------------------------------------

  describe("rag_embedding_info", () => {
    it("returns current model, backend, and local path", async () => {
      embeddingService.getCurrentModel.returns("Xenova/all-MiniLM-L6-v2");
      embeddingService.getActiveBackendType.returns("huggingface");
      embeddingService.getLocalModelPath.returns("/models/all-MiniLM-L6-v2");

      const result = await handlers.rag_embedding_info({});
      const body = parseResponse(result);

      expect(body.currentModel).to.equal("Xenova/all-MiniLM-L6-v2");
      expect(body.backend).to.equal("huggingface");
      expect(body.localModelPath).to.equal("/models/all-MiniLM-L6-v2");
    });

    it("returns 'none' when local model path is null", async () => {
      embeddingService.getLocalModelPath.returns(null);

      const result = await handlers.rag_embedding_info({});
      const body = parseResponse(result);

      expect(body.localModelPath).to.equal("none");
    });

    it("sets isError on exception", async () => {
      embeddingService.getCurrentModel.throws(new Error("info boom"));

      const result = await handlers.rag_embedding_info({});

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("info boom");
    });
  });

  // -----------------------------------------------------------------------
  // rag_switch_embedding_model
  // -----------------------------------------------------------------------

  describe("rag_switch_embedding_model", () => {
    it("switches model and returns previous/new names", async () => {
      embeddingService.getCurrentModel
        .onFirstCall().returns("old-model")
        .onSecondCall().returns("new-model");
      embeddingService.initialize.resolves();

      const result = await handlers.rag_switch_embedding_model({ model: "new-model" });
      const body = parseResponse(result);

      expect(body.success).to.be.true;
      expect(body.previousModel).to.equal("old-model");
      expect(body.newModel).to.equal("new-model");
      expect(body.message).to.include("new-model");
      expect(embeddingService.initialize.calledWith("new-model")).to.be.true;
    });

    it("sets isError on exception", async () => {
      embeddingService.getCurrentModel.returns("current");
      embeddingService.initialize.rejects(new Error("switch failed"));

      const result = await handlers.rag_switch_embedding_model({ model: "bad" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("switch failed");
    });
  });

  // -----------------------------------------------------------------------
  // rag_llm_status
  // -----------------------------------------------------------------------

  describe("rag_llm_status", () => {
    it("returns unavailable status with hint when LLM is not configured", async () => {
      llmProvider.isAvailable.resolves(false);

      const result = await handlers.rag_llm_status({});
      const body = parseResponse(result);

      expect(body.available).to.be.false;
      expect(body.model).to.be.null;
      expect(body.hint).to.be.a("string");
      expect(body.hint).to.include("RAGNAROK_LLM_PROVIDER");
    });

    it("returns model info when LLM is available", async () => {
      llmProvider.isAvailable.resolves(true);
      llmProvider.selectModel.resolves({
        id: "gpt-4o",
        family: "gpt-4o",
        sendRequest: sinon.stub(),
      } as unknown as ILLMModel);

      const result = await handlers.rag_llm_status({});
      const body = parseResponse(result);

      expect(body.available).to.be.true;
      expect(body.model).to.deep.equal({ id: "gpt-4o", family: "gpt-4o" });
      expect(body.hint).to.be.undefined;
    });

    it("does not call selectModel when LLM is unavailable", async () => {
      llmProvider.isAvailable.resolves(false);

      await handlers.rag_llm_status({});

      expect(llmProvider.selectModel.called).to.be.false;
    });

    it("sets isError on exception", async () => {
      llmProvider.isAvailable.rejects(new Error("llm boom"));

      const result = await handlers.rag_llm_status({});

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("llm boom");
    });
  });
});
