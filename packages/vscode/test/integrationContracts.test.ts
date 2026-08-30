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
import {
  COMMANDS,
  VIEWS,
  openTopicManagerWithMigration,
  wireExternalStorageChangeRefresh,
  TOOLS,
  TopicTreeItem,
  type MigrationUxDependencies,
} from "@ragnarok/vscode";

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
    statePath: "/legacy-state.json",
  };
}

function migrationDependencies(overrides: Partial<MigrationUxDependencies> = {}): MigrationUxDependencies {
  const manager = {} as any;
  return {
    createTopicManager: async () => manager,
    inspect: async () => ({ status: "legacy" }) as any,
    prepare: async () => ({ plan: legacyPlan() }) as any,
    findState: async () => null,
    apply: async () => ({}) as any,
    resume: async () => ({}) as any,
    rollback: async () => ({}) as any,
    progress: async (_resuming, task) => task(new AbortController().signal),
    showStorageFailure: async () => undefined,
    showInformation: async () => undefined,
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
    // stay sidebar commands so a human confirms them. Asserted one at a time —
    // a negated `include.members` only means "not a superset of all of them",
    // so a single leaked write action would slip through it.
    for (const writeAction of ["create", "rename", "delete", "export", "import"]) {
      expect(ragTopic.inputSchema.properties.action.enum, `${writeAction} must not be model-callable`).to.not.include(
        writeAction,
      );
    }
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

  // The sidebar half of the ragResetMemory removal: reset has to be reachable by
  // a human, so the view, its commands, its title actions, and the welcome entry
  // are all contributed. A dropped contribution is invisible to the compiler.
  it("contributes the memory sidebar section with graph, refresh, and reset actions", async function () {
    const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const views = manifest.contributes.views.ragnarok;
    const commands = manifest.contributes.commands;
    const findCommand = (id: string) => commands.find((command: any) => command.command === id);

    expect(views.map((view: any) => view.id)).to.deep.equal([VIEWS.RAG_TOPICS, VIEWS.RAG_MEMORY, VIEWS.RAG_CONFIG]);
    expect(views.find((view: any) => view.id === VIEWS.RAG_MEMORY).name).to.equal("Memory");

    expect(findCommand(COMMANDS.RESET_MEMORY)).to.include({ title: "Reset Memory", icon: "$(trash)" });
    expect(findCommand(COMMANDS.REFRESH_MEMORY)).to.include({ title: "Refresh Memory", icon: "$(refresh)" });
    // Without an icon the reused graph command cannot render as a title action.
    expect(findCommand(COMMANDS.SHOW_MEMORY_GRAPH).icon).to.match(/^\$\(.+\)$/);

    const titleActions = manifest.contributes.menus["view/title"]
      .filter((item: any) => item.when === `view == ${VIEWS.RAG_MEMORY}`)
      .map((item: any) => [item.command, item.group]);
    expect(titleActions).to.deep.equal([
      [COMMANDS.SHOW_MEMORY_GRAPH, "navigation@1"],
      [COMMANDS.REFRESH_MEMORY, "navigation@2"],
      [COMMANDS.RESET_MEMORY, "navigation@3"],
    ]);

    const welcome = manifest.contributes.viewsWelcome.find((entry: any) => entry.view === VIEWS.RAG_MEMORY);
    expect(welcome.contents).to.include(`command:${COMMANDS.SHOW_MEMORY_GRAPH}`);

    // Reset is a human action in the sidebar and never a model-callable tool.
    const toolNames = manifest.contributes.languageModelTools.map((tool: any) => tool.name);
    expect(toolNames).to.deep.equal(["ragQuery", "ragMemory", "ragTopic"]);
    expect(toolNames).to.not.include(COMMANDS.RESET_MEMORY);
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

describe("activation failure surface", function () {
  // A welcome entry with no `when`, or a stale one that still matches, renders
  // alongside the failure panel and contradicts it. The compiler sees none of
  // this, so the mutual exclusivity is asserted here.
  it("gives every view a failure panel and gates the optimistic entries behind it", async function () {
    const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const welcome = manifest.contributes.viewsWelcome;

    for (const view of [VIEWS.RAG_TOPICS, VIEWS.RAG_MEMORY]) {
      const entries = welcome.filter((entry: any) => entry.view === view);
      const failure = entries.filter((entry: any) => entry.when === "ragnarok.activationFailed");
      expect(failure, `${view} needs exactly one activation-failure panel`).to.have.lengthOf(1);
      expect(failure[0].contents).to.include("command:workbench.action.reloadWindow");
      expect(failure[0].contents).to.include("was not changed");

      for (const entry of entries.filter((candidate: any) => candidate !== failure[0])) {
        expect(entry.when, `${view} entry "${entry.contents.slice(0, 24)}" must yield to the failure panel`).to.include(
          "!ragnarok.activationFailed",
        );
      }
    }
  });
});

describe("automatic VS Code storage migration", function () {
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

  // "resumes durable state instead of applying again" moved to the proactive
  // recovery suite below, where the pre-cutover state now arrives via
  // findState rather than being rediscovered after a failed open.

  it("converts a legacy store without asking and reports where the backup went", async function () {
    let applied = 0;
    const messages: string[] = [];
    const dependencies = migrationDependencies({
      apply: async () => {
        applied++;
        return {} as any;
      },
      showInformation: async (message) => {
        messages.push(message);
      },
    });

    await openTopicManagerWithMigration("/legacy", dependencies);

    expect(applied).to.equal(1);
    // The backup path is the only route back from an unattended migration.
    expect(messages).to.have.lengthOf(1);
    expect(messages[0]).to.include("/backup");
  });

  it("surfaces plan warnings and remap counts in the reported summary", async function () {
    const plan = {
      ...legacyPlan(),
      warnings: ["Legacy knowledge graphs are not copied because their embedding identity cannot be proven."],
      remaps: [{ kind: "topic", from: "old", to: "new", reason: "namespace" }],
    };
    const messages: string[] = [];
    const dependencies = migrationDependencies({
      prepare: async () => ({ plan }) as any,
      showInformation: async (message) => {
        messages.push(message);
      },
    });

    await openTopicManagerWithMigration("/legacy", dependencies);

    expect(messages).to.have.lengthOf(1);
    expect(messages[0]).to.include("Warnings: Legacy knowledge graphs are not copied");
    expect(messages[0]).to.include("1 ID(s) were remapped");
  });

  it("reports corrupt storage without planning", async function () {
    let planned = 0;
    let failure = "";
    const dependencies = migrationDependencies({
      inspect: async () => ({ status: "current" }) as any,
      createTopicManager: async () => {
        throw new Error("corrupt topics index");
      },
      prepare: async () => {
        planned++;
        return { plan: legacyPlan() } as any;
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
    expect(failure).to.include("could not be opened safely");
    expect(failure).to.include("No data was changed");
  });

  // TopicManager.create no longer takes a session lease, so StorageLockHeldError
  // on open means only a full-exclusion migration/reset running elsewhere —
  // never a second window merely having the storage open for reads/writes.
  it("tells the loser of a two-window full-exclusion race to wait, without planning", async function () {
    let planned = 0;
    let failure = "";
    const dependencies = migrationDependencies({
      inspect: async () => ({ status: "current" }) as any,
      createTopicManager: async () => {
        throw Object.assign(new Error("locked"), { name: "StorageLockHeldError" });
      },
      prepare: async () => {
        planned++;
        return { plan: legacyPlan() } as any;
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
    expect(failure).to.equal(
      "A RAGnarōk storage migration or reset is running in another window. Wait for it to finish, then reload this window.",
    );
  });

  it("never surfaces a storage failure when createTopicManager resolves normally", async function () {
    let failureShown = false;
    const dependencies = migrationDependencies({
      inspect: async () => ({ status: "current" }) as any,
      createTopicManager: async () => ({}) as any,
      showStorageFailure: async () => {
        failureShown = true;
      },
    });

    const result = await openTopicManagerWithMigration("/legacy", dependencies);

    expect(result).to.be.an("object");
    expect(failureShown).to.equal(false);
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
        showInformation: async (message) => {
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
        expect(errorMessage).to.include("resume or retry automatically");
      }
    }
  });
});

// Activation inspects before it opens, so an interrupted migration is finished
// on the next window open instead of waiting for a hand-run CLI. Which recovery
// entry point a stage routes to is the whole safety property here: a rollback
// stage sent through resume() would re-run the forward migration over a
// half-restored tree.
describe("proactive activation recovery", function () {
  it("auto-resumes an interrupted forward migration without re-planning", async function () {
    const calls: string[] = [];
    let resumedId = "";
    const dependencies = migrationDependencies({
      inspect: async () =>
        ({
          status: "interrupted",
          migrationId: "mig-forward",
          stage: "cutoverPrepared",
          statePath: "/parent/.storage.migration-mig-forward.json",
        }) as any,
      resume: async (_dir, migrationId) => {
        calls.push("resume");
        resumedId = migrationId;
        return {} as any;
      },
      rollback: async () => {
        calls.push("rollback");
        return {} as any;
      },
      prepare: async () => {
        calls.push("prepare");
        return { plan: legacyPlan() } as any;
      },
      apply: async () => {
        calls.push("apply");
        return {} as any;
      },
    });

    const manager = await openTopicManagerWithMigration("/legacy", dependencies);

    expect(calls).to.deep.equal(["resume"]);
    expect(resumedId).to.equal("mig-forward");
    expect(manager).to.be.an("object");
  });

  it("completes an interrupted rollback with rollback(), then re-enters and migrates the restored legacy tree", async function () {
    const calls: string[] = [];
    let inspections = 0;
    const dependencies = migrationDependencies({
      inspect: async () => {
        inspections++;
        return inspections === 1
          ? ({
              status: "interrupted",
              migrationId: "mig-rollback",
              stage: "rollbackV2BackedUp",
              statePath: "/parent/.storage.migration-mig-rollback.json",
            } as any)
          : ({ status: "legacy" } as any);
      },
      resume: async () => {
        calls.push("resume");
        return {} as any;
      },
      rollback: async () => {
        calls.push("rollback");
        return {} as any;
      },
      prepare: async () => {
        calls.push("prepare");
        return { plan: legacyPlan() } as any;
      },
      apply: async () => {
        calls.push("apply");
        return {} as any;
      },
    });

    await openTopicManagerWithMigration("/legacy", dependencies);

    // Never resume(): it knows nothing about rollback stages.
    expect(calls).to.deep.equal(["rollback", "prepare", "apply"]);
    expect(inspections).to.equal(2);
  });

  it("resumes a pre-cutover state instead of starting a second migration", async function () {
    const calls: string[] = [];
    let resumedId = "";
    const dependencies = migrationDependencies({
      inspect: async () => ({ status: "legacy" }) as any,
      findState: async () =>
        ({
          state: { migrationId: "mig-staged", stage: "staged" },
          statePath: "/parent/.storage.migration-mig-staged.json",
        }) as any,
      resume: async (_dir, migrationId) => {
        calls.push("resume");
        resumedId = migrationId;
        return {} as any;
      },
      prepare: async () => {
        calls.push("prepare");
        return { plan: legacyPlan() } as any;
      },
      apply: async () => {
        calls.push("apply");
        return {} as any;
      },
    });

    await openTopicManagerWithMigration("/legacy", dependencies);

    expect(calls).to.deep.equal(["resume"]);
    expect(resumedId).to.equal("mig-staged");
  });

  it("prepares once and applies that same handle, never converting twice", async function () {
    let prepared = 0;
    const handle = { plan: legacyPlan() } as any;
    let appliedPrepared: unknown;
    const dependencies = migrationDependencies({
      findState: async () => null,
      prepare: async () => {
        prepared++;
        return handle;
      },
      apply: async (_dir, options) => {
        appliedPrepared = (options as any).prepared;
        return {} as any;
      },
    });

    await openTopicManagerWithMigration("/legacy", dependencies);

    expect(prepared).to.equal(1);
    expect(appliedPrepared).to.equal(handle);
  });

  it("names the state file when recovery fails, and lets activation fail", async function () {
    let failure = "";
    const dependencies = migrationDependencies({
      inspect: async () =>
        ({
          status: "interrupted",
          migrationId: "mig-forward",
          stage: "legacyBackedUp",
          statePath: "/parent/.storage.migration-mig-forward.json",
        }) as any,
      resume: async () => {
        throw new Error("resume exploded");
      },
      showStorageFailure: async (message) => {
        failure = message;
      },
    });

    let thrown: any;
    try {
      await openTopicManagerWithMigration("/legacy", dependencies);
      expect.fail("expected recovery failure to propagate");
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).to.equal("resume exploded");
    expect(failure).to.include("/parent/.storage.migration-mig-forward.json");
    expect(failure).to.include("mig-forward");
    expect(failure).to.include("Your data is intact");
  });

  it("tells the loser of a two-window migration race to wait rather than reporting a failure", async function () {
    let failure = "";
    const dependencies = migrationDependencies({
      apply: async () => {
        throw Object.assign(new Error("migration lock held"), {
          name: "StorageMigrationError",
          code: "MIG_BUSY",
        });
      },
      showStorageFailure: async (message) => {
        failure = message;
      },
    });

    try {
      await openTopicManagerWithMigration("/legacy", dependencies);
      expect.fail("expected the busy migration to propagate");
    } catch {
      // expected
    }

    expect(failure).to.include("Another VS Code window is migrating");
    expect(failure).to.not.include("storage migration failed");
  });
});

describe("external storage change wiring", function () {
  function fakeTopicManager() {
    let listener: ((change: { kind: "topics-changed" | "storage-unavailable" }) => void) | undefined;
    let disposed = 0;
    return {
      onExternalChange: (l: (change: { kind: "topics-changed" | "storage-unavailable" }) => void) => {
        listener = l;
        return { dispose: () => (disposed += 1) };
      },
      emit: (change: { kind: "topics-changed" | "storage-unavailable" }) => listener?.(change),
      get disposeCount() {
        return disposed;
      },
    };
  }

  it("refreshes both tree providers on topics-changed and warns only on storage-unavailable", function () {
    const manager = fakeTopicManager();
    let topicRefreshes = 0;
    let configRefreshes = 0;
    const warnings: string[] = [];

    const subscription = wireExternalStorageChangeRefresh(
      manager as any,
      { refresh: () => (topicRefreshes += 1) } as any,
      { refresh: () => (configRefreshes += 1) } as any,
      (message) => warnings.push(message),
    );

    manager.emit({ kind: "topics-changed" });
    expect(topicRefreshes).to.equal(1);
    expect(configRefreshes).to.equal(1);
    expect(warnings).to.deep.equal([]);

    manager.emit({ kind: "storage-unavailable" });
    expect(topicRefreshes).to.equal(2);
    expect(configRefreshes).to.equal(2);
    expect(warnings).to.deep.equal([
      "RAGnarōk storage is temporarily unavailable (another window is migrating or resetting it)",
    ]);

    subscription.dispose();
    expect(manager.disposeCount).to.equal(1);
  });
});

void mockVscode;
