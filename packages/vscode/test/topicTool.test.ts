import { expect } from "chai";
import mockVscode from "../test-harness/setup";
import type { TopicManager } from "@ragnarok/core";
import { TopicTool, TOOLS, type LanguageModelToolRegistrationHost } from "@ragnarok/vscode";

const topic = {
  id: "t1",
  name: "Docs",
  description: "d",
  documentCount: 2,
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  source: undefined,
};

/**
 * Records the ids the executor plumbs through, so a slip that passes the topic
 * *name* where the topic *id* belongs (both are strings, so the compiler cannot
 * catch it) fails a test rather than passing silently.
 */
function fakeManager(overrides: { topics?: Array<Record<string, unknown>> } = {}) {
  const resolvedNames: string[] = [];
  const statsIds: string[] = [];
  const listDocumentsIds: string[] = [];
  return {
    resolvedNames,
    statsIds,
    listDocumentsIds,
    getAllTopics: () => overrides.topics ?? [topic],
    resolveTopicByName: async (name: string) => {
      resolvedNames.push(name);
      return { topic, matchType: "exact" };
    },
    getTopicStats: async (topicId: string) => {
      statsIds.push(topicId);
      return { documentCount: 2, chunkCount: 9, lastUpdated: 1700000100000, embeddingModel: "m" };
    },
    listDocuments: (topicId: string) => {
      listDocumentsIds.push(topicId);
      return [{ id: "d1", name: "a.md", chunkCount: 5 }];
    },
  };
}

interface ListPayload {
  count: number;
  topics: Array<{ name: string; source: string; createdAt: string }>;
}

interface StatsPayload {
  chunkCount: number;
  documents: Array<Record<string, unknown> & { documentId: string }>;
}

interface ErrorPayload {
  error: { code: string; message: string };
}

