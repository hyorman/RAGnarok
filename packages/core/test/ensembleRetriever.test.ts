/**
 * Unit tests for EnsembleRetriever
 */

import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { EnsembleRetrieverWrapper, VectorRetriever, KeywordRetriever, DEFAULT_ENSEMBLE_OPTIONS } from "../src/index";
import { SEMANTIC_SMOKE_CORPUS, toLangChainDocuments } from "./helpers/fixtureCorpus";

// Mock vector store
class MockVectorStore {
  private documents: LangChainDocument[] = [];

  constructor(docs: LangChainDocument[]) {
    this.documents = docs;
  }

  async similaritySearch(query: string, k: number): Promise<LangChainDocument[]> {
    // Simple mock: return all documents up to k
    return this.documents.slice(0, k);
  }

  async similaritySearchWithScore(query: string, k: number): Promise<[LangChainDocument, number][]> {
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

describe("EnsembleRetriever", () => {
  const testDocuments: LangChainDocument[] = toLangChainDocuments(SEMANTIC_SMOKE_CORPUS);

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

  describe("Initialization", () => {
    it("should initialize with provided documents", async () => {
      await keywordRetriever.initialize(testDocuments);
      expect(retriever.isInitialized()).to.be.true;
      expect(retriever.getDocumentCount()).to.equal(testDocuments.length);
    });

    it("should report not initialized before keyword init", () => {
      expect(retriever.isInitialized()).to.be.false;
    });

    it("should report correct document count", async () => {
      await keywordRetriever.initialize(testDocuments);
      expect(retriever.getDocumentCount()).to.equal(5);
    });
  });

  describe("Search", () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it("should perform ensemble search", async () => {
      const results = await retriever.search("programming language", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 3 });

      expect(results).to.be.an("array");
      expect(results.length).to.be.at.most(3);
      expect(results[0]).to.have.property("document");
    });

    it("should respect k parameter", async () => {
      const results = await retriever.search("JavaScript", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 2 });
      expect(results.length).to.be.at.most(2);
    });

    it("should throw error if keyword retriever not initialized", async () => {
      const uninitKr = new KeywordRetriever();
      const uninitRetriever = new EnsembleRetrieverWrapper(vectorRetriever, uninitKr);

      try {
        await uninitRetriever.search("test", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 5 });
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).to.include("not initialized");
      }
    });

    it("should support custom weights", async () => {
      const results = await retriever.search("Python", {
        k: 3,
        vectorWeight: 0.6,
        bm25Weight: 0.4,
      });

      expect(results).to.be.an("array");
      expect(results.length).to.be.at.most(3);
    });

    it("rejects non-finite, zero-total, and invalid rank-fusion options", async () => {
      const invalid = [
        { k: 0, vectorWeight: 0.5, bm25Weight: 0.5 },
        { k: 1.5, vectorWeight: 0.5, bm25Weight: 0.5 },
        { k: 1, vectorWeight: Number.NaN, bm25Weight: 0.5 },
        { k: 1, vectorWeight: 0, bm25Weight: 0 },
        { k: 1, vectorWeight: 0.5, bm25Weight: 0.5, rrfK: 0 },
      ];
      for (const options of invalid) {
        let caught: unknown;
        try {
          await retriever.search("query", options);
        } catch (error) {
          caught = error;
        }
        expect(caught).to.be.instanceOf(Error);
      }
    });

    it("preserves the exact RRF score and per-arm contributions", async () => {
      const docA = new LangChainDocument({ pageContent: "A", metadata: { chunkId: "a" } });
      const docB = new LangChainDocument({ pageContent: "B", metadata: { chunkId: "b" } });
      const fixedVector = {
        getDocuments: async () => [docA, docB],
      } as any;
      const fixedKeyword = {
        isInitialized: () => true,
        search: async () => [
          { document: docA, score: 10 },
          { document: docB, score: 5 },
        ],
        getDocumentCount: () => 2,
      } as any;
      const exactRetriever = new EnsembleRetrieverWrapper(fixedVector, fixedKeyword, 10);

      const [first] = await exactRetriever.search("query", {
        k: 2,
        vectorWeight: 0.5,
        bm25Weight: 0.5,
      });

      expect(first.document.metadata.chunkId).to.equal("a");
      expect(first.scoreKind).to.equal("rrf");
      expect(first.componentScores.vector).to.be.closeTo(0.5 / 11, 1e-12);
      expect(first.componentScores.keyword).to.be.closeTo(0.5 / 11, 1e-12);
      expect(first.score).to.be.closeTo(1 / 11, 1e-12);
      expect(first.score).to.equal(first.componentScores.vector + first.componentScores.keyword);
    });
  });

  describe("Vector Store Management", () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it("should create new ensemble with different vector store", () => {
      const newVectorStore = new MockVectorStore(testDocuments);
      const newVectorRetriever = new VectorRetriever(newVectorStore as any);
      const newRetriever = new EnsembleRetrieverWrapper(newVectorRetriever, keywordRetriever);
      expect(newRetriever.isInitialized()).to.be.true;
    });

    it("should reflect keyword retriever refresh", async () => {
      expect(retriever.isInitialized()).to.be.true;
      await keywordRetriever.refresh(testDocuments);
      expect(retriever.isInitialized()).to.be.true;
    });
  });

  describe("Result Format", () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it("should return documents in correct format", async () => {
      const results = await retriever.search("test query", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 2 });

      results.forEach((result) => {
        expect(result).to.have.property("document");
        expect(result.document).to.have.property("pageContent");
        expect(result.document).to.have.property("metadata");
      });
    });

    it("should handle empty query gracefully", async () => {
      const results = await retriever.search("", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 3 });
      expect(results).to.be.an("array");
    });
  });

  describe("Performance", () => {
    beforeEach(async () => {
      await keywordRetriever.initialize(testDocuments);
    });

    it("should complete search in reasonable time", async () => {
      const startTime = Date.now();
      await retriever.search("JavaScript programming", { ...DEFAULT_ENSEMBLE_OPTIONS, k: 5 });
      const duration = Date.now() - startTime;

      expect(duration).to.be.lessThan(1000); // Should complete within 1 second
    });
  });
});
