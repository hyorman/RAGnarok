import { expect } from "chai";
import * as fs from "fs/promises";
import * as path from "path";
import mockVscode from "../test-harness/setup";
import {
  RetrievalStrategy,
  RAG_MEMORY_INPUT_SCHEMA,
  RAG_QUERY_INPUT_SCHEMA,
  RAG_TOPIC_READ_INPUT_SCHEMA,
  TOOL_LIMITS,
} from "@ragnarok/core";
import { openTopicManagerWithMigration, TOOLS, TopicTreeItem, type MigrationUxDependencies } from "@ragnarok/vscode";

function legacyPlan(): any {
  return {
    dryRun: true,
    migrationId: "migration-id",
    sourcePath: "/legacy",
    layout: "v0.3-local",
    inventory: { files: [], totalBytes: 10, digest: "digest" },
    topics: [{ sourceTopicId: "old", targetTopicId: "new", leafDocumentCount: 2, chunkCount: 3 }],
    remaps: [],
    warnings: [],
    unsupported: [],
    graphRebuildRequired: [],
    requiredBytes: 20,
    availableBytes: 100,
    backupPath: "/backup",
    stagingPath: "/stage",
  };
}

function migrationDependencies(overrides: Partial<MigrationUxDependencies> = {}): MigrationUxDependencies {
  const manager = {} as any;
  let creates = 0;
  return {
    createTopicManager: async () => {
      creates++;
      if (creates === 1) {
        throw new Error("non-empty unversioned RAGnarōk storage");
      }
      return manager;
    },
    plan: async () => legacyPlan(),
    status: async () => ({ plan: legacyPlan() }),
    apply: async () => ({}) as any,
    resume: async () => ({}) as any,
    choose: async () => "migrate",
    progress: async (_resuming, task) => task(new AbortController().signal),
    showStorageFailure: async () => undefined,
    showCancellation: async () => undefined,
    ...overrides,
  };
}

describe("VS Code contribution and tree contracts", function () {
  it("keeps native memory tool manifests aligned with runtime names and MCP limits", async function () {
    const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const contributedNames = manifest.contributes.languageModelTools.map((tool: any) => tool.name);
    const memory = manifest.contributes.languageModelTools.find((tool: any) => tool.name === TOOLS.RAG_MEMORY);

    expect(contributedNames).to.have.members(Object.values(TOOLS));
    expect(contributedNames).to.deep.equal(["ragQuery", "ragMemory", "ragTopic"]);
    // Destructive memory reset is a sidebar action, never a model-callable tool.
    expect(contributedNames).to.not.include("ragResetMemory");
    expect(memory.inputSchema.required).to.deep.equal(["action"]);
    expect(memory.inputSchema.properties.action.enum).to.deep.equal([
      "store",
      "recall",
      "forget",
      "stats",
      "list",
      "decay",
      "history",
      "promote",
      "links",
      "communities",
    ]);
    expect(memory.inputSchema.properties.content.maxLength).to.equal(50_000);
    expect(memory.inputSchema.properties.topK).to.include({ minimum: 1, maximum: 50 });
    expect(memory.inputSchema.properties.olderThan).to.include({ minimum: 1, maximum: 3650 });
    expect(memory.inputSchema.properties.branch.maxLength).to.equal(255);
    expect(memory.inputSchema.properties.tags).to.include({ maxItems: 20 });
    expect(memory.inputSchema.properties.tags.items.maxLength).to.equal(100);
    expect(memory.inputSchema.properties.ttlDays.maximum).to.equal(3650);
    expect(memory.inputSchema.properties.ids.maxItems).to.equal(500);
    expect(memory.inputSchema.properties.limit).to.include({ minimum: 1, maximum: 500 });
  });

  it("contributes the manifest the generator produces from the shared contracts", async function () {
    const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const tools = manifest.contributes.languageModelTools;
    const ragTopic = tools.find((tool: any) => tool.name === TOOLS.RAG_TOPIC);

    expect(ragTopic.inputSchema).to.deep.equal(RAG_TOPIC_READ_INPUT_SCHEMA);
    expect(ragTopic.inputSchema.properties.action.enum).to.deep.equal(["list", "stats"]);
    expect(ragTopic.inputSchema.properties.topic.maxLength).to.equal(TOOL_LIMITS.topicName);
    // Read-only by construction: the write actions the MCP rag_topic tool offers
    // stay sidebar commands so a human confirms them.
    expect(ragTopic.inputSchema.properties.action.enum).to.not.include.members(["create", "rename", "delete"]);
    expect(ragTopic.modelDescription).to.include("Read-only");
    expect(ragTopic.toolReferenceName).to.equal(TOOLS.RAG_TOPIC);
    expect(ragTopic.canBeReferencedInPrompt).to.equal(true);

    const ragQuery = tools.find((tool: any) => tool.name === TOOLS.RAG_QUERY);
    expect(ragQuery.inputSchema).to.deep.equal(RAG_QUERY_INPUT_SCHEMA);
    // The canonical empty-topic payload carries no agenticMetadata, so the old
    // "always check ... agenticMetadata" instruction must not come back.
    expect(ragQuery.modelDescription).to.not.include("agenticMetadata");

    const ragMemory = tools.find((tool: any) => tool.name === TOOLS.RAG_MEMORY);
    expect(ragMemory.inputSchema).to.deep.equal(RAG_MEMORY_INPUT_SCHEMA);

    for (const tool of tools) {
      expect(tool.userDescription, `${tool.name} userDescription`).to.be.a("string").and.not.empty;
      expect(tool.icon, `${tool.name} icon`).to.match(/^\$\(.+\)$/);
    }
  });

  it("declares the same three retrieval strategies in settings, LM tool schema, and tree labels", async function () {
    const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const expected = Object.values(RetrievalStrategy);
    const setting = manifest.contributes.configuration.properties["ragnarok.retrievalStrategy"];
    const tool = manifest.contributes.languageModelTools.find((candidate: any) => candidate.name === "ragQuery");

    expect(setting.enum).to.have.members(expected);
    expect(tool.inputSchema.properties.retrievalStrategy.enum).to.have.members(expected);
    expect(setting.enumDescriptions).to.have.length(expected.length);
    expect(setting.markdownDescription).to.include("bm25");
    expect(tool.inputSchema.properties.retrievalStrategy.description).to.include("bm25");

    const bm25 = new TopicTreeItem({ key: "retrieval-strategy", value: RetrievalStrategy.BM25 } as any, "config-item");
    const vector = new TopicTreeItem(
      { key: "retrieval-strategy", value: RetrievalStrategy.VECTOR } as any,
      "config-item",
    );
    expect(String(bm25.label)).to.include("BM25");
    expect(String(vector.label)).to.include("Vector");
  });

  it("keeps topic labels and read-only descriptions stable", function () {
    const local = new TopicTreeItem(
      { id: "local", name: "Local", documentCount: 1, createdAt: 0, updatedAt: 0 } as any,
      "topic",
    );
    const common = new TopicTreeItem(
      { id: "common", name: "Common", documentCount: 2, createdAt: 0, updatedAt: 0, source: "common" } as any,
      "topic",
    );
    expect(local.label).to.equal("Local");
    expect(local.description).to.equal("1 document");
    expect(common.description).to.equal("2 documents (read-only)");
    expect(common.contextValue).to.equal("topic-common");
  });
});

