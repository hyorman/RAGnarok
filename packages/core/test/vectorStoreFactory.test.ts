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
  EmbeddingBackend,
  IConfigProvider,
  INotifier,
  VectorStoreMetadataCorruptionError,
  EmbeddingEndpointMismatchError,
  EmbeddingReindexRequiredError,
  STORAGE_FORMAT_VERSION,
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

  // getStoredStats counts chunks with a pushdown countRows() and derives the
  // distinct document count from an id-column scan. Both numbers are reported
  // to users and gate ingestion bookkeeping, so pin the exact values for a
  // multi-document, multi-chunk table before and after a document removal.
  it("reports exact stored document and chunk counts", async function () {
    const statsTopic = "stored-stats";
    const chunk = (documentId: string, index: number): LangChainDocument =>
      new LangChainDocument({
        pageContent: `${documentId} chunk ${index} about storage counters`,
        metadata: { documentId, chunkId: `${documentId}-${index}`, source: `${documentId}.md` },
      });

    await factory.createStore({ topicId: statsTopic, storageDir }, [
      chunk("alpha", 0),
      chunk("alpha", 1),
      chunk("alpha", 2),
      chunk("beta", 0),
      chunk("beta", 1),
    ]);
    expect(await factory.getStoredStats(statsTopic)).to.deep.equal({ documentCount: 2, chunkCount: 5 });

    await factory.reconcileDocuments(statsTopic, [chunk("gamma", 0)]);
    expect(await factory.getStoredStats(statsTopic)).to.deep.equal({ documentCount: 3, chunkCount: 6 });

    expect(await factory.removeDocument(statsTopic, "alpha")).to.have.length(3);
    expect(await factory.getStoredStats(statsTopic)).to.deep.equal({ documentCount: 2, chunkCount: 3 });

    expect(await factory.getStoredStats("no-such-topic")).to.deep.equal({ documentCount: 0, chunkCount: 0 });
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

  /**
   * Byte-for-byte what the 0.3 release wrote. A store already marked v2 still
   * acquires these files — an older build writing into it, or a 0.3-era `.rag`
   * archive imported by topicManager, which rewrites only `topicId`. The
   * whole-storage migrator normalizes this shape but never sees those, so the
   * read boundary has to.
   */
  const legacyMetadata = (topicId: string) => ({
    topicId,
    documentCount: 1,
    chunkCount: 1386,
    embeddingModel: "vscodeLM:copilot.text-embedding-3-small",
    createdAt: 1787169289626,
    updatedAt: 1787169289626,
  });

  it("adopts pre-v2 metadata instead of rejecting it, without inventing a fingerprint", async function () {
    const legacyTopic = "metadata-pre-v2";
    await factory.createStore({ topicId: legacyTopic, storageDir });
    const metadataPath = path.join(storageDir, `vector-${legacyTopic}-metadata.json`);
    await fs.writeFile(metadataPath, JSON.stringify(legacyMetadata(legacyTopic), null, 2));

    const metadata = await factory.getStoreMetadata(legacyTopic);

    expect(metadata).to.deep.equal({
      schemaVersion: STORAGE_FORMAT_VERSION,
      topicId: legacyTopic,
      documentCount: 1,
      chunkCount: 1386,
      embeddingModel: "vscodeLM:copilot.text-embedding-3-small",
      embeddingBackend: "",
      createdAt: 1787169289626,
      updatedAt: 1787169289626,
      migrationRequiresFingerprintOnReindex: true,
    });
    // Adoption is a read-path concern; it must not write.
    expect(JSON.parse(await fs.readFile(metadataPath, "utf8"))).to.deep.equal(legacyMetadata(legacyTopic));
  });

  it("still refuses to extend adopted vectors whose embedding space is unverifiable", async function () {
    const legacyTopic = "metadata-pre-v2-mutation";
    await factory.createStore({ topicId: legacyTopic, storageDir });
    const metadataPath = path.join(storageDir, `vector-${legacyTopic}-metadata.json`);
    await fs.writeFile(metadataPath, JSON.stringify(legacyMetadata(legacyTopic), null, 2));

    // Both guarded entry points, because adoption must not open either one.
    for (const mutate of [
      () => factory.validateEmbeddingModel(legacyTopic),
      () =>
        factory.reconcileDocuments(legacyTopic, [
          new LangChainDocument({ pageContent: "new chunk", metadata: { source: "new.md" } }),
        ]),
    ]) {
      let error: unknown;
      try {
        await mutate();
      } catch (caught) {
        error = caught;
      }
      // Reads recover the topic; only extension waits for an explicit reindex.
      expect(error).to.be.instanceOf(EmbeddingReindexRequiredError);
    }
  });

  it("persists the adopted shape on the next legitimate metadata write", async function () {
    const legacyTopic = "metadata-pre-v2-persist";
    await factory.createStore({ topicId: legacyTopic, storageDir });
    const metadataPath = path.join(storageDir, `vector-${legacyTopic}-metadata.json`);
    await fs.writeFile(metadataPath, JSON.stringify(legacyMetadata(legacyTopic), null, 2));

    await factory.saveStore(legacyTopic, { documentCount: 1, chunkCount: 1386 });

    const persisted = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    expect(persisted.schemaVersion).to.equal(STORAGE_FORMAT_VERSION);
    // The flag survives the write, so the topic does not silently become mutable.
    expect(persisted.migrationRequiresFingerprintOnReindex).to.equal(true);
    expect(persisted.embeddingFingerprint).to.equal(undefined);
    expect(persisted.embeddingModel).to.equal("vscodeLM:copilot.text-embedding-3-small");
  });

  it("rejects damage that only resembles pre-v2 metadata", async function () {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a future schema version", { ...legacyMetadata("x"), schemaVersion: 99 }],
      ["a mismatched topic id", { ...legacyMetadata("someone-else") }],
      ["a non-finite chunk count", { ...legacyMetadata("x"), chunkCount: "1386" }],
      ["a missing embedding model", { ...legacyMetadata("x"), embeddingModel: undefined }],
      ["a missing timestamp", { ...legacyMetadata("x"), updatedAt: undefined }],
    ];

    for (const [name, payload] of cases) {
      const topicId = "x";
      const metadataPath = path.join(storageDir, `vector-${topicId}-metadata.json`);
      await fs.writeFile(metadataPath, JSON.stringify({ ...payload, topicId: payload.topicId ?? topicId }));

      let error: unknown;
      try {
        await factory.getStoreMetadata(topicId);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${name} must stay a corruption refusal`).to.be.instanceOf(VectorStoreMetadataCorruptionError);
    }
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

  /**
   * Embeds a query through the store and reports the model that served it.
   * The query text must differ per call: TransformersEmbeddings memoises query
   * vectors, so a repeated string would be served from cache without embedding.
   */
  async function resolvedModelFor(store: VectorStore, query: string): Promise<string> {
    await (store as any).embeddings.embedQuery(query);
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
    expect(await resolvedModelFor(storeA!, "first query on a")).to.equal("model-x");

    const storeB = await factory.loadStore("b");
    expect(storeB, "topic b failed to load").to.not.equal(null);
    expect(await resolvedModelFor(storeB!, "first query on b"), "topic b must use its own recorded model").to.equal(
      "model-y",
    );

    // The decisive assertion: a genuinely new query on A, after B has embedded.
    const modelUsedByA = await resolvedModelFor(storeA!, "second query on a");
    expect(modelUsedByA, "loading topic B must not re-point topic A's embedder").to.equal("model-x");
    // Asserted after the verdict so a regression reports the model, not the log.
    expect(
      serviceOf(storeA!).embedLog,
      "the third query must actually re-embed rather than hit the query cache",
    ).to.deep.equal(["model-x", "model-x"]);
  });
});

/**
 * A topic must be EXTENDED with the model its existing vectors were built from.
 *
 * Reads were fixed first (see above), but writes still went through the
 * factory's shared service, which is pointed at the CONFIGURED model. Adding a
 * document to a topic built with another model would then mix two embedding
 * spaces into one LanceDB table — persisted corruption, not a recoverable
 * misconfiguration.
 */
describe("VectorStoreFactory per-topic embedding model on writes", function () {
  this.timeout(60000);

  interface WriteFixture {
    addDocument: (topicId: string, content: string) => Promise<void>;
    /** The model of the service that actually produced the written vectors. */
    modelUsedForLastWrite: () => string;
    dispose: () => Promise<void>;
  }

  let fixture: WriteFixture | undefined;

  async function makeWriteFixture(options: {
    topic: string;
    topicModel: string;
    configuredModel: string;
  }): Promise<WriteFixture> {
    const dir = path.join(os.tmpdir(), `vsf-write-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });

    // Every service the write could conceivably embed through: the factory's
    // shared (configured) one, plus every service the registry hands out.
    const services: RecordingEmbeddingService[] = [];
    const configuredService = new RecordingEmbeddingService();
    await configuredService.initialize(options.configuredModel);
    services.push(configuredService);

    const registry = new EmbeddingServiceRegistry({
      createService: () => {
        const service = new RecordingEmbeddingService();
        services.push(service);
        return service as unknown as EmbeddingService;
      },
      maxResidentLocal: 4,
    });
    const factory = new VectorStoreFactory(
      dir,
      options.configuredModel,
      configuredService as unknown as EmbeddingService,
      registry,
    );
    await factory.initialize();

    // The table is stamped with an embedding space this deployment is not
    // configured for — exactly the state a model change leaves behind.
    await factory.createStore({ topicId: options.topic, storageDir: dir });
    await factory.saveStore(options.topic, {
      embeddingModel: options.topicModel,
      embeddingBackend: "huggingface",
      embeddingFingerprint: {
        backendKind: "huggingface",
        providerFormat: "huggingface",
        model: options.topicModel,
        revision: "test",
        dimension: 4,
        endpointHash: "local",
      },
    });
    (factory as any).storeCache.clear();

    let documentCounter = 0;
    let modelOfLastWrite = "";

    return {
      addDocument: async (topicId: string, content: string): Promise<void> => {
        const before = services.map((service) => service.embedLog.length);
        documentCounter += 1;
        await factory.reconcileDocuments(topicId, [
          new LangChainDocument({
            pageContent: content,
            metadata: { documentId: `doc-${documentCounter}`, chunkId: `doc-${documentCounter}-0` },
          }),
        ]);
        // Read the model from the service that ACTUALLY embedded. Reading it
        // from the topic's metadata would report the topic's model whether or
        // not the write path honoured it — a false green.
        const embedders = services.filter((service, index) => service.embedLog.length > (before[index] ?? 0));
        expect(embedders, "exactly one embedding service must have served the write").to.have.length(1);
        modelOfLastWrite = embedders[0].lastEmbedModel;
      },
      modelUsedForLastWrite: () => modelOfLastWrite,
      dispose: async (): Promise<void> => {
        factory.dispose();
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  }

  afterEach(async function () {
    await fixture?.dispose();
    fixture = undefined;
  });

  it("embeds newly added documents with the topic's own model, not the configured one", async function () {
    fixture = await makeWriteFixture({ topic: "t", topicModel: "model-x", configuredModel: "model-y" });
    await fixture.addDocument("t", "some new content");
    expect(fixture.modelUsedForLastWrite(), "the write must use the topic's model, not the configured one").to.equal(
      "model-x",
    );
  });
});

/**
 * Stands in for a real backend. Like HuggingFaceBackend, an explicitly named
 * model it does not know is a hard failure with no fallback — that is what
 * turns a mispaired (model, backend) into a thrown error rather than silence.
 */
class StubBackend implements EmbeddingBackend {
  public initializeCalls: Array<string | undefined> = [];

  constructor(
    public readonly name: string,
    private readonly modelId: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async initialize(modelName?: string): Promise<void> {
    this.initializeCalls.push(modelName);
    if (modelName && modelName !== this.modelId) {
      throw new Error(`Backend "${this.name}" cannot load model "${modelName}"`);
    }
  }

  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }

  getDimension(): number | null {
    return 4;
  }

  getModelId(): string | null {
    return this.modelId;
  }

  dispose(): void {}
}

/**
 * A VS Code host with the VS Code LM backend active must be able to create a
 * topic. Its model name carries a backend prefix ("vscodeLM:<id>") that only
 * that backend knows how to strip, so createStore has to hand the registry a
 * backend matching the model it passes.
 */
describe("VectorStoreFactory on a vscodeLM host", function () {
  this.timeout(60000);

  const VSCODE_MODEL_ID = "copilot-text-embedding-3-small";
  let factory: VectorStoreFactory;
  let storageDir: string;
  let registryBackends: StubBackend[];

  const vscodeLmConfig: IConfigProvider = {
    get: <T>(key: string, defaultValue: T): T =>
      key === "embeddingBackend" ? ("vscodeLM" as unknown as T) : defaultValue,
  };

  // Mirrors the VS Code root: every service gets both backends, vscodeLM first
  // and HuggingFace last as the fallback, with fresh backend instances.
  const buildService = (collect?: StubBackend[]): EmbeddingService => {
    const service = new EmbeddingService({ config: vscodeLmConfig, notifier: mockNotifier });
    const vscodeLm = new StubBackend("vscodeLM", VSCODE_MODEL_ID);
    collect?.push(vscodeLm);
    service.registerBackend(vscodeLm);
    service.registerBackend(new StubBackend("huggingface", "Xenova/all-MiniLM-L6-v2"));
    return service;
  };

  before(async function () {
    storageDir = path.join(os.tmpdir(), `vsf-vscode-lm-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });

    const embeddingService = buildService();
    await embeddingService.initialize();
    // The prefix is produced by production code, not hard-coded by this test.
    const embeddingModel = embeddingService.getCurrentModel();
    expect(embeddingModel, "the host's model name must carry the backend prefix").to.equal(
      `vscodeLM:${VSCODE_MODEL_ID}`,
    );

    registryBackends = [];
    const embeddingRegistry = new EmbeddingServiceRegistry({
      createService: () => buildService(registryBackends),
      maxResidentLocal: 2,
    });
    factory = new VectorStoreFactory(storageDir, embeddingModel, embeddingService, embeddingRegistry);
    await factory.initialize();
  });

  after(async function () {
    factory?.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("creates a topic whose model carries a backend prefix", async function () {
    await factory.createStore({ topicId: "vscode-lm-topic", storageDir });

    // The prefixed model reached the vscodeLM backend, which stripped it. Had
    // the backend been defaulted, HuggingFace would have been handed
    // "vscodeLM:<id>" and thrown, failing createStore outright.
    expect(registryBackends).to.have.length(1);
    expect(registryBackends[0].initializeCalls).to.deep.equal([VSCODE_MODEL_ID]);

    const metadata = await factory.getStoreMetadata("vscode-lm-topic");
    expect(metadata?.embeddingBackend).to.equal("vscodeLM");
    expect(metadata?.embeddingModel).to.equal(`vscodeLM:${VSCODE_MODEL_ID}`);
  });

  it("resolves the same embedding service when the topic is loaded again", async function () {
    (factory as any).storeCache.clear();
    const store = await factory.loadStore("vscode-lm-topic");
    expect(store, "topic failed to load").to.not.equal(null);
    // createStore and loadStore must agree on the key, or one topic would
    // occupy two cap slots and hold the same model resident twice.
    expect(registryBackends, "loadStore must reuse the service createStore resolved").to.have.length(1);
  });
});

/**
 * A recording service whose fingerprint reports a configurable backend kind and
 * endpoint, so a test can stand a factory up on one endpoint and a topic on
 * another. Counts fingerprint calls: the endpoint probe is a live embed against
 * a remote service and must never run while loading a topic that has no endpoint.
 */
class EndpointRecordingService extends RecordingEmbeddingService {
  public fingerprintCalls = 0;

  constructor(
    private readonly backendKind: string,
    private readonly endpointHash: string,
  ) {
    super();
  }

  public override async getFingerprint(): Promise<Record<string, unknown>> {
    this.fingerprintCalls += 1;
    return {
      backendKind: this.backendKind,
      providerFormat: this.backendKind,
      model: this.currentModel,
      revision: "test",
      dimension: 4,
      endpointHash: this.endpointHash,
    };
  }
}

/**
 * An embedding endpoint carries credentials and is a deployment-level setting,
 * so — unlike the model — it is never resolved per topic. A topic recorded
 * against a different endpoint is refused outright: honouring it would make the
 * server authenticate to an endpoint of the topic's choosing, and an endpoint
 * serving a different model under the same name would silently return vectors
 * from another semantic space.
 */
describe("VectorStoreFactory foreign remote endpoint", function () {
  this.timeout(60000);

  const CONFIGURED_ENDPOINT = "endpoint-bbb";
  const FOREIGN_ENDPOINT = "endpoint-aaa";

  let factory: VectorStoreFactory;
  /** Shares the storage dir, but its endpoint probe has never been made. */
  let probeFactory: VectorStoreFactory;
  let probeService: EndpointRecordingService;
  let storageDir: string;

  const buildFactory = (service: EndpointRecordingService): VectorStoreFactory =>
    new VectorStoreFactory(
      storageDir,
      "remote-model",
      service as unknown as EmbeddingService,
      new EmbeddingServiceRegistry({
        createService: () => new EndpointRecordingService("remote", CONFIGURED_ENDPOINT) as unknown as EmbeddingService,
        maxResidentLocal: 4,
      }),
    );

  before(async function () {
    storageDir = path.join(os.tmpdir(), `vsf-endpoint-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });

    const configuredService = new EndpointRecordingService("remote", CONFIGURED_ENDPOINT);
    await configuredService.initialize("remote-model");
    factory = buildFactory(configuredService);
    await factory.initialize();

    // "same-endpoint" is stamped by createStore from the configured service.
    await factory.createStore({ topicId: "same-endpoint", storageDir });

    // Every other topic is re-stamped to a semantic space this deployment is
    // not configured for.
    await factory.createStore({ topicId: "foreign-endpoint", storageDir });
    await factory.saveStore("foreign-endpoint", {
      embeddingModel: "remote-model",
      embeddingBackend: "remote",
      embeddingFingerprint: {
        backendKind: "remote",
        providerFormat: "openai",
        model: "remote-model",
        revision: "test",
        dimension: 4,
        endpointHash: FOREIGN_ENDPOINT,
      },
    });

    await factory.createStore({ topicId: "local-topic", storageDir });
    await factory.saveStore("local-topic", {
      embeddingModel: "model-x",
      embeddingBackend: "huggingface",
      embeddingFingerprint: {
        backendKind: "huggingface",
        providerFormat: "huggingface",
        model: "model-x",
        revision: "test",
        dimension: 4,
        endpointHash: "local",
      },
    });

    await factory.createStore({ topicId: "vscode-lm-endpoint-topic", storageDir });
    await factory.saveStore("vscode-lm-endpoint-topic", {
      embeddingModel: "vscodeLM:text-embedding-3-small",
      embeddingBackend: "vscodeLM",
      embeddingFingerprint: {
        backendKind: "vscodeLM",
        providerFormat: "vscodeLM",
        model: "text-embedding-3-small",
        revision: "test",
        dimension: 4,
        endpointHash: "local",
      },
    });

    // Drop the stores cached by createStore so every topic loads from metadata.
    (factory as any).storeCache.clear();

    probeService = new EndpointRecordingService("remote", CONFIGURED_ENDPOINT);
    await probeService.initialize("remote-model");
    probeFactory = buildFactory(probeService);
    await probeFactory.initialize();
  });

  after(async function () {
    factory?.dispose();
    probeFactory?.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("refuses a topic recorded against a different remote endpoint", async function () {
    let error: unknown;
    try {
      await factory.loadStore("foreign-endpoint");
    } catch (caught) {
      error = caught;
    }

    // The refusal must ESCAPE loadStore's catch-all. Swallowed, it becomes a
    // null store — indistinguishable from an empty topic, and on the ingestion
    // path that null makes documentPipeline drop the table and rebuild it
    // against this deployment's endpoint.
    expect(error, "the endpoint refusal was swallowed and degraded into a null store").to.be.instanceOf(
      EmbeddingEndpointMismatchError,
    );
    const mismatch = error as EmbeddingEndpointMismatchError;
    expect(mismatch.topicId).to.equal("foreign-endpoint");
    expect(mismatch.expected).to.equal(FOREIGN_ENDPOINT);
    expect(mismatch.actual).to.equal(CONFIGURED_ENDPOINT);
    expect(mismatch.message).to.contain("foreign-endpoint");
    expect(mismatch.message).to.contain(FOREIGN_ENDPOINT);
    expect(mismatch.message).to.contain(CONFIGURED_ENDPOINT);
  });

  it("loads a topic recorded against the same remote endpoint", async function () {
    expect(await factory.loadStore("same-endpoint"), "a matching endpoint must not be refused").to.not.equal(null);
  });

  it("does not apply the endpoint check to local topics, and never probes the endpoint", async function () {
    expect(
      await probeFactory.loadStore("local-topic"),
      "local topics carry endpointHash 'local' and must load",
    ).to.not.equal(null);
    // Asserted HERE, in the test that performs the load, rather than in a test
    // of its own: standing alone it would pass vacuously whenever no load had
    // run — under `--grep`, `.only`, or any reordering.
    // getFingerprint() performs a live embed. Probing it once per store load
    // for backends that have no endpoint is both wasteful and, offline, fatal.
    expect(probeService.fingerprintCalls, "loading a local topic must not probe the endpoint").to.equal(0);
  });

  it("does not apply the endpoint check to vscodeLM topics, and never probes the endpoint", async function () {
    // vscodeLM is cap-exempt (it holds no weights) but has NO configurable
    // endpoint. Gating the refusal on isCapExempt rather than hasRemoteEndpoint
    // would compare this topic's "local" against the configured endpoint and
    // refuse it.
    expect(
      await probeFactory.loadStore("vscode-lm-endpoint-topic"),
      "a vscodeLM topic has no endpoint and must load",
    ).to.not.equal(null);
    expect(probeService.fingerprintCalls, "loading a vscodeLM topic must not probe the endpoint").to.equal(0);
  });
});

/**
 * Reports a per-model dimension, so a test can tell "the dimension the TOPIC's
 * own model produces" apart from "the dimension the CONFIGURED model produces".
 */
class DimensionRecordingService extends RecordingEmbeddingService {
  constructor(private readonly dimensions: Record<string, number>) {
    super();
  }

  public override async getFingerprint(): Promise<Record<string, unknown>> {
    const base = await super.getFingerprint();
    return { ...base, dimension: this.dimensions[this.currentModel] ?? 4 };
  }
}

/**
 * Now that a topic is both read AND written with the model its metadata
 * records, "the configured model has a different name" is ordinary
 * configuration drift, not corruption, and must no longer block ingestion.
 *
 * What must still bite are the conditions no per-topic routing can reconcile:
 * a table whose vectors have a different dimension than its own model now
 * produces, and migrated vectors whose embedding space cannot be verified at all.
 */
describe("VectorStoreFactory embedding-model guard", function () {
  this.timeout(60000);

  const CONFIGURED_MODEL = "model-y";
  let storageDir: string;
  let factories: VectorStoreFactory[];

  /** Fingerprint of a local huggingface topic. */
  const fingerprintOf = (model: string, dimension: number): Record<string, unknown> => ({
    backendKind: "huggingface",
    providerFormat: "huggingface",
    model,
    revision: "test",
    dimension,
    endpointHash: "local",
  });

  async function writeMetadata(topicId: string, overrides: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(storageDir, `vector-${topicId}-metadata.json`),
      JSON.stringify({
        schemaVersion: STORAGE_FORMAT_VERSION,
        topicId,
        documentCount: 1,
        chunkCount: 1,
        embeddingBackend: "huggingface",
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
      }),
    );
  }

  /** A factory configured for CONFIGURED_MODEL, whose services report `dimensions` per model. */
  async function makeFactory(dimensions: Record<string, number> = {}): Promise<VectorStoreFactory> {
    const configured = new DimensionRecordingService(dimensions);
    await configured.initialize(CONFIGURED_MODEL);
    const factory = new VectorStoreFactory(
      storageDir,
      CONFIGURED_MODEL,
      configured as unknown as EmbeddingService,
      new EmbeddingServiceRegistry({
        createService: () => new DimensionRecordingService(dimensions) as unknown as EmbeddingService,
        maxResidentLocal: 4,
      }),
    );
    await factory.initialize();
    factories.push(factory);
    return factory;
  }

  async function makeFactoryWithTopics(topics: Record<string, string>): Promise<VectorStoreFactory> {
    for (const [topicId, model] of Object.entries(topics)) {
      await writeMetadata(topicId, { embeddingModel: model, embeddingFingerprint: fingerprintOf(model, 4) });
    }
    return makeFactory();
  }

  async function makeFactoryWithDimensionMismatch(topicId: string): Promise<VectorStoreFactory> {
    // The table holds 8-dimensional vectors, but "model-x" now yields 4.
    await writeMetadata(topicId, {
      embeddingModel: "model-x",
      embeddingFingerprint: fingerprintOf("model-x", 8),
    });
    return makeFactory();
  }

  /**
   * A migrated topic backed by a REAL table, so adoption's dimension check has
   * something genuine to fail against: the table is built at CONFIGURED_MODEL's
   * dimension (4), but "model-x" -- the topic's own recorded model -- now
   * yields 8. Adoption must resolve model-x, discover the mismatch, and refuse;
   * it must never fall back to trusting the flag alone.
   */
  async function makeFactoryWithUnfingerprintedVectors(topicId: string): Promise<VectorStoreFactory> {
    const factory = await makeFactory({ [CONFIGURED_MODEL]: 4, "model-x": 8 });
    await factory.createStore({ topicId, storageDir });
    await writeMetadata(topicId, {
      embeddingModel: "model-x",
      migrationRequiresFingerprintOnReindex: true,
    });
    return factory;
  }

  /**
   * The reindex FLAG alone, with a stale-but-present fingerprint that *claims*
   * to match the real table -- proving the flag forces re-verification through
   * adoption rather than letting a recorded-but-untrustworthy fingerprint wave
   * the write through.
   *
   * Pins the first disjunct of the write-path guard on its own: with a
   * fingerprint recorded, the missing-fingerprint disjunct cannot carry the
   * refusal, so only the flag can route the mutation through adoption, which
   * then genuinely refuses because model-x now yields 8, not the table's 4.
   */
  async function makeFactoryWithReindexFlagOnly(topicId: string): Promise<VectorStoreFactory> {
    const factory = await makeFactory({ [CONFIGURED_MODEL]: 4, "model-x": 8 });
    await factory.createStore({ topicId, storageDir });
    await writeMetadata(topicId, {
      embeddingModel: "model-x",
      // Stale: claims to match the table (4), but model-x now yields 8.
      embeddingFingerprint: fingerprintOf("model-x", 4),
      migrationRequiresFingerprintOnReindex: true,
    });
    return factory;
  }

  /**
   * A MISSING fingerprint alone, with the reindex flag clear, against a REAL
   * table whose dimension model-x no longer matches.
   *
   * Pins the second disjunct on its own: with the flag down, only the absent
   * fingerprint can route the mutation through adoption, which then genuinely
   * refuses on the real dimension mismatch.
   */
  async function makeFactoryWithMissingFingerprintOnly(topicId: string): Promise<VectorStoreFactory> {
    const factory = await makeFactory({ [CONFIGURED_MODEL]: 4, "model-x": 8 });
    await factory.createStore({ topicId, storageDir });
    await writeMetadata(topicId, {
      embeddingModel: "model-x",
      migrationRequiresFingerprintOnReindex: false,
    });
    return factory;
  }

  /** A single document, enough to get past reconcileDocuments' empty-input early return. */
  const oneDocument = (): LangChainDocument[] => [
    new LangChainDocument({
      pageContent: "text",
      metadata: { documentId: "doc-1", chunkId: "chunk-1", source: "s" },
    }),
  ];

  const rejectionOf = async (operation: () => Promise<unknown>): Promise<Error | undefined> => {
    try {
      await operation();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  beforeEach(async function () {
    factories = [];
    storageDir = path.join(os.tmpdir(), `vsf-guard-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });
  });

  afterEach(async function () {
    for (const factory of factories) {
      factory.dispose();
    }
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("allows adding documents to a topic whose model differs from the configured one", async function () {
    const factory = await makeFactoryWithTopics({ t: "model-x" });
    expect(
      await rejectionOf(() => factory.validateEmbeddingModel("t")),
      "a differing model name is not corruption",
    ).to.equal(undefined);
  });

  it("compares the dimension against the topic's own model, not the configured one", async function () {
    // The decisive case: two models of DIFFERENT dimension, both correct.
    // Comparing the table's 8 against the configured model's 4 would refuse
    // every legitimately different model and re-break the feature.
    await writeMetadata("big", { embeddingModel: "model-big", embeddingFingerprint: fingerprintOf("model-big", 8) });
    const factory = await makeFactory({ "model-big": 8, [CONFIGURED_MODEL]: 4 });
    expect(
      await rejectionOf(() => factory.validateEmbeddingModel("big")),
      "the topic's own model produces 8 dimensions, exactly what the table holds",
    ).to.equal(undefined);
  });

  it("still throws on a dimension mismatch", async function () {
    const factory = await makeFactoryWithDimensionMismatch("t");
    const error = await rejectionOf(() => factory.validateEmbeddingModel("t"));
    expect(error, "a dimension mismatch is corruption and must still be refused").to.be.instanceOf(Error);
    expect(error?.message).to.match(/dimension/i);
  });

  it("still throws on migrated vectors with no verifiable fingerprint", async function () {
    const factory = await makeFactoryWithUnfingerprintedVectors("t");
    const error = await rejectionOf(() => factory.validateEmbeddingModel("t"));
    expect(error, "unverifiable vectors must still be quarantined").to.be.instanceOf(EmbeddingReindexRequiredError);
    expect(error?.message).to.match(/reindex/i);
  });

  // The two tests below pin the write-path guard's disjuncts SEPARATELY.
  //
  // A fixture that sets the reindex flag AND omits the fingerprint satisfies
  // both conditions at once, so removing either one leaves it green and neither
  // is actually pinned. Each test below satisfies exactly one condition.
  //
  // They go through reconcileDocuments — the real mutation entry point —
  // deliberately: validateEmbeddingModel carries a second, independent
  // missing-fingerprint throw right after the guard, which would keep a
  // fingerprint-only test green even with the guard's disjunct deleted.
  // reconcileDocuments has no such safety net; past the guard it reaches
  // LanceDB, and these fixtures have no table, so a lapsed guard surfaces as a
  // different error and the assertion on the error TYPE turns red.

  it("refuses a mutation on a topic flagged for reindex even when its fingerprint is present", async function () {
    const factory = await makeFactoryWithReindexFlagOnly("t");
    const error = await rejectionOf(() => factory.reconcileDocuments("t", oneDocument()));
    expect(error, "the reindex flag alone must refuse the write").to.be.instanceOf(EmbeddingReindexRequiredError);
    expect(error?.message).to.match(/reindex/i);
  });

  it("refuses a mutation on a topic with no fingerprint even when the reindex flag is clear", async function () {
    const factory = await makeFactoryWithMissingFingerprintOnly("t");
    const error = await rejectionOf(() => factory.reconcileDocuments("t", oneDocument()));
    expect(error, "an absent fingerprint alone must refuse the write").to.be.instanceOf(EmbeddingReindexRequiredError);
    expect(error?.message).to.match(/reindex/i);
  });
});

/**
 * The migrator (and the read-path legacy adopter) never invent a fingerprint —
 * they stamp `migrationRequiresFingerprintOnReindex: true` and leave the topic
 * permanently unwritable. This is where that dead end turns into self-healing:
 * a migrated topic's first write resolves its OWN recorded model, verifies its
 * dimension against the REAL live table, and only then stamps the fingerprint
 * the migrator refused to invent. A genuine mismatch still refuses.
 */
describe("fingerprint adoption on first write", function () {
  this.timeout(60000);

  const CONFIGURED_MODEL = "model-x";
  const TEST_DIMENSION = 4;
  let storageDir: string;
  let factory: VectorStoreFactory;
  let topicId: string;
  let metadataPath: string;
  let dimensions: Record<string, number>;

  beforeEach(async function () {
    storageDir = path.join(os.tmpdir(), `vsf-adopt-${crypto.randomUUID()}`);
    await fs.mkdir(storageDir, { recursive: true });

    // Mutable and shared by reference with every service the registry hands
    // out, so a test can change what CONFIGURED_MODEL yields AFTER the real
    // table has already been built at the original dimension.
    dimensions = { [CONFIGURED_MODEL]: TEST_DIMENSION };
    const configured = new DimensionRecordingService(dimensions);
    await configured.initialize(CONFIGURED_MODEL);
    factory = new VectorStoreFactory(
      storageDir,
      CONFIGURED_MODEL,
      configured as unknown as EmbeddingService,
      new EmbeddingServiceRegistry({
        createService: () => new DimensionRecordingService(dimensions) as unknown as EmbeddingService,
        maxResidentLocal: 4,
      }),
    );
    await factory.initialize();

    // A REAL LanceDB table, built normally at TEST_DIMENSION.
    topicId = "migrated-topic";
    await factory.createStore({ topicId, storageDir });
    metadataPath = path.join(storageDir, `vector-${topicId}-metadata.json`);
    // Drop the cached store so every call below re-reads metadata from disk.
    (factory as any).storeCache.clear();
  });

  afterEach(async function () {
    factory?.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("stamps the fingerprint and clears the migration flag when dimensions match", async function () {
    // Arrange: rewrite the normally-created metadata into the migrated shape:
    // fingerprint removed, flag set. (getStoreMetadata reads the JSON from
    // disk on every call, so no cache invalidation is needed beyond the clear
    // in beforeEach.)
    const raw = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    delete raw.embeddingFingerprint;
    raw.migrationRequiresFingerprintOnReindex = true;
    await fs.writeFile(metadataPath, JSON.stringify(raw));

    await factory.validateEmbeddingModel(topicId); // must NOT throw

    const healed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    expect(healed.migrationRequiresFingerprintOnReindex).to.equal(false);
    expect(healed.embeddingFingerprint).to.be.an("object");
    expect(healed.embeddingFingerprint.dimension).to.equal(TEST_DIMENSION);
  });

  it("still refuses when the topic's model produces a different dimension", async function () {
    const raw = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    delete raw.embeddingFingerprint;
    raw.migrationRequiresFingerprintOnReindex = true;
    await fs.writeFile(metadataPath, JSON.stringify(raw));

    // The real table stays at TEST_DIMENSION; the topic's own model now
    // yields something else. A genuine, verified mismatch.
    dimensions[CONFIGURED_MODEL] = TEST_DIMENSION + 8;

    let error: unknown;
    try {
      await factory.validateEmbeddingModel(topicId);
      expect.fail("should have thrown");
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).name).to.equal("EmbeddingReindexRequiredError");
    const untouched = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    expect(untouched.migrationRequiresFingerprintOnReindex).to.equal(true);
  });

  it("adopted pre-v2 metadata heals the same way (schemaVersion absent on disk)", async function () {
    const raw = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const legacy = {
      topicId: raw.topicId,
      documentCount: raw.documentCount,
      chunkCount: raw.chunkCount,
      embeddingModel: raw.embeddingModel,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
    await fs.writeFile(metadataPath, JSON.stringify(legacy));

    await factory.validateEmbeddingModel(topicId);

    const healed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    expect(healed.schemaVersion).to.equal(STORAGE_FORMAT_VERSION);
    expect(healed.migrationRequiresFingerprintOnReindex).to.equal(false);
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
