import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TopicManager, type IConfigProvider, type INotifier } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../src/embeddings/embeddingServiceRegistry";
import { StorageTransactionCoordinator } from "../src/utils/storageTransactionCoordinator";

const LOCK_FILENAME = ".ragnarok.lock";

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
  } as unknown as EmbeddingService;
}

function stubEmbeddingRegistry(): EmbeddingServiceRegistry {
  return {} as unknown as EmbeddingServiceRegistry;
}

async function lockFileGone(storageDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(storageDir, LOCK_FILENAME));
    return false;
  } catch {
    return true;
  }
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
});
