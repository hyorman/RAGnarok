/**
 * Unit tests for the rag_memory tool handler.
 *
 * Strategy: reuse the registerTool capture pattern from tools.test.ts, then
 * invoke the registered handler directly with a stubbed MemoryStore.
 */

import { expect } from "chai";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "../src/tools";
import type {
  TopicManager,
  EmbeddingService,
  IConfigProvider,
  ILLMProvider,
  RAGQueryService,
  MemoryStore,
  MemoryEntry,
  StandaloneMemoryStats,
  MemoryRecallResult,
} from "@ragnarok/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the JSON text from the first content entry of a tool response */
function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
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

/** Minimal stubs for the non-memory dependencies (not under test). */
function makeBaseDeps() {
  const topicManager = {
    getAllTopics: sinon.stub().returns([]),
    getTopicStats: sinon.stub(),
    createTopic: sinon.stub(),
    addDocuments: sinon.stub(),
    resolveTopicByName: sinon.stub(),
    getVectorStore: sinon.stub().resolves(null),
  } as unknown as sinon.SinonStubbedInstance<TopicManager>;

  const config: IConfigProvider = {
    get<T>(_key: string, defaultValue: T): T {
      return defaultValue;
    },
  };

  const llmProvider = {
    isAvailable: sinon.stub(),
    selectModel: sinon.stub(),
  } as unknown as sinon.SinonStubbedInstance<ILLMProvider>;

  const embeddingService = {
    getCurrentModel: sinon.stub().returns("Xenova/all-MiniLM-L6-v2"),
    listAvailableModels: sinon.stub(),
    getActiveBackendType: sinon.stub().returns("huggingface"),
    getLocalModelPath: sinon.stub().returns("/models/all-MiniLM-L6-v2"),
    initialize: sinon.stub().resolves(),
  } as unknown as sinon.SinonStubbedInstance<EmbeddingService>;

  const ragQueryService = {
    executeQuery: sinon.stub(),
    clearAgentCache: sinon.stub(),
    dispose: sinon.stub(),
  } as unknown as sinon.SinonStubbedInstance<RAGQueryService>;

  return { topicManager, config, llmProvider, embeddingService, ragQueryService };
}

/**
 * Register tools and capture handler callbacks keyed by tool name.
 * Optionally passes a MemoryStore to registerTools.
 */
function captureHandlers(memoryStore?: MemoryStore, deployment?: "local" | "shared"): Record<string, ToolHandler> {
  const captured: CapturedTool[] = [];
  const server = {
    registerTool(name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) {
      captured.push({ name, config, handler });
      return { name };
    },
  } as unknown as McpServer;

  const deps = makeBaseDeps();

  registerTools(
    server,
    deps.topicManager as unknown as TopicManager,
    deps.llmProvider as unknown as ILLMProvider,
    deps.embeddingService as unknown as EmbeddingService,
    deps.ragQueryService as unknown as RAGQueryService,
    memoryStore,
    undefined,
    undefined,
    undefined,
    undefined,
    deployment,
  );

  return Object.fromEntries(
    captured.map(({ name, handler }) => [name, (args: any, context = makeServerContext()) => handler(args, context)]),
  );
}

