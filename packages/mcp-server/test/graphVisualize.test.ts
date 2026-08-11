import { expect } from "chai";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/server";
import {
  EmbeddingService,
  TopicManager,
  projectMemoryGraphVisualization,
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
    undefined,
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

function memoryEntity(id: string, metadata: Record<string, unknown> = {}): any {
  return {
    id,
    name: `Entity ${id}`,
    type: "concept",
    description: `Description ${id}`,
    scope: "workspace",
    confidence: 0.9,
    strength: 0.8,
    createdAt: 10,
    updatedAt: 20,
    sourceMemoryIds: [`memory-${id}`],
    metadata,
  };
}

function memoryRelationship(id: string, blob: string): any {
  return {
    id,
    sourceId: "edge-source",
    targetId: "edge-target",
    type: "related_to",
    weight: 1,
    description: `Relationship ${id}`,
    scope: "workspace",
    metadata: { blob },
  };
}

/** Registers the tool against a workspace-memory store returning the given snapshot. */
function registerMemorySnapshot(
  server: McpServer,
  entities: any[],
  relationships: any[] = [],
  options: RegisterOptions = {},
): void {
  register(server, makeTopicManager(), {
    ...options,
    memoryStore: { getGraphSnapshot: sinon.stub().resolves({ entities, relationships }) },
  });
}

const WORKSPACE_MEMORY_INPUT = { source: "memory" as const, memoryScope: "workspace" as const };

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

  it("exposes graph UI resource metadata", function () {
    const { server, captured } = fakeServer();
    registerMemorySnapshot(server, [], []);
    const graph = graphTool(captured);
    expect(graph.config._meta).to.deep.equal({ ui: { resourceUri: "ui://ragnarok/graph" } });
    expect(graph.config._meta).not.to.have.property("ui/resourceUri");
    expect(graph.config.annotations?.readOnlyHint).to.equal(true);
  });

  it("uses the exact two-branch memory-only input schema", function () {
    const { server, captured } = fakeServer();
    registerMemorySnapshot(server, []);
    const schema = graphTool(captured).config.inputSchema!;

    for (const valid of [
      { source: "memory", memoryScope: "workspace", maxNodes: 25 },
      { source: "memory", memoryScope: "branch", branch: " feature/graph ", maxNodes: 25 },
    ]) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).to.equal(true);
    }

    for (const invalid of [
      { source: "memory", memoryScope: "branch" },
      { source: "memory", memoryScope: "branch", branch: "   " },
      { source: "memory", memoryScope: "workspace", branch: "feature/graph" },
      { source: "memory", memoryScope: "workspace", topic: "real" },
      { source: "memory", memoryScope: "workspace", maxNodes: 0 },
      { source: "memory", memoryScope: "workspace", maxNodes: 2_001 },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).to.equal(false);
    }
  });

  it("rejects the removed knowledge source at schema validation", function () {
    const { server, captured } = fakeServer();
    registerMemorySnapshot(server, []);
    const schema = graphTool(captured).config.inputSchema!;

    for (const removed of [
      { source: "knowledge", topic: "anything" },
      { source: "knowledge" },
      { source: "knowledge", topic: "anything", maxNodes: 25 },
      { source: "knowledge", memoryScope: "workspace" },
    ]) {
      expect(schema.safeParse(removed).success, JSON.stringify(removed)).to.equal(false);
    }
  });

  it("is not registered without a memory store", function () {
    const { server, captured } = fakeServer();
    register(server, makeTopicManager(), { memoryStore: undefined });
    expect(captured.map((tool) => tool.name)).to.not.include("rag_graph_visualize");
  });

  it("uses the common runtime wrapper", async function () {
    const { server, captured } = fakeServer();
    let runtimeRuns = 0;
    registerMemorySnapshot(server, [memoryEntity("runtime")], [], {
      runtime: {
        run: async (operation) => {
          runtimeRuns += 1;
          return operation();
        },
      },
    });

    await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    expect(runtimeRuns).to.equal(1);
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

  it("reduces huge metadata to the final wrapped response budget", async function () {
    const { server, captured } = fakeServer();
    const entities = Array.from({ length: 20 }, (_, index) =>
      memoryEntity(`large-${String(index).padStart(2, "0")}`, { blob: "x".repeat(90_000) }),
    );
    registerMemorySnapshot(server, entities);

    const result = await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    const payload = parseResult(result);
    expect(result.isError).not.to.equal(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);
    expect(payload.metadata.truncationReasons).to.include("responseBytes");
    expect(payload.metadata.retainedNodeCount).to.be.lessThan(entities.length);
  });

  it("keeps graph results within the absolute byte budget when the server limit is larger", async function () {
    const { server, captured } = fakeServer();
    const entities = Array.from({ length: 20 }, (_, index) =>
      memoryEntity(`absolute-${String(index).padStart(2, "0")}`, { blob: "x".repeat(90_000) }),
    );
    registerMemorySnapshot(server, entities, [], { maxResponseBytes: 16 * 1024 * 1024 });

    const result = await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    expect(result.isError).not.to.equal(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).to.be.at.most(MCP_LIMITS.responseBytes);
    expect(parseResult(result).metadata.truncationReasons).to.include("responseBytes");
  });

  it("maximally and deterministically edge-prefix reduces a once-projected 10,000-edge graph", async function () {
    const entities = [memoryEntity("edge-source"), memoryEntity("edge-target")];
    const edgeBlob = "e".repeat(400);
    const relationships = Array.from({ length: 10_000 }, (_, index) =>
      memoryRelationship(`edge-${String(index).padStart(5, "0")}`, edgeBlob),
    );

    const execute = async (orderedRelationships: any[]) => {
      const { server, captured } = fakeServer();
      const getGraphSnapshot = sinon.stub().resolves({ entities, relationships: orderedRelationships });
      register(server, makeTopicManager(), { memoryStore: { getGraphSnapshot } });

      const result = await graphTool(captured).handler({ ...WORKSPACE_MEMORY_INPUT, maxNodes: 2 }, makeServerContext());
      expect(result.isError).not.to.equal(true);
      expect(getGraphSnapshot.calledOnce).to.equal(true);
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

    const projected = projectMemoryGraphVisualization(
      { entities, relationships },
      { kind: "memory", scope: "workspace" },
      { maxNodes: 2 },
    );
    const retained = reduceGraphVisualizationDocument(projected, 2, retainedEdgeCount);
    const next = reduceGraphVisualizationDocument(projected, 2, retainedEdgeCount + 1);
    const wrap = (document: typeof projected) => ({
      content: [{ type: "text" as const, text: JSON.stringify(document, null, 2) }],
    });
    const retainedMeasurement = measureToolResultForResponse(wrap(retained), MCP_LIMITS.responseBytes);
    const nextMeasurement = measureToolResultForResponse(wrap(next), MCP_LIMITS.responseBytes);
    expect(retainedMeasurement.fits).to.equal(true);
    expect(retainedMeasurement.responseBytes).to.equal(Buffer.byteLength(JSON.stringify(forward.result), "utf8"));
    expect(nextMeasurement.fits).to.equal(false);
  });

  it("returns GRAPH_VISUALIZATION_RECORD_TOO_LARGE for one oversized node and zero edges", async function () {
    const { server, captured } = fakeServer();
    registerMemorySnapshot(server, [memoryEntity("oversized", { blob: "x".repeat(700_000) })]);

    const result = await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    expect(result.isError).to.equal(true);
    expect(parseResult(result).error.code).to.equal("GRAPH_VISUALIZATION_RECORD_TOO_LARGE");
  });

  it("returns GRAPH_VISUALIZATION_FAILED for unexpected projection errors", async function () {
    const { server, captured } = fakeServer();
    registerMemorySnapshot(server, [memoryEntity("broken", { unsupported: 1n })]);

    const result = await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    expect(result.isError).to.equal(true);
    expect(parseResult(result).error.code).to.equal("GRAPH_VISUALIZATION_FAILED");
  });

  it("bounds huge graph storage errors without changing GRAPH_VISUALIZATION_FAILED", async function () {
    const { server, captured } = fakeServer();
    register(server, makeTopicManager(), {
      maxResponseBytes: 16 * 1024 * 1024,
      memoryStore: {
        getGraphSnapshot: sinon.stub().rejects(new Error(`Memory graph storage failed: ${HUGE_UTF8_ERROR_SUFFIX}`)),
      },
    });

    const result = await graphTool(captured).handler(WORKSPACE_MEMORY_INPUT, makeServerContext());
    const payload = expectBoundedGraphError(result, "GRAPH_VISUALIZATION_FAILED");
    expect(payload.error.message).to.match(/^Memory graph storage failed: /);
    expect(payload.error.message.endsWith("...")).to.equal(true);
    expect(payload.error.message).not.to.include("�");
  });
});