describe("guided VS Code storage migration UX", function () {
  it("applies a previewed migration and opens the converted manager", async function () {
    let appliedSignal: AbortSignal | undefined;
    const dependencies = migrationDependencies({
      apply: async (_storage, options) => {
        appliedSignal = options.signal;
        return {} as any;
      },
    });
    const result = await openTopicManagerWithMigration("/legacy", dependencies);
    expect(result).to.be.an("object");
    expect(appliedSignal?.aborted).to.equal(false);
  });

  it("resumes durable state instead of applying again", async function () {
    let resumed = 0;
    let applied = 0;
    const dependencies = migrationDependencies({
      status: async () => ({ plan: legacyPlan(), state: { stage: "staged" } as any }),
      resume: async () => {
        resumed++;
        return {} as any;
      },
      apply: async () => {
        applied++;
        return {} as any;
      },
    });
    await openTopicManagerWithMigration("/legacy", dependencies);
    expect(resumed).to.equal(1);
    expect(applied).to.equal(0);
  });

  it("leaves storage untouched when the user cancels", async function () {
    let applied = 0;
    let cancellationMessage = "";
    const dependencies = migrationDependencies({
      choose: async () => "cancel",
      apply: async () => {
        applied++;
        return {} as any;
      },
      showCancellation: async (message) => {
        cancellationMessage = message;
      },
    });
    try {
      await openTopicManagerWithMigration("/legacy", dependencies);
      expect.fail("expected cancellation");
    } catch (error) {
      expect((error as Error).message).to.include("unversioned");
    }
    expect(applied).to.equal(0);
    expect(cancellationMessage).to.include("No data was changed");
  });

  it("reports corrupt storage and two-window lease failures without planning", async function () {
    for (const [error, expected] of [
      [new Error("corrupt topics index"), "could not be opened safely"],
      [Object.assign(new Error("locked by another RAGnarōk process"), { name: "StorageLockHeldError" }), "another"],
    ] as const) {
      let planned = 0;
      let failure = "";
      const dependencies = migrationDependencies({
        createTopicManager: async () => {
          throw error;
        },
        plan: async () => {
          planned++;
          return legacyPlan();
        },
        showStorageFailure: async (message) => {
          failure = message;
        },
      });
      try {
        await openTopicManagerWithMigration("/legacy", dependencies);
        expect.fail("expected storage failure");
      } catch {
        // expected
      }
      expect(planned).to.equal(0);
      expect(failure).to.include(expected);
      expect(failure).to.include("No data was changed");
    }
  });

  it("surfaces apply failure and cancellation before cutover", async function () {
    for (const failure of [new Error("conversion failed"), new Error("Storage migration cancelled before cutover")]) {
      let errorMessage = "";
      let cancellationMessage = "";
      const dependencies = migrationDependencies({
        apply: async () => {
          throw failure;
        },
        showStorageFailure: async (message) => {
          errorMessage = message;
        },
        showCancellation: async (message) => {
          cancellationMessage = message;
        },
      });
      try {
        await openTopicManagerWithMigration("/legacy", dependencies);
        expect.fail("expected migration failure");
      } catch {
        // expected
      }
      if (failure.message.includes("cancelled")) {
        expect(cancellationMessage).to.include("before cutover");
        expect(errorMessage).to.equal("");
      } else {
        expect(errorMessage).to.include("Inspect migration status");
      }
    }
  });
});

void mockVscode;
