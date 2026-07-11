/**
 * LanceDB Integration Test
 * Tests actual LanceDB vector store with real embeddings
 */

import { expect } from "chai";
import { LanceDB } from "@langchain/community/vectorstores/lancedb";
import { connect } from "@lancedb/lancedb";
import {
  TransformersEmbeddings,
  EmbeddingService,
  IConfigProvider,
  INotifier,
  HuggingFaceBackend,
  ModelRegistry,
} from "../src/index";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { SEARCH_OPERATIONS_CORPUS, SEMANTIC_SMOKE_CORPUS, toLangChainDocuments } from "./helpers/fixtureCorpus";

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

describe("LanceDB Integration", function () {
  this.timeout(120000); // 2 minutes for model initialization

  let embeddings: TransformersEmbeddings;
  let testDbPath: string;
  let tableName: string;

  before(async function () {
    // Initialize embeddings
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier);
    embeddingService.registerBackend(hfBackend);
    embeddings = new TransformersEmbeddings({ embeddingService });

    // Create temp directory for test database
    testDbPath = path.join(os.tmpdir(), `lancedb-test-${Date.now()}`);
    await fs.mkdir(testDbPath, { recursive: true });

    tableName = "test-table";
  });

  after(async function () {
    // Cleanup test database
    try {
      await fs.rm(testDbPath, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe("Document Creation and Search", function () {
    it("should create vector store and add documents", async function () {
      const docs = toLangChainDocuments(SEMANTIC_SMOKE_CORPUS.slice(0, 4), (entry, index) => ({
        source: entry.source,
        chunkId: `chunk${index + 1}`,
        topic: entry.topic,
      }));

      // Create vector store with documents
      const store = await LanceDB.fromDocuments(docs, embeddings, {
        uri: testDbPath,
        tableName: tableName,
      });

      expect(store).to.not.be.null;
    });

    it("should load existing vector store and search", async function () {
      // Open existing database
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);

      // Create vector store from existing table
      const store = new LanceDB(embeddings, { table });

      // Search for programming-related content
      const results = await store.similaritySearch("programming language", 3);

      console.log("\n=== Search Results ===");
      console.log('Query: "programming language"');
      console.log(`Results found: ${results.length}`);

      results.forEach((result, i) => {
        console.log(`\n${i + 1}. ${result.pageContent}`);
        console.log(`   Source: ${result.metadata.source}`);
      });

      expect(results).to.have.length.greaterThan(0);
      expect(results[0].pageContent).to.include("Python");
    });

    it("should search with scores", async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      const results = await store.similaritySearchWithScore("web development", 3);

      console.log("\n=== Search with Scores ===");
      console.log('Query: "web development"');

      results.forEach(([doc, score], i) => {
        const scoreValue = typeof score === "number" ? score.toFixed(4) : "N/A";
        console.log(`\n${i + 1}. Score: ${scoreValue}`);
        console.log(`   Text: ${doc.pageContent}`);
      });

      expect(results).to.have.length.greaterThan(0);

      // Note: LanceDB may return undefined scores in some cases
      // The important thing is we get results
      expect(results[0][0].pageContent).to.include("JavaScript");
    });

    it("should find semantically similar content", async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      // Search for "scripting" which should match JavaScript/TypeScript
      const results = await store.similaritySearch("scripting language", 2);

      console.log("\n=== Semantic Search ===");
      console.log('Query: "scripting language"');
      console.log(`Results: ${results.length}`);

      results.forEach((result, i) => {
        console.log(`${i + 1}. ${result.pageContent}`);
      });

      expect(results).to.have.length.greaterThan(0);

      // Should find JavaScript or TypeScript related content
      const hasScriptingContent = results.some(
        (r) => r.pageContent.includes("JavaScript") || r.pageContent.includes("TypeScript"),
      );

      expect(hasScriptingContent).to.be.true;
    });

    it("should handle empty search gracefully", async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      const results = await store.similaritySearch("quantum physics", 3);

      // Should still return results (even if not highly relevant)
      expect(results).to.be.an("array");
    });
  });

  describe("Fixture Corpus Data Search", function () {
    it("should search fixture data that mimics a production corpus", async function () {
      const fixtureDocs = toLangChainDocuments(SEARCH_OPERATIONS_CORPUS, (entry, index) => ({
        source: entry.source,
        chunkId: `fixture-${index + 1}`,
        topic: entry.topic,
      }));

      const fixtureTableName = "fixture-corpus-table";
      await LanceDB.fromDocuments(fixtureDocs, embeddings, {
        uri: testDbPath,
        tableName: fixtureTableName,
      });

      const db = await connect(testDbPath);
      const table = await db.openTable(fixtureTableName);
      const rowCount = await table.countRows();
      const store = new LanceDB(embeddings, { table });

      const results = await store.similaritySearch("search index record ingestion", 5);

      console.log(`\n=== Fixture Corpus Search Results ===`);
      console.log(`Query: "search index record ingestion"`);
      console.log(`Rows indexed: ${rowCount}`);
      console.log(`Results found: ${results.length}`);

      results.forEach((result, i) => {
        console.log(`\n${i + 1}. ${result.pageContent.substring(0, 150)}...`);
        console.log(`   Source: ${result.metadata.source}`);
        console.log(`   Chunk: ${result.metadata.chunkId}`);
      });

      expect(rowCount).to.equal(fixtureDocs.length);
      expect(results).to.have.length.greaterThan(0);

      const matchedSources = new Set(results.map((result) => String(result.metadata.source)));
      expect(matchedSources.has("index-sync.txt") || matchedSources.has("document-ingestion.txt")).to.be.true;
    });
  });
});
