import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TopicManager, type IConfigProvider, type INotifier } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { TopicsIndex } from "../src/utils/types";

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

function createManager(storageDir: string): TopicManager {
  const embeddingService = {
    getCurrentModel: () => "test-model",
  } as unknown as EmbeddingService;
  const Manager = TopicManager as unknown as new (options: {
    storageDir: string;
    config: IConfigProvider;
    notifier: INotifier;
    embeddingService: EmbeddingService;
  }) => TopicManager;
  return new Manager({ storageDir, config, notifier, embeddingService });
}

describe("TopicManager metadata corruption handling", function () {
  let storageDir: string;
  let databaseDir: string;

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-corruption-test-"));
    databaseDir = path.join(storageDir, "database");
    await fs.mkdir(databaseDir, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("rejects truncated topics JSON without overwriting the file or loaded state", async function () {
    const indexPath = path.join(databaseDir, "topics.json");
    const corruptContents = '{"topics":{"topic-1":';
    await fs.writeFile(indexPath, corruptContents, "utf8");

    const manager = createManager(storageDir);
    const previousIndex: TopicsIndex = {
      topics: {
        previous: {
          id: "previous",
          name: "Previously loaded",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
      },
      modelName: "test-model",
      lastUpdated: 1,
    };
    (manager as any).topicsIndex = previousIndex;

    let caught: unknown;
    try {
      await (manager as any).loadTopicsIndex();
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal("Invalid topics.json: malformed JSON");
    expect((manager as any).topicsIndex).to.equal(previousIndex);
    expect(await fs.readFile(indexPath, "utf8")).to.equal(corruptContents);
  });

  it("rejects schema-invalid topics JSON without replacing it with an empty index", async function () {
    const indexPath = path.join(databaseDir, "topics.json");
    const corruptContents = JSON.stringify({ topics: [], modelName: "test-model", lastUpdated: 1 });
    await fs.writeFile(indexPath, corruptContents, "utf8");

    const manager = createManager(storageDir);
    let caught: unknown;
    try {
      await (manager as any).loadTopicsIndex();
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include("expected a topics map");
    expect(await fs.readFile(indexPath, "utf8")).to.equal(corruptContents);
  });

  it("propagates non-ENOENT index I/O errors without initializing empty state", async function () {
    const indexPath = path.join(databaseDir, "topics.json");
    await fs.mkdir(indexPath);

    const manager = createManager(storageDir);
    const previousIndex = {
      topics: {},
      modelName: "previous-model",
      lastUpdated: 1,
    };
    (manager as any).topicsIndex = previousIndex;

    let caught: any;
    try {
      await (manager as any).loadTopicsIndex();
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect(caught.code).to.not.equal("ENOENT");
    expect((manager as any).topicsIndex).to.equal(previousIndex);
    expect((await fs.stat(indexPath)).isDirectory()).to.equal(true);
  });

  it("rejects corrupt document JSON without publishing partial document state", async function () {
    const topicId = "topic-1";
    const index: TopicsIndex = {
      topics: {
        [topicId]: {
          id: topicId,
          name: "Topic",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 1,
        },
      },
      modelName: "test-model",
      lastUpdated: 1,
    };
    await fs.writeFile(path.join(databaseDir, "topics.json"), JSON.stringify(index), "utf8");

    const documentsPath = path.join(databaseDir, `topic-${topicId}-documents.json`);
    const corruptContents = '[{"id":"doc-1"';
    await fs.writeFile(documentsPath, corruptContents, "utf8");

    const manager = createManager(storageDir);
    const previousDocuments = new Map([["previous", { id: "previous" }]]);
    (manager as any).topicDocuments = new Map([[topicId, previousDocuments]]);

    let caught: unknown;
    try {
      await (manager as any).loadTopicsIndex();
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal(`Invalid document metadata for topic "${topicId}": malformed JSON`);
    expect((manager as any).topicDocuments.get(topicId)).to.equal(previousDocuments);
    expect(await fs.readFile(documentsPath, "utf8")).to.equal(corruptContents);
  });

  it("accepts a missing document metadata file as an empty older-format topic", async function () {
    const topicId = "topic-without-doc-file";
    const index: TopicsIndex = {
      topics: {
        [topicId]: {
          id: topicId,
          name: "Older topic",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
      },
      modelName: "test-model",
      lastUpdated: 1,
    };
    await fs.writeFile(path.join(databaseDir, "topics.json"), JSON.stringify(index), "utf8");

    const manager = createManager(storageDir);
    await (manager as any).loadTopicsIndex();

    expect((manager as any).topicDocuments.get(topicId)).to.be.instanceOf(Map);
    expect((manager as any).topicDocuments.get(topicId).size).to.equal(0);
  });
});
