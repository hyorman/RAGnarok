import { expect } from "chai";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/server";
import {
  EmbeddingService,
  TopicManager,
  projectKnowledgeGraphVisualization,
  reduceGraphVisualizationDocument,
} from "@ragnarok/core";
import { MCP_LIMITS, measureToolResultForResponse, registerTools } from "../src/tools";

type CapturedTool = {
  name: string;
  config: {
    description?: string;
    inputSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  handler: (...args: any[]) => Promise<any>;
};

type RegisterOptions = {
  memoryStore?: any;
  role?: "reader" | "curator" | "admin";
  deployment?: "local" | "shared";
  runtime?: { run<T>(operation: () => Promise<T>): Promise<T> };
  maxResponseBytes?: number;
};

function makeServerContext(signal = new AbortController().signal): any {
  return { mcpReq: { signal } };
}

function fakeServer(): { server: McpServer; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    registerTool(name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) {
      captured.push({ name, config, handler });
      return { name };
    },
  } as unknown as McpServer;
  return { server, captured };
}

function makeTopicManager(): any {
  return sinon.createStubInstance(TopicManager) as any;
}

function register(server: McpServer, topicManager: any, options: RegisterOptions = {}): void {
  registerTools(
    server,
    topicManager,
    undefined as any,
    sinon.createStubInstance(EmbeddingService) as any,
    {} as any,
    options.memoryStore,
    undefined,
    { maxResponseBytes: options.maxResponseBytes ?? MCP_LIMITS.responseBytes } as any,
    options.role ?? "admin",
    undefined,
    options.deployment ?? "local",
    options.runtime,
  );
}

function graphTool(captured: CapturedTool[]): CapturedTool {
  const tool = captured.find((candidate) => candidate.name === "rag_graph_visualize");
  if (!tool) {
    expect.fail("rag_graph_visualize was not registered");
  }
  return tool;
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function knowledgeEntity(id: string, metadata: Record<string, unknown> = {}): any {
  return {
    id,
    name: `Entity ${id}`,
    type: "concept",
    description: `Description ${id}`,
    vector: [0.25, 0.75],
    sourceChunkIds: [`chunk-${id}`],
    confidence: 0.9,
    strength: 0.8,
    lastAccessedAt: 123,
    metadata,
  };
}

function knowledgeGraph(entities: any[], relationships: any[] = []): any {
  return {
    getAllEntities: () => entities,
    getAllRelationships: () => relationships,
  };
}

function knowledgeRelationship(id: string, blob: string): any {
  return {
    id,
    sourceId: "edge-source",
    targetId: "edge-target",
    type: "related_to",
    weight: 1,
    description: `Relationship ${id}`,
    sourceChunkIds: [`chunk-${id}`],
    confidence: 0.9,
    metadata: { blob },
  };
}

function memorySnapshot(scope: "workspace" | "branch", branch?: string): any {
  return {
    entities: [
      {
        id: "memory-entity",
        name: "Build pipeline",
        type: "concept",
        description: "CI for the monorepo",
        scope,
        branch,
        confidence: 1,
        strength: 0.5,
        createdAt: 10,
        updatedAt: 20,
        sourceMemoryIds: ["memory-1"],
        metadata: { owner: "platform" },
      },
    ],
    relationships: [],
  };
}

const HUGE_UTF8_ERROR_SUFFIX = "🙂".repeat(700_000);

function expectBoundedGraphError(result: any, code: string): any {
  expect(result.isError).to.equal(true);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);
  const payload = parseResult(result);
  expect(payload).to.have.keys("error");
  expect(payload.error).to.have.keys("code", "message");
  expect(payload.error.code).to.equal(code);
  return payload;
}

