/**
 * TopicManager fuzzy topic resolution.
 *
 * `resolveTopicByName` memoizes the embedding of every topic name, because a
 * non-exact lookup otherwise re-embeds one vector per topic on every query.
 * These tests pin both halves of that contract: the vectors are computed once,
 * and they are never served stale — not after a rename, and not after the
 * embedding model changes underneath the manager.
 */

import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TopicManager, type IConfigProvider, type INotifier } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { Topic, TopicsIndex } from "../src/utils/types";

/**
 * Vectors are model-dependent on purpose: under "model-b" the winner for the
 * same query flips, so a cache that survives a model switch produces a visibly
 * wrong match instead of a silently identical one.
 */
const VECTORS: Record<string, Record<string, number[]>> = {
  "model-a": {
    "alpha handbook": [1, 0],
    "Alpha docs": [0.9, 0.4],
    "Beta notes": [0.1, 1],
    "Gamma memos": [1, 0.05],
  },
  "model-b": {
    "alpha handbook": [1, 0],
    "Alpha docs": [0.1, 1],
    "Beta notes": [0.9, 0.4],
    "Gamma memos": [0.1, 1],
  },
};

class StubEmbeddingService {
  public model = "model-a";
  public readonly embedCalls: string[] = [];

  public getCurrentModel(): string {
    return this.model;
  }

  public async embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    const vector = VECTORS[this.model][text];
    if (!vector) {
      throw new Error(`Test fixture has no vector for "${text}" under ${this.model}`);
    }
    return vector;
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
    const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
    return dot / (normA * normB);
  }
}

function topic(id: string, name: string): Topic {
  return { id, name, createdAt: 1, updatedAt: 1, documentCount: 0 };
}

describe("TopicManager fuzzy topic resolution", function () {
  let storageDir: string;
  let embeddingService: StubEmbeddingService;
  let manager: TopicManager;

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-resolution-"));
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    embeddingService = new StubEmbeddingService();

    const config: IConfigProvider = { get: <T>(_key: string, defaultValue: T): T => defaultValue };
    const notifier: INotifier = {
      showInfo: () => undefined,
      showWarning: () => undefined,
      showError: () => undefined,
      withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
        task(() => undefined),
    };
    const Manager = TopicManager as unknown as new (options: {
      storageDir: string;
      config: IConfigProvider;
      notifier: INotifier;
      embeddingService: EmbeddingService;
    }) => TopicManager;
    manager = new Manager({
      storageDir,
      config,
      notifier,
      embeddingService: embeddingService as unknown as EmbeddingService,
    });
    const index: TopicsIndex = {
      topics: {
        "t-alpha": topic("t-alpha", "Alpha docs"),
        "t-beta": topic("t-beta", "Beta notes"),
      },
      modelName: "model-a",
      lastUpdated: 1,
    };
    (manager as unknown as { topicsIndex: TopicsIndex }).topicsIndex = index;
  });

  afterEach(async function () {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("embeds each topic name once across repeated lookups", async function () {
    const first = await manager.resolveTopicByName("alpha handbook");
    expect(first.topic.id).to.equal("t-alpha");
    expect(first.matchType).to.equal("similar");

    const second = await manager.resolveTopicByName("alpha handbook");
    expect(second.topic.id).to.equal("t-alpha");

    // The query is embedded per lookup; each topic name exactly once.
    expect(embeddingService.embedCalls.filter((text) => text === "alpha handbook")).to.have.length(2);
    expect(embeddingService.embedCalls.filter((text) => text === "Alpha docs")).to.have.length(1);
    expect(embeddingService.embedCalls.filter((text) => text === "Beta notes")).to.have.length(1);
  });

  it("never matches a renamed topic on its stale vector", async function () {
    expect((await manager.resolveTopicByName("alpha handbook")).topic.id).to.equal("t-alpha");

    await manager.updateTopic("t-beta", { name: "Gamma memos" });

    const match = await manager.resolveTopicByName("alpha handbook");
    // "Gamma memos" is the closer vector, so the renamed topic must win and the
    // old name must be gone from the reported alternatives.
    expect(match.topic.id).to.equal("t-beta");
    expect(match.topic.name).to.equal("Gamma memos");
    expect(match.availableTopics).to.deep.equal(["Alpha docs", "Gamma memos"]);
    expect(embeddingService.embedCalls).to.include("Gamma memos");
    expect(embeddingService.embedCalls.filter((text) => text === "Beta notes")).to.have.length(1);
  });

  it("re-embeds topic names after the embedding model changes", async function () {
    expect((await manager.resolveTopicByName("alpha handbook")).topic.id).to.equal("t-alpha");

    embeddingService.model = "model-b";

    const match = await manager.resolveTopicByName("alpha handbook");
    // Under model-b the same query is closest to "Beta notes". A cache that
    // survived the model switch would still answer "Alpha docs".
    expect(match.topic.id).to.equal("t-beta");
    expect(embeddingService.embedCalls.filter((text) => text === "Alpha docs")).to.have.length(2);
    expect(embeddingService.embedCalls.filter((text) => text === "Beta notes")).to.have.length(2);
  });
});
