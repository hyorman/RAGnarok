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
import { measureToolResultForResponse, registerTools } from "../src/tools";
import type { McpConfig } from "../src/config";
import { TopicEmptyError } from "@ragnarok/core";
import type {
  TopicManager,
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
  ragQueryService: sinon.SinonStubbedInstance<RAGQueryService>;
  mcpConfig?: McpConfig;
  memoryService?: Pick<MemoryService, "execute" | "reset">;
  graphVisualizationService?: Pick<GraphVisualizationService, "generate">;
  memoryBranchProvider?: Pick<MemoryStore, "getCurrentBranch">;
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
    deps.ragQueryService as unknown as RAGQueryService,
    deps.memoryService as MemoryService | undefined,
    deps.graphVisualizationService as GraphVisualizationService | undefined,
    deps.memoryBranchProvider,
    deps.mcpConfig,
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

    // -- RAGQueryService stub --
    ragQueryService = {
      executeQuery: sinon.stub(),
      clearAgentCache: sinon.stub(),
      dispose: sinon.stub(),
    } as any;

    handlers = captureHandlers({ topicManager, config, ragQueryService });
  });

  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // Registration smoke test
  // -----------------------------------------------------------------------

  /** Every tool name registered with a memory service present. */
  function listRegisteredToolNames(): string[] {
    return Object.keys(
      captureHandlers({
        topicManager,
        config,
        ragQueryService,
        memoryService: { execute: sinon.stub(), reset: sinon.stub() } as any,
        graphVisualizationService: { generate: sinon.stub() },
        memoryBranchProvider: { getCurrentBranch: sinon.stub().resolves(null) },
      }),
    );
  }

  it("registers the complete release tool surface", () => {
    // rag_memory/rag_reset_memory register only when a memory service exists,
    // so capture with one present.
    const fullHandlers = captureHandlers({
      topicManager,
      config,
      ragQueryService,
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
      "rag_memory",
      "rag_reset_memory",
      "rag_memory_visualize",
    ];
    expect(Object.keys(fullHandlers)).to.have.lengthOf(8);
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
      "rag_list_embedding_models",
      "rag_embedding_info",
      "rag_switch_embedding_model",
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

    // The shared executor is called as (input, deps, signal); every one of the
    // forwarded pieces is optional, so dropping any of them still compiles and
    // still returns a result. Pin all three by hand — a dropped abort signal
    // means client cancellation silently stops reaching retrieval.
    it("forwards the normalized query params, no workspace context, and the request signal", async () => {
      const signal = new AbortController().signal;
      ragQueryService.executeQuery.resolves({ query: "q", topicName: "docs", results: [] } as any);

      const result = await handlers.rag_query(
        { topic: "  docs  ", query: "  q  ", topK: 3, retrievalStrategy: "bm25" },
        makeServerContext(signal),
      );

      expect(ragQueryService.executeQuery.calledOnce).to.equal(true);
      const [params, workspaceContext, forwardedSignal] = ragQueryService.executeQuery.firstCall.args;
      expect(params).to.deep.equal({ topic: "docs", query: "q", topK: 3, retrievalStrategy: "bm25" });
      // Editor context is VS Code's alone: MCP must forward none.
      expect(workspaceContext).to.equal(undefined);
      // By identity, not by deep equality — two fresh AbortSignals look alike.
      expect(forwardedSignal).to.equal(signal);
      expect(parseResponse(result).topicName).to.equal("docs");
    });

    // The empty-topic payload is produced by the shared core executor, not by a
    // local TopicEmptyError branch. Reverting to the inline branch reinstates
    // the old {message, topicName} body and fails this test.
    it("returns the honest empty payload for a topic with no documents", async () => {
      ragQueryService.executeQuery.rejects(new TopicEmptyError("Empty"));

      const result = await handlers.rag_query({ topic: "Empty", query: "anything" });
      const payload = parseResponse(result);

      expect(result.isError).to.be.undefined;
      expect(payload).to.include({ empty: true, topicMatched: "fallback", topicName: "Empty", query: "anything" });
      expect(payload.results).to.deep.equal([]);
      expect(payload.message).to.include("no documents");
      // The retrieval run never happened, so no agentic metadata is invented.
      expect(payload).to.not.have.property("agenticMetadata");
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

    // getTopicStats returns null for an uninitialised index AND for any swallowed
    // internal error. The inline handler spread that null into a stats body with
    // no counts at all; the shared executor refuses to report a non-answer.
    it("stats sets isError when getTopicStats yields no statistics", async () => {
      topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
      topicManager.getTopicStats.resolves(null as any);
      (topicManager as any).listDocuments = sinon.stub().returns([]);

      const result = await handlers.rag_topic({ action: "stats", topic: "docs" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.equal("No statistics available for topic 'docs'");
      expect(body).to.not.have.property("documents");
    });

    // The shared executor resolves the TRIMMED name. The zod schema for `stats`
    // does not trim, so an untrimmed name used to reach resolveTopicByName raw
    // and could match a different topic through the similarity branch.
    it("stats resolves the trimmed topic name", async () => {
      topicManager.resolveTopicByName.resolves({ topic: makeTopic({ id: "t1", name: "docs" }), matchType: "exact" });
      topicManager.getTopicStats.resolves({
        documentCount: 1,
        chunkCount: 2,
        lastUpdated: 3,
        embeddingModel: "m",
      } as any);
      (topicManager as any).listDocuments = sinon.stub().returns([]);

      const result = await handlers.rag_topic({ action: "stats", topic: "  docs  " });

      expect(topicManager.resolveTopicByName.calledOnceWithExactly("docs")).to.equal(true);
      // Resolving the right name is not enough: the call must also succeed, or
      // an executor that resolved correctly and then threw would pass this test.
      expect(result.isError).to.be.undefined;
      expect(parseResponse(result)).to.deep.equal({
        documentCount: 1,
        chunkCount: 2,
        lastUpdated: 3,
        embeddingModel: "m",
        documents: [],
      });
    });

    // A whitespace-only name clears zod's min(1) on the raw string; the shared
    // executor's own guard fires before TopicManager is consulted at all.
    it("stats rejects a whitespace-only topic before touching the manager", async () => {
      const result = await handlers.rag_topic({ action: "stats", topic: "   " });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("Topic tool 'topic' is required for the 'stats' action");
      expect(topicManager.resolveTopicByName.called).to.equal(false);
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
      registerTools(server, topicManager as unknown as TopicManager, ragQueryService as unknown as RAGQueryService);
      const schema: any = captured.find(({ name }) => name === "rag_topic")!.config.inputSchema;

      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag", confirm: true }).success).to.equal(true);
      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag", confirm: false }).success).to.equal(false);
      expect(schema.safeParse({ action: "import", archivePath: "/tmp/x.rag" }).success).to.equal(false);
      expect(schema.safeParse({ action: "list" }).success).to.equal(true);
      expect(schema.safeParse({ action: "stats" }).success, "stats requires topic").to.equal(false);
      expect(schema.safeParse({ action: "create" }).success, "create requires name").to.equal(false);
      expect(schema.safeParse({ action: "rename", topic: "docs" }).success, "rename requires newName").to.equal(false);
    });

    // The zod gate must stay IN FRONT of the shared executor: zod bounds the RAW
    // string at 200 while the executor bounds the TRIMMED one, so bypassing zod
    // would widen what rag_topic accepts.
    it("bounds the raw stats topic string at 200 characters before the executor sees it", () => {
      const captured: CapturedTool[] = [];
      const server = {
        registerTool(name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) {
          captured.push({ name, config, handler });
          return { name };
        },
      } as unknown as McpServer;
      registerTools(server, topicManager as unknown as TopicManager, ragQueryService as unknown as RAGQueryService);
      const schema: any = captured.find(({ name }) => name === "rag_topic")!.config.inputSchema;

      expect(schema.safeParse({ action: "stats", topic: "x".repeat(200) }).success).to.equal(true);
      expect(schema.safeParse({ action: "stats", topic: "x".repeat(201) }).success).to.equal(false);
      // 210 raw characters that would trim down to 20 are still rejected: the
      // raw bound is the outer gate, not the executor's trimmed bound.
      expect(schema.safeParse({ action: "stats", topic: `${" ".repeat(190)}${"x".repeat(20)}` }).success).to.equal(
        false,
      );
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
  // rag_memory — service result envelope
  // -----------------------------------------------------------------------

  describe("rag_memory service result", () => {
    function memoryHandlers(memoryService: Pick<MemoryService, "execute" | "reset">): Record<string, ToolHandler> {
      return captureHandlers({
        topicManager,
        config,
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

      registerTools(server, topicManager as unknown as TopicManager, ragQueryService as unknown as RAGQueryService);

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
        ragQueryService as unknown as RAGQueryService,
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
      expect(Object.keys(handlers)).to.include.members(["rag_query"]);
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
