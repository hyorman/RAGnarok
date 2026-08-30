import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  TopicManager,
  VectorStoreFactory,
  VectorStoreLoadError,
  type IConfigProvider,
  type INotifier,
} from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../src/embeddings/embeddingServiceRegistry";
import type { PipelineOptions, PipelineResult } from "../src/managers/documentPipeline";
import {
  StorageTransactionCoordinator,
  type StorageTransactionOperation,
} from "../src/utils/storageTransactionCoordinator";

const LOCK_FILENAME = ".ragnarok.lock";

// Compiled tests live in packages/core/dist-test/test; fixtures are package-local under test/fixtures.
const FIXTURES_DIR = path.join(__dirname, "../../test/fixtures");
function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

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

function stubEmbeddingService(): EmbeddingService {
  return {
    initialize: async () => undefined,
    getCurrentModel: () => "test-model",
    dispose: () => undefined,
    // Only used to stamp a vector store's metadata on creation; no actual
    // embedding call is exercised by these tests.
    getFingerprint: async () => ({
      backendKind: "huggingface",
      providerFormat: "huggingface",
      model: "test-model",
      revision: "unknown",
      dimension: 4,
      endpointHash: "local",
    }),
    isBackendAvailable: async () => true,
  } as unknown as EmbeddingService;
}

function stubEmbeddingRegistry(): EmbeddingServiceRegistry {
  return {
    // Resolved but never invoked: these tests never embed real text.
    get: async () => stubEmbeddingService(),
  } as unknown as EmbeddingServiceRegistry;
}

/**
 * Leave a real interrupted transaction on disk: `replacement` is published
 * over `destination`, but the commit record is never written, so the WAL stays
 * in the `prepared` state with the pre-image sitting in its backup directory.
 *
 * The prepared state is reached by driving the real coordinator rather than
 * hand-writing a checksummed WAL. Losing the fence right after the publication
 * is what stops the coordinator from rolling back on its own — a fenced owner
 * must stop touching storage and leave recovery to the next lease holder.
 */
async function abandonPreparedIndexReplacement(
  databaseDir: string,
  destination: string,
  replacement: unknown,
): Promise<void> {
  let fenced = false;
  const coordinator = new StorageTransactionCoordinator(databaseDir, {
    ownerId: "interrupted-writer",
    assertOwned: async () => {
      if (fenced) {
        throw new Error("storage lease ownership was lost");
      }
    },
  });
  await coordinator.initialize();

  const internals = coordinator as unknown as { applyPrepared: (record: unknown) => Promise<void> };
  const realApplyPrepared = internals.applyPrepared.bind(coordinator);
  internals.applyPrepared = async (record: unknown) => {
    await realApplyPrepared(record);
    fenced = true;
  };

  const source = path.join(databaseDir, ".prepared-index-fixture.json");
  await fs.writeFile(source, JSON.stringify(replacement));
  const operations: StorageTransactionOperation[] = [{ type: "replace", source, destination }];
  try {
    await coordinator.commit("fixture-interrupted-replace", operations);
    throw new Error("the fixture transaction should not have committed");
  } catch (error: any) {
    if (!String(error?.message).includes("ownership was lost")) {
      throw error;
    }
  } finally {
    await fs.rm(source, { force: true });
  }
}

async function lockFileGone(storageDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(storageDir, LOCK_FILENAME));
    return false;
  } catch {
    return true;
  }
}

/**
 * Stand in for the real document pipeline: no chunking, no embedding, no
 * writes to the vector store. Just enough to drive addDocuments/addSources
 * through the metadata/journal side of ingestion so lease behaviour can be
 * observed without a real embedding backend.
 *
 * `onProcessing` runs from inside `processDocument`, mid-call — the seam a
 * multi-file test uses to observe the lease that must still be held there.
 */
function installFakeDocumentPipeline(manager: TopicManager, onProcessing?: () => Promise<void>): void {
  (manager as any).documentPipeline = {
    processDocument: async (
      filePath: string,
      _topicId: string,
      _options: PipelineOptions,
    ): Promise<PipelineResult> => {
      await onProcessing?.();
      const documentId = `doc-${path.basename(filePath)}`;
      return {
        success: true,
        stages: { loading: true, chunking: true, extracting: false, embedding: true, storing: true },
        metadata: {
          originalDocuments: 1,
          chunksCreated: 1,
          chunksEmbedded: 1,
          chunksStored: 1,
          entitiesExtracted: 0,
          relationshipsExtracted: 0,
          totalTime: 1,
          stageTimings: { loading: 0, chunking: 0, extracting: 0, embedding: 0, storing: 0 },
          graphExtracted: false,
          partial: false,
          sourceDocuments: [
            {
              documentId,
              canonicalSource: filePath,
              sourceType: "file",
              sourceRevision: "rev-1",
              fileName: path.basename(filePath),
              filePath,
              fileType: "markdown",
              chunkCount: 1,
            },
          ],
          warnings: [],
        },
        chunks: [],
      };
    },
  };
}

