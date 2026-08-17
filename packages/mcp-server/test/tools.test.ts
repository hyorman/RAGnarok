/**
 * Unit tests for MCP tool handlers (registerTools)
 *
 * Strategy: capture registerTool calls, then invoke handlers directly with
 * mocked dependencies.
 */

import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/server";
import { MemoryOperationCoordinator } from "@ragnarok/core";
import { measureToolResultForResponse, registerTools } from "../src/tools";
import type { McpConfig } from "../src/config";
import type {
  TopicManager,
  EmbeddingService,
  IConfigProvider,

  Topic,
  RAGQueryService,
  MemoryService,
  GraphVisualizationService,
  MemoryStore,
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
type CapturedTool = {
  name: string;
  config: {
    description?: string;
    inputSchema?: { safeParse(value: unknown): unknown };
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  handler: ToolHandler;
};

function makeServerContext(signal = new AbortController().signal): any {
  return { mcpReq: { signal } };
}

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
    logLevel: "error",
    llmProvider: "none",
    llmApiKey: "",
    llmModel: "",
    llmBaseUrl: "",
    embeddingProvider: "huggingface",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    maxResidentModels: 2,
    rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    exportDir: "/tmp/ragnarok-exports",
    githubHosts: ["github.com"],
    githubToken: "",
    resetStorage: false,
    ...overrides,
  };
}

/**
 * Register all tools on a v2-shaped server and capture callbacks by name.
 */
