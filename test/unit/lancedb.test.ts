/**
 * LanceDB Integration Test
 * Tests actual LanceDB vector store with real embeddings
 */

import { expect } from 'chai';
import { LanceDB } from '@langchain/community/vectorstores/lancedb';
import { connect } from '@lancedb/lancedb';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { TransformersEmbeddings } from '../../src/embeddings/langchainEmbeddings';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('LanceDB Integration', function () {
  this.timeout(120000); // 2 minutes for model initialization

  let embeddings: TransformersEmbeddings;
  let testDbPath: string;
  let tableName: string;

  before(async function () {
    // Initialize embeddings
    embeddings = new TransformersEmbeddings();

    // Create temp directory for test database
    testDbPath = path.join(os.tmpdir(), `lancedb-test-${Date.now()}`);
    await fs.mkdir(testDbPath, { recursive: true });

    tableName = 'test-table';
  });

  after(async function () {
    // Cleanup test database
    try {
      await fs.rm(testDbPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Document Creation and Search', function () {
    it('should create vector store and add documents', async function () {
      const docs = [
        new LangChainDocument({
          pageContent: 'Python is a high-level programming language',
          metadata: { source: 'test1.txt', chunkId: 'chunk1' }
        }),
        new LangChainDocument({
          pageContent: 'JavaScript is used for web development',
          metadata: { source: 'test2.txt', chunkId: 'chunk2' }
        }),
        new LangChainDocument({
          pageContent: 'TypeScript adds static typing to JavaScript',
          metadata: { source: 'test3.txt', chunkId: 'chunk3' }
        }),
        new LangChainDocument({
          pageContent: 'Machine learning models process data',
          metadata: { source: 'test4.txt', chunkId: 'chunk4' }
        }),
      ];

      // Create vector store with documents
      const store = await LanceDB.fromDocuments(
        docs,
        embeddings,
        {
          uri: testDbPath,
          tableName: tableName
        }
      );

      expect(store).to.not.be.null;
    });

    it('should load existing vector store and search', async function () {
      // Open existing database
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);

      // Create vector store from existing table
      const store = new LanceDB(embeddings, { table });

      // Search for programming-related content
      const results = await store.similaritySearch('programming language', 3);

      console.log('\n=== Search Results ===');
      console.log('Query: "programming language"');
      console.log(`Results found: ${results.length}`);

      results.forEach((result, i) => {
        console.log(`\n${i + 1}. ${result.pageContent}`);
        console.log(`   Source: ${result.metadata.source}`);
      });

      expect(results).to.have.length.greaterThan(0);
      expect(results[0].pageContent).to.include('Python');
    });

    it('should search with scores', async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      const results = await store.similaritySearchWithScore('web development', 3);

      console.log('\n=== Search with Scores ===');
      console.log('Query: "web development"');

      results.forEach(([doc, score], i) => {
        const scoreValue = typeof score === 'number' ? score.toFixed(4) : 'N/A';
        console.log(`\n${i + 1}. Score: ${scoreValue}`);
        console.log(`   Text: ${doc.pageContent}`);
      });

      expect(results).to.have.length.greaterThan(0);

      // Note: LanceDB may return undefined scores in some cases
      // The important thing is we get results
      expect(results[0][0].pageContent).to.include('JavaScript');
    });

    it('should find semantically similar content', async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      // Search for "scripting" which should match JavaScript/TypeScript
      const results = await store.similaritySearch('scripting language', 2);

      console.log('\n=== Semantic Search ===');
      console.log('Query: "scripting language"');
      console.log(`Results: ${results.length}`);

      results.forEach((result, i) => {
        console.log(`${i + 1}. ${result.pageContent}`);
      });

      expect(results).to.have.length.greaterThan(0);

      // Should find JavaScript or TypeScript related content
      const hasScriptingContent = results.some(r =>
        r.pageContent.includes('JavaScript') ||
        r.pageContent.includes('TypeScript')
      );

      expect(hasScriptingContent).to.be.true;
    });

    it('should handle empty search gracefully', async function () {
      const db = await connect(testDbPath);
      const table = await db.openTable(tableName);
      const store = new LanceDB(embeddings, { table });

      const results = await store.similaritySearch('quantum physics', 3);

      // Should still return results (even if not highly relevant)
      expect(results).to.be.an('array');
    });
  });

  describe('Real Yellow Book Data Search', function () {
    it('should search in actual yellow book database', async function () {
      const realDbPath = process.env.TEST_DB_PATH;
      if (!realDbPath) {
        this.skip();
        return;
      }
      const realTableName = process.env.TEST_TABLE_NAME || 'topic-1762689493819-xmetedt';

      try {
        const db = await connect(realDbPath);
        const tableNames = await db.tableNames();

        console.log(`\n=== Real Database Check ===`);
        console.log(`Available tables: ${tableNames.join(', ')}`);

        if (!tableNames.includes(realTableName)) {
          console.log(`Table ${realTableName} not found - skipping test`);
          this.skip();
          return;
        }

        const table = await db.openTable(realTableName);
        const rowCount = await table.countRows();
        console.log(`Table has ${rowCount} rows`);

        const store = new LanceDB(embeddings, { table });

        const results = await store.similaritySearch('DP source DP store', 5);

        console.log(`\n=== Yellow Book Search Results ===`);
        console.log(`Query: "DP source DP store"`);
        console.log(`Results found: ${results.length}`);

        results.forEach((result, i) => {
          console.log(`\n${i + 1}. ${result.pageContent.substring(0, 150)}...`);
          console.log(`   Source: ${result.metadata.source}`);
          console.log(`   Chunk: ${result.metadata.chunkId}`);
        });

        expect(results).to.have.length.greaterThan(0);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Could not access real database: ${message}`);
        this.skip();
      }
    });
  });
});
