import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  EmbeddingFingerprintMismatchError,
  EmbeddingReindexRequiredError,
  KnowledgeGraphCorruptionError,
  TopicManager,
  VectorStoreMetadataCorruptionError,
  type IConfigProvider,
  type INotifier,
} from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { PipelineOptions, PipelineResult, PipelineSourceDocument } from "../src/managers/documentPipeline";
import type { KnowledgeGraphData } from "../src/utils/graphTypes";
import type { Document as TopicDocument, Topic, TopicsIndex } from "../src/utils/types";

const topicId = "topic-ingestion";

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

interface FakeVectorStore {
  rows: LangChainDocument[];
  removedDocumentIds: string[];
  removeFailuresRemaining: number;
  getAllDocuments(topic: string, limit: number): Promise<LangChainDocument[]>;
  getDocumentChunkCount(topic: string, documentId: string): Promise<number>;
  removeDocument(topic: string, documentId: string): Promise<string[]>;
  getStoredStats(topic: string): Promise<{ documentCount: number; chunkCount: number }>;
  getStoreMetadata(topic: string): Promise<Record<string, unknown> | null>;
  saveStore(topic: string, metadata: Record<string, unknown>): Promise<void>;
  dispose(): void;
}

function fakeVectorStore(): FakeVectorStore {
  const store: FakeVectorStore = {
    rows: [],
    removedDocumentIds: [],
    removeFailuresRemaining: 0,
    async getAllDocuments(_topic, limit) {
      return this.rows.slice(0, limit);
    },
    async getDocumentChunkCount(_topic, documentId) {
      return this.rows.filter((row) => row.metadata.documentId === documentId).length;
    },
    async removeDocument(_topic, documentId) {
      if (this.removeFailuresRemaining > 0) {
        this.removeFailuresRemaining -= 1;
        throw new Error("injected cleanup failure");
      }
      this.removedDocumentIds.push(documentId);
      const removed = this.rows.filter((row) => row.metadata.documentId === documentId);
      this.rows = this.rows.filter((row) => row.metadata.documentId !== documentId);
      return removed.map((row) => String(row.metadata.chunkId));
    },
    async getStoredStats() {
      return {
        documentCount: new Set(this.rows.map((row) => String(row.metadata.documentId))).size,
        chunkCount: this.rows.length,
      };
    },
    async getStoreMetadata() {
      return null;
    },
    async saveStore() {
      return;
    },
    dispose() {
      return;
    },
  };
  return store;
}

function createManager(storageDir: string, vectorStore: FakeVectorStore): TopicManager {
  const embeddingService = {
    getCurrentModel: () => "test-model",
  } as unknown as EmbeddingService;
  const Manager = TopicManager as unknown as new (options: {
    storageDir: string;
    config: IConfigProvider;
    notifier: INotifier;
    embeddingService: EmbeddingService;
  }) => TopicManager;
  const manager = new Manager({ storageDir, config, notifier, embeddingService });
  const topic: Topic = {
    id: topicId,
    name: "Ingestion",
    createdAt: 1,
    updatedAt: 1,
    documentCount: 0,
  };
  const index: TopicsIndex = {
    topics: { [topicId]: topic },
    modelName: "test-model",
    lastUpdated: 1,
  };
  (manager as any).topicsIndex = index;
  (manager as any).topicDocuments = new Map([[topicId, new Map<string, TopicDocument>()]]);
  (manager as any).vectorStoreFactory = vectorStore;
  return manager;
}

function source(
  documentId: string,
  canonicalSource: string,
  chunkCount: number,
  sourceType = "file",
): PipelineSourceDocument {
  return {
    documentId,
    canonicalSource,
    sourceType,
    sourceRevision: `revision-${documentId}`,
    fileName: path.basename(canonicalSource),
    filePath: canonicalSource,
    fileType: canonicalSource.endsWith(".md") ? "markdown" : "text",
    chunkCount,
  };
}