function captureHandlers(deps: {
  topicManager: sinon.SinonStubbedInstance<TopicManager>;
  config: IConfigProvider;
  embeddingService: sinon.SinonStubbedInstance<EmbeddingService>;
  ragQueryService: sinon.SinonStubbedInstance<RAGQueryService>;
  mcpConfig?: McpConfig;
  memoryStore?: unknown;
  memoryService?: Pick<MemoryService, "execute" | "reset">;
  graphVisualizationService?: Pick<GraphVisualizationService, "generate">;
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">;
  runMemoryMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
}): Record<string, ToolHandler> {
  const captured: CapturedTool[] = [];
  const server = {
    registerTool(name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) {
      captured.push({ name, config, handler });
      return { name };
    },
  } as unknown as McpServer;

  registerTools(
    server,
    deps.topicManager as unknown as TopicManager,
    deps.embeddingService as unknown as EmbeddingService,
    deps.ragQueryService as unknown as RAGQueryService,
    deps.memoryStore as never,
    deps.memoryService as MemoryService | undefined,
    deps.graphVisualizationService as GraphVisualizationService | undefined,
    deps.memoryBranchProvider,
    deps.mcpConfig,
    undefined,
    undefined,
    deps.runMemoryMutation,
  );

  expect(captured.map(({ name }) => name)).to.deep.equal(
    captured.map(({ name }) => name).sort((left, right) => left.localeCompare(right)),
  );
  for (const tool of captured) {
    expect(tool.config.inputSchema, tool.name).to.respondTo("safeParse");
  }

  return Object.fromEntries(
    captured.map(({ name, handler }) => [name, (args: any, context = makeServerContext()) => handler(args, context)]),
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("common tool response wrapper", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("serializes and measures a fitting non-graph result once", () => {
    const input = { content: [{ type: "text", text: JSON.stringify({ message: "ok" }) }] };
    const byteLength = sinon.spy(Buffer, "byteLength");

    const measurement = measureToolResultForResponse(input, 1024);

    expect(measurement.fits).to.equal(true);
    expect(measurement.result.structuredContent).to.deep.equal({ message: "ok" });
    expect(byteLength.callCount).to.equal(1);
  });
});

describe("MCP Tools (registerTools)", () => {
  let topicManager: sinon.SinonStubbedInstance<TopicManager>;
  let config: IConfigProvider;
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

    handlers = captureHandlers({ topicManager, config, embeddingService, ragQueryService });
  });

  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // Registration smoke test
  // -----------------------------------------------------------------------

  /** Every tool name registered with a memory store present. */
  function listRegisteredToolNames(): string[] {
    return Object.keys(
      captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        memoryStore: {},
        memoryService: { execute: sinon.stub(), reset: sinon.stub() } as any,
        graphVisualizationService: { generate: sinon.stub() },
        memoryBranchProvider: { getCurrentBranch: sinon.stub().resolves(null) },
      }),
    );
  }

  it("registers the complete release tool surface", () => {
    // rag_memory/rag_reset_memory register only when a memory store exists,
    // so capture with one present.
    const fullHandlers = captureHandlers({
      topicManager,
      config,
      embeddingService,
      ragQueryService,
      memoryStore: {},
      memoryService: { execute: sinon.stub(), reset: sinon.stub() } as any,
      graphVisualizationService: { generate: sinon.stub() },
      memoryBranchProvider: { getCurrentBranch: sinon.stub().resolves(null) },
    });
    const expected = [
      "rag_query",
      "rag_ingest",
      "rag_topic",
      "rag_delete_topic",
      "rag_remove_document",
      "rag_list_embedding_models",
      "rag_embedding_info",
      "rag_switch_embedding_model",
      "rag_memory",
      "rag_reset_memory",
      "rag_memory_visualize",
    ];
    expect(Object.keys(fullHandlers)).to.have.lengthOf(11);
    for (const name of expected) {
      expect(fullHandlers[name], `handler for ${name}`).to.be.a("function");
    }
  });

  it("registers the previously local-only tools with no deployment mode", () => {
    const names = listRegisteredToolNames();
    for (const name of ["rag_ingest", "rag_topic", "rag_memory", "rag_reset_memory"]) {
      expect(names, `${name} must be registered unconditionally`).to.include(name);
    }
  });

  it("registers no removed or upload tools", () => {
    const names = listRegisteredToolNames();
    for (const name of [
      "rag_create_document_upload",
      "rag_ingest_upload",
      "rag_create_archive_upload",
      "rag_import_upload",
      "rag_list_topics",
      "rag_topic_stats",
      "rag_create_topic",
      "rag_add_documents",
      "rag_add_url",
      "rag_add_github_repo",
      "rag_rename_topic",
      "rag_export_topic",
      "rag_import_topic",
      "rag_list_documents",
      "rag_llm_status",
      "rag_storage_status",
      "rag_list_reranker_models",
      "rag_reranker_info",
      "rag_switch_reranker_model",
      "rag_graph_visualize",
    ]) {
      expect(names, `${name} must not exist`).to.not.include(name);
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

  describe("rag_topic", () => {
    it("list returns formatted topic list", async () => {
      const t1 = makeTopic({ name: "alpha", description: "A", documentCount: 3 });
      const t2 = makeTopic({ name: "beta", description: "B", documentCount: 7 });
      topicManager.getAllTopics.returns([t1, t2]);

      const result = await handlers.rag_topic({ action: "list" });
      const body = parseResponse(result);

      expect(body.count).to.equal(2);
      expect(body.topics).to.have.lengthOf(2);
      expect(body.topics[0].name).to.equal("alpha");
      expect(body.topics[1].name).to.equal("beta");
      expect(body.topics[0].documentCount).to.equal(3);
    });

    it("list returns empty list when no topics exist", async () => {
      topicManager.getAllTopics.returns([]);

      const result = await handlers.rag_topic({ action: "list" });
      const body = parseResponse(result);

      expect(body.count).to.equal(0);
      expect(body.topics).to.deep.equal([]);
    });

    it("list includes source field defaulting to 'local' and ISO dates", async () => {
      topicManager.getAllTopics.returns([makeTopic({ source: undefined, createdAt: 0, updatedAt: 0 })]);

      const result = await handlers.rag_topic({ action: "list" });
      const body = parseResponse(result);

      expect(body.topics[0].source).to.equal("local");
      expect(body.topics[0].createdAt).to.equal(new Date(0).toISOString());
      expect(body.topics[0].updatedAt).to.equal(new Date(0).toISOString());
    });

    it("list sets isError on exception", async () => {
      topicManager.getAllTopics.throws(new Error("list failed"));

      const result = await handlers.rag_topic({ action: "list" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("list failed");
    });

    it("stats sets isError when topic is not found", async () => {
      topicManager.resolveTopicByName.rejects(new Error('Topic "nope" not found'));

      const result = await handlers.rag_topic({ action: "stats", topic: "nope" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("not found");
    });

    it("stats returns stats plus the topic's documents", async () => {
      topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
      topicManager.getTopicStats.resolves({
        documentCount: 10,
        chunkCount: 200,
        lastUpdated: 9999,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      });
      (topicManager as any).listDocuments = sinon.stub().returns([{ id: "doc-1", name: "a.md" }]);

      const result = await handlers.rag_topic({ action: "stats", topic: "docs" });
      const body = parseResponse(result);

      expect(body.documentCount).to.equal(10);
      expect(body.chunkCount).to.equal(200);
      expect(body.documents).to.deep.equal([{ id: "doc-1", name: "a.md", documentId: "doc-1" }]);
      expect(topicManager.getTopicStats.calledWith("t1")).to.be.true;
    });

    it("create returns created topic details", async () => {
      topicManager.createTopic.resolves(makeTopic({ id: "new-id", name: "my-topic", description: "desc" }));

      const result = await handlers.rag_topic({ action: "create", name: "my-topic", description: "desc" });
      const body = parseResponse(result);

      expect(body.success).to.be.true;
      expect(body.topic.id).to.equal("new-id");
      expect(body.topic.name).to.equal("my-topic");
      expect(body.topic.description).to.equal("desc");
      expect(topicManager.createTopic.firstCall.args[0]).to.deep.equal({ name: "my-topic", description: "desc" });
    });

    it("create sets isError on exception", async () => {
      topicManager.createTopic.rejects(new Error("create failed"));

      const result = await handlers.rag_topic({ action: "create", name: "x" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("create failed");
    });

    it("rename delegates to updateTopic", async () => {
      topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
      (topicManager as any).updateTopic = sinon.stub().resolves(makeTopic({ id: "t1", name: "renamed" }));

      const result = await handlers.rag_topic({ action: "rename", topic: "docs", newName: "renamed" });
      const body = parseResponse(result);

      expect(body.success).to.be.true;
      expect(body.topic.name).to.equal("renamed");
      expect((topicManager as any).updateTopic.calledWith("t1", { name: "renamed" })).to.be.true;
    });

    it("import requires confirm true in the schema", () => {
      const captured: CapturedTool[] = [];
      const server = {
        registerTool(name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) {
          captured.push({ name, config, handler });
          return { name };
        },
      } as unknown as McpServer;
      registerTools(
        server,
        topicManager as unknown as TopicManager,
        embeddingService as unknown as EmbeddingService,
        ragQueryService as unknown as RAGQueryService,
      );
      const schema: any = captured.find(({ name }) => name === "rag_topic")!.config.inputSchema;

      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag", confirm: true }).success).to.equal(true);
      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag", confirm: false }).success).to.equal(false);
      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag" }).success).to.equal(false);
      expect(schema.safeParse({ action: "list" }).success).to.equal(true);
      expect(schema.safeParse({ action: "stats" }).success, "stats requires topic").to.equal(false);
      expect(schema.safeParse({ action: "create" }).success, "create requires name").to.equal(false);
      expect(schema.safeParse({ action: "rename", topic: "docs" }).success, "rename requires newName").to.equal(false);
    });

    it("import rejects archives outside the allowed roots", async () => {
      const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-allowed-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-outside-"));
      const outsideArchive = path.join(outsideDir, "topic.rag");
      await fs.writeFile(outsideArchive, "archive");

      try {
        handlers = captureHandlers({
          topicManager,
          config,
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [allowedDir] }),
        });

        const result = await handlers.rag_topic({ action: "import", archivePath: outsideArchive, confirm: true });

        expect(result.isError).to.equal(true);
        expect(parseResponse(result).error).to.include("Path not allowed");
        expect((topicManager as any).importTopic?.called ?? false).to.equal(false);
      } finally {
        await fs.rm(allowedDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("export writes under the configured export directory", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "topic-export-"));
      try {
        handlers = captureHandlers({
          topicManager,
          config,
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ exportDir: path.join(root, "exports") }),
        });
        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
        (topicManager as any).exportTopic = sinon
          .stub()
          .callsFake(async (_id: string, exportPath: string) => fs.writeFile(exportPath, "archive-bytes"));

        const result = await handlers.rag_topic({ action: "export", topic: "docs" });
        const body = parseResponse(result);

        expect(body.path.startsWith(path.join(root, "exports"))).to.equal(true);
        expect(body.size).to.be.greaterThan(0);
        expect(body.sha256).to.match(/^[0-9a-f]{64}$/);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // rag_ingest
  // -----------------------------------------------------------------------

  describe("rag_ingest (files)", () => {
    it("sets isError when topic is not found", async () => {
      topicManager.resolveTopicByName.rejects(new Error('Topic "nope" not found'));

      const result = await handlers.rag_ingest({
        source: "files",
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
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [tmpDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
        topicManager.addDocuments.resolves([{ pipelineResult: { metadata: { chunksStored: 3 } } }] as any);

        const result = await handlers.rag_ingest({
          source: "files",
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
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [allowedDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });

        const result = await handlers.rag_ingest({
          source: "files",
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
          embeddingService,
          ragQueryService,
          mcpConfig: makeMcpConfig({ allowedPaths: [tmpDir] }),
        });

        topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
        topicManager.addDocuments.resolves([{ pipelineResult: { metadata: { chunksStored: 1 } } }] as any);

        const result = await handlers.rag_ingest({
          source: "files",
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

      const result = await handlers.rag_ingest({
        source: "files",
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

    it("flags a local-registry fallback when a remote provider is configured", async () => {
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        mcpConfig: makeMcpConfig({ embeddingProvider: "ollama" }),
      });
      embeddingService.listAvailableModels.resolves([
        { name: "Xenova/all-MiniLM-L6-v2", source: "curated" as any, downloaded: false },
      ]);

      const body = parseResponse(await handlers.rag_list_embedding_models({}));

      expect(body.remoteListingFailed).to.equal(true);
      expect(body.warning).to.include("remote embedding provider");
    });

    it("does not flag the remote catalogue itself", async () => {
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        mcpConfig: makeMcpConfig({ embeddingProvider: "ollama" }),
      });
      embeddingService.listAvailableModels.resolves([
        { name: "nomic-embed-text", source: "remote" as any, downloaded: true },
      ]);

      const body = parseResponse(await handlers.rag_list_embedding_models({}));

      expect(body).to.not.have.property("remoteListingFailed");
      expect(body).to.not.have.property("warning");
    });

    it("does not flag local catalogues for the huggingface provider", async () => {
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        mcpConfig: makeMcpConfig({ embeddingProvider: "huggingface" }),
      });
      embeddingService.listAvailableModels.resolves([
        { name: "Xenova/all-MiniLM-L6-v2", source: "curated" as any, downloaded: false },
      ]);

      const body = parseResponse(await handlers.rag_list_embedding_models({}));

      expect(body).to.not.have.property("remoteListingFailed");
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

    it("echoes the configured model and provider from config.json", async () => {
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        mcpConfig: makeMcpConfig({ embeddingModel: "Xenova/all-MiniLM-L12-v2", embeddingProvider: "huggingface" }),
      });

      const body = parseResponse(await handlers.rag_embedding_info({}));

      expect(body.configuredModel).to.equal("Xenova/all-MiniLM-L12-v2");
      expect(body.configuredProvider).to.equal("huggingface");
    });

    it("reports null configured values without a config", async () => {
      const body = parseResponse(await handlers.rag_embedding_info({}));

      expect(body.configuredModel).to.equal(null);
      expect(body.configuredProvider).to.equal(null);
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
    it("waits for an active memory mutation before switching", async () => {
      const coordinator = new MemoryOperationCoordinator();
      const memoryGate = deferred<void>();
      const activeMemoryMutation = coordinator.runMutation(async () => memoryGate.promise);
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        runMemoryMutation: (operation) => coordinator.runMutation(operation),
      });
      embeddingService.getCurrentModel.onFirstCall().returns("old-model").onSecondCall().returns("new-model");

      const switching = handlers.rag_switch_embedding_model({ model: "new-model" });
      await tick();

      expect(embeddingService.initialize.called).to.equal(false);
      memoryGate.resolve();
      await Promise.all([activeMemoryMutation, switching]);
      expect(embeddingService.initialize.calledOnceWithExactly("new-model")).to.equal(true);
    });

    it("blocks a later memory mutation until switching completes", async () => {
      const coordinator = new MemoryOperationCoordinator();
      const switchGate = deferred<void>();
      const switchStarted = deferred<void>();
      let memoryMutationStarted = false;
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        runMemoryMutation: (operation) => coordinator.runMutation(operation),
      });
      embeddingService.getCurrentModel.onFirstCall().returns("old-model").onSecondCall().returns("new-model");
      embeddingService.initialize.callsFake(async () => {
        switchStarted.resolve();
        await switchGate.promise;
      });

      const switching = handlers.rag_switch_embedding_model({ model: "new-model" });
      await switchStarted.promise;
      const memoryMutation = coordinator.runMutation(async () => {
        memoryMutationStarted = true;
      });
      await tick();

      expect(memoryMutationStarted).to.equal(false);
      switchGate.resolve();
      await Promise.all([switching, memoryMutation]);
      expect(memoryMutationStarted).to.equal(true);
    });

    it("switches model, propagates to topic management, and returns previous/new names", async () => {
      embeddingService.getCurrentModel.onFirstCall().returns("old-model").onSecondCall().returns("new-model");
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

    it("rejects a dimension-changing switch while memory holds data, and rolls back", async () => {
      const memoryStore = {
        stats: sinon.stub().resolves({ totalMemories: 3 }),
        getCurrentBranch: sinon.stub().returns(null),
      };
      handlers = captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        memoryStore,
      });

      embeddingService.getCurrentModel.returns("old-model");
      // Probe before switch: 384 dims; probe after switch: 768 dims
      (embeddingService.embed as sinon.SinonStub)
        .onFirstCall()
        .resolves(new Array(384).fill(0))
        .onSecondCall()
        .resolves(new Array(768).fill(0));

      const result = await handlers.rag_switch_embedding_model({ model: "bigger-model" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.include("dimension");
      // Rolled back: initialize called with the new model, then the old one
      const initCalls = (embeddingService.initialize as sinon.SinonStub).getCalls().map((c) => c.args[0]);
      expect(initCalls).to.deep.equal(["bigger-model", "old-model"]);
      // The topic-side reinit must NOT run for a rejected switch
      expect((topicManager.reinitializeWithNewModel as sinon.SinonStub).called).to.equal(false);
    });
  });


  // -----------------------------------------------------------------------
  // rag_memory — service result envelope
  // -----------------------------------------------------------------------

  describe("rag_memory service result", () => {
    function memoryHandlers(memoryService: Pick<MemoryService, "execute" | "reset">): Record<string, ToolHandler> {
      return captureHandlers({
        topicManager,
        config,
        embeddingService,
        ragQueryService,
        memoryService,
        memoryBranchProvider: { getCurrentBranch: sinon.stub().resolves(null) },
      });
    }

    it("preserves the core communities result unchanged", async () => {
      const resultFromCore = {
        action: "communities" as const,
        scope: "workspace" as const,
        communities: [],
        count: 0,
        entityExtractionEnabled: false,
        hint: "New memory graph entities require an LLM provider.",
      };
      const memoryService = {
        execute: sinon.stub().resolves(resultFromCore),
        reset: sinon.stub(),
      } as any;

      const result = await memoryHandlers(memoryService).rag_memory({ action: "communities" });
      const body = parseResponse(result);

      expect(result.isError).to.not.equal(true);
      expect(body).to.deep.equal(resultFromCore);
    });
  });

  // -----------------------------------------------------------------------
  // Reranker tools
  // -----------------------------------------------------------------------

  describe("tool descriptions", () => {
    function captureDescriptions(): Record<string, string> {
      const descriptions: Record<string, string> = {};
      const server = {
        registerTool(name: string, config: CapturedTool["config"], _handler: CapturedTool["handler"]) {
          descriptions[name] = config.description ?? "";
          return { name };
        },
      } as unknown as McpServer;

      registerTools(
        server,
        topicManager as unknown as TopicManager,
        embeddingService as unknown as EmbeddingService,
        ragQueryService as unknown as RAGQueryService,
      );

      return descriptions;
    }

    it("carries no deployment-mode prefix", () => {
      const descriptions = captureDescriptions();
      expect(Object.keys(descriptions)).to.have.length.greaterThan(0);
      for (const [name, description] of Object.entries(descriptions)) {
        expect(description, `description of ${name}`).to.not.match(/^\[Team shared KB\]/);
      }
    });
  });

  describe("read-only tool inertness", () => {
    /** Capture only the tools annotated read-only. */
    function captureReadOnlyHandlers(cfg?: McpConfig) {
      const handlers: Record<string, ToolHandler> = {};
      const server = {
        registerTool(name: string, toolConfig: CapturedTool["config"], handler: CapturedTool["handler"]) {
          if (toolConfig.annotations?.readOnlyHint === true) {
            handlers[name] = (args: any, context = makeServerContext()) => handler(args, context);
          }
          return { name };
        },
      } as unknown as McpServer;
      registerTools(
        server,
        topicManager as unknown as TopicManager,
        embeddingService as unknown as EmbeddingService,
        ragQueryService as unknown as RAGQueryService,
        undefined,
        undefined,
        undefined,
        undefined,
        cfg,
      );
      return handlers;
    }

    it("does not create or alter configured storage while registering and invoking every read-only tool", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-readonly-immutability-"));
      const marker = path.join(root, "marker.bin");
      const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
      await fs.writeFile(marker, bytes);
      const cfg = makeMcpConfig({
        storageDir: path.join(root, "storage"),
        exportDir: path.join(root, "exports"),
        workingDir: root,
        allowedPaths: [root],
      });
      const beforeEntries = await fs.readdir(root);
      const handlers = captureReadOnlyHandlers(cfg);
      expect(Object.keys(handlers)).to.include.members(["rag_query", "rag_list_embedding_models", "rag_embedding_info"]);
      const args: Record<string, any> = {
        rag_query: { topic: "docs", query: "question" },
      };
      for (const [name, handler] of Object.entries(handlers)) {
        await handler(args[name] ?? {}, {});
      }
      expect(await fs.readdir(root)).to.deep.equal(beforeEntries);
      expect(await fs.readFile(marker)).to.deep.equal(bytes);
      await fs.rm(root, { recursive: true, force: true });
    });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
