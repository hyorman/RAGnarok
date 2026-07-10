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
import {
  VectorStoreFactory,
  EmbeddingService,
  ModelRegistry,
  HuggingFaceBackend,
  IConfigProvider,
  INotifier,
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

    factory = new VectorStoreFactory(storageDir, modelRegistry.getDefaultModel(), embeddingService);
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
});
