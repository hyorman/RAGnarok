import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TopicManager, type IConfigProvider, type INotifier } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { Topic, TopicsIndex } from "../src/utils/types";

function topic(id: string, name: string): Topic {
  return { id, name, createdAt: 1, updatedAt: 1, documentCount: 0 };
}

function createManager(storageDir: string, commonPath: string, errors: string[]): TopicManager {
  const config: IConfigProvider = {
    get<T>(key: string, defaultValue: T): T {
      return (key.endsWith("commonDatabasePath") ? commonPath : defaultValue) as T;
    },
  };
  const notifier: INotifier = {
    showInfo: () => undefined,
    showWarning: () => undefined,
    showError: (message) => errors.push(message),
    withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
      task(() => undefined),
  };
  const embeddingService = { getCurrentModel: () => "test-model" } as unknown as EmbeddingService;
  const Manager = TopicManager as unknown as new (options: {
    storageDir: string;
    config: IConfigProvider;
    notifier: INotifier;
    embeddingService: EmbeddingService;
  }) => TopicManager;
  return new Manager({ storageDir, config, notifier, embeddingService });
}

describe("TopicManager common database identity", function () {
  let temporaryDir: string;

  beforeEach(async function () {
    temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "common-db-identity-"));
  });

  afterEach(async function () {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  });

  for (const collision of ["id", "name"] as const) {
    it(`rejects a common database with a local/common ${collision} collision`, async function () {
      const commonRoot = path.join(temporaryDir, "common");
      const commonDatabase = path.join(commonRoot, "database");
      await fs.mkdir(commonDatabase, { recursive: true });
      await fs.writeFile(path.join(commonRoot, "storage-format.json"), JSON.stringify({ formatVersion: 2 }));
      const commonTopic = collision === "id" ? topic("same-id", "Different name") : topic("different-id", "Same name");
      const commonIndex: TopicsIndex = {
        topics: { [commonTopic.id]: commonTopic },
        modelName: "test-model",
        lastUpdated: 1,
      };
      await fs.writeFile(path.join(commonDatabase, "topics.json"), JSON.stringify(commonIndex));

      const errors: string[] = [];
      const manager = createManager(path.join(temporaryDir, "local"), commonRoot, errors);
      const localTopic = collision === "id" ? topic("same-id", "Local") : topic("local-id", "Same name");
      (manager as any).topicsIndex = {
        topics: { [localTopic.id]: localTopic },
        modelName: "test-model",
        lastUpdated: 1,
      } satisfies TopicsIndex;

      await manager.loadCommonDatabase();
      expect(manager.getAllTopics().map((entry) => entry.id)).to.deep.equal([localTopic.id]);
      expect(errors[0]).to.include("topic ID/name conflicts");
    });
  }

  it("always routes a same-ID local topic as local even if a conflicting common index is injected", function () {
    const manager = createManager(path.join(temporaryDir, "local"), "", []);
    const local = topic("same-id", "Local");
    const common = topic("same-id", "Common");
    (manager as any).topicsIndex = {
      topics: { [local.id]: local },
      modelName: "test-model",
      lastUpdated: 1,
    } satisfies TopicsIndex;
    (manager as any).commonTopicsIndex = {
      topics: { [common.id]: common },
      modelName: "test-model",
      lastUpdated: 1,
    } satisfies TopicsIndex;

    expect(manager.isCommonTopic("same-id")).to.equal(false);
    expect(manager.getTopic("same-id")).to.deep.include({ name: "Local", source: "local" });
  });

  it("publishes topic deletion before removing its storage generation", async function () {
    const storageRoot = path.join(temporaryDir, "delete-local");
    const database = path.join(storageRoot, "database");
    const lancedb = path.join(database, "lancedb");
    await fs.mkdir(lancedb, { recursive: true });
    const local = topic("delete-me", "Delete me");
    const index: TopicsIndex = {
      topics: { [local.id]: local },
      modelName: "test-model",
      lastUpdated: 1,
    };
    await fs.writeFile(path.join(database, "topics.json"), JSON.stringify(index));
    await fs.writeFile(path.join(database, `topic-${local.id}-documents.json`), "[]");
    await fs.writeFile(path.join(database, `vector-${local.id}-metadata.json`), "{}");
    for (const table of [`${local.id}.lance`]) {
      await fs.mkdir(path.join(lancedb, table));
      await fs.writeFile(path.join(lancedb, table, "data"), "fixture");
    }

    const manager = createManager(storageRoot, "", []);
    (manager as any).topicsIndex = index;
    (manager as any).topicDocuments = new Map([[local.id, new Map()]]);
    (manager as any).vectorStoreFactory = { dispose: () => undefined };

    await manager.deleteTopic(local.id);
    expect(manager.getTopic(local.id)).to.equal(null);
    expect(JSON.parse(await fs.readFile(path.join(database, "topics.json"), "utf8")).topics).to.deep.equal({});
    for (const candidate of [
      path.join(database, `topic-${local.id}-documents.json`),
      path.join(database, `vector-${local.id}-metadata.json`),
      path.join(lancedb, `${local.id}.lance`),
    ]) {
      let exists = true;
      try {
        await fs.access(candidate);
      } catch {
        exists = false;
      }
      expect(exists, candidate).to.equal(false);
    }
  });
});
