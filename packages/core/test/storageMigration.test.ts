import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { connect } from "@lancedb/lancedb";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  EmbeddingReindexRequiredError,
  MIGRATION_REPORT_FILENAME,
  STORAGE_FORMAT_FILENAME,
  StorageMigrationError,
  applyStorageMigration,
  ensureStorageFormatV2,
  getStorageMigrationStatus,
  planStorageMigration,
  resumeStorageMigration,
  rollbackStorageMigration,
  TopicManager,
  VectorStoreFactory,
  type IConfigProvider,
  type INotifier,
} from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";

interface Fixture {
  storageDir: string;
  databaseDir: string;
  topicId: string;
}

async function writeLegacyFixture(parent: string, common = false): Promise<Fixture> {
  const storageDir = path.join(parent, common ? "shared-kb" : "global-storage");
  const databaseDir = common ? storageDir : path.join(storageDir, "database");
  const topicId = "topic-legacy";
  await fs.mkdir(path.join(databaseDir, "lancedb"), { recursive: true });
  const topics = {
    topics: {
      [topicId]: {
        id: topicId,
        name: "Legacy",
        description: "A v0.3 fixture",
        createdAt: 100,
        updatedAt: 200,
        documentCount: 1,
      },
    },
    modelName: "Xenova/all-MiniLM-L6-v2",
    lastUpdated: 200,
  };
  await fs.writeFile(path.join(databaseDir, "topics.json"), JSON.stringify(topics));
  await fs.writeFile(
    path.join(databaseDir, `topic-${topicId}-documents.json`),
    JSON.stringify([
      {
        id: "old-container",
        topicId,
        name: "docs",
        filePath: path.join(parent, "docs"),
        fileType: "markdown",
        addedAt: 123,
        chunkCount: 3,
      },
    ]),
  );
  await fs.writeFile(
    path.join(databaseDir, `vector-${topicId}-metadata.json`),
    JSON.stringify({
      topicId,
      documentCount: 1,
      chunkCount: 3,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      createdAt: 100,
      updatedAt: 200,
    }),
  );
  const db = await connect(path.join(databaseDir, "lancedb"));
  await db.createTable(topicId, [
    {
      vector: [1, 0, 0],
      text: "alpha one",
      source: path.join(parent, "docs", "a.md"),
      fileName: "a.md",
      filePath: path.join(parent, "docs", "a.md"),
      fileType: "markdown",
      fileSize: 10,
      loadedAt: 123,
      chunkIndex: 0,
      totalChunks: 2,
      loc_lines_from: 1,
      loc_lines_to: 2,
      isMarkdown: true,
      preserveStructure: true,
    },
    {
      vector: [0.9, 0.1, 0],
      text: "alpha two",
      source: path.join(parent, "docs", "a.md"),
      fileName: "a.md",
      filePath: path.join(parent, "docs", "a.md"),
      fileType: "markdown",
      fileSize: 10,
      loadedAt: 123,
      chunkIndex: 1,
      totalChunks: 2,
      loc_lines_from: 3,
      loc_lines_to: 4,
      isMarkdown: true,
      preserveStructure: true,
    },
    {
      vector: [0, 1, 0],
      text: "beta",
      source: path.join(parent, "docs", "b.txt"),
      fileName: "b.txt",
      filePath: path.join(parent, "docs", "b.txt"),
      fileType: "text",
      fileSize: 5,
      loadedAt: 124,
      chunkIndex: 0,
      totalChunks: 1,
      loc_lines_from: 1,
      loc_lines_to: 1,
      isMarkdown: false,
      preserveStructure: false,
    },
  ]);
  db.close();
  return { storageDir, databaseDir, topicId };
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected action to reject");
}

async function makeTreeWritable(root: string): Promise<void> {
  let entries: Array<import("fs").Dirent>;
  try {
    await fs.chmod(root, 0o700);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeTreeWritable(candidate);
    } else {
      await fs.chmod(candidate, 0o600).catch(() => undefined);
    }
  }
}

