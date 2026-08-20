import { expect } from "chai";
import { executeTopicRead, TopicInputError } from "../src/tools/index";

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

  // Hosts need to tell "the model sent bad arguments" apart from "the backend is
  // unwell", because only the first is worth retrying with different arguments.
  describe("input errors are distinguishable from backend failures", function () {
    const inputCases: Array<{ label: string; input: unknown }> = [
      { label: "missing topic", input: { action: "stats" } },
      { label: "blank topic", input: { action: "stats", topic: "   " } },
      { label: "over-long topic", input: { action: "stats", topic: "x".repeat(201) } },
    ];

    for (const { label, input } of inputCases) {
      it(`throws TopicInputError for a ${label}`, async function () {
        try {
          await executeTopicRead(input as never, { topicManager: fakeManager() as never });
          expect.fail("should have thrown");
        } catch (error) {
          expect(error).to.be.instanceOf(TopicInputError);
        }
      });
    }

    it("does not throw TopicInputError when the backend fails", async function () {
      const manager = fakeManager();
      manager.resolveTopicByName = async () => {
        throw new Error("embedding provider unavailable");
      };
      try {
        await executeTopicRead({ action: "stats", topic: "Docs" }, { topicManager: manager as never });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect(error).to.not.be.instanceOf(TopicInputError);
        expect((error as Error).message).to.equal("embedding provider unavailable");
      }
    });

    // TopicManager.getTopicStats catches every internal failure, logs it, and
    // returns null, so null is what an embedding outage, a rate limit, and an
    // unreadable metadata file all look like from here. Classifying that as an
    // input error tells the model to retry a different topic name against
    // infrastructure that is down.
    it("does not throw TopicInputError when no statistics are available", async function () {
      try {
        await executeTopicRead(
          { action: "stats", topic: "Docs" },
          { topicManager: fakeManager({ getTopicStats: async () => null }) as never },
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect(error).to.not.be.instanceOf(TopicInputError);
      }
    });

    it("does not throw TopicInputError when listing fails", async function () {
      const manager = fakeManager();
      manager.getAllTopics = () => {
        throw new Error("storage unreadable");
      };
      try {
        await executeTopicRead({ action: "list" }, { topicManager: manager as never });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).to.not.be.instanceOf(TopicInputError);
      }
    });
  });

  // resolveTopicByName embeds the query plus one vector per topic when the name
  // is not an exact match, so the stats path can be network-bound and must be
  // interruptible. The signal is optional: the MCP host passes none.
  describe("cancellation", function () {
    it("rejects a pre-aborted list before touching the manager", async function () {
      const manager = fakeManager();
      const controller = new AbortController();
      controller.abort(new Error("cancelled by host"));
      try {
        await executeTopicRead({ action: "list" }, { topicManager: manager as never }, controller.signal);
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Error).message).to.equal("cancelled by host");
      }
    });

    it("rejects a pre-aborted stats before resolving the topic", async function () {
      const manager = fakeManager();
      const controller = new AbortController();
      controller.abort(new Error("cancelled by host"));
      try {
        await executeTopicRead(
          { action: "stats", topic: "Docs" },
          { topicManager: manager as never },
          controller.signal,
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Error).message).to.equal("cancelled by host");
      }
      expect(manager.resolvedNames).to.deep.equal([]);
    });

    it("stops between resolve and stats when cancelled mid-flight", async function () {
      const controller = new AbortController();
      const manager = fakeManager();
      const resolve = manager.resolveTopicByName;
      manager.resolveTopicByName = async (name: string) => {
        const result = await resolve(name);
        controller.abort(new Error("cancelled mid-flight"));
        return result;
      };
      try {
        await executeTopicRead(
          { action: "stats", topic: "Docs" },
          { topicManager: manager as never },
          controller.signal,
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Error).message).to.equal("cancelled mid-flight");
      }
      expect(manager.resolvedNames).to.deep.equal(["Docs"]);
      // The abort must land before the next await, not after it.
      expect(manager.statsIds).to.deep.equal([]);
    });

    it("completes normally with a live signal", async function () {
      const controller = new AbortController();
      const manager = fakeManager();
      const payload = await executeTopicRead(
        { action: "stats", topic: "Docs" },
        { topicManager: manager as never },
        controller.signal,
      );
      expect(payload).to.have.property("chunkCount", 9);
    });

    it("still works when no signal is passed, as the MCP host calls it", async function () {
      const payload = await executeTopicRead({ action: "list" }, { topicManager: fakeManager() as never });
      expect(payload).to.have.property("count", 1);
    });
  });
});
