import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  EmbeddingService,
  HuggingFaceBackend,
  ModelRegistry,
  VectorStoreFactory,
  type IConfigProvider,
  type INotifier,
} from "../src/index";
import { EVAL_CORPUS } from "./helpers/evalCorpus";

let isolatedIndexTimeMs: number | undefined;

const config: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

const notifier: INotifier = {
  showInfo: () => undefined,
  showWarning: () => undefined,
  showError: () => undefined,
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>) =>
    task(() => undefined),
};

describe("release performance evidence", function () {
  this.timeout(120_000);

  it("measures isolated vector-index construction after model initialization", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-release-index-"));
    const embeddingService = new EmbeddingService({ config, notifier });
    const registry = ModelRegistry.getInstance();
    embeddingService.registerBackend(new HuggingFaceBackend(registry, notifier));
    const factory = new VectorStoreFactory(storageDir, registry.getDefaultModel(), embeddingService);
    try {
      // Model initialization is deliberately outside the timed region: this
      // metric covers database setup, corpus embedding, and durable index
      // construction, not model download/startup.
      await embeddingService.initialize();
      const documents = EVAL_CORPUS.map(
        (fixture) =>
          new LangChainDocument({
            pageContent: fixture.content,
            metadata: {
              ...fixture.metadata,
              documentId: fixture.id,
              chunkId: `${fixture.id}-0`,
            },
          }),
      );
      const started = performance.now();
      await factory.initialize();
      await factory.createStore({ topicId: "release-index", storageDir }, documents);
      isolatedIndexTimeMs = performance.now() - started;

      expect(isolatedIndexTimeMs).to.be.greaterThan(0);
      expect(await factory.getStoredStats("release-index")).to.deep.equal({
        documentCount: EVAL_CORPUS.length,
        chunkCount: EVAL_CORPUS.length,
      });
    } finally {
      factory.dispose();
      await embeddingService.dispose();
      await fs.rm(storageDir, { recursive: true, force: true });
    }
  });
});

after(function () {
  if (process.env.RAGNAROK_BENCHMARK_MODE !== "release") {
    return;
  }
  if (!Number.isFinite(isolatedIndexTimeMs) || isolatedIndexTimeMs! <= 0) {
    throw new Error("Release performance benchmark did not produce a finite index-time measurement");
  }
  console.log(
    `RAGNAROK_METRICS performance ${JSON.stringify({
      indexTimeMs: isolatedIndexTimeMs,
      indexTimeScope: "model-ready database initialization, corpus embedding, and durable vector-index construction",
      indexModelInitializationIncluded: false,
      indexMeasurementClock: "performance.now",
      indexDocumentCount: EVAL_CORPUS.length,
    })}`,
  );
});
