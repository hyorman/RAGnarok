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
    get: <T>(key: string, defaultValue: T): T => (key === "embeddingBackend" ? ("vscodeLM" as unknown as T) : defaultValue),
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

  it("does not apply the endpoint check to local topics", async function () {
    expect(
      await probeFactory.loadStore("local-topic"),
      "local topics carry endpointHash 'local' and must load",
    ).to.not.equal(null);
  });

  it("does not apply the endpoint check to vscodeLM topics", async function () {
    // vscodeLM is cap-exempt (it holds no weights) but has NO configurable
    // endpoint. Gating the refusal on isCapExempt rather than hasRemoteEndpoint
    // would compare this topic's "local" against the configured endpoint and
    // refuse it.
    expect(
      await probeFactory.loadStore("vscode-lm-endpoint-topic"),
      "a vscodeLM topic has no endpoint and must load",
    ).to.not.equal(null);
  });

  it("never probes the configured endpoint while loading a topic that has no endpoint", async function () {
    // getFingerprint() performs a live embed. Probing it once per store load
    // for backends that have no endpoint is both wasteful and, offline, fatal.
    expect(probeService.fingerprintCalls, "loading endpointless topics must not probe the endpoint").to.equal(0);
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
