import { expect } from "chai";
import { executeTopicRead } from "../src/tools/index";

const topic = {
  id: "t1",
  name: "Docs",
  description: "d",
  documentCount: 2,
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  source: undefined,
};

interface FakeOverrides {
  getTopicStats?: () => Promise<unknown>;
  topics?: Array<Record<string, unknown>>;
}

/**
 * Records every argument the executor plumbs through, so a slip that passes the
 * topic *name* where the topic *id* belongs (both are strings, so the compiler
 * cannot catch it) fails a test.
 */
function fakeManager(overrides: FakeOverrides = {}) {
  const resolvedNames: string[] = [];
  const statsIds: string[] = [];
  const listDocumentsIds: string[] = [];
  const manager = {
    resolvedNames,
    statsIds,
    listDocumentsIds,
    getAllTopics: () => overrides.topics ?? [topic],
    resolveTopicByName: async (name: string) => {
      resolvedNames.push(name);
      return { topic, matchType: name === topic.name ? "exact" : "fallback" };
    },
    getTopicStats: async (topicId: string) => {
      statsIds.push(topicId);
      if (overrides.getTopicStats) {
        return overrides.getTopicStats();
      }
      return { documentCount: 2, chunkCount: 9, lastUpdated: 1700000100000, embeddingModel: "m" };
    },
    listDocuments: (topicId: string) => {
      listDocumentsIds.push(topicId);
      return [{ id: "d1", name: "a.md", chunkCount: 5 }];
    },
  };
  return manager;
}

describe("topic read tool", function () {
  it("lists topics with ISO timestamps and a default source", async function () {
    const payload = await executeTopicRead({ action: "list" }, { topicManager: fakeManager() as never });
    expect(payload).to.deep.equal({
      topics: [
        {
          name: "Docs",
          description: "d",
          documentCount: 2,
          createdAt: new Date(1700000000000).toISOString(),
          updatedAt: new Date(1700000100000).toISOString(),
          source: "local",
        },
      ],
      count: 1,
    });
  });

  it("keeps an explicit topic source and counts every topic", async function () {
    const payload = (await executeTopicRead(
      { action: "list" },
      { topicManager: fakeManager({ topics: [{ ...topic, source: "common" }, topic] }) as never },
    )) as { topics: Array<{ source: string }>; count: number };
    expect(payload.topics.map((entry) => entry.source)).to.deep.equal(["common", "local"]);
    expect(payload.count).to.equal(2);
  });

  it("passes a missing description through untouched", async function () {
    const bare = { id: "t2", name: "Bare", documentCount: 0, createdAt: 1700000000000, updatedAt: 1700000000000 };
    const payload = (await executeTopicRead(
      { action: "list" },
      { topicManager: fakeManager({ topics: [bare] }) as never },
    )) as { topics: Array<Record<string, unknown>> };
    // MCP passes `description` through raw; it must not be defaulted to a string.
    expect(payload.topics[0]).to.have.property("description");
    expect(payload.topics[0].description).to.equal(undefined);
    expect(payload.topics[0]).to.deep.equal({
      name: "Bare",
      description: undefined,
      documentCount: 0,
      createdAt: new Date(1700000000000).toISOString(),
      updatedAt: new Date(1700000000000).toISOString(),
      source: "local",
    });
  });

  it("returns an empty list with a zero count", async function () {
    const payload = await executeTopicRead({ action: "list" }, { topicManager: fakeManager({ topics: [] }) as never });
    expect(payload).to.deep.equal({ topics: [], count: 0 });
  });

  it("returns stats merged with documents", async function () {
    const manager = fakeManager();
    const payload = await executeTopicRead({ action: "stats", topic: "Docs" }, { topicManager: manager as never });
    // deep.equal, not deep.include: an extra top-level key would silently change
    // the MCP handler's published stats output.
    expect(payload).to.deep.equal({
      documentCount: 2,
      chunkCount: 9,
      lastUpdated: 1700000100000,
      embeddingModel: "m",
      // Mirrors the MCP handler: `documentId` is *added* to the document, `id` survives.
      documents: [{ id: "d1", documentId: "d1", name: "a.md", chunkCount: 5 }],
    });
  });

  it("reads stats and documents by the resolved topic id, not the name", async function () {
    const manager = fakeManager();
    await executeTopicRead({ action: "stats", topic: "Docs" }, { topicManager: manager as never });
    expect(manager.statsIds).to.deep.equal(["t1"]);
    expect(manager.listDocumentsIds).to.deep.equal(["t1"]);
  });

  it("resolves the trimmed topic name", async function () {
    const manager = fakeManager();
    await executeTopicRead({ action: "stats", topic: "  Docs  " }, { topicManager: manager as never });
    expect(manager.resolvedNames).to.deep.equal(["Docs"]);
  });

  it("requires a topic for stats", async function () {
    try {
      await executeTopicRead({ action: "stats" } as never, { topicManager: fakeManager() as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/is required for the 'stats' action/);
    }
  });

  it("rejects a blank topic for stats", async function () {
    try {
      await executeTopicRead({ action: "stats", topic: "   " }, { topicManager: fakeManager() as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/'topic' is required/);
    }
  });

  it("rejects a topic name longer than the shared bound", async function () {
    const manager = fakeManager();
    try {
      await executeTopicRead({ action: "stats", topic: "x".repeat(201) }, { topicManager: manager as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/must not exceed 200 characters/);
    }
    expect(manager.resolvedNames).to.deep.equal([]);
  });

  it("accepts a topic name exactly at the shared bound", async function () {
    const name = "x".repeat(200);
    const manager = fakeManager();
    await executeTopicRead({ action: "stats", topic: name }, { topicManager: manager as never });
    expect(manager.resolvedNames).to.deep.equal([name]);
  });

  it("throws when no statistics are available", async function () {
    try {
      await executeTopicRead(
        { action: "stats", topic: "Docs" },
        { topicManager: fakeManager({ getTopicStats: async () => null }) as never },
      );
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/No statistics available for topic 'Docs'/);
    }
  });
});