function result(sourceDocuments: PipelineSourceDocument[], graphExtracted = false): PipelineResult {
  const chunks = sourceDocuments.flatMap((item) =>
    Array.from(
      { length: item.chunkCount },
      (_, index) =>
        new LangChainDocument({
          pageContent: `${item.documentId}-${index}`,
          metadata: {
            documentId: item.documentId,
            chunkId: `${item.documentId}-chunk-${index}`,
            source: item.canonicalSource,
            sourceType: item.sourceType,
            sourceRevision: item.sourceRevision,
            fileName: item.fileName,
            filePath: item.filePath,
            fileType: item.fileType,
          },
        }),
    ),
  );
  return {
    success: true,
    stages: {
      loading: true,
      chunking: true,
      extracting: graphExtracted,
      embedding: true,
      storing: true,
    },
    metadata: {
      originalDocuments: sourceDocuments.length,
      chunksCreated: chunks.length,
      chunksEmbedded: chunks.length,
      chunksStored: chunks.length,
      entitiesExtracted: graphExtracted ? 1 : 0,
      relationshipsExtracted: 0,
      totalTime: 1,
      stageTimings: { loading: 0, chunking: 0, extracting: 0, embedding: 0, storing: 0 },
      graphExtracted,
      partial: false,
      sourceDocuments,
      warnings: [],
    },
    chunks,
  };
}

function persistRows(store: FakeVectorStore, pipelineResult: PipelineResult, transactionId: string): void {
  const affected = new Set(pipelineResult.metadata.sourceDocuments?.map((item) => item.documentId) ?? []);
  store.rows = store.rows.filter((row) => !affected.has(String(row.metadata.documentId)));
  store.rows.push(
    ...pipelineResult.chunks.map(
      (chunk) =>
        new LangChainDocument({
          pageContent: chunk.pageContent,
          metadata: { ...chunk.metadata, ingestionTransactionId: transactionId },
        }),
    ),
  );
}

function installPipeline(
  manager: TopicManager,
  store: FakeVectorStore,
  producer: (input: string, options: PipelineOptions) => PipelineResult | Promise<PipelineResult>,
): void {
  (manager as any).documentPipeline = {
    processDocument: async (input: string, _topic: string, options: PipelineOptions) => {
      const pipelineResult = await producer(input, options);
      persistRows(store, pipelineResult, options.ingestionTransactionId!);
      return pipelineResult;
    },
  };
}

async function readJournal(storageDir: string): Promise<any[]> {
  return JSON.parse(await fs.readFile(path.join(storageDir, "database", "ingestion-journal.json"), "utf8"));
}

