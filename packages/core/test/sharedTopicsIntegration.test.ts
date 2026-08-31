/**
 * Shared topics, end to end.
 *
 * A real topic is exported to a real `.rag` archive, dropped in a folder, and
 * queried back through real LanceDB with a real embedding backend. A stubbed
 * embedder would prove nothing about whether a shared topic is queryable.
 */

import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  ArchiveFolderSource,
  EmbeddingService,
  EmbeddingServiceRegistry,
  HuggingFaceBackend,
  ModelRegistry,
  SHARED_TOPIC_CACHE_DIRNAME,
  TopicManager,
  atomicWriteJson,
  type IConfigProvider,
  type INotifier,
  type SharedTopicSource,
} from "../src/index";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

const config: IConfigProvider = {
  get<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  },
};

const notifier: INotifier = {
  showInfo: () => undefined,
  showWarning: () => undefined,
  showError: () => undefined,
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => undefined),
};

function buildEmbeddingService(): EmbeddingService {
  const service = new EmbeddingService({ config, notifier });
  service.registerBackend(new HuggingFaceBackend(ModelRegistry.getInstance(), notifier, EMBEDDING_MODEL));
  return service;
}

async function createTestTopicManager(storageDir: string, sharedTopicSources: SharedTopicSource[] = []) {
  return TopicManager.create({
    storageDir,
    config,
    notifier,
    embeddingService: buildEmbeddingService(),
    embeddingRegistry: new EmbeddingServiceRegistry({ createService: buildEmbeddingService, maxResidentLocal: 2 }),
    sharedTopicSources,
  });
}

