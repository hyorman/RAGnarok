/**
 * Unit Tests for DocumentPipeline
 * Tests the complete document processing pipeline
 */

import { expect } from "chai";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as sinon from "sinon";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  DocumentPipeline,
  PipelineProgress,
  EmbeddingService,
  EmbeddingServiceRegistry,
  IConfigProvider,
  INotifier,
  HuggingFaceBackend,
  ModelRegistry,
  VectorStoreFactory,
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

describe("DocumentPipeline", function () {
  this.timeout(120000); // 2 minutes for embedding model initialization

  let pipeline: DocumentPipeline;
  let embeddingService: EmbeddingService;
  let embeddingRegistry: EmbeddingServiceRegistry;
  let originalModel: string | null = null;

  // Compiled tests live in packages/core/dist-test/test; fixtures are package-local under test/fixtures
  const fixturesPath = path.join(__dirname, "../../test/fixtures");
  let tempStorageDir: string;

  before(async function () {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-pipeline-"));

    // Get embedding service instance and save original model state
    embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier);
    embeddingService.registerBackend(hfBackend);
    originalModel = embeddingService.getCurrentModel();
    embeddingRegistry = new EmbeddingServiceRegistry({
      createService: () => embeddingService,
      maxResidentLocal: 2,
    });

    // Initialize pipeline
    pipeline = new DocumentPipeline(mockNotifier, embeddingService, embeddingRegistry, mockConfig);
    await pipeline.initialize(tempStorageDir);
  });

  after(async function () {
    // Restore original embedding model state
    if (originalModel && originalModel !== embeddingService.getCurrentModel()) {
      await embeddingService.initialize(originalModel);
    } else if (!originalModel) {
      await embeddingService.clearCache();
    }

    fs.rmSync(tempStorageDir, { recursive: true, force: true });
  });

  describe("Initialization", function () {
    it("should initialize successfully", async function () {
      const newPipeline = new DocumentPipeline(mockNotifier, embeddingService, embeddingRegistry, mockConfig);
      await newPipeline.initialize(tempStorageDir);

      // If initialization succeeds, pipeline should be ready
      expect(newPipeline).to.be.an("object");
    });

    it("should throw error if processing before initialization", async function () {
      const uninitializedPipeline = new DocumentPipeline(mockNotifier, embeddingService, embeddingRegistry, mockConfig);
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const result = await uninitializedPipeline.processDocument(testFile, "test-topic");

      // Pipeline should handle errors gracefully and return them in result
      expect(result.success).to.be.false;
      expect(result.errors).to.be.an("array");
      expect(result.errors!.length).to.be.greaterThan(0);
      expect(result.errors![0]).to.include("not initialized");
    });
  });

  describe("Document Loading", function () {
    it("should process a text file", async function () {
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const result = await pipeline.processDocument(testFile, "test-topic-txt");

      if (!result.success) {
        console.error("[DEBUG] Pipeline failed:", JSON.stringify(result.errors), JSON.stringify(result.stages));
      }
      expect(result.success).to.be.true;
      expect(result.stages.loading).to.be.true;
      expect(result.stages.chunking).to.be.true;
      expect(result.stages.embedding).to.be.true;
      expect(result.stages.storing).to.be.true;
      expect(result.metadata.originalDocuments).to.equal(1);
      expect(result.metadata.chunksCreated).to.be.greaterThan(0);
      expect(result.chunks).to.be.an("array");
      expect(result.chunks.length).to.be.greaterThan(0);
    });

    it("should process a markdown file", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-md");

      expect(result.success).to.be.true;
      expect(result.stages.loading).to.be.true;
      expect(result.metadata.chunksCreated).to.be.greaterThan(0);

      // Markdown files should create chunks
      expect(result.chunks.length).to.be.greaterThan(0);

      // Check that chunks have content
      result.chunks.forEach((chunk) => {
        expect(chunk.pageContent).to.be.a("string");
        expect(chunk.pageContent.length).to.be.greaterThan(0);
      });
    });

    it("should process an HTML file", async function () {
      const testFile = path.join(fixturesPath, "sample.html");

      const result = await pipeline.processDocument(testFile, "test-topic-html");

      expect(result.success).to.be.true;
      expect(result.stages.loading).to.be.true;
      expect(result.metadata.chunksCreated).to.be.greaterThan(0);
      expect(result.chunks.length).to.be.greaterThan(0);
    });

    it("should process multiple files", async function () {
      const testFiles = [path.join(fixturesPath, "sample-text.txt"), path.join(fixturesPath, "sample.md")];

      const result = await pipeline.processDocuments(testFiles, "test-topic-multi");

      expect(result.success).to.be.true;
      expect(result.metadata.originalDocuments).to.equal(2);
      expect(result.metadata.chunksCreated).to.be.greaterThan(0);
      expect(result.chunks.length).to.be.greaterThan(0);
    });

    it("should handle non-existent files gracefully", async function () {
      const fakeFile = path.join(fixturesPath, "nonexistent.txt");

      const result = await pipeline.processDocument(fakeFile, "test-topic-fake");

      // Pipeline should complete but with no chunks since file doesn't exist
      // The loader uses allSettled so it handles errors gracefully
      expect(result.metadata.chunksCreated).to.equal(0);
      expect(result.chunks.length).to.equal(0);
    });
  });

  describe("Chunking", function () {
    it("should create appropriate chunk sizes", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-chunks", {
        chunkingOptions: {
          chunkSize: 200,
          chunkOverlap: 20,
        },
      });

      expect(result.success).to.be.true;
      expect(result.stages.chunking).to.be.true;
      expect(result.chunks.length).to.be.greaterThan(0);

      // Check chunk sizes (should be around target size)
      result.chunks.forEach((chunk) => {
        // Chunks can be smaller than target size, but not too much larger
        expect(chunk.pageContent.length).to.be.lessThan(400); // 2x target size
      });
    });

    it("should preserve metadata in chunks", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-metadata");

      expect(result.success).to.be.true;

      // All chunks should have metadata
      result.chunks.forEach((chunk) => {
        expect(chunk.metadata).to.be.an("object");
        expect(chunk.metadata).to.have.property("source");
      });
    });

    it("should handle different chunking options", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      // Use custom chunking settings
      const result = await pipeline.processDocument(testFile, "test-topic-strategy", {
        chunkingOptions: {
          chunkSize: 300,
          chunkOverlap: 30,
        },
      });

      expect(result.success).to.be.true;
      expect(result.stages.chunking).to.be.true;
      expect(result.chunks.length).to.be.greaterThan(0);
    });
  });

  describe("Embedding", function () {
    it("should generate embeddings for chunks", async function () {
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const result = await pipeline.processDocument(testFile, "test-topic-embeddings");

      expect(result.success).to.be.true;
      expect(result.stages.embedding).to.be.true;
      expect(result.metadata.chunksEmbedded).to.equal(result.metadata.chunksCreated);
    });

    it("should respect batch size for embedding generation", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-batch", {
        embeddingBatchSize: 2, // Small batch size
      });

      expect(result.success).to.be.true;
      expect(result.stages.embedding).to.be.true;
      expect(result.metadata.chunksEmbedded).to.be.greaterThan(0);
    });
  });

  describe("Vector Storage", function () {
    it("should store chunks in vector store", async function () {
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const result = await pipeline.processDocument(testFile, "test-topic-storage");

      expect(result.success).to.be.true;
      expect(result.stages.storing).to.be.true;
      expect(result.metadata.chunksStored).to.equal(result.metadata.chunksCreated);
    });

    it("should use Chroma vector store", async function () {
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const result = await pipeline.processDocument(testFile, "test-topic-chroma", {});

      expect(result.success).to.be.true;
      expect(result.stages.storing).to.be.true;
    });
  });

  describe("Progress Tracking", function () {
    it("should report progress through all stages", async function () {
      const testFile = path.join(fixturesPath, "sample.md");
      const progressReports: PipelineProgress[] = [];

      const result = await pipeline.processDocument(testFile, "test-topic-progress", {
        onProgress: (progress) => {
          progressReports.push(progress);
        },
      });

      expect(result.success).to.be.true;
      expect(progressReports.length).to.be.greaterThan(0);

      // Should have reports from different stages
      const stages = new Set(progressReports.map((p) => p.stage));
      expect(stages.has("loading")).to.be.true;
      expect(stages.has("chunking")).to.be.true;
      expect(stages.has("embedding")).to.be.true;
      expect(stages.has("storing")).to.be.true;
      expect(stages.has("complete")).to.be.true;
    });

    it("should report progress values from 0 to 100", async function () {
      const testFile = path.join(fixturesPath, "sample.md");
      const progressReports: PipelineProgress[] = [];

      const result = await pipeline.processDocument(testFile, "test-topic-progress-values", {
        onProgress: (progress) => {
          progressReports.push(progress);
        },
      });

      expect(result.success).to.be.true;

      // All progress values should be 0-100
      progressReports.forEach((report) => {
        expect(report.progress).to.be.at.least(0);
        expect(report.progress).to.be.at.most(100);
      });

      // Final progress should be 100
      const finalProgress = progressReports[progressReports.length - 1];
      expect(finalProgress.progress).to.equal(100);
      expect(finalProgress.stage).to.equal("complete");
    });
  });

  describe("Performance and Metrics", function () {
    it("should track timing for each stage", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-timing");

      expect(result.success).to.be.true;
      expect(result.metadata.totalTime).to.be.greaterThan(0);
      // Stage timings should be tracked (>= 0, some may be very fast)
      expect(result.metadata.stageTimings.loading).to.be.at.least(0);
      expect(result.metadata.stageTimings.chunking).to.be.at.least(0);
      expect(result.metadata.stageTimings.embedding).to.be.at.least(0);
      expect(result.metadata.stageTimings.storing).to.be.at.least(0);
    });

    it("should provide accurate chunk counts", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-counts");

      expect(result.success).to.be.true;
      expect(result.metadata.chunksCreated).to.equal(result.chunks.length);
      expect(result.metadata.chunksEmbedded).to.equal(result.metadata.chunksCreated);
      expect(result.metadata.chunksStored).to.equal(result.metadata.chunksCreated);
    });

    it("should process documents efficiently", async function () {
      const testFile = path.join(fixturesPath, "sample.md");
      const startTime = Date.now();

      const result = await pipeline.processDocument(testFile, "test-topic-efficiency");
      const elapsedTime = Date.now() - startTime;

      expect(result.success).to.be.true;

      // Processing should complete in reasonable time (< 30 seconds for small files)
      expect(elapsedTime).to.be.lessThan(30000);
    });
  });

  describe("Error Handling", function () {
    it("does not create vector rows when ingestion is cancelled", async function () {
      const controller = new AbortController();
      controller.abort(new Error("ingestion cancelled"));
      const topicId = "test-topic-cancelled";
      let caught: unknown;
      try {
        await pipeline.processDocument(path.join(fixturesPath, "sample.md"), topicId, {
          signal: controller.signal,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).to.equal(controller.signal.reason);
      const verifier = new VectorStoreFactory(
        tempStorageDir,
        embeddingService.getCurrentModel(),
        embeddingService,
        embeddingRegistry,
      );
      await verifier.initialize();
      expect(await verifier.loadStore(topicId)).to.equal(null);
      verifier.dispose();
    });

    /**
     * documentPipeline treats a null return from loadStore as "no store
     * yet" and calls createStore — which used to unconditionally drop
     * whatever table already existed. loadStore must therefore fail the
     * whole ingestion instead of returning null when a table exists but
     * cannot be loaded.
     *
     * validateEmbeddingModel already reads (and fails closed on) the same
     * metadata file before storeDocuments ever reaches loadStore, so a
     * corrupted-metadata scenario run end-to-end would be rejected one step
     * earlier, by a different error type, without ever exercising loadStore.
     * That earlier check is not what this test is about, so it is stubbed
     * to a no-op here, letting the real, corrupted-metadata loadStore path
     * run — this is the interaction documented on VectorStoreFactory: a
     * table that exists but fails to load must surface as
     * VectorStoreLoadError, not null.
     */
    it("aborts ingestion on a load failure without touching the existing table", async function () {
      const topicId = "test-topic-load-failure";
      const testFile = path.join(fixturesPath, "sample-text.txt");

      const initial = await pipeline.processDocument(testFile, topicId);
      expect(initial.success).to.be.true;

      const factory = (pipeline as any).vectorStoreFactory as VectorStoreFactory;
      const metadataPath = path.join(tempStorageDir, `vector-${topicId}-metadata.json`);
      const originalMetadata = fs.readFileSync(metadataPath, "utf8");
      const statsBefore = await factory.getStoredStats(topicId);
      expect(statsBefore.chunkCount).to.be.greaterThan(0);

      await fs.promises.writeFile(metadataPath, "not json{{");
      (factory as any).storeCache.clear();
      const validateStub = sinon.stub(factory, "validateEmbeddingModel").resolves();

      let caught: unknown;
      try {
        await (pipeline as any).storeDocuments(
          [
            new LangChainDocument({
              pageContent: "must never be embedded once the load has failed",
              metadata: { documentId: "extra", chunkId: "extra-0" },
            }),
          ],
          topicId,
          {},
        );
        expect.fail("storeDocuments should have rejected");
      } catch (error) {
        caught = error;
      } finally {
        validateStub.restore();
      }

      expect((caught as Error)?.name).to.equal("VectorStoreLoadError");

      // The table must be untouched: same chunk count as before the failed load.
      const statsAfter = await factory.getStoredStats(topicId);
      expect(statsAfter).to.deep.equal(statsBefore);

      fs.writeFileSync(metadataPath, originalMetadata);
    });

    it("should collect and report errors", async function () {
      // Try to process a non-existent file
      const fakeFile = path.join(fixturesPath, "does-not-exist.txt");

      const result = await pipeline.processDocument(fakeFile, "test-topic-errors");

      // Pipeline handles errors gracefully using allSettled, so result will be empty but successful
      expect(result.metadata.chunksCreated).to.equal(0);
      expect(result.chunks.length).to.equal(0);
    });

    it("should continue processing other files if one fails", async function () {
      const testFiles = [
        path.join(fixturesPath, "sample.md"), // Valid file
        path.join(fixturesPath, "nonexistent.txt"), // Invalid file
        path.join(fixturesPath, "sample-text.txt"), // Valid file
      ];

      const result = await pipeline.processDocuments(testFiles, "test-topic-partial");

      // Should have some success even with failures
      // originalDocuments now reflects actual loaded count (2 succeed, 1 fails)
      expect(result.metadata.originalDocuments).to.equal(2);

      // Should have processed at least some files
      if (result.metadata.chunksCreated > 0) {
        expect(result.chunks.length).to.be.greaterThan(0);
      }
    });

    it("should handle empty files gracefully", async function () {
      // Create an empty temp file
      const emptyFile = path.join(tempStorageDir, "empty.txt");
      fs.writeFileSync(emptyFile, "");

      const result = await pipeline.processDocument(emptyFile, "test-topic-empty");

      // Pipeline should handle empty files without crashing
      expect(result).to.be.an("object");
      expect(result.stages.loading).to.be.a("boolean");

      // Cleanup
      fs.unlinkSync(emptyFile);
    });
  });

  describe("Custom Options", function () {
    it("should respect custom chunking options", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const smallChunks = await pipeline.processDocument(testFile, "test-topic-small", {
        chunkingOptions: {
          chunkSize: 100,
          chunkOverlap: 10,
        },
      });

      const largeChunks = await pipeline.processDocument(testFile, "test-topic-large", {
        chunkingOptions: {
          chunkSize: 500,
          chunkOverlap: 50,
        },
      });

      expect(smallChunks.success).to.be.true;
      expect(largeChunks.success).to.be.true;

      // Smaller chunk size should generally create more chunks
      // (though not always guaranteed depending on content)
      expect(smallChunks.metadata.chunksCreated).to.be.greaterThan(0);
      expect(largeChunks.metadata.chunksCreated).to.be.greaterThan(0);
    });

    it("should respect custom loader options", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-loader", {
        loaderOptions: {
          // Custom loader options would go here
        },
      });

      expect(result.success).to.be.true;
    });
  });

  describe("Integration", function () {
    it("supports TXT, Markdown, HTML, and PDF in every first-file ordering without duplicates", async function () {
      const files = ["sample-text.txt", "sample.md", "sample.html", "sample.pdf"].map((name) =>
        path.join(fixturesPath, name),
      );
      const verifier = new VectorStoreFactory(
        tempStorageDir,
        embeddingService.getCurrentModel(),
        embeddingService,
        embeddingRegistry,
      );
      for (let first = 0; first < files.length; first++) {
        const topicId = `mixed-first-${first}`;
        const order = [files[first], ...files.filter((_, index) => index !== first)];
        for (const file of order) {
          expect((await pipeline.processDocument(file, topicId)).success).to.equal(true);
        }
        const before = await verifier.getStoredStats(topicId);
        expect(before.documentCount).to.equal(4);
        expect((await pipeline.processDocument(files[first], topicId)).success).to.equal(true);
        const after = await verifier.getStoredStats(topicId);
        expect(after).to.deep.equal(before);
      }
      verifier.dispose();
    });

    it("should complete end-to-end pipeline successfully", async function () {
      const testFile = path.join(fixturesPath, "sample.md");

      const result = await pipeline.processDocument(testFile, "test-topic-e2e");

      // Verify all stages completed
      expect(result.success).to.be.true;
      expect(result.stages.loading).to.be.true;
      expect(result.stages.chunking).to.be.true;
      expect(result.stages.embedding).to.be.true;
      expect(result.stages.storing).to.be.true;

      // Verify data flow
      expect(result.metadata.originalDocuments).to.equal(1);
      expect(result.metadata.chunksCreated).to.be.greaterThan(0);
      expect(result.metadata.chunksEmbedded).to.equal(result.metadata.chunksCreated);
      expect(result.metadata.chunksStored).to.equal(result.metadata.chunksCreated);
      expect(result.chunks.length).to.equal(result.metadata.chunksCreated);

      // Verify timing
      expect(result.metadata.totalTime).to.be.greaterThan(0);

      // Verify no errors
      if (result.errors) {
        expect(result.errors).to.be.empty;
      }
    });

    it("should accumulate metadata when adding documents to existing topic", async function () {
      const testFile1 = path.join(fixturesPath, "sample.md");
      const testFile2 = path.join(fixturesPath, "sample-text.txt");
      const topicId = "test-topic-accumulation";

      // Process first document
      const result1 = await pipeline.processDocument(testFile1, topicId);
      expect(result1.success).to.be.true;
      const firstChunkCount = result1.metadata.chunksCreated;

      // Process second document to same topic
      const result2 = await pipeline.processDocument(testFile2, topicId);
      expect(result2.success).to.be.true;
      const secondChunkCount = result2.metadata.chunksCreated;

      // Verify that both documents were processed
      expect(firstChunkCount).to.be.greaterThan(0);
      expect(secondChunkCount).to.be.greaterThan(0);

      // Note: The individual results show chunks per document,
      // but the metadata should be accumulated in the vector store metadata file
      // This test verifies the pipeline can process multiple documents to the same topic
    });

    /**
     * A topic is now read AND written with the model its own metadata records,
     * so changing the CONFIGURED model no longer makes an existing topic
     * unwritable — it is configuration drift, not corruption. What still
     * refuses a write is an incompatible dimension or an unverifiable
     * fingerprint (see the VectorStoreFactory guard suite).
     */
    it("adds documents to a topic whose model differs from the configured one", async function () {
      const testFile1 = path.join(fixturesPath, "sample.md");
      const testFile2 = path.join(fixturesPath, "sample-text.txt");
      const topicId = "test-topic-model-mismatch";

      // Process first document with default model
      const result1 = await pipeline.processDocument(testFile1, topicId);
      expect(result1.success).to.be.true;

      const verifier = new VectorStoreFactory(
        tempStorageDir,
        embeddingService.getCurrentModel(),
        embeddingService,
        embeddingRegistry,
      );
      const metadataBefore = await verifier.getStoreMetadata(topicId);
      expect(metadataBefore?.embeddingModel, "the topic must have recorded a model").to.be.a("string");

      // Save current model state
      const testOriginalModel = embeddingService.getCurrentModel();

      try {
        // Initialize embedding service with a different model
        const differentModel = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
        await embeddingService.initialize(differentModel);

        // The new pipeline will use the currently initialized model from the singleton
        const differentPipeline = new DocumentPipeline(mockNotifier, embeddingService, embeddingRegistry, mockConfig);
        await differentPipeline.initialize(tempStorageDir);

        const result2 = await differentPipeline.processDocument(testFile2, topicId);

        expect(result2.errors ?? [], "a differing configured model must no longer be refused").to.be.empty;
        expect(result2.success).to.be.true;

        // The topic keeps its own recorded embedding space — the configured
        // model must never be stamped over it, or the next load would resolve
        // a model the existing vectors did not come from.
        const metadataAfter = await verifier.getStoreMetadata(topicId);
        expect(metadataAfter?.embeddingModel).to.equal(metadataBefore?.embeddingModel);
        expect(metadataAfter?.embeddingFingerprint).to.deep.equal(metadataBefore?.embeddingFingerprint);
      } finally {
        verifier.dispose();
        // Always restore original model state in finally block
        if (testOriginalModel) {
          await embeddingService.initialize(testOriginalModel);
        } else {
          await embeddingService.clearCache();
        }
      }
    });
  });
});