describe("offline v0.3 storage migration", function () {
  let parent: string;

  beforeEach(async function () {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-migration-"));
  });

  afterEach(async function () {
    await makeTreeWritable(parent);
    await fs.rm(parent, { recursive: true, force: true });
  });

  it("produces a complete zero-write dry run, including stable mtimes and disk/collision paths", async function () {
    const fixture = await writeLegacyFixture(parent);
    const before = await planStorageMigration(fixture.storageDir);
    const after = await planStorageMigration(fixture.storageDir);

    expect(before.layout).to.equal("v0.3-local");
    expect(before.sourceVersion).to.equal("0.3");
    expect(before.topics).to.have.length(1);
    expect(before.topics[0]).to.include({
      legacyDocumentCount: 1,
      leafDocumentCount: 2,
      chunkCount: 3,
      vectorDimension: 3,
    });
    expect(before.availableBytes).to.be.greaterThan(0);
    expect(before.backupPath).to.include("backup-v0.3-");
    expect(after.inventory).to.deep.equal(before.inventory);
    expect(await fs.readdir(parent)).to.deep.equal(["global-storage"]);
  });

  it("stages, validates, and atomically cuts over to per-leaf v2 data with an immutable backup", async function () {
    const fixture = await writeLegacyFixture(parent);
    const plan = await planStorageMigration(fixture.storageDir);
    const report = await applyStorageMigration(fixture.storageDir, {
      nonInteractive: true,
      acceptedBackupPath: plan.backupPath,
    });

    expect(report.validation).to.include({
      topics: 1,
      documents: 2,
      chunks: 3,
      contentDigestsMatched: true,
      vectorDimensionsValid: true,
      referentialIntegrityValid: true,
      nativeQuerySmokePassed: true,
    });
    expect(JSON.parse(await fs.readFile(path.join(fixture.storageDir, STORAGE_FORMAT_FILENAME), "utf8"))).to.include({
      formatVersion: 2,
      migrationId: plan.migrationId,
    });
    const documents = JSON.parse(
      await fs.readFile(path.join(fixture.storageDir, "database", `topic-${fixture.topicId}-documents.json`), "utf8"),
    );
    expect(documents).to.have.length(2);
    expect(documents.map((document: any) => document.chunkCount)).to.have.members([2, 1]);
    expect(new Set(documents.map((document: any) => document.id)).size).to.equal(2);
    expect(documents.every((document: any) => document.canonicalSource && document.sourceRevision)).to.equal(true);
    const metadata = JSON.parse(
      await fs.readFile(path.join(fixture.storageDir, "database", `vector-${fixture.topicId}-metadata.json`), "utf8"),
    );
    expect(metadata).to.include({
      schemaVersion: 2,
      chunkCount: 3,
      embeddingBackend: "",
      migrationRequiresFingerprintOnReindex: true,
    });
    expect(metadata).not.to.have.property("embeddingFingerprint");
    await fs.access(path.join(fixture.storageDir, MIGRATION_REPORT_FILENAME));
    await fs.access(plan.backupPath);
    await fs.access(`${plan.backupPath}.inventory.json`);

    const db = await connect(path.join(fixture.storageDir, "database", "lancedb"));
    const table = await db.openTable(fixture.topicId);
    const rows = await table.query().limit(10).toArray();
    expect(rows).to.have.length(3);
    expect(rows.every((row: any) => row.document_id && row.chunk_id)).to.equal(true);
    table.close();
    db.close();

    const embeddingService = {
      getCurrentModel: () => "Xenova/all-MiniLM-L6-v2",
      getFingerprint: async () => ({
        backendKind: "huggingface",
        model: "Xenova/all-MiniLM-L6-v2",
        dimension: 3,
        normalized: true,
      }),
    } as unknown as EmbeddingService;
    const config: IConfigProvider = { get: <T>(_key: string, fallback: T) => fallback };
    const notifier: INotifier = {
      showInfo: () => undefined,
      showWarning: () => undefined,
      showError: () => undefined,
      withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>) =>
        task(() => undefined),
    };
    const Manager = TopicManager as unknown as new (options: {
      storageDir: string;
      config: IConfigProvider;
      notifier: INotifier;
      embeddingService: EmbeddingService;
    }) => TopicManager;
    const manager = new Manager({ storageDir: fixture.storageDir, config, notifier, embeddingService });
    (manager as any).topicsIndex = JSON.parse(
      await fs.readFile(path.join(fixture.storageDir, "database", "topics.json"), "utf8"),
    );
    (manager as any).topicDocuments = new Map([
      [fixture.topicId, new Map(documents.map((document: any) => [document.id, document]))],
    ]);
    const vectorStoreFactory = new VectorStoreFactory(
      path.join(fixture.storageDir, "database"),
      "Xenova/all-MiniLM-L6-v2",
      embeddingService,
    );
    (manager as any).vectorStoreFactory = vectorStoreFactory;
    try {
      await vectorStoreFactory.reconcileDocuments(fixture.topicId, [
        new LangChainDocument({
          pageContent: "must not be mixed into unverifiable vectors",
          metadata: { documentId: "new-document", chunkId: "new-chunk" },
        }),
      ]);
      expect.fail("expected migrated-vector quarantine");
    } catch (error) {
      expect(error).to.be.instanceOf(EmbeddingReindexRequiredError);
    }
    const removed = await manager.removeDocument(fixture.topicId, documents[0].id);
    expect(removed.chunksRemoved).to.be.greaterThan(0);
    const archivePath = path.join(parent, "migrated-topic.rag");
    await manager.exportTopic(fixture.topicId, archivePath);
    expect((await fs.stat(archivePath)).size).to.be.greaterThan(0);
    vectorStoreFactory.dispose();
  });

  it("deterministically namespaces flat v0.3 common-database topic IDs", async function () {
    const fixture = await writeLegacyFixture(parent, true);
    const plan = await planStorageMigration(fixture.storageDir);
    expect(plan.layout).to.equal("v0.3-common");
    const topicRemap = plan.remaps.find((remap) => remap.kind === "topic")!;
    expect(topicRemap).to.include({ kind: "topic", from: fixture.topicId });
    expect(topicRemap.to).to.match(/^common-[a-f0-9]{40}$/);

    await applyStorageMigration(fixture.storageDir, {
      nonInteractive: true,
      acceptedBackupPath: plan.backupPath,
    });
    const index = JSON.parse(await fs.readFile(path.join(fixture.storageDir, "database", "topics.json"), "utf8"));
    expect(Object.keys(index.topics)).to.deep.equal([topicRemap.to]);
  });

  it("marks unverifiable legacy graphs for rebuild and never copies their tables", async function () {
    const fixture = await writeLegacyFixture(parent);
    const db = await connect(path.join(fixture.databaseDir, "lancedb"));
    await db.createTable(`kg-entities-${fixture.topicId}`, [
      { id: "legacy-entity", name: "Legacy", vector: [1, 0, 0] },
    ]);
    db.close();
    const plan = await planStorageMigration(fixture.storageDir);
    expect(plan.topics[0].graphRebuildRequired).to.equal(true);
    expect(plan.warnings.some((warning) => warning.includes("knowledge graphs"))).to.equal(true);
    await applyStorageMigration(fixture.storageDir, {
      nonInteractive: true,
      acceptedBackupPath: plan.backupPath,
    });
    const migratedDb = await connect(path.join(fixture.storageDir, "database", "lancedb"));
    expect(await migratedDb.tableNames()).not.to.include(`kg-entities-${fixture.topicId}`);
    migratedDb.close();
  });

  it("fails closed on malformed, partial, and unknown layouts without writing migration state", async function () {
    const storageDir = path.join(parent, "bad");
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "database", "topics.json"), '{"topics":');
    const malformed = await captureError(() => planStorageMigration(storageDir));
    expect(malformed).to.be.instanceOf(StorageMigrationError);
    expect((malformed as StorageMigrationError).code).to.equal("MIG_CORRUPT");
    expect((await fs.readdir(parent)).filter((entry) => entry.includes("migration-"))).to.deep.equal([]);

    await fs.writeFile(
      path.join(storageDir, "database", "topics.json"),
      JSON.stringify({
        topics: {},
        modelName: "model",
        lastUpdated: 1,
      }),
    );
    await fs.writeFile(path.join(storageDir, "unknown.bin"), "do not overwrite");
    const plan = await planStorageMigration(storageDir);
    expect(plan.unsupported).to.deep.equal(["unknown.bin"]);
    const rejected = await captureError(() =>
      applyStorageMigration(storageDir, {
        nonInteractive: true,
        acceptedBackupPath: plan.backupPath,
      }),
    );
    expect((rejected as StorageMigrationError).code).to.equal("MIG_UNSUPPORTED");
    expect(await fs.readFile(path.join(storageDir, "unknown.bin"), "utf8")).to.equal("do not overwrite");
  });

  it("resumes idempotently after failures at planned and staged boundaries", async function () {
    for (const failAfterStage of ["planned", "staged", "validated"] as const) {
      const fixtureParent = path.join(parent, failAfterStage);
      await fs.mkdir(fixtureParent);
      const fixture = await writeLegacyFixture(fixtureParent);
      const plan = await planStorageMigration(fixture.storageDir);
      await captureError(() =>
        applyStorageMigration(fixture.storageDir, {
          nonInteractive: true,
          acceptedBackupPath: plan.backupPath,
          failAfterStage,
        }),
      );
      const status = await getStorageMigrationStatus(fixture.storageDir, plan.migrationId);
      expect(status.state?.stage).to.equal(failAfterStage);
      const report = await resumeStorageMigration(fixture.storageDir, plan.migrationId);
      expect(report.migrationId).to.equal(plan.migrationId);
      expect((await getStorageMigrationStatus(fixture.storageDir, plan.migrationId)).state?.stage).to.equal(
        "committed",
      );
      expect((await resumeStorageMigration(fixture.storageDir, plan.migrationId)).migrationId).to.equal(
        plan.migrationId,
      );
    }
  });

  it("persists cutover intent, blocks normal initialization, and resumes every rename boundary", async function () {
    for (const failAfterStage of ["cutoverPrepared", "legacyBackedUp", "v2Published"] as const) {
      const fixtureParent = path.join(parent, failAfterStage);
      await fs.mkdir(fixtureParent);
      const fixture = await writeLegacyFixture(fixtureParent);
      const plan = await planStorageMigration(fixture.storageDir);

      await captureError(() =>
        applyStorageMigration(fixture.storageDir, {
          nonInteractive: true,
          acceptedBackupPath: plan.backupPath,
          failAfterStage,
        }),
      );
      expect((await getStorageMigrationStatus(fixture.storageDir, plan.migrationId)).state?.stage).to.equal(
        failAfterStage,
      );
      const startupError = await captureError(() => ensureStorageFormatV2(fixture.storageDir));
      expect(startupError.message).to.include("is interrupted");
      expect(startupError.message).to.include("resume");

      const report = await resumeStorageMigration(fixture.storageDir, plan.migrationId);
      expect(report.migrationId).to.equal(plan.migrationId);
      expect((await getStorageMigrationStatus(fixture.storageDir, plan.migrationId)).state?.stage).to.equal(
        "committed",
      );
    }
  });

  it("rollback preserves subsequent v2 data in a new backup and retains the immutable legacy backup", async function () {
    const fixture = await writeLegacyFixture(parent);
    const originalTopics = await fs.readFile(path.join(fixture.databaseDir, "topics.json"), "utf8");
    const plan = await planStorageMigration(fixture.storageDir);
    await applyStorageMigration(fixture.storageDir, {
      nonInteractive: true,
      acceptedBackupPath: plan.backupPath,
    });
    await fs.writeFile(path.join(fixture.storageDir, "post-migration-v2-data.txt"), "must survive rollback");

    const state = await rollbackStorageMigration(fixture.storageDir, plan.migrationId);
    expect(state.stage).to.equal("rolledBack");
    expect(state.currentV2BackupPath).to.be.a("string");
    expect(await fs.readFile(path.join(state.currentV2BackupPath!, "post-migration-v2-data.txt"), "utf8")).to.equal(
      "must survive rollback",
    );
    expect(await fs.readFile(path.join(fixture.storageDir, "database", "topics.json"), "utf8")).to.equal(
      originalTopics,
    );
    await fs.access(plan.backupPath);
    expect(await fs.stat(plan.backupPath)).to.satisfy((stat: any) => stat.isDirectory());
  });

  it("persists rollback intent and resumes every namespace rename boundary", async function () {
    for (const failAfterStage of ["rollbackPrepared", "rollbackV2BackedUp", "rollbackLegacyPublished"] as const) {
      const fixtureParent = path.join(parent, failAfterStage);
      await fs.mkdir(fixtureParent);
      const fixture = await writeLegacyFixture(fixtureParent);
      const plan = await planStorageMigration(fixture.storageDir);
      await applyStorageMigration(fixture.storageDir, {
        nonInteractive: true,
        acceptedBackupPath: plan.backupPath,
      });
      await fs.writeFile(path.join(fixture.storageDir, "post-migration-v2-data.txt"), failAfterStage);

      await captureError(() => rollbackStorageMigration(fixture.storageDir, plan.migrationId, { failAfterStage }));
      expect((await getStorageMigrationStatus(fixture.storageDir, plan.migrationId)).state?.stage).to.equal(
        failAfterStage,
      );
      const startupError = await captureError(() => ensureStorageFormatV2(fixture.storageDir));
      expect(startupError.message).to.include("is interrupted");

      const state = await rollbackStorageMigration(fixture.storageDir, plan.migrationId);
      expect(state.stage).to.equal("rolledBack");
      expect(await fs.readFile(path.join(state.currentV2BackupPath!, "post-migration-v2-data.txt"), "utf8")).to.equal(
        failAfterStage,
      );
      await fs.access(path.join(fixture.storageDir, "database", "topics.json"));
    }
  });

  it("reconciles rollback crashes after namespace renames but before their state writes", async function () {
    for (const failAfterStage of ["rollbackV2Renamed", "rollbackLegacyRenamed"] as const) {
      const fixtureParent = path.join(parent, failAfterStage);
      await fs.mkdir(fixtureParent);
      const fixture = await writeLegacyFixture(fixtureParent);
      const plan = await planStorageMigration(fixture.storageDir);
      await applyStorageMigration(fixture.storageDir, {
        nonInteractive: true,
        acceptedBackupPath: plan.backupPath,
      });
      await fs.writeFile(path.join(fixture.storageDir, "post-migration-v2-data.txt"), failAfterStage);

      await captureError(() => rollbackStorageMigration(fixture.storageDir, plan.migrationId, { failAfterStage }));
      const interrupted = (await getStorageMigrationStatus(fixture.storageDir, plan.migrationId)).state!;
      expect(interrupted.stage).to.equal(
        failAfterStage === "rollbackV2Renamed" ? "rollbackPrepared" : "rollbackV2BackedUp",
      );

      const state = await rollbackStorageMigration(fixture.storageDir, plan.migrationId);
      expect(state.stage).to.equal("rolledBack");
      expect(await fs.readFile(path.join(state.currentV2BackupPath!, "post-migration-v2-data.txt"), "utf8")).to.equal(
        failAfterStage,
      );
      await fs.access(path.join(fixture.storageDir, "database", "topics.json"));
    }
  });

  it("exposes machine-readable standalone CLI dry-run and stable exit semantics", async function () {
    const storageDir = path.join(parent, "cli-empty");
    await fs.mkdir(storageDir);
    const cliPath = path.resolve(__dirname, "../src/migrationCli.js");
    const execution = await promisify(execFile)(process.execPath, [
      cliPath,
      "migrate",
      "--storage",
      storageDir,
      "--dry-run",
      "--json",
    ]);
    const response = JSON.parse(execution.stdout);
    expect(response).to.include({ ok: true, command: "dry-run" });
    expect(response.result.layout).to.equal("empty");
    expect(await fs.readdir(storageDir)).to.deep.equal([]);

    let rejected: any;
    try {
      await promisify(execFile)(process.execPath, [cliPath, "migrate", "--storage", storageDir, "--apply", "--json"]);
    } catch (error) {
      rejected = error;
    }
    expect(rejected?.code).to.equal(33);
    expect(JSON.parse(rejected.stdout).error.code).to.equal("MIG_CONFIRMATION");
  });
});
