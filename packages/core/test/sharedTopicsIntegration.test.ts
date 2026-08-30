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
