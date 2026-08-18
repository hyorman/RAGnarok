import { expect } from "chai";
import mockVscode from "../test-harness/setup";
import type { TopicManager } from "@ragnarok/core";
import { TopicTool, TOOLS, type TopicToolRegistrationHost } from "@ragnarok/vscode";

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

function capturedRegistration() {
  const subscriptions: Array<{ dispose(): void }> = [];
  const registered: Array<{ name: string; tool: any }> = [];
  const disposed: string[] = [];
  const registrationHost: TopicToolRegistrationHost = {
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

  it("registers under the contributed tool name and disposes through the subscription", function () {
    const { subscriptions, registered, disposed, registration } = capturedRegistration();

    expect(registered.map(({ name }) => name)).to.deep.equal([TOOLS.RAG_TOPIC]);
    expect(subscriptions).to.deep.equal([registration]);
    subscriptions[0].dispose();
    expect(disposed).to.deep.equal([TOOLS.RAG_TOPIC]);
  });

  it("returns pretty JSON text parts from the registered invoke", async function () {
    const { registered } = capturedRegistration();

    const result = await registered[0].tool.invoke({ input: { action: "list" } }, {});
    const text = result.content[0].value;

    expect(JSON.parse(text).count).to.equal(1);
    expect(text).to.equal(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("describes both read actions before invoking", async function () {
    const { registered } = capturedRegistration();
    const tool = registered[0].tool;

    const list = await tool.prepareInvocation({ input: { action: "list" } }, {});
    const stats = await tool.prepareInvocation({ input: { action: "stats", topic: "Docs" } }, {});

    expect(list.invocationMessage).to.include("Listing");
    expect(stats.invocationMessage).to.include("Docs");
  });
});