describe("TopicManager operation-scoped write transactions", function () {
  let storageDir: string;
  let manager: TopicManager | null;

  async function createManagerInTmpDir(): Promise<TopicManager> {
    manager = await TopicManager.create({
      storageDir,
      config,
      notifier,
      embeddingService: stubEmbeddingService(),
      embeddingRegistry: stubEmbeddingRegistry(),
    });
    return manager;
  }

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-transactions-"));
    manager = null;
  });

  afterEach(async function () {
    if (manager) {
      await manager.dispose().catch(() => undefined);
      manager = null;
    }
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("holds no lease once initialization returns: the lock file does not exist", async function () {
    await createManagerInTmpDir();

    // A fresh install still stamps the storage-format marker under a lease.
    // That lease is operation-scoped, so the lock file must be gone again.
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("reloads state written by another process before applying a mutation", async function () {
    const created = await createManagerInTmpDir();
    // The first mutation is what persists topics.json; initialization no
    // longer writes on the reader path.
    await created.createTopic({ name: "mine" });

    const indexPath = path.join(storageDir, "database", "topics.json");
    const raw = JSON.parse(await fs.readFile(indexPath, "utf8"));
    raw.topics["foreign-topic"] = {
      id: "foreign-topic",
      name: "foreign",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      documentCount: 0,
    };
    await fs.writeFile(indexPath, JSON.stringify(raw));

    await created.createTopic({ name: "second" });

    const ids = created.getAllTopics().map((topic) => topic.id);
    expect(ids).to.include("foreign-topic");
    const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
    expect(Object.keys(persisted.topics)).to.include("foreign-topic");
  });

  it("releases the lease after a mutation completes", async function () {
    const created = await createManagerInTmpDir();
    await created.createTopic({ name: "t" });

    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("fails a mutation with StorageBusyError while a foreign holder is live", async function () {
    this.timeout(20_000);
    const created = await createManagerInTmpDir();
    const lockPath = path.join(storageDir, LOCK_FILENAME);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 2,
        ownerId: "foreign-owner",
        pid: 99999,
        hostname: "other-host",
        acquiredAt: Date.now(),
      }),
    );

    try {
      await created.createTopic({ name: "blocked" });
      expect.fail("createTopic should have rejected while a foreign writer holds the lease");
    } catch (error: any) {
      expect(error?.name).to.equal("StorageBusyError");
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  });

  it("never writes the topics index from the reader path", async function () {
    await createManagerInTmpDir();

    // Initialization only classifies storage and stamps the format marker.
    // topics.json belongs to the first write transaction.
    const indexPath = path.join(storageDir, "database", "topics.json");
    let missing = false;
    try {
      await fs.access(indexPath);
    } catch {
      missing = true;
    }
    expect(missing).to.equal(true);
  });

  it("refreshes topics from disk without taking a lease", async function () {
    const created = await createManagerInTmpDir();
    const topic = await created.createTopic({ name: "before" });

    const indexPath = path.join(storageDir, "database", "topics.json");
    const raw = JSON.parse(await fs.readFile(indexPath, "utf8"));
    raw.topics[topic.id].name = "renamed by another process";
    await fs.writeFile(indexPath, JSON.stringify(raw));

    await created.refresh();

    expect(created.getTopic(topic.id)?.name).to.equal("renamed by another process");
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("still recovers an interrupted transaction when the store is opened", async function () {
    // Startup no longer builds a session coordinator, so an abandoned staging
    // directory would otherwise linger until somebody happened to write.
    await fs.writeFile(
      path.join(storageDir, "storage-format.json"),
      JSON.stringify({ formatVersion: 2, initializedAt: Date.now() }),
    );
    const transactionsDir = path.join(storageDir, "database", ".transactions");
    await fs.mkdir(path.join(transactionsDir, "abandoned-transaction"), { recursive: true });
    await fs.writeFile(path.join(transactionsDir, "abandoned-transaction", "payload"), "orphan");

    await createManagerInTmpDir();

    let recovered = false;
    try {
      await fs.access(path.join(transactionsDir, "abandoned-transaction"));
    } catch {
      recovered = true;
    }
    expect(recovered).to.equal(true);
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("rolls a prepared-but-uncommitted transaction back before reloading the caches", async function () {
    // WAL recovery rewrites the canonical files. A transaction that read them
    // first would cache the torn generation, then commit it back over the
    // rollback and resurrect the aborted transaction.
    const created = await createManagerInTmpDir();
    const original = await created.createTopic({ name: "original" });

    const databaseDir = path.join(storageDir, "database");
    const indexPath = path.join(databaseDir, "topics.json");
    await abandonPreparedIndexReplacement(databaseDir, indexPath, {
      topics: {
        "torn-topic": {
          id: "torn-topic",
          name: "torn",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          documentCount: 0,
        },
      },
      modelName: "test-model",
      lastUpdated: Date.now(),
    });

    // The tear is live on disk: the original topic is gone and a phantom is
    // visible, exactly as an interrupted publication would leave it.
    const torn = JSON.parse(await fs.readFile(indexPath, "utf8"));
    expect(Object.keys(torn.topics)).to.deep.equal(["torn-topic"]);
    const walFiles = (await fs.readdir(path.join(databaseDir, ".transactions"))).filter((entry) =>
      entry.endsWith(".wal"),
    );
    expect(walFiles).to.have.length(1);

    const second = await created.createTopic({ name: "second" });

    const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
    expect(Object.keys(persisted.topics).sort()).to.deep.equal([original.id, second.id].sort());
    expect(persisted.topics).to.not.have.property("torn-topic");
    expect(created.getTopic("torn-topic")).to.equal(null);
    expect(created.getTopic(original.id)).to.not.equal(null);
  });

  it("publishes a topic deletion to the cache only after the commit succeeds", async function () {
    const created = await createManagerInTmpDir();
    const topic = await created.createTopic({ name: "doomed" });

    // Force the commit to fail: the cache must still advertise the topic.
    const prototype = StorageTransactionCoordinator.prototype as unknown as {
      commit: (name: string, operations: unknown[], metadata?: unknown) => Promise<unknown>;
    };
    const realCommit = prototype.commit;
    prototype.commit = async function (name: string, operations: unknown[], metadata?: unknown) {
      if (name === "delete-topic") {
        throw new Error("injected commit failure");
      }
      return realCommit.call(this, name, operations, metadata);
    };

    try {
      await created.deleteTopic(topic.id);
      expect.fail("deleteTopic should have surfaced the commit failure");
    } catch (error: any) {
      expect(String(error?.message)).to.include("injected commit failure");
    } finally {
      prototype.commit = realCommit;
    }

    expect(created.getTopic(topic.id)).to.not.equal(null);
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("ingestion holds one lease for the whole call and releases it after", async function () {
    const created = await createManagerInTmpDir();
    const lockPath = path.join(storageDir, LOCK_FILENAME);
    const observedLeases: unknown[] = [];
    installFakeDocumentPipeline(created, async () => {
      observedLeases.push(JSON.parse(await fs.readFile(lockPath, "utf8")));
    });
    const topic = await created.createTopic({ name: "t" });

    // Two files in one call: if a lease were acquired per file instead of
    // once per call, the two observations below would carry different
    // ownerId/acquiredAt identities (or the lock could vanish between them).
    const added = await created.addDocuments(topic.id, [fixturePath("sample.md"), fixturePath("sample-text.txt")]);

    expect(added).to.have.length(2);
    expect(created.listDocuments(topic.id)).to.have.length(2);
    expect(observedLeases).to.have.length(2);
    expect(observedLeases[0]).to.deep.equal(observedLeases[1]);
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("addDocuments to a topic deleted by a foreign process fails cleanly after reload", async function () {
    const created = await createManagerInTmpDir();
    installFakeDocumentPipeline(created);
    const topic = await created.createTopic({ name: "doomed" });

    const indexPath = path.join(storageDir, "database", "topics.json");
    const raw = JSON.parse(await fs.readFile(indexPath, "utf8"));
    delete raw.topics[topic.id];
    await fs.writeFile(indexPath, JSON.stringify(raw));

    try {
      await created.addDocuments(topic.id, [fixturePath("sample.md")]);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(String(error.message)).to.match(/not found|does not exist/i);
    }
    expect(await lockFileGone(storageDir)).to.equal(true);
  });

  it("getVectorStore retries once on a load failure before rethrowing", async function () {
    this.timeout(10_000);
    const created = await createManagerInTmpDir();
    const topic = await created.createTopic({ name: "churny" });
    const factory = (created as any).vectorStoreFactory as VectorStoreFactory;
    const databaseDir = path.join(storageDir, "database");
    await factory.createStore({ topicId: topic.id, storageDir: databaseDir }, []);
    const metadataPath = path.join(databaseDir, `vector-${topic.id}-metadata.json`);
    const goodMetadata = await fs.readFile(metadataPath, "utf8");

    const clearCaches = () => {
      created.invalidateVectorStoreCache(topic.id);
      (factory as any).storeCache.clear();
    };

    // Race: corrupt the metadata, then restore it well inside the retry's
    // 100ms wait while getVectorStore is in flight. Success proves the retry.
    clearCaches();
    await fs.writeFile(metadataPath, "{not valid json");
    const restore = new Promise<void>((resolve) => {
      setTimeout(() => {
        fs.writeFile(metadataPath, goodMetadata).then(resolve);
      }, 50);
    });
    const [store] = await Promise.all([created.getVectorStore(topic.id), restore]);
    expect(store).to.not.equal(null);

    // Control: corrupt again and never restore. The retry must also fail and
    // the failure must be surfaced, not silently swallowed to null.
    clearCaches();
    await fs.writeFile(metadataPath, "{not valid json");
    let caught: unknown;
    try {
      await created.getVectorStore(topic.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(VectorStoreLoadError);
  });
});
