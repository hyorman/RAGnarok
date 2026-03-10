/**
 * Unit tests for EnsembleRetriever
 */

import { expect } from 'chai';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { EnsembleRetrieverWrapper } from '../../src/retrievers/ensembleRetriever';
import { VectorRetriever } from '../../src/retrievers/vectorRetriever';
import { KeywordRetriever } from '../../src/retrievers/keywordRetriever';

// Mock vector store
class MockVectorStore {
  private documents: LangChainDocument[] = [];

  constructor(docs: LangChainDocument[]) {
    this.documents = docs;
  }

  async similaritySearch(
    query: string,
    k: number
  ): Promise<LangChainDocument[]> {
    // Simple mock: return all documents up to k
    return this.documents.slice(0, k);
  }

  async similaritySearchWithScore(
    query: string,
    k: number
  ): Promise<[LangChainDocument, number][]> {
    // Mock with decreasing scores
    return this.documents.slice(0, k).map((doc, i) => [doc, i * 0.1]);
  }

  asRetriever(options: { k: number }) {
    return {
      invoke: async (query: string) => {
        return this.similaritySearch(query, options.k);
      },
    };
  }
}

describe('EnsembleRetriever', () => {
  const testDocuments: LangChainDocument[] = [
    {
      pageContent: 'Python is a high-level programming language',
      metadata: { source: 'test1.txt' },
    },
    {
      pageContent: 'JavaScript is used for web development',
      metadata: { source: 'test2.txt' },
    },
    {
      pageContent: 'TypeScript adds types to JavaScript',
      metadata: { source: 'test3.txt' },
    },
    {
      pageContent: 'Machine learning models process data',
      metadata: { source: 'test4.txt' },
    },
    {
      pageContent: 'React is a JavaScript library for building UIs',
      metadata: { source: 'test5.txt' },
    },
  ];

  let vectorStore: any;
  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let retriever: EnsembleRetrieverWrapper;

  beforeEach(() => {
    vectorStore = new MockVectorStore(testDocuments);
    vectorRetriever = new VectorRetriever(vectorStore as any);
    keywordRetriever = new KeywordRetriever();
    retriever = new EnsembleRetrieverWrapper(vectorRetriever, keywordRetriever);
  });

  describe('Initialization', () => {
    it('should initialize with provided documents', async () => {
      await keywordRetriever.initialize(testDocuments);
      expect(retriever.isInitialized()).to.be.true;
      expect(retriever.getDocumentCount()).to.equal(testDocuments.length);
    });

    it('should report not initialized before keyword init', () => {
      expect(retriever.isInitialized()).to.be.false;
    });

    it('should report correct document count', async () => {
      await keywordRetriever.initialize(testDocuments);
      expect(retriever.getDocumentCount()).to.equal(5);
    });
  });

  describe('Search', () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it('should perform ensemble search', async () => {
      const results = await retriever.search('programming language', { k: 3 });

      expect(results).to.be.an('array');
      expect(results.length).to.be.at.most(3);
      expect(results[0]).to.have.property('document');
    });

    it('should respect k parameter', async () => {
      const results = await retriever.search('JavaScript', { k: 2 });
      expect(results.length).to.be.at.most(2);
    });

    it('should throw error if keyword retriever not initialized', async () => {
      const uninitKr = new KeywordRetriever();
      const uninitRetriever = new EnsembleRetrieverWrapper(vectorRetriever, uninitKr);

      try {
        await uninitRetriever.search('test');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).to.include('not initialized');
      }
    });

    it('should support custom weights', async () => {
      const results = await retriever.search('Python', {
        k: 3,
        vectorWeight: 0.7,
        bm25Weight: 0.3,
      });

      expect(results).to.be.an('array');
      expect(results.length).to.be.at.most(3);
    });
  });

  describe('Vector Store Management', () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it('should create new ensemble with different vector store', () => {
      const newVectorStore = new MockVectorStore(testDocuments);
      const newVectorRetriever = new VectorRetriever(newVectorStore as any);
      const newRetriever = new EnsembleRetrieverWrapper(newVectorRetriever, keywordRetriever);
      expect(newRetriever.isInitialized()).to.be.true;
    });

    it('should reflect keyword retriever refresh', async () => {
      expect(retriever.isInitialized()).to.be.true;
      await keywordRetriever.refresh(testDocuments);
      expect(retriever.isInitialized()).to.be.true;
    });
  });

  describe('Result Format', () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it('should return documents in correct format', async () => {
      const results = await retriever.search('test query', { k: 2 });

      results.forEach((result) => {
        expect(result).to.have.property('document');
        expect(result.document).to.have.property('pageContent');
        expect(result.document).to.have.property('metadata');
      });
    });

    it('should handle empty query gracefully', async () => {
      const results = await retriever.search('', { k: 3 });
      expect(results).to.be.an('array');
    });
  });

  describe('Performance', () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it('should complete search in reasonable time', async () => {
      const startTime = Date.now();
      await retriever.search('JavaScript programming', { k: 5 });
      const duration = Date.now() - startTime;

      expect(duration).to.be.lessThan(1000); // Should complete within 1 second
    });
  });
});
