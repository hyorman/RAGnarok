/**
 * Integration Tests
 * End-to-end tests for complete workflows across multiple components
 */

import { expect } from 'chai';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import { RAGAgent } from '../../src/agents/ragAgent';
import { RetrievalStrategy } from '../../src/utils/types';
import { HybridRetriever } from '../../src/retrievers/hybridRetriever';
import { VectorRetriever } from '../../src/retrievers/vectorRetriever';
import { EmbeddingService } from '../../src/embeddings/embeddingService';
import { SemanticChunker } from '../../src/splitters/semanticChunker';
import { QueryPlannerAgent } from '../../src/agents/queryPlannerAgent';
import { DEFAULTS } from '../../src/utils/constants';

// Simple in-memory VectorStore for testing
class TestVectorStore extends VectorStore {
  private docs: LangChainDocument[] = [];
  private vectors: number[][] = [];

  async addDocuments(documents: LangChainDocument[]): Promise<void> {
    const texts = documents.map(d => d.pageContent);
    const embeddings = await this.embeddings.embedDocuments(texts);
    this.docs.push(...documents);
    this.vectors.push(...embeddings);
  }

  async addVectors(vectors: number[][], documents: LangChainDocument[]): Promise<void> {
    this.vectors.push(...vectors);
    this.docs.push(...documents);
  }

  async similaritySearchVectorWithScore(query: number[], k: number): Promise<[LangChainDocument, number][]> {
    const scores = this.vectors.map(vec => {
      const dotProduct = vec.reduce((sum, val, i) => sum + val * query[i], 0);
      const magA = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
      const magB = Math.sqrt(query.reduce((sum, val) => sum + val * val, 0));
      return dotProduct / (magA * magB);
    });

    const results = this.docs.map((doc, i) => ({ doc, score: scores[i] }));
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k).map(r => [r.doc, r.score]);
  }

  _vectorstoreType(): string {
    return 'test-memory';
  }

  static async fromDocuments(docs: LangChainDocument[], embeddings: Embeddings): Promise<TestVectorStore> {
    const store = new TestVectorStore(embeddings, {});
    await store.addDocuments(docs);
    return store;
  }
}

// Mock Embeddings wrapper for testing
class TestEmbeddings extends Embeddings {
  private embeddingService: EmbeddingService;