/** Build a fake MemoryEntry */
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem-1",
    content: "test memory content",
    scope: "workspace",
    branch: undefined,
    vector: [0.1, 0.2],
    createdAt: 1000,
    updatedAt: 2000,
    accessCount: 0,
    lastAccessedAt: 1000,
    tags: ["test"],
    entityIds: ["ent-1"],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rag_memory tool", () => {
  let memoryStore: sinon.SinonStubbedInstance<MemoryStore>;
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    memoryStore = {
      store: sinon.stub(),
      recall: sinon.stub(),
      forget: sinon.stub(),
      stats: sinon.stub(),
      list: sinon.stub(),
      getCurrentBranch: sinon.stub(),
      runDecay: sinon.stub(),
      getVersionHistory: sinon.stub(),
      promoteToWorkspace: sinon.stub(),
      discoverLinks: sinon.stub(),
    } as any;

    handlers = captureHandlers(memoryStore as unknown as MemoryStore);
  });

  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  it("is registered when memoryStore is provided", () => {
    expect(handlers.rag_memory).to.be.a("function");
  });

  it("is NOT registered when memoryStore is undefined", () => {
    const noMemoryHandlers = captureHandlers(undefined);
    expect(noMemoryHandlers.rag_memory).to.be.undefined;
  });

  it("is NOT registered in a shared deployment, even with a memoryStore and writer role", () => {
    const sharedHandlers = captureHandlers(memoryStore as unknown as MemoryStore, "shared");
    expect(sharedHandlers.rag_memory).to.be.undefined;
    expect(sharedHandlers.rag_reset_memory).to.be.undefined;
    // Only the memory tools are dropped — the rest of the surface stays.
    expect(sharedHandlers.rag_query).to.be.a("function");
    expect(sharedHandlers.rag_storage_status).to.be.a("function");
    expect(sharedHandlers.rag_create_topic).to.be.a("function");
  });

  it("is registered alongside rag_reset_memory in a local deployment", () => {
    const localHandlers = captureHandlers(memoryStore as unknown as MemoryStore, "local");
    expect(localHandlers.rag_memory).to.be.a("function");
    expect(localHandlers.rag_reset_memory).to.be.a("function");
  });

  // -----------------------------------------------------------------------
  // store action
  // -----------------------------------------------------------------------

  describe("store", () => {
    it("calls memoryStore.store() with correct params", async () => {
      const entry = makeEntry();
      const signal = new AbortController().signal;
      memoryStore.store.resolves(entry);

      const result = await handlers.rag_memory(
        {
          action: "store",
          content: "remember this",
          scope: "branch",
          branch: "feature-x",
          tags: ["tag1"],
        },
        makeServerContext(signal),
      );
      const body = parseResponse(result);

      expect(memoryStore.store.calledOnce).to.be.true;
      expect(memoryStore.store.firstCall.args[0]).to.deep.equal({
        content: "remember this",
        scope: "branch",
        branch: "feature-x",
        tags: ["tag1"],
        signal,
      });
      expect(body.action).to.equal("store");
      expect(body.memory.id).to.equal("mem-1");
      expect(body.memory.entityIds).to.deep.equal(["ent-1"]);
    });

    it("defaults scope to 'workspace' when not provided", async () => {
      const entry = makeEntry();
      memoryStore.store.resolves(entry);

      await handlers.rag_memory({ action: "store", content: "hello" });

      expect(memoryStore.store.firstCall.args[0].scope).to.equal("workspace");
    });

    it("returns error when content is missing", async () => {
      const result = await handlers.rag_memory({ action: "store" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.include("'content' is required");
      expect(memoryStore.store.called).to.be.false;
    });

    it("formats createdAt as ISO string", async () => {
      const entry = makeEntry({ createdAt: 0 });
      memoryStore.store.resolves(entry);

      const result = await handlers.rag_memory({ action: "store", content: "x" });
      const body = parseResponse(result);

      expect(body.memory.createdAt).to.equal(new Date(0).toISOString());
    });

    it("sets isError on exception", async () => {
      memoryStore.store.rejects(new Error("store failed"));

      const result = await handlers.rag_memory({ action: "store", content: "x" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("store failed");
    });
  });

  // -----------------------------------------------------------------------
  // recall action
  // -----------------------------------------------------------------------

  describe("recall", () => {
    it("calls memoryStore.recall() with correct params", async () => {
      const recallResult: MemoryRecallResult = {
        memories: [{ entry: makeEntry(), score: 0.9 }],
        entities: [],
      };
      const signal = new AbortController().signal;
      memoryStore.recall.resolves(recallResult);

      const result = await handlers.rag_memory(
        {
          action: "recall",
          query: "what do I know",
          topK: 5,
          scope: "branch",
          branch: "main",
          includeEntities: true,
        },
        makeServerContext(signal),
      );
      const body = parseResponse(result);

      expect(memoryStore.recall.calledOnce).to.be.true;
      expect(memoryStore.recall.firstCall.args[0]).to.deep.equal({
        query: "what do I know",
        topK: 5,
        scope: "branch",
        branch: "main",
        includeEntities: true,
        signal,
      });
      expect(body.action).to.equal("recall");
      expect(body.count).to.equal(1);
      expect(body.memories[0].score).to.equal(0.9);
    });

    it("defaults topK to 10 and includeEntities to false", async () => {
      memoryStore.recall.resolves({ memories: [], entities: [] });

      await handlers.rag_memory({ action: "recall", query: "q" });

      const args = memoryStore.recall.firstCall.args[0];
      expect(args.topK).to.equal(10);
      expect(args.includeEntities).to.equal(false);
    });

    it("returns error when query is missing", async () => {
      const result = await handlers.rag_memory({ action: "recall" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.include("'query' is required");
      expect(memoryStore.recall.called).to.be.false;
    });

    it("rounds scores to 3 decimal places", async () => {
      const recallResult: MemoryRecallResult = {
        memories: [{ entry: makeEntry(), score: 0.87654 }],
        entities: [
          {
            entity: {
              id: "e1",
              name: "Concept",
              type: "concept",
              description: "A concept",
              vector: [],
              scope: "workspace",
              confidence: 1,
              strength: 1,
              createdAt: 0,
              updatedAt: 0,
              sourceMemoryIds: [],
              metadata: {},
            },
            score: 0.12345,
          },
        ],
      };
      memoryStore.recall.resolves(recallResult);

      const result = await handlers.rag_memory({ action: "recall", query: "q" });
      const body = parseResponse(result);

      expect(body.memories[0].score).to.equal(0.877);
      expect(body.entities[0].score).to.equal(0.123);
    });

    it("sets isError on exception", async () => {
      memoryStore.recall.rejects(new Error("recall failed"));

      const result = await handlers.rag_memory({ action: "recall", query: "q" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("recall failed");
    });
  });

  // -----------------------------------------------------------------------
  // forget action
  // -----------------------------------------------------------------------

  describe("forget", () => {
    it("calls memoryStore.forget() with id", async () => {
      memoryStore.forget.resolves(1);

      const result = await handlers.rag_memory({
        action: "forget",
        id: "mem-1",
      });
      const body = parseResponse(result);

      expect(memoryStore.forget.calledOnce).to.be.true;
      expect(memoryStore.forget.firstCall.args[0]).to.deep.equal({
        id: "mem-1",
        scope: undefined,
        branch: undefined,
        olderThan: undefined,
        expired: undefined,
      });
      expect(body.action).to.equal("forget");
      expect(body.forgottenCount).to.equal(1);
    });

    it("passes scope, branch, and olderThan filters", async () => {
      memoryStore.forget.resolves(3);

      await handlers.rag_memory({
        action: "forget",
        scope: "branch",
        branch: "old-branch",
        olderThan: 30,
      });

      expect(memoryStore.forget.firstCall.args[0]).to.deep.equal({
        id: undefined,
        scope: "branch",
        branch: "old-branch",
        olderThan: 30,
        expired: undefined,
      });
    });

    it("derives branch scope when a branch filter is supplied", async () => {
      memoryStore.forget.resolves(1);

      await handlers.rag_memory({
        action: "forget",
        branch: "only-this-branch",
        olderThan: 30,
      });

      expect(memoryStore.forget.firstCall.args[0]).to.deep.equal({
        id: undefined,
        scope: "branch",
        branch: "only-this-branch",
        olderThan: 30,
        expired: undefined,
      });
    });

    it("rejects unscoped or zero-day age deletion before calling the store", async () => {
      const unscoped = await handlers.rag_memory({ action: "forget", olderThan: 30 });
      expect(unscoped.isError).to.equal(true);
      expect(parseResponse(unscoped).error).to.include("explicit 'scope' or 'branch'");

      const zeroDay = await handlers.rag_memory({ action: "forget", scope: "workspace", olderThan: 0 });
      expect(zeroDay.isError).to.equal(true);
      expect(parseResponse(zeroDay).error).to.include("positive whole number");
      expect(memoryStore.forget.called).to.equal(false);
    });

    it("rejects workspace scope combined with a branch", async () => {
      const result = await handlers.rag_memory({
        action: "forget",
        scope: "workspace",
        branch: "feature/nope",
        olderThan: 30,
      });
      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("cannot be combined");
      expect(memoryStore.forget.called).to.equal(false);
    });

    it("passes expired: true through so decayed/TTL-expired entries can be purged", async () => {
      memoryStore.forget.resolves(4);

      const result = await handlers.rag_memory({
        action: "forget",
        expired: true,
      });
      const body = parseResponse(result);

      expect(memoryStore.forget.firstCall.args[0]).to.deep.equal({
        id: undefined,
        scope: undefined,
        branch: undefined,
        olderThan: undefined,
        expired: true,
      });
      expect(body.forgottenCount).to.equal(4);
    });

    it("requires a destructive selector", async () => {
      const result = await handlers.rag_memory({ action: "forget" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.include("requires 'id', 'olderThan', or 'expired: true'");
      expect(memoryStore.forget.called).to.equal(false);
    });

    it("sets isError on exception", async () => {
      memoryStore.forget.rejects(new Error("forget failed"));

      const result = await handlers.rag_memory({ action: "forget", id: "mem-fail" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("forget failed");
    });
  });

  // -----------------------------------------------------------------------
  // stats action
  // -----------------------------------------------------------------------

  describe("stats", () => {
    it("calls memoryStore.stats() and returns result", async () => {
      const fakeStats: StandaloneMemoryStats = {
        totalMemories: 10,
        totalEntities: 5,
        totalRelationships: 3,
        byScope: { workspace: 7, branch: 3 },
        branches: ["main", "dev"],
        entityTypes: { concept: 3, fact: 2 },
        lastUpdated: 9999,
      };
      memoryStore.stats.resolves(fakeStats);

      const result = await handlers.rag_memory({ action: "stats" });
      const body = parseResponse(result);

      expect(memoryStore.stats.calledOnce).to.be.true;
      expect(body.action).to.equal("stats");
      expect(body.totalMemories).to.equal(10);
      expect(body.totalEntities).to.equal(5);
      expect(body.byScope).to.deep.equal({ workspace: 7, branch: 3 });
      expect(body.branches).to.deep.equal(["main", "dev"]);
    });

    it("sets isError on exception", async () => {
      memoryStore.stats.rejects(new Error("stats failed"));

      const result = await handlers.rag_memory({ action: "stats" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("stats failed");
    });
  });

  // -----------------------------------------------------------------------
  // list action
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("calls memoryStore.list() with correct params", async () => {
      const entries = [makeEntry(), makeEntry({ id: "mem-2", content: "second" })];
      memoryStore.list.resolves(entries);

      const result = await handlers.rag_memory({
        action: "list",
        scope: "workspace",
        limit: 20,
      });
      const body = parseResponse(result);

      expect(memoryStore.list.calledOnce).to.be.true;
      expect(memoryStore.list.firstCall.args[0]).to.deep.equal({
        scope: "workspace",
        branch: undefined,
        limit: 20,
      });
      expect(body.action).to.equal("list");
      expect(body.count).to.equal(2);
      expect(body.memories).to.have.lengthOf(2);
    });

    it("defaults limit to 50", async () => {
      memoryStore.list.resolves([]);

      await handlers.rag_memory({ action: "list" });

      const args = memoryStore.list.firstCall!.args[0] as any;
      expect(args.limit).to.equal(50);
    });

    it("truncates content to 200 chars with ellipsis", async () => {
      const longContent = "x".repeat(300);
      memoryStore.list.resolves([makeEntry({ content: longContent })]);

      const result = await handlers.rag_memory({ action: "list" });
      const body = parseResponse(result);

      expect(body.memories[0].content).to.have.lengthOf(203); // 200 + "..."
      expect(body.memories[0].content.endsWith("...")).to.be.true;
    });

    it("does not truncate short content", async () => {
      memoryStore.list.resolves([makeEntry({ content: "short" })]);

      const result = await handlers.rag_memory({ action: "list" });
      const body = parseResponse(result);

      expect(body.memories[0].content).to.equal("short");
    });

    it("includes accessCount in list output", async () => {
      memoryStore.list.resolves([makeEntry({ accessCount: 42 })]);

      const result = await handlers.rag_memory({ action: "list" });
      const body = parseResponse(result);

      expect(body.memories[0].accessCount).to.equal(42);
    });

    it("sets isError on exception", async () => {
      memoryStore.list.rejects(new Error("list failed"));

      const result = await handlers.rag_memory({ action: "list" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("list failed");
    });
  });

  // -----------------------------------------------------------------------
  // decay action
  // -----------------------------------------------------------------------

  describe("decay", () => {
    it("calls memoryStore.runDecay() and returns status", async () => {
      const fakeStatus = {
        totalEntries: 20,
        decayedCount: 5,
        expiredCount: 2,
        nearThresholdCount: 3,
      };
      memoryStore.runDecay.resolves(fakeStatus);

      const result = await handlers.rag_memory({ action: "decay", scope: "workspace" });
      const body = parseResponse(result);

      expect(memoryStore.runDecay.calledOnce).to.be.true;
      expect(memoryStore.runDecay.firstCall.args[0]).to.equal("workspace");
      expect(body.action).to.equal("decay");
      expect(body.totalEntries).to.equal(20);
      expect(body.decayedCount).to.equal(5);
      expect(body.belowThresholdCount).to.equal(2);
      expect(body.nearThresholdCount).to.equal(3);
      expect(body.note).to.equal("Use the 'forget' action with expired: true to remove expired entries");
    });

    it("passes scope and branch to runDecay", async () => {
      memoryStore.runDecay.resolves({ totalEntries: 0, decayedCount: 0, expiredCount: 0, nearThresholdCount: 0 });

      await handlers.rag_memory({ action: "decay", scope: "branch", branch: "feature-x" });

      expect(memoryStore.runDecay.firstCall.args).to.deep.equal(["branch", "feature-x"]);
    });

    it("sets isError on exception", async () => {
      memoryStore.runDecay.rejects(new Error("decay failed"));

      const result = await handlers.rag_memory({ action: "decay" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("decay failed");
    });
  });

  // -----------------------------------------------------------------------
  // history action
  // -----------------------------------------------------------------------

  describe("history", () => {
    it("calls memoryStore.getVersionHistory() and returns versions", async () => {
      const versions = [
        makeEntry({
          id: "mem-1-v2",
          content: "updated",
          version: 2,
          isLatest: true,
          confidence: 0.85,
          supersededBy: undefined,
        }),
        makeEntry({
          id: "mem-1-v1",
          content: "original",
          version: 1,
          isLatest: false,
          confidence: 0.5,
          supersededBy: "mem-1-v2",
        }),
      ];
      memoryStore.getVersionHistory.resolves(versions);

      const result = await handlers.rag_memory({ action: "history", id: "mem-1-v2" });
      const body = parseResponse(result);

      expect(memoryStore.getVersionHistory.calledOnce).to.be.true;
      expect(memoryStore.getVersionHistory.firstCall.args[0]).to.equal("mem-1-v2");
      expect(body.action).to.equal("history");
      expect(body.entryId).to.equal("mem-1-v2");
      expect(body.count).to.equal(2);
      expect(body.versions[0].version).to.equal(2);
      expect(body.versions[0].isLatest).to.equal(true);
      expect(body.versions[0].confidence).to.equal(0.85);
      expect(body.versions[0].supersededBy).to.equal(null);
      expect(body.versions[1].version).to.equal(1);
      expect(body.versions[1].isLatest).to.equal(false);
      expect(body.versions[1].confidence).to.equal(0.5);
      expect(body.versions[1].supersededBy).to.equal("mem-1-v2");
    });

    it("returns error when id is missing", async () => {
      const result = await handlers.rag_memory({ action: "history" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.include("'id' is required");
      expect(memoryStore.getVersionHistory.called).to.be.false;
    });

    it("sets isError on exception", async () => {
      memoryStore.getVersionHistory.rejects(new Error("history failed"));

      const result = await handlers.rag_memory({ action: "history", id: "mem-1" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("history failed");
    });
  });

  // -----------------------------------------------------------------------
  // promote action
  // -----------------------------------------------------------------------

  describe("promote", () => {
    it("calls memoryStore.promoteToWorkspace() and returns count", async () => {
      memoryStore.promoteToWorkspace.resolves(4);

      const result = await handlers.rag_memory({ action: "promote", branch: "feature-x" });
      const body = parseResponse(result);

      expect(memoryStore.promoteToWorkspace.calledOnce).to.be.true;
      expect(memoryStore.promoteToWorkspace.firstCall.args[0]).to.equal("feature-x");
      expect(memoryStore.promoteToWorkspace.firstCall.args[1]).to.be.undefined;
      expect(body.action).to.equal("promote");
      expect(body.branch).to.equal("feature-x");
      expect(body.promotedCount).to.equal(4);
    });

    it("passes comma-separated entry IDs to promoteToWorkspace", async () => {
      memoryStore.promoteToWorkspace.resolves(2);

      const result = await handlers.rag_memory({ action: "promote", branch: "feature-x", id: "mem-1, mem-2" });
      const body = parseResponse(result);

      expect(memoryStore.promoteToWorkspace.calledOnce).to.be.true;
      expect(memoryStore.promoteToWorkspace.firstCall.args[0]).to.equal("feature-x");
      expect(memoryStore.promoteToWorkspace.firstCall.args[1]).to.deep.equal(["mem-1", "mem-2"]);
      expect(body.promotedCount).to.equal(2);
    });

    it("returns error when branch is missing", async () => {
      const result = await handlers.rag_memory({ action: "promote" });
      const body = parseResponse(result);

      expect(result.isError).to.equal(true);
      expect(body.error).to.include("'branch' is required");
      expect(memoryStore.promoteToWorkspace.called).to.be.false;
    });

    it("sets isError on exception", async () => {
      memoryStore.promoteToWorkspace.rejects(new Error("promote failed"));

      const result = await handlers.rag_memory({ action: "promote", branch: "b" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("promote failed");
    });
  });

  // -----------------------------------------------------------------------
  // links action
  // -----------------------------------------------------------------------

  describe("links", () => {
    it("calls memoryStore.discoverLinks() and returns links", async () => {
      const fakeLinks = [
        {
          sourceScope: "workspace",
          targetScope: "branch:main",
          sourceEntityId: "e1",
          targetEntityId: "e2",
          entityName: "Auth",
          entityType: "concept",
          confidence: 0.95678,
        },
      ];
      memoryStore.discoverLinks.resolves(fakeLinks);

      const result = await handlers.rag_memory({ action: "links" });
      const body = parseResponse(result);

      expect(memoryStore.discoverLinks.calledOnce).to.be.true;
      expect(body.action).to.equal("links");
      expect(body.count).to.equal(1);
      expect(body.links[0].entityName).to.equal("Auth");
      expect(body.links[0].confidence).to.equal(0.957);
    });

    it("passes scope and branch to discoverLinks", async () => {
      memoryStore.discoverLinks.resolves([]);

      await handlers.rag_memory({ action: "links", scope: "branch", branch: "dev" });

      expect(memoryStore.discoverLinks.firstCall.args[0]).to.equal("branch:dev");
    });

    it("sets isError on exception", async () => {
      memoryStore.discoverLinks.rejects(new Error("links failed"));

      const result = await handlers.rag_memory({ action: "links" });

      expect(result.isError).to.equal(true);
      expect(parseResponse(result).error).to.equal("links failed");
    });
  });
});