describe("shared topics end to end", function () {
  this.timeout(300_000);

  let publisherDir: string;
  let consumerDir: string;
  let shareDir: string;

  beforeEach(async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-sharede2e-"));
    publisherDir = path.join(root, "publisher");
    consumerDir = path.join(root, "consumer");
    shareDir = path.join(root, "share");
    await fs.mkdir(shareDir, { recursive: true });
  });

  it("exports a topic, shares it, and queries it from another store", async function () {
    // 1. Publisher: build a topic with real content and export it.
    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const sourceFile = path.join(publisherDir, "guide.md");
    await fs.writeFile(sourceFile, "# Rate limits\n\nThe API allows 100 requests per minute.\n", "utf8");
    await publisher.addDocuments(topic.id, [sourceFile]);
    const archivePath = path.join(shareDir, "api-docs.rag");
    await publisher.exportTopic(topic.id, archivePath);
    await publisher.dispose();

    // 2. Consumer: a different store, with the share configured.
    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);

    const topics = consumer.getAllTopics();
    expect(topics).to.have.lengthOf(1);
    expect(topics[0].name).to.equal("API Docs");
    expect(topics[0].source).to.equal("common");
    expect(topics[0].id).to.match(/^shared-[0-9a-f]{16}$/);
    expect(consumer.isCommonTopic(topics[0].id)).to.equal(true);

    // 3. The shared topic is queryable through real LanceDB.
    const store = await consumer.getVectorStore(topics[0].id);
    expect(store).to.not.equal(null);
    const hits = await store!.similaritySearch("how many requests per minute", 3);
    expect(hits.length).to.be.greaterThan(0);
    expect(hits.map((hit) => hit.pageContent).join(" ")).to.contain("100 requests");

    // 4. The cache lives inside the consumer's storage dir.
    await fs.access(path.join(consumerDir, SHARED_TOPIC_CACHE_DIRNAME));

    await consumer.dispose();
  });

  it("disambiguates a shared topic whose name a local topic already owns", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    await publisher.exportTopic(topic.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir);
    await consumer.createTopic({ name: "API Docs" });
    await consumer.refreshSharedTopics([new ArchiveFolderSource(shareDir)]);

    const names = consumer
      .getAllTopics()
      .map((entry) => entry.name)
      .sort();
    expect(names).to.deep.equal(["API Docs", "API Docs (share)"]);

    await consumer.dispose();
  });

  it("renames a shared topic when a new local topic takes its name", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const published = await publisher.createTopic({ name: "API Docs" });
    await publisher.exportTopic(published.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    // Nothing local owns the name yet, so the share is served under it.
    expect(consumer.getAllTopics().map((entry) => entry.name)).to.deep.equal(["API Docs"]);

    await consumer.createTopic({ name: "API Docs" });

    const topics = consumer.getAllTopics();
    const local = topics.find((entry) => entry.source === "local");
    const shared = topics.find((entry) => entry.source === "common");
    expect(local?.name).to.equal("API Docs");
    expect(shared?.name).to.equal("API Docs (share)");
    // Without the post-create refresh both would still be called "API Docs",
    // and resolveTopicByName would never reach the shared one.
    const names = topics.map((entry) => entry.name);
    expect(new Set(names).size).to.equal(names.length);

    await consumer.dispose();
  });

  it("renames a shared topic when a local topic is renamed onto its name", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const published = await publisher.createTopic({ name: "API Docs" });
    await publisher.exportTopic(published.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    const local = await consumer.createTopic({ name: "Internal Notes" });
    expect(
      consumer
        .getAllTopics()
        .map((entry) => entry.name)
        .sort(),
    ).to.deep.equal(["API Docs", "Internal Notes"]);

    await consumer.updateTopic(local.id, { name: "API Docs" });

    const topics = consumer.getAllTopics();
    expect(topics.find((entry) => entry.source === "local")?.name).to.equal("API Docs");
    expect(topics.find((entry) => entry.source === "common")?.name).to.equal("API Docs (share)");
    const names = topics.map((entry) => entry.name);
    expect(new Set(names).size).to.equal(names.length);

    await consumer.dispose();
  });

  it("closes the LanceDB connection to a shared unpack that a republish retired", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const firstSource = path.join(publisherDir, "guide.md");
    await fs.writeFile(firstSource, "# Rate limits\n\nThe API allows 100 requests per minute.\n", "utf8");
    await publisher.addDocuments(topic.id, [firstSource]);
    const archivePath = path.join(shareDir, "api-docs.rag");
    await publisher.exportTopic(topic.id, archivePath);

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    const sharedId = consumer.getAllTopics()[0].id;

    // Opening the store is what makes the factory hold a connection and a table
    // against the unpack directory.
    const firstStore = await consumer.getVectorStore(sharedId);
    expect(firstStore).to.not.equal(null);

    const registry = (consumer as any).sharedTopics;
    const factory = (consumer as any).vectorStoreFactory;
    const retiredStoreDir: string = registry.getStoreDir(sharedId);
    const retiredUri = path.join(retiredStoreDir, "lancedb");
    expect(factory.connections.has(retiredUri), "connection open before republish").to.equal(true);
    expect(factory.tables.has(retiredUri), "table open before republish").to.equal(true);

    // Republish: different content means a different fingerprint, so the unpack
    // is content-addressed to a new directory and the old one is pruned.
    const secondSource = path.join(publisherDir, "quotas.md");
    await fs.writeFile(secondSource, "# Quotas\n\nBurst quota is 500 requests per hour.\n", "utf8");
    await publisher.addDocuments(topic.id, [secondSource]);
    await fs.rm(archivePath);
    await publisher.exportTopic(topic.id, archivePath);
    await publisher.dispose();

    await consumer.refreshSharedTopics();

    const currentStoreDir: string = registry.getStoreDir(sharedId);
    expect(currentStoreDir).to.not.equal(retiredStoreDir);
    // Without the targeted close, both of these stay behind until dispose() --
    // one leaked connection and table set per republish, against a directory
    // the cache has already deleted.
    expect(factory.connections.has(retiredUri), "connection closed after republish").to.equal(false);
    expect(factory.tables.has(retiredUri), "table closed after republish").to.equal(false);

    // And the topic is still served, from the new directory.
    const republishedStore = await consumer.getVectorStore(sharedId);
    expect(republishedStore).to.not.equal(null);
    const hits = await republishedStore!.similaritySearch("what is the burst quota", 4);
    expect(hits.map((hit) => hit.pageContent).join(" ")).to.contain("500 requests");

    await consumer.dispose();
  });

  it("renames a shared topic when an external process takes its name in topics.json", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const published = await publisher.createTopic({ name: "API Docs" });
    await publisher.exportTopic(published.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    expect(consumer.getAllTopics().map((entry) => entry.name)).to.deep.equal(["API Docs"]);

    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no topics-changed event within 30s")), 30_000);
      const subscription = consumer.onExternalChange((change) => {
        if (change.kind !== "topics-changed") {
          return;
        }
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      });
    });

    // A second window writing topics.json underneath us -- exactly the
    // cross-process case this feature exists for.
    await atomicWriteJson(path.join(consumerDir, "database", "topics.json"), {
      topics: {
        "topic-1700000000000-abcdef": {
          id: "topic-1700000000000-abcdef",
          name: "API Docs",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
      },
      modelName: (consumer as any).topicsIndex.modelName,
      lastUpdated: Date.now(),
    });

    await changed;

    const names = consumer
      .getAllTopics()
      .map((entry) => entry.name)
      .sort();
    // Without the watcher-side refresh both are "API Docs" and the shared one
    // is unreachable by any name resolveTopicByName can return.
    expect(names).to.deep.equal(["API Docs", "API Docs (share)"]);

    await consumer.dispose();
  });

  it("does not let dispose() drain past an in-flight share refresh", async function () {
    // A source whose scan can be held open on demand. It starts ungated so the
    // manager's own startup refresh completes normally.
    let gate: Promise<void> | null = null;
    let openGate: (() => void) | null = null;
    let scanStarted: (() => void) | null = null;
    const scanRunning = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    let scanCompleted = false;

    const gatedSource: SharedTopicSource = {
      id: "test:gated",
      label: "gated",
      resolve: async () => {
        if (gate) {
          scanStarted?.();
          await gate;
          scanCompleted = true;
        }
        return [];
      },
    };

    const consumer = await createTestTopicManager(consumerDir, [gatedSource]);

    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    // Runs the write transaction, then blocks in refreshSharedTopics.
    const creating = consumer.createTopic({ name: "API Docs" });
    await scanRunning;

    const disposing = consumer.dispose();
    const pending = await Promise.race([
      disposing.then(() => "disposed" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    // With the refresh outside runManagedOperation, the drain counter is
    // already zero here and dispose() returns while the scan is still running.
    expect(pending, "dispose() returned while a share refresh was still running").to.equal("pending");
    expect(scanCompleted).to.equal(false);

    openGate!();
    await creating;
    await disposing;
    expect(scanCompleted).to.equal(true);
  });

  it("re-unpacks a half-deleted cache entry instead of serving it empty", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const sourceFile = path.join(publisherDir, "guide.md");
    await fs.writeFile(sourceFile, "# Rate limits\n\nThe API allows 100 requests per minute.\n", "utf8");
    await publisher.addDocuments(topic.id, [sourceFile]);
    await publisher.exportTopic(topic.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    const sharedId = consumer.getAllTopics()[0].id;
    const storeDir: string = (consumer as any).sharedTopics.getStoreDir(sharedId);

    // Half of an interrupted rm -rf: topic.json survives, the table does not.
    // The archive is untouched, so the warm path would happily serve this.
    await fs.rm(path.join(storeDir, "lancedb"), { recursive: true, force: true });
    await fs.access(path.join(storeDir, "topic.json"));

    await consumer.refreshSharedTopics();

    const store = await consumer.getVectorStore(consumer.getAllTopics()[0].id);
    expect(store, "a half-deleted unpack must be rebuilt, not served empty").to.not.equal(null);
    const hits = await store!.similaritySearch("how many requests per minute", 3);
    expect(hits.length).to.be.greaterThan(0);
    expect(hits.map((hit) => hit.pageContent).join(" ")).to.contain("100 requests");

    await consumer.dispose();
  });

  it("stops serving a topic whose archive was removed", async function () {
    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const archivePath = path.join(shareDir, "api-docs.rag");
    await publisher.exportTopic(topic.id, archivePath);
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    expect(consumer.getAllTopics()).to.have.lengthOf(1);

    await fs.rm(archivePath);
    await consumer.refreshSharedTopics();

    expect(consumer.getAllTopics()).to.deep.equal([]);
    await consumer.dispose();
  });
});

describe("shared topics are read-only", function () {
  this.timeout(300_000);

  it("refuses every mutation with a typed error naming the topic", async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-sharedro-"));
    const publisherDir = path.join(root, "publisher");
    const consumerDir = path.join(root, "consumer");
    const shareDir = path.join(root, "share");
    await fs.mkdir(shareDir, { recursive: true });

    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    await publisher.exportTopic(topic.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    const sharedId = consumer.getAllTopics()[0].id;

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["deleteTopic", () => consumer.deleteTopic(sharedId)],
      ["addDocuments", () => consumer.addDocuments(sharedId, ["/tmp/whatever.md"])],
      ["removeDocument", () => consumer.removeDocument(sharedId, "doc-1")],
      ["updateTopic", () => consumer.updateTopic(sharedId, { name: "Renamed" })],
    ];

    for (const [label, attempt] of attempts) {
      let caught: unknown;
      try {
        await attempt();
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.name, label).to.equal("SharedTopicReadOnlyError");
      expect((caught as Error).message, label).to.contain("API Docs");
    }

    await consumer.dispose();
  });

  it("reports stats for a shared topic", async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-sharedstats-"));
    const publisherDir = path.join(root, "publisher");
    const consumerDir = path.join(root, "consumer");
    const shareDir = path.join(root, "share");
    await fs.mkdir(shareDir, { recursive: true });

    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const sourceFile = path.join(publisherDir, "guide.md");
    await fs.writeFile(sourceFile, "# Rate limits\n\n100 requests per minute.\n", "utf8");
    await publisher.addDocuments(topic.id, [sourceFile]);
    await publisher.exportTopic(topic.id, path.join(shareDir, "api-docs.rag"));
    await publisher.dispose();

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    const sharedId = consumer.getAllTopics()[0].id;

    const stats = await consumer.getTopicStats(sharedId);

    expect(stats).to.not.equal(null);
    expect(stats!.documentCount).to.equal(1);
    expect(stats!.chunkCount).to.be.greaterThan(0);
    await consumer.dispose();
  });

  it("still succeeds a mutation when closing a retired shared connection rejects", async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-sharedretire-"));
    const publisherDir = path.join(root, "publisher");
    const consumerDir = path.join(root, "consumer");
    const shareDir = path.join(root, "share");
    await fs.mkdir(shareDir, { recursive: true });

    const publisher = await createTestTopicManager(publisherDir);
    const topic = await publisher.createTopic({ name: "API Docs" });
    const archivePath = path.join(shareDir, "api-docs.rag");
    await publisher.exportTopic(topic.id, archivePath);

    const consumer = await createTestTopicManager(consumerDir, [new ArchiveFolderSource(shareDir)]);
    expect(consumer.getAllTopics()).to.have.lengthOf(1);

    // Republish with different content: content-addressing gives the unpack a
    // new directory, so the next refresh must retire the old one.
    const sourceFile = path.join(publisherDir, "guide.md");
    await fs.writeFile(sourceFile, "# Rate limits\n\n100 requests per minute.\n", "utf8");
    await publisher.addDocuments(topic.id, [sourceFile]);
    await fs.rm(archivePath);
    await publisher.exportTopic(topic.id, archivePath);
    await publisher.dispose();

    // A factory whose closeConnection always rejects: retirement can never
    // succeed, so this exercises the forgiving handling around it.
    (consumer as any).vectorStoreFactory.closeConnection = async () => {
      throw new Error("boom: connection refused to close");
    };

    // createTopic awaits refreshSharedTopics() on its success path, which is
    // where the republish above is noticed and the stale directory retired.
    const created = await consumer.createTopic({ name: "Local Only" });

    expect(consumer.getTopic(created.id)).to.not.equal(null);
    await consumer.dispose();
  });
});
