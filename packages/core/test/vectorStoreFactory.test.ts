/**
 * VectorStoreFactory Metadata Persistence Test
 *
 * Real LanceDB round-trip (no mocks): writes a document carrying chunk identity
 * and location metadata through VectorStoreFactory, reads it back via a table
 * scan, and asserts every field survives with the correct value and type.
 *
 * Guards the contract that graph retrieval relies on: chunkId must persist so
 * entity `sourceChunkIds` can hydrate their chunks, and position/heading
 * metadata must survive so query results carry accurate source attribution.
 */

import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { VectorStore } from "@langchain/core/vectorstores";
import {
  VectorStoreFactory,
  EmbeddingService,
  EmbeddingServiceRegistry,
  ModelRegistry,
  HuggingFaceBackend,
  IConfigProvider,
  INotifier,
  VectorStoreMetadataCorruptionError,
} from "../src/index";

const mockConfig: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

const mockNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

describe("VectorStoreFactory metadata persistence", function () {
  this.timeout(120000); // model initialization

  let factory: VectorStoreFactory;
  let storageDir: string;
  const topicId = "metadata-roundtrip";

  before(async function () {
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    embeddingService.registerBackend(new HuggingFaceBackend(modelRegistry, mockNotifier));

    storageDir = path.join(os.tmpdir(), `vsf-test-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });

    const embeddingRegistry = new EmbeddingServiceRegistry({
      createService: () => embeddingService,
      maxResidentLocal: 2,
    });
    factory = new VectorStoreFactory(storageDir, modelRegistry.getDefaultModel(), embeddingService, embeddingRegistry);
    await factory.initialize();
  });

  after(async function () {
    factory?.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("preserves chunkId and location metadata through a LanceDB round-trip", async function () {
    const headingPath = ["Memory Allocation", "Malloc"];
    const doc = new LangChainDocument({
      pageContent: "# Malloc\nmalloc reserves a block of memory on the heap.",
      metadata: {
        source: "memory.md",
        fileName: "memory.md",
        chunkIndex: 0,
        chunkId: "memory.md-0-1",
        startPosition: 100,
        endPosition: 250,
        headingPath,
        sectionTitle: "Malloc",
        loc: { lines: { from: 5, to: 12 } },
      },
    });

    await factory.createStore({ topicId, storageDir }, [doc]);

    const loaded = await factory.getAllDocuments(topicId, 10);
    expect(loaded).to.have.length(1);
    const md = loaded[0].metadata;

    // chunkId must survive as a stable scalar string (graph retrieval keys on it)
    expect(md.chunkId, "chunkId dropped during persistence").to.equal("memory.md-0-1");
    expect(typeof md.chunkId).to.equal("string");

    // Character offsets survive as numbers
    expect(Number(md.startPosition)).to.equal(100);
    expect(Number(md.endPosition)).to.equal(250);

    // loc is flattened to scalar columns
    expect(Number(md.loc_lines_from)).to.equal(5);
    expect(Number(md.loc_lines_to)).to.equal(12);

    // headingPath is persisted as a scalar JSON string that deserializes to the array
    expect(typeof md.headingPath).to.equal("string");
    expect(JSON.parse(md.headingPath as string)).to.deep.equal(headingPath);

    expect(md.sectionTitle).to.equal("Malloc");
  });

  it("refuses to write or stamp an existing table whose metadata is missing", async function () {
    const missingTopic = "metadata-missing";
    await factory.createStore({ topicId: missingTopic, storageDir }, [
      new LangChainDocument({
        pageContent: "original semantic space",
        metadata: { documentId: "original", chunkId: "original-0" },
      }),
    ]);
    const metadataPath = path.join(storageDir, `vector-${missingTopic}-metadata.json`);
    await fs.unlink(metadataPath);

    let reconcileError: unknown;
    try {
      await factory.reconcileDocuments(missingTopic, [
        new LangChainDocument({
          pageContent: "must never be embedded into the unidentified table",
          metadata: { documentId: "new", chunkId: "new-0" },
        }),
      ]);
    } catch (error) {
      reconcileError = error;
    }
    expect(reconcileError).to.be.instanceOf(VectorStoreMetadataCorruptionError);
    expect(await factory.getDocumentChunkCount(missingTopic, "original")).to.equal(1);
    expect(await factory.getDocumentChunkCount(missingTopic, "new")).to.equal(0);

    let saveError: unknown;
    try {
      await factory.saveStore(missingTopic, { documentCount: 2, chunkCount: 2 });
    } catch (error) {
      saveError = error;
    }
    expect(saveError).to.be.instanceOf(VectorStoreMetadataCorruptionError);
    await expectFileMissing(metadataPath);
  });

  it("fails closed on malformed metadata without replacing it", async function () {
    const corruptTopic = "metadata-corrupt";
    await factory.createStore({ topicId: corruptTopic, storageDir });
    const metadataPath = path.join(storageDir, `vector-${corruptTopic}-metadata.json`);
    const corruptBytes = '{"schemaVersion":2,"topicId":';
    await fs.writeFile(metadataPath, corruptBytes);

    let error: unknown;
    try {
      await factory.saveStore(corruptTopic, { documentCount: 0, chunkCount: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(VectorStoreMetadataCorruptionError);
    expect(await fs.readFile(metadataPath, "utf8")).to.equal(corruptBytes);
  });
});

/**
 * Records every model it is pointed at, so a test can ask which model actually
 * served an embed. Mirrors the real service closely enough for the property
 * under test: `initializeForBackend` re-points the (per-service) backend, so a
 * service shared between two topics ends up serving whichever loaded last.
 */
class RecordingEmbeddingService {
  public currentModel = "";
  public lastEmbedModel = "";
  public readonly embedLog: string[] = [];

  public async initialize(modelName?: string): Promise<void> {
    this.currentModel = modelName ?? this.currentModel;
  }

  public async initializeForBackend(_backendType: string, modelName?: string): Promise<void> {
    this.currentModel = modelName ?? this.currentModel;
  }

  public async getFingerprint(): Promise<Record<string, unknown>> {
    return {
      backendKind: "huggingface",
      providerFormat: "huggingface",
      model: this.currentModel,
      revision: "test",
      dimension: 4,
      endpointHash: "local",
    };
  }

  public async embed(_text: string): Promise<number[]> {
    return this.record();
  }

  public async embedWithBackend(_backendType: string, _text: string): Promise<number[]> {
    return this.record();
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => this.record());
  }

  public async embedBatchWithBackend(_backendType: string, texts: string[]): Promise<number[][]> {
    return texts.map(() => this.record());
  }

  public getCurrentModel(): string {
    return this.currentModel;
  }

  public async dispose(): Promise<void> {}

  private record(): number[] {
    this.lastEmbedModel = this.currentModel;
    this.embedLog.push(this.currentModel);
    return [0.1, 0.2, 0.3, 0.4];
  }
}

/**
 * A topic must keep embedding with the model its vectors were built from, no
 * matter which other topic was loaded — or queried — after it.
 *
 * Regression test for the shared-EmbeddingService bug: every store's
 * TransformersEmbeddings used to close over one service and re-point it via
 * initialize(model) behind a one-shot flag, so the topic that embedded first
 * silently inherited the model of whichever topic embedded next.
 */
describe("VectorStoreFactory per-topic embedding model", function () {
  this.timeout(60000);

  let factory: VectorStoreFactory;
  let storageDir: string;
  let sharedService: RecordingEmbeddingService;

  /** The service each store actually embeds through. */
  const serviceOf = (store: VectorStore): RecordingEmbeddingService =>
    (store as any).embeddings.embeddingService as RecordingEmbeddingService;

  /** Embeds a query through the store and reports the model that served it. */
  async function resolvedModelFor(store: VectorStore): Promise<string> {
    await (store as any).embeddings.embedQuery("which model am I using?");
    const service = serviceOf(store);
    const fingerprint = await service.getFingerprint();
    expect(service.lastEmbedModel, "fingerprint disagrees with the model that served the embed").to.equal(
      fingerprint.model,
    );
    return service.lastEmbedModel;
  }

  before(async function () {
    storageDir = path.join(os.tmpdir(), `vsf-per-topic-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });

    sharedService = new RecordingEmbeddingService();
    await sharedService.initialize("model-x");
    const embeddingRegistry = new EmbeddingServiceRegistry({
      // A fresh service per embedding space, exactly as the real roots do.
      createService: () => new RecordingEmbeddingService() as unknown as EmbeddingService,
      maxResidentLocal: 4,
    });
    factory = new VectorStoreFactory(
      storageDir,
      "model-x",
      sharedService as unknown as EmbeddingService,
      embeddingRegistry,
    );
    await factory.initialize();

    // Topic "a" records model-x; topic "b" is re-stamped to model-y.
    await factory.createStore({ topicId: "a", storageDir });
    await factory.createStore({ topicId: "b", storageDir });
    await factory.saveStore("b", {
      embeddingModel: "model-y",
      embeddingBackend: "huggingface",
      embeddingFingerprint: {
        backendKind: "huggingface",
        providerFormat: "huggingface",
        model: "model-y",
        revision: "test",
        dimension: 4,
        endpointHash: "local",
      },
    });
    // Drop the stores cached by createStore so both topics load from metadata.
    (factory as any).storeCache.clear();
  });

  after(async function () {
    factory?.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("keeps each topic on its own embedding model when another topic is loaded", async function () {
    const storeA = await factory.loadStore("a");
    expect(storeA, "topic a failed to load").to.not.equal(null);
    expect(await resolvedModelFor(storeA!)).to.equal("model-x");

    const storeB = await factory.loadStore("b");
    expect(storeB, "topic b failed to load").to.not.equal(null);
    expect(await resolvedModelFor(storeB!), "topic b must use its own recorded model").to.equal("model-y");

    // The decisive assertion: querying A again, after B has embedded.
    expect(await resolvedModelFor(storeA!), "loading topic B must not re-point topic A's embedder").to.equal("model-x");
  });
});

async function expectFileMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    expect.fail(`Expected ${filePath} not to exist`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).to.equal("ENOENT");
  }
}