describe("rag_graph_visualize tool", function () {
  this.timeout(30000);

  it("exposes graph UI resource metadata only for curator and admin", function () {
    for (const role of ["reader", "curator", "admin"] as const) {
      const { server, captured } = fakeServer();
      register(server, makeTopicManager(), { role });
      const graph = captured.find((tool) => tool.name === "rag_graph_visualize");
      expect(Boolean(graph), role).to.equal(role !== "reader");
      if (graph) {
        expect(graph.config._meta).to.deep.equal({ ui: { resourceUri: "ui://ragnarok/graph" } });
        expect(graph.config._meta).not.to.have.property("ui/resourceUri");
        expect(graph.config.annotations?.readOnlyHint).to.equal(true);
      }
    }
  });

  it("uses the exact three-branch discriminated input schema", function () {
    const { server, captured } = fakeServer();
    register(server, makeTopicManager());
    const schema = graphTool(captured).config.inputSchema!;

    for (const valid of [
      { source: "knowledge", topic: " real ", maxNodes: 25 },
      { source: "memory", memoryScope: "workspace", maxNodes: 25 },
      { source: "memory", memoryScope: "branch", branch: " feature/graph ", maxNodes: 25 },
    ]) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).to.equal(true);
    }

    for (const invalid of [
      { source: "knowledge" },
      { source: "knowledge", topic: "   " },
      { source: "memory", memoryScope: "branch" },
      { source: "memory", memoryScope: "branch", branch: "   " },
      { source: "memory", memoryScope: "workspace", branch: "feature/graph" },
      { source: "knowledge", topic: "real", memoryScope: "workspace" },
      { source: "knowledge", topic: "real", maxNodes: 2_001 },
      { source: "memory", memoryScope: "workspace", maxNodes: 0 },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).to.equal(false);
    }
  });

  it("uses the common runtime wrapper", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().rejects(new Error("Topic not found: missing"));
    let runtimeRuns = 0;
    register(server, topicManager, {
      runtime: {
        run: async (operation) => {
          runtimeRuns += 1;
          return operation();
        },
      },
    });

    await graphTool(captured).handler({ source: "knowledge", topic: "missing" }, makeServerContext());
    expect(runtimeRuns).to.equal(1);
  });

  it("returns the canonical resolved knowledge source and full non-vector details", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-123", name: "Canonical Aurora" },
      matchType: "similar",
    });
    topicManager.getKnowledgeGraph = sinon
      .stub()
      .resolves(knowledgeGraph([knowledgeEntity("entity-1", { owner: "science" })]));
    register(server, topicManager);

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "aurora", maxNodes: 25 },
      makeServerContext(),
    );
    const payload = parseResult(result);
    expect(result.isError).not.to.equal(true);
    expect(payload.schema).to.equal("ragnarok.graph.visualization.v1");
    expect(payload.source).to.deep.equal({ kind: "knowledge", topicId: "topic-123", topicName: "Canonical Aurora" });
    expect(payload.nodes[0].attributes).to.deep.include({
      description: "Description entity-1",
      sourceChunkIds: ["chunk-entity-1"],
      confidence: 0.9,
      strength: 0.8,
      lastAccessedAt: 123,
      metadata: { owner: "science" },
    });
    expect(payload.nodes[0].attributes).not.to.have.property("vector");
    expect(payload).not.to.have.any.keys("scope", "communities");
  });

  it("returns a successful empty document when knowledge storage is absent", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-empty", name: "Empty Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon.stub().resolves(null);
    register(server, topicManager);

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Empty Topic" },
      makeServerContext(),
    );
    const payload = parseResult(result);
    expect(result.isError).not.to.equal(true);
    expect(payload.source).to.deep.equal({ kind: "knowledge", topicId: "topic-empty", topicName: "Empty Topic" });
    expect(payload.nodes).to.deep.equal([]);
    expect(payload.edges).to.deep.equal([]);
    expect(payload.metadata.empty).to.equal(true);
  });

  it("returns GRAPH_TOPIC_NOT_FOUND with the structured graph error shape", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().rejects(new Error("Topic not found: nope"));
    register(server, topicManager);

    const result = await graphTool(captured).handler({ source: "knowledge", topic: "nope" }, makeServerContext());
    expect(result.isError).to.equal(true);
    expect(parseResult(result)).to.deep.equal({
      error: { code: "GRAPH_TOPIC_NOT_FOUND", message: "Topic not found: nope" },
    });
  });

  it("maps the exact empty-topic catalog error to GRAPH_TOPIC_NOT_FOUND", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon
      .stub()
      .rejects(new Error("No topics found in the RAG database. Create a topic first."));
    register(server, topicManager);

    const result = await graphTool(captured).handler({ source: "knowledge", topic: "missing" }, makeServerContext());
    expect(parseResult(result).error.code).to.equal("GRAPH_TOPIC_NOT_FOUND");
  });

  it("bounds huge explicit topic-not-found errors without changing their graph code", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().rejects(new Error(`Topic not found: ${HUGE_UTF8_ERROR_SUFFIX}`));
    register(server, topicManager, { maxResponseBytes: 16 * 1024 * 1024 });
    const call = graphTool(captured);

    const first = await call.handler({ source: "knowledge", topic: "missing" }, makeServerContext());
    const second = await call.handler({ source: "knowledge", topic: "missing" }, makeServerContext());
    const firstPayload = expectBoundedGraphError(first, "GRAPH_TOPIC_NOT_FOUND");
    const secondPayload = expectBoundedGraphError(second, "GRAPH_TOPIC_NOT_FOUND");
    expect(firstPayload.error.message).to.equal(secondPayload.error.message);
    expect(firstPayload.error.message).to.match(/^Topic not found: /);
    expect(firstPayload.error.message.endsWith("...")).to.equal(true);
    expect(firstPayload.error.message).not.to.include("�");
  });

  it("maps and bounds huge operational resolution errors as GRAPH_VISUALIZATION_FAILED", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon
      .stub()
      .rejects(new Error(`Embedding service offline: ${HUGE_UTF8_ERROR_SUFFIX}`));
    register(server, topicManager, { maxResponseBytes: 16 * 1024 * 1024 });

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "unavailable" },
      makeServerContext(),
    );
    const payload = expectBoundedGraphError(result, "GRAPH_VISUALIZATION_FAILED");
    expect(payload.error.message).to.match(/^Embedding service offline: /);
    expect(payload.error.message.endsWith("...")).to.equal(true);
    expect(payload.error.message).not.to.include("�");
  });

  for (const memoryCase of [
    { memoryScope: "workspace" as const, branch: undefined },
    { memoryScope: "branch" as const, branch: "feature/graph" },
  ]) {
    it(`projects the ${memoryCase.memoryScope} memory snapshot with exact source identity`, async function () {
      const { server, captured } = fakeServer();
      const getGraphSnapshot = sinon.stub().resolves(memorySnapshot(memoryCase.memoryScope, memoryCase.branch));
      register(server, makeTopicManager(), { memoryStore: { getGraphSnapshot } });

      const input = {
        source: "memory" as const,
        memoryScope: memoryCase.memoryScope,
        ...(memoryCase.branch ? { branch: memoryCase.branch } : {}),
        maxNodes: 25,
      };
      const result = await graphTool(captured).handler(input, makeServerContext());
      const payload = parseResult(result);
      expect(result.isError).not.to.equal(true);
      expect(payload.source).to.deep.equal(
        memoryCase.branch
          ? { kind: "memory", scope: "branch", branch: memoryCase.branch }
          : { kind: "memory", scope: "workspace" },
      );
      expect(getGraphSnapshot.calledOnceWithExactly(memoryCase.memoryScope, memoryCase.branch)).to.equal(true);
      expect(payload.nodes[0].attributes).to.deep.include({
        description: "CI for the monorepo",
        scope: memoryCase.memoryScope,
        sourceMemoryIds: ["memory-1"],
        metadata: { owner: "platform" },
      });
      expect(payload.nodes[0].attributes).not.to.have.property("vector");
    });
  }

  it("returns a successful empty branch document for an absent branch", async function () {
    const { server, captured } = fakeServer();
    const getGraphSnapshot = sinon.stub().resolves({ entities: [], relationships: [] });
    register(server, makeTopicManager(), { memoryStore: { getGraphSnapshot } });

    const result = await graphTool(captured).handler(
      { source: "memory", memoryScope: "branch", branch: "feature/absent" },
      makeServerContext(),
    );
    const payload = parseResult(result);
    expect(result.isError).not.to.equal(true);
    expect(payload.source).to.deep.equal({ kind: "memory", scope: "branch", branch: "feature/absent" });
    expect(payload.metadata.empty).to.equal(true);
  });

  for (const memoryScope of ["workspace", "branch"] as const) {
    it(`rejects shared ${memoryScope} memory with GRAPH_MEMORY_UNAVAILABLE`, async function () {
      const { server, captured } = fakeServer();
      register(server, makeTopicManager(), {
        memoryStore: { getGraphSnapshot: sinon.stub().rejects(new Error("must not be called")) },
        deployment: "shared",
      });

      const result = await graphTool(captured).handler(
        {
          source: "memory",
          memoryScope,
          ...(memoryScope === "branch" ? { branch: "feature/graph" } : {}),
        },
        makeServerContext(),
      );
      expect(result.isError).to.equal(true);
      expect(parseResult(result).error.code).to.equal("GRAPH_MEMORY_UNAVAILABLE");
    });
  }

  it("allows knowledge visualization in a shared deployment", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "shared-topic", name: "Shared Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon.stub().resolves(null);
    register(server, topicManager, { deployment: "shared" });

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Shared Topic" },
      makeServerContext(),
    );
    expect(result.isError).not.to.equal(true);
    expect(parseResult(result).source.topicId).to.equal("shared-topic");
  });

  it("reduces huge metadata to the final wrapped response budget", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    const entities = Array.from({ length: 20 }, (_, index) =>
      knowledgeEntity(`large-${String(index).padStart(2, "0")}`, { blob: "x".repeat(90_000) }),
    );
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-large", name: "Large Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon.stub().resolves(knowledgeGraph(entities));
    register(server, topicManager);

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Large Topic" },
      makeServerContext(),
    );
    const payload = parseResult(result);
    expect(result.isError).not.to.equal(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);
    expect(payload.metadata.truncationReasons).to.include("responseBytes");
    expect(payload.metadata.retainedNodeCount).to.be.lessThan(entities.length);
  });

  it("keeps graph results within the absolute byte budget when the server limit is larger", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    const entities = Array.from({ length: 20 }, (_, index) =>
      knowledgeEntity(`absolute-${String(index).padStart(2, "0")}`, { blob: "x".repeat(90_000) }),
    );
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-absolute", name: "Absolute Limit Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon.stub().resolves(knowledgeGraph(entities));
    register(server, topicManager, { maxResponseBytes: 16 * 1024 * 1024 });

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Absolute Limit Topic" },
      makeServerContext(),
    );
    expect(result.isError).not.to.equal(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);
    expect(parseResult(result).metadata.truncationReasons).to.include("responseBytes");
  });

  it("maximally and deterministically edge-prefix reduces a once-projected 10,000-edge graph", async function () {
    const entities = [knowledgeEntity("edge-source"), knowledgeEntity("edge-target")];
    const edgeBlob = "e".repeat(400);
    const relationships = Array.from({ length: 10_000 }, (_, index) =>
      knowledgeRelationship(`edge-${String(index).padStart(5, "0")}`, edgeBlob),
    );

    const execute = async (orderedRelationships: any[]) => {
      const { server, captured } = fakeServer();
      const topicManager = makeTopicManager();
      const getAllEntities = sinon.stub().returns(entities);
      const getAllRelationships = sinon.stub().returns(orderedRelationships);
      topicManager.resolveTopicByName = sinon.stub().resolves({
        topic: { id: "topic-edge-limit", name: "Edge Limit Topic" },
        matchType: "exact",
      });
      topicManager.getKnowledgeGraph = sinon.stub().resolves({ getAllEntities, getAllRelationships });
      register(server, topicManager);

      const result = await graphTool(captured).handler(
        { source: "knowledge", topic: "Edge Limit Topic", maxNodes: 2 },
        makeServerContext(),
      );
      expect(result.isError).not.to.equal(true);
      expect(getAllEntities.calledOnce).to.equal(true);
      expect(getAllRelationships.calledOnce).to.equal(true);
      return { result, payload: parseResult(result) };
    };

    const forward = await execute(relationships);
    const reverse = await execute([...relationships].reverse());
    const retainedEdgeCount = forward.payload.metadata.retainedEdgeCount;
    expect(retainedEdgeCount).to.be.greaterThan(0).and.lessThan(relationships.length);
    expect(forward.payload.metadata.retainedNodeCount).to.equal(2);
    expect(forward.payload.metadata.truncationReasons).to.include("responseBytes");
    expect(forward.payload.edges.map((edge: any) => edge.id)).to.deep.equal(
      reverse.payload.edges.map((edge: any) => edge.id),
    );
    expect(Buffer.byteLength(JSON.stringify(forward.result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);

    const projected = projectKnowledgeGraphVisualization(
      { entities, relationships },
      { kind: "knowledge", topicId: "topic-edge-limit", topicName: "Edge Limit Topic" },
      { maxNodes: 2 },
    );
    const retained = reduceGraphVisualizationDocument(projected, 2, retainedEdgeCount);
    const next = reduceGraphVisualizationDocument(projected, 2, retainedEdgeCount + 1);
    const wrap = (document: typeof projected) => ({
      content: [{ type: "text" as const, text: JSON.stringify(document, null, 2) }],
    });
    const retainedMeasurement = measureToolResultForResponse(wrap(retained), "local", MCP_LIMITS.responseBytes);
    const nextMeasurement = measureToolResultForResponse(wrap(next), "local", MCP_LIMITS.responseBytes);
    expect(retainedMeasurement.fits).to.equal(true);
    expect(retainedMeasurement.responseBytes).to.equal(Buffer.byteLength(JSON.stringify(forward.result), "utf8"));
    expect(nextMeasurement.fits).to.equal(false);
  });

  it("returns GRAPH_VISUALIZATION_RECORD_TOO_LARGE for one oversized node and zero edges", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-oversized", name: "Oversized Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon
      .stub()
      .resolves(knowledgeGraph([knowledgeEntity("oversized", { blob: "x".repeat(700_000) })]));
    register(server, topicManager);

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Oversized Topic" },
      makeServerContext(),
    );
    expect(result.isError).to.equal(true);
    expect(parseResult(result).error.code).to.equal("GRAPH_VISUALIZATION_RECORD_TOO_LARGE");
  });

  it("returns GRAPH_VISUALIZATION_FAILED for unexpected projection errors", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-broken", name: "Broken Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon
      .stub()
      .resolves(knowledgeGraph([knowledgeEntity("broken", { unsupported: 1n })]));
    register(server, topicManager);

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Broken Topic" },
      makeServerContext(),
    );
    expect(result.isError).to.equal(true);
    expect(parseResult(result).error.code).to.equal("GRAPH_VISUALIZATION_FAILED");
  });

  it("bounds huge graph storage errors without changing GRAPH_VISUALIZATION_FAILED", async function () {
    const { server, captured } = fakeServer();
    const topicManager = makeTopicManager();
    topicManager.resolveTopicByName = sinon.stub().resolves({
      topic: { id: "topic-storage-error", name: "Storage Error Topic" },
      matchType: "exact",
    });
    topicManager.getKnowledgeGraph = sinon
      .stub()
      .rejects(new Error(`Knowledge graph storage failed: ${HUGE_UTF8_ERROR_SUFFIX}`));
    register(server, topicManager, { maxResponseBytes: 16 * 1024 * 1024 });

    const result = await graphTool(captured).handler(
      { source: "knowledge", topic: "Storage Error Topic" },
      makeServerContext(),
    );
    const payload = expectBoundedGraphError(result, "GRAPH_VISUALIZATION_FAILED");
    expect(payload.error.message).to.match(/^Knowledge graph storage failed: /);
    expect(payload.error.message.endsWith("...")).to.equal(true);
    expect(payload.error.message).not.to.include("�");
  });
});