function token() {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function capturedRegistration() {
  const subscriptions: Array<{ dispose(): void }> = [];
  const registered: Array<{ name: string; tool: any }> = [];
  const disposed: string[] = [];
  const registrationHost: LanguageModelToolRegistrationHost = {
    registerTool(name, tool) {
      registered.push({ name, tool });
      return { dispose: () => disposed.push(name) };
    },
    createToolResult: (content) => new mockVscode.LanguageModelToolResult(content),
    createTextPart: (value) => new mockVscode.LanguageModelTextPart(value),
  };
  const registration = TopicTool.register(
    { subscriptions } as never,
    fakeManager() as unknown as TopicManager,
    registrationHost,
  );
  return { subscriptions, registered, disposed, registration };
}

describe("VS Code ragTopic tool", function () {
  it("returns the topic list as a payload the shared executor produced", async function () {
    const manager = fakeManager();

    const payload = (await TopicTool.invoke({ action: "list" }, manager as unknown as TopicManager)) as ListPayload;

    expect(payload.count).to.equal(1);
    expect(payload.topics[0].name).to.equal("Docs");
    // Shape produced by executeTopicRead, not by this host: ISO timestamps and
    // the "local" source default are the executor's contract.
    expect(payload.topics[0].source).to.equal("local");
    expect(payload.topics[0].createdAt).to.equal(new Date(topic.createdAt).toISOString());
  });

  it("resolves stats by name and reads statistics and documents by topic id", async function () {
    const manager = fakeManager();

    const payload = (await TopicTool.invoke(
      { action: "stats", topic: "  Docs  " },
      manager as unknown as TopicManager,
    )) as StatsPayload;

    expect(manager.resolvedNames).to.deep.equal(["Docs"]);
    expect(manager.statsIds).to.deep.equal(["t1"]);
    expect(manager.listDocumentsIds).to.deep.equal(["t1"]);
    expect(payload.chunkCount).to.equal(9);
    expect(payload.documents[0].documentId).to.equal("d1");
  });

  it("surfaces an invalid stats call as a structured error instead of throwing", async function () {
    const manager = fakeManager();

    const payload = (await TopicTool.invoke(
      { action: "stats" } as never,
      manager as unknown as TopicManager,
    )) as unknown as ErrorPayload;

    expect(payload.error.code).to.equal("TOPIC_TOOL_INVALID_INPUT");
    expect(payload.error.message).to.include("topic");
    expect(manager.resolvedNames).to.deep.equal([]);
  });

  it("surfaces an over-long topic name as a structured error", async function () {
    const manager = fakeManager();

    const payload = (await TopicTool.invoke(
      { action: "stats", topic: "x".repeat(201) },
      manager as unknown as TopicManager,
    )) as unknown as ErrorPayload;

    expect(payload.error.code).to.equal("TOPIC_TOOL_INVALID_INPUT");
    expect(manager.resolvedNames).to.deep.equal([]);
  });

  // A model told "your input was invalid" when the embedding provider is down
  // will loop trying different topic names against broken infrastructure. The
  // code has to separate "fix your arguments" from "the backend is unwell".
  describe("backend failures do not masquerade as input errors", function () {
    it("reports an embedding/provider outage on the stats path as TOPIC_TOOL_FAILED", async function () {
      const manager = fakeManager();
      manager.resolveTopicByName = async () => {
        throw new Error("embedding provider unavailable");
      };

      const payload = (await TopicTool.invoke(
        { action: "stats", topic: "Docs" },
        manager as unknown as TopicManager,
      )) as unknown as ErrorPayload;

      expect(payload.error.code).to.equal("TOPIC_TOOL_FAILED");
      expect(payload.error.message).to.equal("embedding provider unavailable");
    });

    it("reports a storage failure on the list path as TOPIC_TOOL_FAILED", async function () {
      const manager = fakeManager();
      manager.getAllTopics = () => {
        throw new Error("storage unreadable");
      };

      const payload = (await TopicTool.invoke(
        { action: "list" },
        manager as unknown as TopicManager,
      )) as unknown as ErrorPayload;

      expect(payload.error.code).to.equal("TOPIC_TOOL_FAILED");
    });

    it("reports a stats-query failure as TOPIC_TOOL_FAILED", async function () {
      const manager = fakeManager();
      manager.getTopicStats = async () => {
        throw new Error("rate limited");
      };

      const payload = (await TopicTool.invoke(
        { action: "stats", topic: "Docs" },
        manager as unknown as TopicManager,
      )) as unknown as ErrorPayload;

      expect(payload.error.code).to.equal("TOPIC_TOOL_FAILED");
    });

    it("reports absent statistics as TOPIC_TOOL_FAILED", async function () {
      const manager = fakeManager();
      manager.getTopicStats = async () => null as never;

      const payload = (await TopicTool.invoke(
        { action: "stats", topic: "Docs" },
        manager as unknown as TopicManager,
      )) as unknown as ErrorPayload;

      // TopicManager.getTopicStats (packages/core/src/managers/topicManager.ts)
      // catches every internal failure, logs it, and returns null, so null is
      // what an embedding outage, a rate limit, and unreadable storage all look
      // like. Nothing about the topic argument is wrong, and telling the model
      // otherwise sends it retrying names against broken infrastructure.
      expect(payload.error.code).to.equal("TOPIC_TOOL_FAILED");
    });
  });

  describe("cancellation", function () {
    it("rejects a pre-aborted signal without touching the manager", async function () {
      const manager = fakeManager();
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));

      let caught: unknown;
      try {
        await TopicTool.invoke(
          { action: "stats", topic: "Docs" },
          manager as unknown as TopicManager,
          controller.signal,
        );
      } catch (error) {
        caught = error;
      }

      // Rethrown, not wrapped in a payload: cancellation is the host's decision,
      // not something the model should try to correct.
      expect((caught as Error).message).to.equal("cancelled");
      expect(manager.resolvedNames).to.deep.equal([]);
    });

    it("stops between resolve and stats when cancelled mid-flight", async function () {
      const manager = fakeManager();
      const controller = new AbortController();
      const resolve = manager.resolveTopicByName;
      manager.resolveTopicByName = async (name: string) => {
        const result = await resolve(name);
        controller.abort(new Error("cancelled"));
        return result;
      };

      let caught: unknown;
      try {
        await TopicTool.invoke(
          { action: "stats", topic: "Docs" },
          manager as unknown as TopicManager,
          controller.signal,
        );
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).to.equal("cancelled");
      expect(manager.statsIds).to.deep.equal([]);
    });

    it("bridges the VS Code cancellation token into the signal it forwards", async function () {
      const original = TopicTool.invoke;
      const captured: Array<AbortSignal | undefined> = [];
      let admitted!: () => void;
      const reached = new Promise<void>((resolve) => (admitted = resolve));
      (TopicTool as { invoke: unknown }).invoke = async (_input: unknown, _manager: unknown, signal?: AbortSignal) => {
        captured.push(signal);
        admitted();
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };

      try {
        const { registered } = capturedRegistration();
        const cancellation = token();
        const pending = registered[0].tool.invoke({ input: { action: "list" } }, cancellation);

        await reached;
        expect(captured[0], "a signal must reach the executor").to.be.instanceOf(AbortSignal);
        expect(captured[0]!.aborted).to.equal(false);

        cancellation.cancel();
        let caught: unknown;
        try {
          await pending;
        } catch (error) {
          caught = error;
        }

        expect(caught).to.be.instanceOf(Error);
        // Identity, not deep equality: two fresh AbortSignals are deep-equal.
        expect(captured[0]!.aborted).to.equal(true);
      } finally {
        (TopicTool as { invoke: unknown }).invoke = original;
      }
    });

    it("rejects when the token is already cancelled before invocation", async function () {
      const { registered } = capturedRegistration();
      const cancellation = token();
      cancellation.cancel();

      let caught: unknown;
      try {
        await registered[0].tool.invoke({ input: { action: "list" } }, cancellation);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).to.include("cancelled");
    });
  });

  it("registers under the contributed tool name and disposes through the subscription", function () {
    const { subscriptions, registered, disposed, registration } = capturedRegistration();

    expect(registered.map(({ name }) => name)).to.deep.equal([TOOLS.RAG_TOPIC]);
    expect(subscriptions).to.deep.equal([registration]);
    subscriptions[0].dispose();
    expect(disposed).to.deep.equal([TOOLS.RAG_TOPIC]);
  });

  it("returns pretty JSON text parts from the registered invoke", async function () {
    const { registered } = capturedRegistration();

    const result = await registered[0].tool.invoke({ input: { action: "list" } }, token());
    const text = result.content[0].value;

    expect(JSON.parse(text).count).to.equal(1);
    expect(text).to.equal(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("describes both read actions before invoking", async function () {
    const { registered } = capturedRegistration();
    const tool = registered[0].tool;

    const list = await tool.prepareInvocation({ input: { action: "list" } }, token());
    const stats = await tool.prepareInvocation({ input: { action: "stats", topic: "Docs" } }, token());

    expect(list.invocationMessage).to.include("Listing");
    expect(stats.invocationMessage).to.include("Docs");
  });
});
