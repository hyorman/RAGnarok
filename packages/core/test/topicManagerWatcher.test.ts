import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TopicManager, type IConfigProvider, type INotifier, type StorageExternalChange } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../src/embeddings/embeddingServiceRegistry";

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
    get: async () => stubEmbeddingService(),
  } as unknown as EmbeddingServiceRegistry;
}

/** Poll `check` until it returns true or `timeoutMs` elapses. */
async function pollUntil(check: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!check()) {
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }
}

describe("TopicManager external-change watcher", function () {
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
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-watcher-"));
    manager = null;
  });

  afterEach(async function () {
    if (manager) {
      await manager.dispose().catch(() => undefined);
      manager = null;
    }
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("fires topics-changed within ~2s when another process edits topics.json directly, and getAllTopics reflects it without refresh()", async function () {
    this.timeout(15_000);
    const created = await createManagerInTmpDir();
    await created.createTopic({ name: "mine" });

    const events: StorageExternalChange[] = [];
    const subscription = created.onExternalChange((change) => events.push(change));

    try {
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

      await pollUntil(() => events.some((event) => event.kind === "topics-changed"), 10_000);

      // No refresh() call here: freshness must come from the watcher alone.
      const ids = created.getAllTopics().map((topic) => topic.id);
      expect(ids).to.include("foreign-topic");
    } finally {
      subscription.dispose();
    }
  });

  it("emits storage-unavailable when the database dir is renamed away with a lock file present, then topics-changed once restored", async function () {
    this.timeout(20_000);
    const created = await createManagerInTmpDir();
    await created.createTopic({ name: "mine" });

    const events: StorageExternalChange[] = [];
    const subscription = created.onExternalChange((change) => events.push(change));
    const lockPath = path.join(storageDir, LOCK_FILENAME);
    const databaseDir = path.join(storageDir, "database");
    const movedDir = path.join(storageDir, "database-away");

    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          version: 2,
          ownerId: "foreign-migration",
          pid: 99999,
          hostname: "other-host",
          acquiredAt: Date.now(),
        }),
      );
      await fs.rename(databaseDir, movedDir);

      await pollUntil(() => events.some((event) => event.kind === "storage-unavailable"), 15_000);

      await fs.rename(movedDir, databaseDir);
      await fs.rm(lockPath, { force: true });

      await pollUntil(() => events.some((event) => event.kind === "topics-changed"), 15_000);
    } finally {
      subscription.dispose();
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      await fs.rm(movedDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("dispose() stops the watcher: no external-change events fire afterward", async function () {
    this.timeout(10_000);
    const created = await createManagerInTmpDir();
    await created.createTopic({ name: "mine" });

    const events: StorageExternalChange[] = [];
    created.onExternalChange((change) => events.push(change));

    const indexPath = path.join(storageDir, "database", "topics.json");
    await created.dispose();
    manager = null;

    const raw = JSON.parse(await fs.readFile(indexPath, "utf8"));
    raw.topics["after-dispose"] = {
      id: "after-dispose",
      name: "after-dispose",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      documentCount: 0,
    };
    await fs.writeFile(indexPath, JSON.stringify(raw));

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events).to.have.length(0);
  });

  it("does not repopulate caches or emit an event when dispose() runs while a watcher-triggered reload is mid-flight", async function () {
    this.timeout(10_000);
    const created = await createManagerInTmpDir();
    await created.createTopic({ name: "mine" });

    const events: StorageExternalChange[] = [];
    created.onExternalChange((change) => events.push(change));

    // Stall the handler's very first await point (the database-dir existence
    // check) so we control exactly when it resumes, relative to dispose().
    // handleDebouncedChange is invoked directly here -- bypassing fs.watch
    // timing entirely -- because it is not tracked by the managed-operation
    // drain, which is precisely the gap this test exercises.
    let releaseStall: () => void = () => undefined;
    const stall = new Promise<void>((resolve) => {
      releaseStall = resolve;
    });
    let stallEntered = false;
    const originalDatabaseDirExists = ((created as any).databaseDirExists as () => Promise<boolean>).bind(created);
    (created as any).databaseDirExists = async (): Promise<boolean> => {
      stallEntered = true;
      await stall;
      return originalDatabaseDirExists();
    };

    const pending: Promise<void> = (created as any).handleDebouncedChange();

    await pollUntil(() => stallEntered, 2_000);

    await created.dispose();
    manager = null;
    // Dispose must have cleared the cache before the stalled reload resumes.
    expect((created as any).topicsIndex).to.equal(null);

    releaseStall();
    await pending;

    // The resumed handler must have bailed out on the post-await
    // watcherStopped check instead of reloading and republishing state.
    expect((created as any).topicsIndex).to.equal(null);
    expect(events).to.have.length(0);
  });
});
