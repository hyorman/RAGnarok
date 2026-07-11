/**
 * Unit tests for MCP tool handlers (registerTools)
 *
 * Strategy: spy on McpServer.prototype.tool to capture each registered
 * handler callback, then invoke handlers directly with mocked dependencies.
 */

import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools";
import type { McpConfig } from "../src/config";
import type {
  TopicManager,
  EmbeddingService,
  IConfigProvider,
  ILLMProvider,
  ILLMModel,
  Topic,
  RAGQueryService,
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

/** Build a full McpConfig for tests that need one (e.g. path allowlisting). */
function makeMcpConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    storageDir: "/tmp/ragnarok-test",
    workingDir: "",
    allowedPaths: [],
    embeddingModel: "test-model",
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    langGraphEnabled: false,
    logLevel: "error",
    port: 0,
    llmProvider: "none",
    llmApiKey: "",
    llmModel: "",
    llmBaseUrl: "",
    embeddingProvider: "huggingface",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    apiKey: "",
    corsOrigin: "*",
    httpHost: "127.0.0.1",
    rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    ...overrides,
  };
}

/**
 * Register all tools on a real McpServer and capture the handler callbacks
 * keyed by tool name.
 */
function captureHandlers(deps: {
  topicManager: sinon.SinonStubbedInstance<TopicManager>;
  config: IConfigProvider;
  llmProvider: sinon.SinonStubbedInstance<ILLMProvider>;
  embeddingService: sinon.SinonStubbedInstance<EmbeddingService>;
  ragQueryService: sinon.SinonStubbedInstance<RAGQueryService>;
  mcpConfig?: McpConfig;
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
    deps.llmProvider as unknown as ILLMProvider,
    deps.embeddingService as unknown as EmbeddingService,
    deps.ragQueryService as unknown as RAGQueryService,
    undefined,
    undefined,
    deps.mcpConfig,
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
  let ragQueryService: sinon.SinonStubbedInstance<RAGQueryService>;
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    // -- TopicManager stubs --
    topicManager = {
      getAllTopics: sinon.stub(),
      getTopicStats: sinon.stub(),
      createTopic: sinon.stub(),
      addDocuments: sinon.stub(),
      resolveTopicByName: sinon.stub(),
      getVectorStore: sinon.stub().resolves(null),
      reinitializeWithNewModel: sinon.stub().resolves(),
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
      embed: sinon.stub().resolves(new Array(384).fill(0)),
    } as any;

    // -- RAGQueryService stub --
    ragQueryService = {
      executeQuery: sinon.stub(),
      clearAgentCache: sinon.stub(),
      dispose: sinon.stub(),
    } as any;

    handlers = captureHandlers({ topicManager, config, llmProvider, embeddingService, ragQueryService });
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
    it("sets isError when topic is not found", async () => {
      ragQueryService.executeQuery.rejects(new Error('Topic "missing" not found'));

      const result = await handlers.rag_query({ topic: "missing", query: "hello" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("not found");
    });

    it("sets isError when no topics exist", async () => {
      ragQueryService.executeQuery.rejects(new Error("No topics found in the RAG database. Create a topic first."));

      const result = await handlers.rag_query({ topic: "x", query: "q" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("No topics found");
    });

    it("returns 'no vector store' error when topic matches but store is missing", async () => {
      ragQueryService.executeQuery.rejects(new Error("Failed to load vector store for topic: topic-1"));

      const result = await handlers.rag_query({ topic: "docs", query: "q" });
      const body = parseResponse(result);

      // Should not be the generic "not found" error — should be about the vector store
      expect(body.error).to.not.include("not found");
    });

    it("sets isError on exception", async () => {
      ragQueryService.executeQuery.rejects(new Error("boom"));

      const result = await handlers.rag_query({ topic: "x", query: "q" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("boom");
    });

    it("returns query result on success", async () => {
      const fakeResult = { query: "q", topicName: "docs", results: [] };
      ragQueryService.executeQuery.resolves(fakeResult as any);

      const result = await handlers.rag_query({ topic: "docs", query: "q" });
      const body = parseResponse(result);

      expect(result.isError).to.be.undefined;
      expect(body.topicName).to.equal("docs");
      expect(body.results).to.deep.equal([]);
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
    it("sets isError when topic is not found", async () => {
      topicManager.resolveTopicByName.rejects(new Error('Topic "nope" not found'));

      const result = await handlers.rag_topic_stats({ topic: "nope" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("not found");
    });

    it("returns stats for a matched topic", async () => {
      topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
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
      topicManager.resolveTopicByName.rejects(new Error("stats boom"));

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
    it("sets isError when topic is not found", async () => {
      topicManager.resolveTopicByName.rejects(new Error('Topic "nope" not found'));

      const result = await handlers.rag_add_documents({
        topic: "nope",
        filePaths: ["/a.md"],
      });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("not found");
    });

    it("adds documents per file and reports actual outcomes", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-add-"));
      const fileA = path.join(tmpDir, "a.md");
      const fileB = path.join(tmpDir, "b.md");
      await fs.writeFile(fileA, "# a");
      await fs.writeFile(fileB, "# b");

      try {
        // Re-register with an allowlist covering the temp dir
        handlers = captureHandlers({
          topicManager,
          config,
          llmProvider,
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [tmpDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
        topicManager.addDocuments.resolves([{ pipelineResult: { metadata: { chunksStored: 3 } } }] as any);

        const result = await handlers.rag_add_documents({
          topic: "docs",
          filePaths: [fileA, fileB],
        });
        const body = parseResponse(result);

        expect(body.success).to.be.true;
        expect(body.partial).to.be.false;
        expect(body.topic).to.equal("docs");
        expect(body.documentsAdded).to.equal(2);
        expect(body.documentsFailed).to.equal(0);
        expect(body.files.map((f: any) => f.status)).to.deep.equal(["added", "added"]);
        expect(topicManager.addDocuments.callCount).to.equal(2);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects paths outside the allowed roots", async () => {
      const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-allowed-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-outside-"));
      const outsideFile = path.join(outsideDir, "secret.md");
      await fs.writeFile(outsideFile, "secret");

      try {
        handlers = captureHandlers({
          topicManager,
          config,
          llmProvider,
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [allowedDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });

        const result = await handlers.rag_add_documents({
          topic: "docs",
          filePaths: [outsideFile],
        });
        const body = parseResponse(result);

        expect(result.isError).to.equal(true);
        expect(body.success).to.be.false;
        expect(body.files[0].status).to.equal("failed");
        expect(body.files[0].error).to.include("Path not allowed");
        expect(topicManager.addDocuments.called, "addDocuments must not run for disallowed paths").to.be.false;
      } finally {
        await fs.rm(allowedDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("reports partial success when some files fail", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-partial-"));
      const goodFile = path.join(tmpDir, "good.md");
      await fs.writeFile(goodFile, "# good");

      try {
        handlers = captureHandlers({
          topicManager,
          config,
          llmProvider,
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [tmpDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
        topicManager.addDocuments.resolves([{ pipelineResult: { metadata: { chunksStored: 1 } } }] as any);

        const result = await handlers.rag_add_documents({
          topic: "docs",
          filePaths: [goodFile, path.join(tmpDir, "missing.md")],
        });
        const body = parseResponse(result);

        expect(body.success).to.be.true;
        expect(body.partial).to.be.true;
        expect(body.documentsAdded).to.equal(1);
        expect(body.documentsFailed).to.equal(1);
        expect(result.isError).to.equal(false);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("sets isError on exception", async () => {
      topicManager.resolveTopicByName.rejects(new Error("add failed"));

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
    it("switches model, propagates to topic management, and returns previous/new names", async () => {
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
      // Coordinated switch: the factory/pipeline must be rebuilt, otherwise a
      // later topic operation silently reverts the shared backend.
      expect((topicManager.reinitializeWithNewModel as sinon.SinonStub).calledOnce).to.be.true;
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

  // -----------------------------------------------------------------------
  // Reranker tools
  // -----------------------------------------------------------------------

  describe("reranker tools", () => {
    let rerankerHandlers: Record<string, ToolHandler>;

    function captureHandlersWithReranker(
      deps: {
        topicManager: sinon.SinonStubbedInstance<TopicManager>;
        config: IConfigProvider;
        llmProvider: sinon.SinonStubbedInstance<ILLMProvider>;
        embeddingService: sinon.SinonStubbedInstance<EmbeddingService>;
        ragQueryService: sinon.SinonStubbedInstance<RAGQueryService>;
      },
      mockReranker: any,
      mockConfig: any,
    ): Record<string, ToolHandler> {
      const captured: Record<string, ToolHandler> = {};
      const server = new McpServer({ name: "test", version: "0.0.0" });

      const originalTool = server.tool.bind(server);
      server.tool = function (this: McpServer, ...args: any[]) {
        const name = args[0] as string;
        const handler = args[args.length - 1] as ToolHandler;
        captured[name] = handler;
        return (originalTool as (...a: unknown[]) => unknown).apply(this, args);
      } as any;

      registerTools(
        server,
        deps.topicManager as unknown as TopicManager,
        deps.llmProvider as unknown as ILLMProvider,
        deps.embeddingService as unknown as EmbeddingService,
        deps.ragQueryService as unknown as RAGQueryService,
        null as any, // memoryStore
        mockReranker,
        mockConfig,
      );

      return captured;
    }

    describe("rag_list_reranker_models", () => {
      it("returns model list when reranker is available", async () => {
        const mockReranker = {
          getCurrentModel: sinon.stub().returns("Xenova/ms-marco-MiniLM-L-6-v2"),
          isAvailable: sinon.stub().returns(true),
        };
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          mockReranker,
          {} as any,
        );

        const result = await rerankerHandlers.rag_list_reranker_models({});
        const body = parseResponse(result);

        expect(body.enabled).to.be.true;
        expect(body.isAvailable).to.be.true;
        expect(body.currentModel).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
        expect(body.models).to.be.an("array");
      });

      it("returns enabled: false when reranker is null", async () => {
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          null,
          {} as any,
        );

        const result = await rerankerHandlers.rag_list_reranker_models({});
        const body = parseResponse(result);

        expect(body.enabled).to.be.false;
        expect(body.currentModel).to.be.null;
        expect(body.isAvailable).to.be.false;
      });
    });

    describe("rag_reranker_info", () => {
      it("returns correct status when reranker is available", async () => {
        const mockReranker = {
          getCurrentModel: sinon.stub().returns("Xenova/ms-marco-MiniLM-L-6-v2"),
          isAvailable: sinon.stub().returns(true),
        };
        const mockConfig = {
          rerankerMaxCandidates: 20,
          rerankerCandidateMultiplier: 4,
        };
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          mockReranker,
          mockConfig as any,
        );

        const result = await rerankerHandlers.rag_reranker_info({});
        const body = parseResponse(result);

        expect(body.enabled).to.be.true;
        expect(body.currentModel).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
        expect(body.isAvailable).to.be.true;
        expect(body.maxCandidates).to.equal(20);
        expect(body.candidateMultiplier).to.equal(4);
      });

      it("returns correct status when reranker is null", async () => {
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          null,
          {} as any,
        );

        const result = await rerankerHandlers.rag_reranker_info({});
        const body = parseResponse(result);

        expect(body.enabled).to.be.false;
        expect(body.currentModel).to.be.null;
        expect(body.isAvailable).to.be.false;
      });

      it("returns maxCandidates and candidateMultiplier from config", async () => {
        const mockConfig = {
          rerankerMaxCandidates: 30,
          rerankerCandidateMultiplier: 6,
        };
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          null,
          mockConfig as any,
        );

        const result = await rerankerHandlers.rag_reranker_info({});
        const body = parseResponse(result);

        expect(body.maxCandidates).to.equal(30);
        expect(body.candidateMultiplier).to.equal(6);
      });
    });

    describe("rag_switch_reranker_model", () => {
      it("returns error when reranker is null", async () => {
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          null,
          {} as any,
        );

        const result = await rerankerHandlers.rag_switch_reranker_model({ model: "some/model" });

        expect(result.isError).to.equal(true);
        expect(parseResponse(result).error).to.include("not available");
      });

      it("calls switchModel on the reranker", async () => {
        const mockReranker = {
          getCurrentModel: sinon.stub()
            .onFirstCall().returns("Xenova/ms-marco-MiniLM-L-6-v2")
            .onSecondCall().returns("Xenova/ms-marco-MiniLM-L-12-v2"),
          switchModel: sinon.stub().resolves(),
        };
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          mockReranker,
          {} as any,
        );

        await rerankerHandlers.rag_switch_reranker_model({ model: "Xenova/ms-marco-MiniLM-L-12-v2" });

        expect(mockReranker.switchModel.calledOnce).to.be.true;
        expect(mockReranker.switchModel.firstCall.args[0]).to.equal("Xenova/ms-marco-MiniLM-L-12-v2");
      });

      it("returns previous and new model names on success", async () => {
        const mockReranker = {
          getCurrentModel: sinon.stub()
            .onFirstCall().returns("Xenova/ms-marco-MiniLM-L-6-v2")
            .onSecondCall().returns("Xenova/ms-marco-MiniLM-L-12-v2"),
          switchModel: sinon.stub().resolves(),
        };
        rerankerHandlers = captureHandlersWithReranker(
          { topicManager, config, llmProvider, embeddingService, ragQueryService },
          mockReranker,
          {} as any,
        );

        const result = await rerankerHandlers.rag_switch_reranker_model({ model: "Xenova/ms-marco-MiniLM-L-12-v2" });
        const body = parseResponse(result);

        expect(body.success).to.be.true;
        expect(body.previousModel).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
        expect(body.newModel).to.equal("Xenova/ms-marco-MiniLM-L-12-v2");
        expect(body.message).to.include("Switched");
      });
    });
  });
});