  constructor(embeddingService: EmbeddingService) {
    super({});
    this.embeddingService = embeddingService;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return await this.embeddingService.embedBatch(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    return await this.embeddingService.embed(text);
  }
}

describe('Integration Tests', function () {
  this.timeout(120000); // 2 minutes for model downloads

  let embeddingService: EmbeddingService;
  let testEmbeddings: TestEmbeddings;

  before(async function () {
    // Initialize embedding service
    embeddingService = EmbeddingService.getInstance();
    await embeddingService.initialize(DEFAULTS.EMBEDDING_MODEL);
    testEmbeddings = new TestEmbeddings(embeddingService);
  });

  describe('Component Integration: Planner + Retriever + Agent', function () {
    it('should integrate query planner with retriever', async function () {
      // Create vector store with test data
      const docs = [
        new LangChainDocument({
          pageContent: 'Python is a high-level programming language',
          metadata: { chunkId: 'py1', source: 'python.txt' },
        }),
        new LangChainDocument({
          pageContent: 'JavaScript is used for web development',
          metadata: { chunkId: 'js1', source: 'javascript.txt' },
        }),
      ];

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      // Test planner
      const planner = new QueryPlannerAgent();
      const plan = await planner.createPlan('compare Python and JavaScript');

      expect(plan).to.have.property('complexity');
      expect(plan).to.have.property('strategy');
      expect(plan).to.have.property('subQueries');

      // Test retriever
      const vectorRetriever = new VectorRetriever(vectorStore);
      const retriever = new HybridRetriever(vectorRetriever);
      const results = await retriever.search('Python', { k: 5 });

      expect(results).to.be.an('array');
      expect(results.length).to.be.greaterThan(0);
    });

    it('should integrate all components in RAG workflow', async function () {
      const docs = [
        new LangChainDocument({
          pageContent: 'Python is excellent for data science and machine learning',
          metadata: { chunkId: 'py1' },
        }),
        new LangChainDocument({
          pageContent: 'JavaScript powers modern web applications and Node.js servers',
          metadata: { chunkId: 'js1' },
        }),
        new LangChainDocument({
          pageContent: 'TypeScript adds static typing to JavaScript',
          metadata: { chunkId: 'ts1' },
        }),
      ];

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(vectorStore);

      const result = await agent.query('What is Python used for?', {
        topK: 3,
      });

      expect(result).to.have.property('query');
      expect(result).to.have.property('plan');
      expect(result).to.have.property('results');
      expect(result).to.have.property('iterations');
      expect(result).to.have.property('metadata');
      expect(result.results.length).to.be.greaterThan(0);
    });
  });

  describe('End-to-End Simple Query Workflow', function () {
    let vectorStore: TestVectorStore;
    let ragAgent: RAGAgent;

    beforeEach(async function () {
      // Create comprehensive test dataset
      const testDocs = [
        new LangChainDocument({
          pageContent: 'Python is a versatile programming language used for web development, data science, and automation.',
          metadata: { chunkId: 'chunk1', source: 'python.txt', topic: 'Python' },
        }),
        new LangChainDocument({
          pageContent: 'JavaScript is the language of the web. It runs in browsers and on servers via Node.js.',
          metadata: { chunkId: 'chunk2', source: 'javascript.txt', topic: 'JavaScript' },
        }),
        new LangChainDocument({
          pageContent: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
          metadata: { chunkId: 'chunk3', source: 'typescript.txt', topic: 'TypeScript' },
        }),
        new LangChainDocument({
          pageContent: 'React is a JavaScript library for building user interfaces, developed by Facebook.',
          metadata: { chunkId: 'chunk4', source: 'react.txt', topic: 'React' },
        }),
        new LangChainDocument({
          pageContent: 'Machine learning with Python uses libraries like scikit-learn, TensorFlow, and PyTorch.',
          metadata: { chunkId: 'chunk5', source: 'ml.txt', topic: 'Machine Learning' },
        }),
      ];

      vectorStore = await TestVectorStore.fromDocuments(testDocs, testEmbeddings);
      ragAgent = new RAGAgent();
      await ragAgent.initialize(vectorStore);
    });

    it('should execute complete simple query workflow', async function () {
      const result = await ragAgent.query('What is Python?', {
        topK: 3,
      });

      expect(result.results).to.be.an('array');
      expect(result.results.length).to.be.at.most(3);
      expect(result.results.length).to.be.greaterThan(0);
      expect(result.executionTime).to.be.at.least(0);
    });

    it('should return relevant results for queries', async function () {
      const result = await ragAgent.query('Python programming', {
        topK: 5,
      });

      // Results should be sorted by relevance
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i - 1].score).to.be.at.least(result.results[i].score);
      }
    });
  });

  describe('End-to-End Agentic Query Workflow', function () {
    let vectorStore: TestVectorStore;
    let ragAgent: RAGAgent;

    beforeEach(async function () {
      const testDocs = [
        new LangChainDocument({
          pageContent: 'Python features: dynamic typing, automatic memory management, extensive standard library.',
          metadata: { chunkId: 'py1', source: 'python.txt' },
        }),
        new LangChainDocument({
          pageContent: 'Python is excellent for data science, machine learning, and scientific computing.',
          metadata: { chunkId: 'py2', source: 'python.txt' },
        }),
        new LangChainDocument({
          pageContent: 'JavaScript is event-driven and runs asynchronously using callbacks and promises.',
          metadata: { chunkId: 'js1', source: 'javascript.txt' },
        }),
        new LangChainDocument({
          pageContent: 'JavaScript ecosystem includes React, Vue, Angular for frontend and Node.js for backend.',
          metadata: { chunkId: 'js2', source: 'javascript.txt' },
        }),
        new LangChainDocument({
          pageContent: 'TypeScript adds static type checking to JavaScript, catching errors at compile time.',
          metadata: { chunkId: 'ts1', source: 'typescript.txt' },
        }),
        new LangChainDocument({
          pageContent: 'TypeScript is widely used in large-scale applications and supports modern JavaScript features.',
          metadata: { chunkId: 'ts2', source: 'typescript.txt' },
        }),
      ];

      vectorStore = await TestVectorStore.fromDocuments(testDocs, testEmbeddings);
      ragAgent = new RAGAgent();
      await ragAgent.initialize(vectorStore);
    });

    it('should handle complex comparison queries', async function () {
      const result = await ragAgent.query('compare Python and JavaScript', {
        topK: 5,
      });

      expect(result.plan.complexity).to.equal('complex');
      expect(result.plan.strategy).to.equal('parallel');
      expect(result.results).to.be.an('array');
      expect(result.metadata.subQueriesExecuted).to.be.greaterThan(0);
    });

    it('should decompose queries into sub-queries', async function () {
      const result = await ragAgent.query(
        'Python and JavaScript and TypeScript programming'
      );

      expect(result.plan.subQueries.length).to.be.greaterThan(1);
      expect(result.metadata.subQueriesExecuted).to.be.greaterThan(1);
    });

    it('should deduplicate results from multiple sub-queries', async function () {
      const result = await ragAgent.query('JavaScript and TypeScript', {
        topK: 10,
      });

      // Check for unique chunk IDs
      const chunkIds = result.results.map((r) => r.document.metadata.chunkId);
      const uniqueIds = new Set(chunkIds);
      expect(uniqueIds.size).to.equal(chunkIds.length);
    });

    it('should support iterative refinement when enabled', async function () {
      const result = await ragAgent.query('Python features and use cases', {
        maxIterations: 2,
        confidenceThreshold: 0.8,
      });

      expect(result.iterations).to.be.a('number');
      expect(result.iterations).to.be.at.least(1);
      expect(result.avgConfidence).to.be.a('number');
      expect(result.confidenceMet).to.be.a('boolean');
    });
  });

  describe('Chunking and Embedding Integration', function () {
    it('should chunk and embed documents together', async function () {
      const sourceDoc = new LangChainDocument({
        pageContent: 'This is a long document that needs to be chunked. It has multiple sentences. Each sentence provides different information. The chunker should split this appropriately.',
        metadata: { source: 'test.txt' },
      });

      const chunker = new SemanticChunker();
      const chunkResult = await chunker.chunkDocuments([sourceDoc]);

      expect(chunkResult.chunks).to.be.an('array');
      expect(chunkResult.chunks.length).to.be.greaterThan(0);

      // Embed the chunks
      const texts = chunkResult.chunks.map(c => c.pageContent);
      const embeddings = await embeddingService.embedBatch(texts);

      expect(embeddings).to.be.an('array');
      expect(embeddings.length).to.equal(chunkResult.chunks.length);
      embeddings.forEach(emb => {
        expect(emb).to.be.an('array');
        expect(emb.length).to.be.greaterThan(0);
      });
    });

    it('should store chunked documents in vector store', async function () {
      const sourceDoc = new LangChainDocument({
        pageContent: 'Python programming language is great for beginners. JavaScript is essential for web development. TypeScript improves JavaScript development.',
        metadata: { source: 'test.txt' },
      });

      const chunker = new SemanticChunker();
      const chunkResult = await chunker.chunkDocuments([sourceDoc]);

      const vectorStore = await TestVectorStore.fromDocuments(
        chunkResult.chunks,
        testEmbeddings
      );

      // Search the chunked content
      const results = await vectorStore.similaritySearchWithScore('Python', 3);

      expect(results).to.be.an('array');
      expect(results.length).to.be.greaterThan(0);
    });
  });

  describe('Error Handling Across Components', function () {
    it('should handle uninitialized RAG agent gracefully', async function () {
      const agent = new RAGAgent();

      try {
        await agent.query('test query');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.an('error');
        expect((error as Error).message).to.include('not initialized');
      }
    });

    it('should handle empty vector store queries', async function () {
      const emptyVectorStore = await TestVectorStore.fromDocuments(
        [],
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(emptyVectorStore);

      const result = await agent.query('any query');

      expect(result).to.be.an('object');
      expect(result.results).to.be.an('array');
    });
  });

  describe('Performance and Scalability', function () {
    it('should handle concurrent queries efficiently', async function () {
      const docs = Array.from({ length: 20 }, (_, i) =>
        new LangChainDocument({
          pageContent: `Document ${i} about programming concepts and best practices`,
          metadata: { chunkId: `c${i}` },
        })
      );

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(vectorStore);

      const queries = [
        'programming concepts',
        'best practices',
        'development tips',
      ];

      const results = await Promise.all(
        queries.map((q) => agent.query(q, { topK: 3 }))
      );

      expect(results).to.have.lengthOf(3);
      results.forEach((result) => {
        expect(result.results).to.be.an('array');
      });
    });

    it('should complete queries in reasonable time', async function () {
      const docs = [
        new LangChainDocument({
          pageContent: 'Test content',
          metadata: { chunkId: 'c1' },
        }),
      ];

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(vectorStore);

      const startTime = Date.now();
      await agent.query('test query');
      const elapsed = Date.now() - startTime;

      expect(elapsed).to.be.lessThan(5000); // Should complete in under 5 seconds
    });
  });

  describe('Configuration and Options', function () {
    it('should respect retrieval strategy option', async function () {
      const docs = [
        new LangChainDocument({
          pageContent: 'Test document',
          metadata: { chunkId: 'c1' },
        }),
      ];

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(vectorStore);

      const vectorResult = await agent.query('test', {
        retrievalStrategy: RetrievalStrategy.VECTOR,
      });
      expect(vectorResult.metadata.strategy).to.equal(RetrievalStrategy.VECTOR);

      const hybridResult = await agent.query('test', {
        retrievalStrategy: RetrievalStrategy.HYBRID,
      });
      expect(hybridResult.metadata.strategy).to.equal(RetrievalStrategy.HYBRID);
    });

    it('should respect topK parameter', async function () {
      const docs = Array.from({ length: 10 }, (_, i) =>
        new LangChainDocument({
          pageContent: `Document ${i}`,
          metadata: { chunkId: `c${i}` },
        })
      );

      const vectorStore = await TestVectorStore.fromDocuments(
        docs,
        testEmbeddings
      );

      const agent = new RAGAgent();
      await agent.initialize(vectorStore);

      const result = await agent.query('document', {
        topK: 3,
      });

      expect(result.results.length).to.be.at.most(3);
    });
  });
});