describe("TopicManager durable expanded-source ingestion", function () {
  let storageDir: string;
  let vectorStore: FakeVectorStore;

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-ingestion-test-"));
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    vectorStore = fakeVectorStore();
  });

  afterEach(async function () {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("publishes one directory leaf per source and precisely prunes and removes the container", async function () {
    const manager = createManager(storageDir, vectorStore);
    const directory = path.join(storageDir, "docs");
    const first = [
      source("leaf-a", path.join(directory, "a.md"), 2),
      source("leaf-b", path.join(directory, "b.txt"), 1),
    ];
    let nextResult = result(first);
    installPipeline(manager, vectorStore, () => nextResult);

    const added = await manager.addDocuments(topicId, [directory]);
    expect(added.map((item) => item.document.id)).to.have.members(["leaf-a", "leaf-b"]);
    expect(added.map((item) => item.document.chunkCount)).to.deep.equal([2, 1]);
    expect(new Set(added.map((item) => item.document.containerId)).size).to.equal(1);
    const containerId = added[0].document.containerId!;
    expect(manager.listDocuments(topicId)).to.have.length(2);

    nextResult = result([source("leaf-a", path.join(directory, "a.md"), 1)]);
    const reindexed = await manager.addDocuments(topicId, [directory]);
    expect(reindexed).to.have.length(1);
    expect(manager.listDocuments(topicId).map((document) => document.id)).to.deep.equal(["leaf-a"]);
    expect(vectorStore.removedDocumentIds).to.include("leaf-b");

    const removed = await manager.removeDocument(topicId, containerId);
    expect(removed.document.id).to.equal("leaf-a");
    expect(removed.chunksRemoved).to.equal(1);
    expect(manager.listDocuments(topicId)).to.deep.equal([]);
    expect(vectorStore.rows).to.deep.equal([]);
  });

  it("publishes every GitHub repository leaf with repository and canonical-leaf provenance", async function () {
    const manager = createManager(storageDir, vectorStore);
    const repository = "https://github.com/example/project";
    const sources = [
      source("github-readme", `${repository}/blob/main/README.md`, 2, "github"),
      source("github-code", `${repository}/blob/main/src/index.ts`, 3, "github"),
    ];
    installPipeline(manager, vectorStore, () => result(sources, true));

    const added = await manager.addSources(topicId, [{ type: "github", url: repository, branch: "main" }]);
    expect(added).to.have.length(2);
    expect(added.map((item) => item.document.canonicalSource)).to.deep.equal(
      sources.map((item) => item.canonicalSource),
    );
    for (const item of added) {
      expect(item.document.source).to.deep.equal({ type: "github", url: repository, branch: "main" });
      expect(item.document.containerId).to.be.a("string").and.not.equal(item.document.id);
    }
  });

  it("retains a durable-stage journal after metadata failure and recovers it after restart", async function () {
    const manager = createManager(storageDir, vectorStore);
    const leaf = source("durable-leaf", path.join(storageDir, "durable.md"), 2);
    installPipeline(manager, vectorStore, () => result([leaf], true));
    (manager as any).saveTopicDocuments = async () => {
      throw new Error("injected metadata failure");
    };

    expect(await manager.addDocuments(topicId, [leaf.canonicalSource])).to.deep.equal([]);
    const pending = await readJournal(storageDir);
    expect(pending).to.have.length(1);
    expect(pending[0].stage).to.equal("graphCommitted");

    const restarted = createManager(storageDir, vectorStore);
    await (restarted as any).recoverIngestionJournal();
    expect(restarted.listDocuments(topicId)).to.have.length(1);
    expect(restarted.listDocuments(topicId)[0]).to.include({
      id: "durable-leaf",
      chunkCount: 2,
      canonicalSource: leaf.canonicalSource,
    });
    expect(await readJournal(storageDir)).to.deep.equal([]);

    await (restarted as any).recoverIngestionJournal();
    expect(restarted.listDocuments(topicId)).to.have.length(1);
  });

  it("rethrows typed safety failures instead of converting them into per-file success outcomes", async function () {
    const safetyFailures = [
      new EmbeddingReindexRequiredError(topicId),
      new VectorStoreMetadataCorruptionError(topicId, "missing"),
      new EmbeddingFingerprintMismatchError(topicId, "fingerprint mismatch"),
      new KnowledgeGraphCorruptionError("graph metadata is torn"),
    ];

    for (const failure of safetyFailures) {
      const manager = createManager(storageDir, vectorStore);
      (manager as any).documentPipeline = {
        processDocument: async () => {
          throw failure;
        },
      };
      let caught: unknown;
      try {
        await manager.addDocuments(topicId, [path.join(storageDir, "unsafe.txt")]);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.equal(failure);
    }
  });

  it("keeps ordinary per-file failures as empty outcomes for callers to report", async function () {
    const manager = createManager(storageDir, vectorStore);
    (manager as any).documentPipeline = {
      processDocument: async () => {
        throw new Error("ordinary loader failure");
      },
    };
    expect(await manager.addDocuments(topicId, [path.join(storageDir, "missing.txt")])).to.deep.equal([]);
  });

  it("recovers a cancelled starter only from transaction-tagged durable rows", async function () {
    const manager = createManager(storageDir, vectorStore);
    const controller = new AbortController();
    const leaf = source("cancelled-leaf", path.join(storageDir, "cancelled.txt"), 1);
    installPipeline(manager, vectorStore, (_input, options) => {
      const pipelineResult = result([leaf]);
      persistRows(vectorStore, pipelineResult, options.ingestionTransactionId!);
      controller.abort(new DOMException("cancelled", "AbortError"));
      options.signal?.throwIfAborted();
      return pipelineResult;
    });
    // This pipeline persists explicitly before aborting; avoid the helper's
    // second persistence because the producer rejects before returning.
    let caught: unknown;
    try {
      await manager.addDocuments(topicId, [leaf.canonicalSource], { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(DOMException);
    expect(manager.listDocuments(topicId)).to.deep.equal([]);
    expect((await readJournal(storageDir))[0].stage).to.equal("started");

    const restarted = createManager(storageDir, vectorStore);
    await (restarted as any).recoverIngestionJournal();
    expect(restarted.listDocuments(topicId).map((document) => document.id)).to.deep.equal(["cancelled-leaf"]);
    expect(await readJournal(storageDir)).to.deep.equal([]);
  });

  it("rolls back an uncommitted starter with no durable vector evidence", async function () {
    const manager = createManager(storageDir, vectorStore);
    const transactionId = "ingest-undurable";
    const planned: TopicDocument = {
      id: "container-undurable",
      topicId,
      name: "missing.txt",
      filePath: "/missing.txt",
      fileType: "text",
      source: { type: "file", path: "/missing.txt" },
      addedAt: 1,
      chunkCount: 0,
      containerId: "container-undurable",
    };
    await (manager as any).upsertIngestionJournal({
      id: `${transactionId}:container`,
      transactionId,
      containerId: planned.id,
      topicId,
      stage: "started",
      document: planned,
      updatedAt: 1,
    });

    await (manager as any).recoverIngestionJournal();
    expect(manager.listDocuments(topicId)).to.deep.equal([]);
    expect(await readJournal(storageDir)).to.deep.equal([]);
  });

  it("serializes concurrent graph mutations so both entity additions survive", async function () {
    const manager = createManager(storageDir, vectorStore);
    let graphData: KnowledgeGraphData | null = null;
    const graphStore = {
      hasGraph: async () => graphData !== null,
      loadGraph: async () => (graphData ? structuredClone(graphData) : null),
      saveGraph: async (_topic: string, data: KnowledgeGraphData) => {
        graphData = structuredClone(data);
      },
    };
    (manager as any).knowledgeGraphStore = graphStore;
    const entity = (id: string) => ({
      id,
      name: id,
      type: "concept" as const,
      description: id,
      vector: [1],
      sourceChunkIds: [`chunk-${id}`],
      confidence: 1,
      strength: 1,
      lastAccessedAt: 1,
      metadata: {},
    });

    await Promise.all([
      manager.mutateKnowledgeGraph(topicId, async (graph) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        graph.addEntity(entity("one"));
      }),
      manager.mutateKnowledgeGraph(topicId, (graph) => {
        graph.addEntity(entity("two"));
      }),
    ]);

    const savedGraph = graphData as KnowledgeGraphData | null;
    expect(savedGraph?.entities.map((item) => item.id)).to.have.members(["one", "two"]);
  });

  it("fails graph mutation closed when the latest graph cannot be loaded", async function () {
    const manager = createManager(storageDir, vectorStore);
    let saveCalled = false;
    (manager as any).knowledgeGraphStore = {
      hasGraph: async () => true,
      loadGraph: async () => {
        throw new Error("injected graph read failure");
      },
      saveGraph: async () => {
        saveCalled = true;
      },
    };

    let caught: unknown;
    try {
      await manager.mutateKnowledgeGraph(topicId, (graph) => graph);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal("injected graph read failure");
    expect(saveCalled).to.equal(false);
  });

  it("removes vector and graph provenance without orphaning shared entities", async function () {
    const manager = createManager(storageDir, vectorStore);
    const containerId = "container";
    const documents = new Map<string, TopicDocument>([
      [
        "leaf-one",
        {
          id: "leaf-one",
          topicId,
          name: "one.txt",
          filePath: "/docs/one.txt",
          fileType: "text",
          addedAt: 1,
          chunkCount: 1,
          containerId,
        },
      ],
      [
        "leaf-two",
        {
          id: "leaf-two",
          topicId,
          name: "two.txt",
          filePath: "/docs/two.txt",
          fileType: "text",
          addedAt: 1,
          chunkCount: 1,
          containerId,
        },
      ],
    ]);
    (manager as any).topicDocuments.set(topicId, documents);
    vectorStore.rows = [
      new LangChainDocument({
        pageContent: "one",
        metadata: { documentId: "leaf-one", chunkId: "chunk-one", source: "/docs/one.txt" },
      }),
      new LangChainDocument({
        pageContent: "two",
        metadata: { documentId: "leaf-two", chunkId: "chunk-two", source: "/docs/two.txt" },
      }),
    ];
    const entity = (id: string, sourceChunkIds: string[]) => ({
      id,
      name: id,
      type: "concept" as const,
      description: id,
      vector: [1],
      sourceChunkIds,
      confidence: 1,
      strength: 1,
      lastAccessedAt: 1,
      metadata: {},
    });
    let graphData: KnowledgeGraphData = {
      entities: [entity("removed-only", ["chunk-one"]), entity("shared", ["chunk-one", "chunk-two"])],
      relationships: [],
      communities: [],
      metadata: {
        topicId,
        createdAt: 1,
        updatedAt: 1,
        entityCount: 2,
        edgeCount: 0,
        communityCount: 0,
        embeddingModel: "test-model",
      },
    };
    (manager as any).knowledgeGraphStore = {
      hasGraph: async () => true,
      loadGraph: async () => structuredClone(graphData),
      saveGraph: async (_topic: string, data: KnowledgeGraphData) => {
        graphData = structuredClone(data);
      },
    };

    await manager.removeDocument(topicId, "leaf-one");
    expect(vectorStore.rows.map((row) => row.metadata.documentId)).to.deep.equal(["leaf-two"]);
    expect(graphData.entities.map((item) => item.id)).to.deep.equal(["shared"]);
    expect(graphData.entities[0].sourceChunkIds).to.deep.equal(["chunk-two"]);
  });

  it("expands legacy directory metadata on removal to avoid vector orphans", async function () {
    const manager = createManager(storageDir, vectorStore);
    const directory = path.join(storageDir, "legacy");
    const legacy: TopicDocument = {
      id: "legacy-container",
      topicId,
      name: "legacy",
      filePath: directory,
      fileType: "text",
      source: { type: "file", path: directory },
      addedAt: 1,
      chunkCount: 2,
    };
    (manager as any).topicDocuments.set(topicId, new Map([[legacy.id, legacy]]));
    vectorStore.rows = [
      new LangChainDocument({
        pageContent: "a",
        metadata: {
          documentId: "legacy-a",
          chunkId: "legacy-a-1",
          source: path.join(directory, "a.txt"),
        },
      }),
      new LangChainDocument({
        pageContent: "outside",
        metadata: {
          documentId: "outside",
          chunkId: "outside-1",
          source: path.join(storageDir, "outside.txt"),
        },
      }),
    ];

    const removed = await manager.removeDocument(topicId, legacy.id);
    expect(removed.chunksRemoved).to.equal(1);
    expect(vectorStore.removedDocumentIds).to.include("legacy-a");
    expect(vectorStore.rows.map((row) => row.metadata.documentId)).to.deep.equal(["outside"]);
  });

  it("journals a committed document removal and recovers idempotently after cleanup failure", async function () {
    const manager = createManager(storageDir, vectorStore);
    const document: TopicDocument = {
      id: "deferred-leaf",
      topicId,
      name: "deferred.txt",
      filePath: "/docs/deferred.txt",
      fileType: "text",
      addedAt: 1,
      chunkCount: 1,
      containerId: "deferred-container",
    };
    (manager as any).topicDocuments.set(topicId, new Map([[document.id, document]]));
    vectorStore.rows = [
      new LangChainDocument({
        pageContent: "deferred",
        metadata: { documentId: document.id, chunkId: "deferred-chunk", source: document.filePath },
      }),
    ];
    vectorStore.removeFailuresRemaining = 1;

    const removed = await manager.removeDocument(topicId, document.id);
    expect(removed.document.id).to.equal(document.id);
    expect(removed.chunksRemoved).to.equal(0);
    expect(vectorStore.rows).to.have.length(1);
    const journalPath = path.join(storageDir, "database", "post-commit-cleanup-journal.json");
    expect(JSON.parse(await fs.readFile(journalPath, "utf8"))).to.have.length(1);

    await (manager as any).recoverPostCommitCleanupJournal();
    expect(vectorStore.rows).to.deep.equal([]);
    expect(JSON.parse(await fs.readFile(journalPath, "utf8"))).to.deep.equal([]);
    await (manager as any).recoverPostCommitCleanupJournal();
  });

  it("stops mutation admission and awaits an admitted mutation before async disposal", async function () {
    const manager = createManager(storageDir, vectorStore);
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    (manager as any).saveTopicsIndex = async () => {
      saveStarted();
      await gate;
    };
    (manager as any).documentPipeline = { dispose: () => undefined };

    const mutation = manager.updateTopic(topicId, { description: "draining" });
    await started;
    let disposed = false;
    const disposal = manager.dispose().then(() => {
      disposed = true;
    });
    const rejected = await (async () => {
      try {
        await manager.updateTopic(topicId, { description: "too late" });
      } catch (error) {
        return error as Error;
      }
      throw new Error("Expected shutdown admission rejection");
    })();
    expect(rejected.message).to.include("shutting down");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).to.equal(false);

    releaseSave();
    await mutation;
    await disposal;
    expect(disposed).to.equal(true);
  });

  it("allows nested graph work from an admitted operation while rejecting unrelated shutdown work", async function () {
    const manager = createManager(storageDir, vectorStore);
    let releaseOuter!: () => void;
    let outerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      outerStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    let graphSaved = false;
    (manager as any).knowledgeGraphStore = {
      hasGraph: async () => false,
      loadGraph: async () => null,
      saveGraph: async () => {
        graphSaved = true;
      },
      dispose: () => undefined,
    };
    (manager as any).documentPipeline = { dispose: () => undefined };

    const admitted = (manager as any).runManagedOperation(async () => {
      outerStarted();
      await gate;
      await manager.mutateKnowledgeGraph(topicId, () => undefined);
    });
    await started;
    const disposal = manager.dispose();
    const rejected = await (async () => {
      try {
        await manager.mutateKnowledgeGraph(topicId, () => undefined);
      } catch (error) {
        return error as Error;
      }
      throw new Error("Expected shutdown admission rejection");
    })();
    expect(rejected.message).to.include("shutting down");

    releaseOuter();
    await admitted;
    await disposal;
    expect(graphSaved).to.equal(true);
  });
});
