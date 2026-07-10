/**
 * LangGraph ingestion E2E:
 * With the langGraphEnabled flag on, TopicManager.addDocuments must run the
 * LangGraph indexing pipeline — building a persisted topic knowledge graph
 * whose entity sourceChunkIds resolve against the persisted chunks — and the
 * graph must survive a restart and serve graph-strategy retrieval.
 *
 * Uses the real embedding backend (bundled ONNX model) and real LanceDB
 * persistence; only the LLM (entity extraction) is a deterministic mock.
 */

import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  TopicManager,
  EmbeddingService,
  HuggingFaceBackend,
  ModelRegistry,
  RAGAgent,
  RetrievalStrategy,
  DEFAULTS,
  CONFIG,
  INotifier,
  IConfigProvider,
  ILLMProvider,
  ILLMModel,
} from "../src/index";
import { mockLLMProvider, defaultQueryOptions } from "./helpers/testDefaults";
import { mockConfig } from "./helpers/realVectorStore";

const quietNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

/** Config: everything from the shared mock, plus the LangGraph flag ON. */
const langGraphConfig: IConfigProvider = {
  get<T>(key: string, defaultValue: T): T {
    if (key === CONFIG.LANGGRAPH_ENABLED) {
      return true as T;
    }
    return mockConfig.get(key, defaultValue);
  },
};

/** Deterministic extraction LLM: always returns the same entities. */
function createExtractionLLM(): ILLMProvider {
  const model: ILLMModel = {
    id: "extraction-mock",
    family: "test",
    sendRequest: async () => {
      async function* gen() {
        yield JSON.stringify({
          entities: [
            { name: "RAGnarok", type: "technology", description: "A local RAG engine for VS Code" },
            { name: "LanceDB", type: "technology", description: "An embedded vector database" },
          ],
          relationships: [
            {
              source: "RAGnarok",
              target: "LanceDB",
              type: "uses",
              description: "RAGnarok stores vectors in LanceDB",
              weight: 0.9,
            },
          ],
        });
      }
      return gen();
    },
  };
  return {
    selectModel: async () => model,
    isAvailable: async () => true,
  };
}

describe("LangGraph ingestion E2E", function () {
  this.timeout(180000); // real embedding model + LanceDB

  let storageDir: string;
  let docsDir: string;
  let docPath: string;
  let embeddingService: EmbeddingService;

  before(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-e2e-"));
    docsDir = path.join(storageDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    docPath = path.join(docsDir, "ragnarok.md");
    await fs.writeFile(
      docPath,
      [
        "# RAGnarok",
        "",
        "RAGnarok is a local RAG engine for VS Code. It stores document",
        "vectors in LanceDB, an embedded vector database, and retrieves",
        "relevant chunks with hybrid semantic search.",
      ].join("\n"),
      "utf-8",
    );

    embeddingService = new EmbeddingService({ config: langGraphConfig, notifier: quietNotifier });
    const hfBackend = new HuggingFaceBackend(ModelRegistry.getInstance(), quietNotifier);
    embeddingService.registerBackend(hfBackend);
    await embeddingService.initialize(DEFAULTS.EMBEDDING_MODEL);
  });

  after(async function () {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("builds, persists, reloads, and queries a topic knowledge graph", async function () {
    const tmStorage = path.join(storageDir, "tm");

    // ── Ingest with the LangGraph pipeline ──
    const manager = await TopicManager.create({
      storageDir: tmStorage,
      config: langGraphConfig,
      notifier: quietNotifier,
      embeddingService,
      llmProvider: createExtractionLLM(),
    });

    const topic = await manager.createTopic({ name: "langgraph-e2e" });
    const results = await manager.addDocuments(topic.id, [docPath]);

    expect(results, "addDocuments produced no results").to.have.lengthOf(1);
    expect(results[0].pipelineResult.success).to.equal(true);
    expect(results[0].pipelineResult.metadata.entitiesExtracted).to.be.greaterThan(0);

    // Graph persisted for the topic
    const kgStore = manager.getKnowledgeGraphStore();
    expect(kgStore, "no KnowledgeGraphStore on TopicManager").to.not.be.null;
    expect(await kgStore!.hasGraph(topic.id), "topic graph was not persisted").to.equal(true);

    // ── Restart: fresh TopicManager over the same storage ──
    const reloaded = await TopicManager.create({
      storageDir: tmStorage,
      config: langGraphConfig,
      notifier: quietNotifier,
      embeddingService,
      llmProvider: createExtractionLLM(),
    });

    const kg = await reloaded.getKnowledgeGraph(topic.id);
    expect(kg, "knowledge graph did not survive restart").to.not.be.null;

    const entities = kg!.getAllEntities();
    expect(entities.map((e) => e.name)).to.include.members(["RAGnarok", "LanceDB"]);

    // Every entity's sourceChunkIds must resolve against persisted chunks —
    // this is the contract graph retrieval hydration depends on.
    const persistedDocs = await reloaded.getAllDocuments(topic.id, 1000);
    const persistedChunkIds = new Set(
      persistedDocs.map((d) => d.metadata?.chunkId as string | undefined).filter(Boolean),
    );
    expect(persistedChunkIds.size, "no chunkIds persisted with documents").to.be.greaterThan(0);
    for (const entity of entities) {
      for (const chunkId of entity.sourceChunkIds) {
        expect(persistedChunkIds.has(chunkId), `entity "${entity.name}" references unknown chunk ${chunkId}`).to.equal(
          true,
        );
      }
    }

    // ── Graph-strategy retrieval returns a graph-derived hit ──
    const vectorStore = await reloaded.getVectorStore(topic.id);
    expect(vectorStore).to.not.be.null;

    const agent = new RAGAgent(langGraphConfig, mockLLMProvider);
    await agent.initialize(vectorStore!, {
      documentFetcher: (limit) => reloaded.getAllDocuments(topic.id, limit),
      knowledgeGraph: kg!,
      embeddingService,
    });

    const queryResult = await agent.query(
      "What database does RAGnarok use?",
      defaultQueryOptions({ retrievalStrategy: RetrievalStrategy.GRAPH, topK: 3 }),
    );

    expect(queryResult.results.length, "graph strategy returned no results").to.be.greaterThan(0);
    const combined = queryResult.results.map((r) => r.document.pageContent).join(" ");
    expect(combined).to.include("LanceDB");
  });
});
