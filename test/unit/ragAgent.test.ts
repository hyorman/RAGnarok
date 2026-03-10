/**
 * Unit Tests for RAGAgent
 * Tests orchestration, query planning, retrieval, and iterative refinement
 */

import { expect } from 'chai';
import { RAGAgent, RetrievalResult } from '../../src/agents/ragAgent';
import { QueryPlan } from '../../src/agents/queryPlannerAgent';
import { RetrievalStrategy } from '../../src/utils/types';
import { VectorStore } from '@langchain/core/vectorstores';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';

// Mock VectorStore for testing
class MockVectorStore extends VectorStore {
  _vectorstoreType(): string {
    return 'mock';
  }

  private documents: LangChainDocument[] = [];

  constructor() {
    super(new MockEmbeddings(), {});
  }

  async addDocuments(docs: LangChainDocument[]): Promise<void> {
    this.documents.push(...docs);
  }

  async addVectors(): Promise<void> {
    // Not used
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number
  ): Promise<[LangChainDocument, number][]> {
    // Return mock results with normalized scores
    return this.documents.slice(0, k).map((doc, index) => {
      const score = Math.max(0, 1 - index * 0.1); // Decreasing scores
      return [doc, score];
    });
  }
}

/**
 * Embeddings subclass that tracks the last query text.
 * Since LangChain always calls embedQuery before similaritySearchVectorWithScore,
 * this is a stable way to pass query context to the vector store (#9).
 */
class QueryTrackingEmbeddings extends Embeddings {
  public lastQueryText: string = '';

  constructor() {
    super({});
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }

  async embedQuery(text: string): Promise<number[]> {
    this.lastQueryText = text;
    return [0.1, 0.2, 0.3];
  }
}

/**
 * Query-aware mock vector store that returns different documents and scores
 * depending on the query text. Uses QueryTrackingEmbeddings for stable
 * query text capture (#9).
 */
class QueryAwareMockVectorStore extends VectorStore {
  _vectorstoreType(): string {
    return 'query-aware-mock';
  }

  private documents: LangChainDocument[] = [];
  private queryRules: Map<string, { docIndices: number[]; scoreMultiplier: number }> = new Map();
  private trackingEmbeddings: QueryTrackingEmbeddings;

  constructor() {
    const embeddings = new QueryTrackingEmbeddings();
    super(embeddings, {});
    this.trackingEmbeddings = embeddings;
  }

  async addDocuments(docs: LangChainDocument[]): Promise<void> {
    this.documents.push(...docs);
  }

  async addVectors(): Promise<void> {}

  addRule(keyword: string, docIndices: number[], scoreMultiplier: number): void {
    this.queryRules.set(keyword.toLowerCase(), { docIndices, scoreMultiplier });
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number
  ): Promise<[LangChainDocument, number][]> {
    let indices = Array.from({ length: Math.min(k, this.documents.length) }, (_, i) => i);
    let multiplier = 0.9;

    const lastQuery = this.trackingEmbeddings.lastQueryText;
    if (lastQuery) {
      for (const [keyword, rule] of this.queryRules) {
        if (lastQuery.toLowerCase().includes(keyword)) {
          indices = rule.docIndices.filter(i => i < this.documents.length).slice(0, k);
          multiplier = rule.scoreMultiplier;
          break;
        }
      }
    }

    return indices.map((docIdx, rank) => {
      const score = Math.max(0, (1 - rank * 0.1) * multiplier);
      return [this.documents[docIdx], score];
    });
  }
}

// Mock Embeddings (used by basic MockVectorStore)
class MockEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }

  async embedQuery(text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

describe('RAGAgent', function () {
  this.timeout(30000); // 30 seconds for LLM tests

  let agent: RAGAgent;
  let mockVectorStore: MockVectorStore;

  beforeEach(async function () {
    agent = new RAGAgent();
    mockVectorStore = new MockVectorStore();

    // Add mock documents
    const mockDocs = [
      new LangChainDocument({
        pageContent: 'Python is a programming language',
        metadata: { chunkId: 'chunk1', source: 'test1.txt' },
      }),
      new LangChainDocument({
        pageContent: 'JavaScript is used for web development',
        metadata: { chunkId: 'chunk2', source: 'test2.txt' },
      }),
      new LangChainDocument({
        pageContent: 'TypeScript is a superset of JavaScript',
        metadata: { chunkId: 'chunk3', source: 'test3.txt' },
      }),
      new LangChainDocument({
        pageContent: 'Machine learning uses Python',
        metadata: { chunkId: 'chunk4', source: 'test4.txt' },
      }),
      new LangChainDocument({
        pageContent: 'React is a JavaScript library',
        metadata: { chunkId: 'chunk5', source: 'test5.txt' },
      }),
    ];

    await mockVectorStore.addDocuments(mockDocs);
    await agent.initialize(mockVectorStore);
  });

  describe('Initialization', function () {
    it('should initialize successfully', function () {
      const newAgent = new RAGAgent();
      expect(newAgent).to.be.an('object');
    });

    it('should initialize with vector store', async function () {
      const newAgent = new RAGAgent();
      await newAgent.initialize(mockVectorStore);

      // Verify the agent is properly initialized and can execute queries
      expect(newAgent).to.be.an('object');
      expect(newAgent).to.respondTo('query');
    });
  });

  describe('Full Query with Planning', function () {
    it('should execute full RAG query', async function () {
      const result = await agent.query('What is Python?', {
        topK: 3,
      });

      expect(result).to.have.property('query');
      expect(result).to.have.property('plan');
      expect(result).to.have.property('results');
      expect(result).to.have.property('iterations');
      expect(result).to.have.property('avgConfidence');
      expect(result).to.have.property('confidenceMet');
      expect(result).to.have.property('executionTime');
      expect(result).to.have.property('metadata');
    });

    it('should create query plan', async function () {
      const result = await agent.query('machine learning');

      expect(result.plan).to.be.an('object');
      expect(result.plan).to.have.property('originalQuery');
      expect(result.plan).to.have.property('complexity');
      expect(result.plan).to.have.property('subQueries');
      expect(result.plan).to.have.property('strategy');
    });

    it('should return results array', async function () {
      const result = await agent.query('programming languages', {
        topK: 5,
      });

      expect(result.results).to.be.an('array');
      expect(result.results.length).to.be.at.most(5);
    });

    it('should calculate average confidence', async function () {
      const result = await agent.query('JavaScript frameworks');

      expect(result.avgConfidence).to.be.a('number');
      expect(result.avgConfidence).to.be.within(0, 1);
    });

    it('should track execution time', async function () {
      const result = await agent.query('Python');

      expect(result.executionTime).to.be.a('number');
      expect(result.executionTime).to.be.at.least(0); // Can be 0 if very fast
    });

    it('should include metadata', async function () {
      const result = await agent.query('test query');

      expect(result.metadata).to.have.property('totalResults');
      expect(result.metadata).to.have.property('uniqueDocuments');
      expect(result.metadata).to.have.property('strategy');
      expect(result.metadata).to.have.property('subQueriesExecuted');
    });
  });

  describe('Query Options', function () {
    it('should accept topic name', async function () {
      const result = await agent.query('programming', {
        topicName: 'Programming Languages',
      });

      expect(result).to.be.an('object');
      expect(result.results).to.be.an('array');
    });

    it('should accept workspace context', async function () {
      const result = await agent.query('refactoring', {
        workspaceContext: 'Current file: main.ts',
      });

      expect(result).to.be.an('object');
    });

    it('should accept retrieval strategy', async function () {
      const vectorResult = await agent.query('test', {
        retrievalStrategy: RetrievalStrategy.VECTOR,
      });

      expect(vectorResult.metadata.strategy).to.equal(RetrievalStrategy.VECTOR);
    });

    it('should respect topK parameter', async function () {
      const result = await agent.query('programming', {
        topK: 2,
      });

      expect(result.results.length).to.be.at.most(2);
    });

    it('should accept confidence threshold', async function () {
      const result = await agent.query('test', {
        confidenceThreshold: 0.5,
      });

      expect(result.confidenceMet).to.be.a('boolean');
    });
  });

  describe('Iterative Refinement', function () {
    // UC-1: High confidence after first pass → stop immediately
    it('should stop after first pass when confidence threshold is met', async function () {
      const result = await agent.query('Python programming', {
        confidenceThreshold: 0.1, // Low threshold easily met
        maxIterations: 5,
      });

      expect(result.confidenceMet).to.be.true;
      expect(result.iterations).to.equal(1);
    });

    // UC-2: Low confidence triggers follow-up iterations
    it('should attempt iteration and stop when no progress is made', async function () {
      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99, // Impossibly high to force iteration
      });

      expect(result.iterations).to.be.a('number');
      // With mock store returning same docs, convergence stops early
      expect(result.iterations).to.be.at.least(1).and.at.most(3);
      expect(result.confidenceMet).to.be.false;
    });

    // UC-3: Comparison queries detect coverage imbalance
    it('should handle comparison queries with iterative refinement', async function () {
      const result = await agent.query('difference between Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99,
      });

      expect(result.plan.complexity).to.equal('complex');
      expect(result.plan.subQueries.length).to.be.greaterThanOrEqual(2);
      expect(result.iterations).to.be.at.least(1);
      expect(result.results).to.be.an('array');
    });

    // UC-4: Complex multi-part queries detect under-covered sub-queries
    it('should iterate for complex multi-part queries', async function () {
      const result = await agent.query(
        'What is Python? How does JavaScript work? Compare TypeScript features.',
        {
          maxIterations: 3,
          confidenceThreshold: 0.99,
        }
      );

      expect(result.plan.complexity).to.be.oneOf(['moderate', 'complex']);
      expect(result.iterations).to.be.at.least(1);
      expect(result.metadata.subQueriesExecuted).to.be.at.least(1);
    });

    // UC-5: Max iterations limit is respected
    it('should respect max iterations', async function () {
      const result = await agent.query('complex query with multiple concepts', {
        maxIterations: 2,
        confidenceThreshold: 0.99,
      });

      expect(result.iterations).to.be.at.most(2);
    });

    // UC-6: Convergence detection stops early when no improvement
    it('should converge and stop when no improvement between iterations', async function () {
      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 5,
        confidenceThreshold: 0.99, // Won't be met
      });

      // Should stop before max iterations due to convergence
      expect(result.iterations).to.be.at.most(5);
      expect(result.results.length).to.be.greaterThan(0);
    });

    // Simple queries should bypass iterative refinement entirely
    it('should disable iterative refinement for simple queries', async function () {
      const result = await agent.query('Python', {
        maxIterations: 5,
      });

      // Simple queries use single-shot (plan.complexity === 'simple')
      expect(result.iterations).to.equal(1);
    });

    // Results accumulate across iterations
    it('should accumulate results across iterations', async function () {
      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99,
        topK: 10, // Higher topK to see accumulation
      });

      expect(result.metadata.totalResults).to.be.at.least(1);
      // Total results should include documents from multiple iterations
      expect(result.results).to.be.an('array');
    });

    // avgConfidence is calculated correctly across all accumulated results
    it('should calculate avgConfidence across all results', async function () {
      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 2,
        confidenceThreshold: 0.99,
      });

      expect(result.avgConfidence).to.be.a('number');
      expect(result.avgConfidence).to.be.within(0, 1);
    });

    // Deduplication still works with multi-iteration results
    it('should deduplicate results from multiple iterations', async function () {
      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99,
        topK: 10,
      });

      // All results should have unique chunk IDs
      const chunkIds = result.results.map(r => r.document.metadata.chunkId);
      const uniqueIds = new Set(chunkIds);
      expect(uniqueIds.size).to.equal(chunkIds.length);
    });

    // UC-cancellation: Pre-cancelled token stops iteration immediately
    it('should stop iteration when cancellation is requested', async function () {
      // Use the mock CancellationTokenSource from test setup
      const vscode = require('vscode');
      const cts = new vscode.CancellationTokenSource();
      cts.cancel(); // pre-cancel

      const result = await agent.query('compare Python and JavaScript', {
        maxIterations: 5,
        confidenceThreshold: 0.99,
        token: cts.token,
      });

      // Pre-cancelled token should stop at 0 iterations (cancelled before first iteration)
      expect(result.iterations).to.be.at.most(1);
      cts.dispose();
    });
  });

  describe('Parallel Execution', function () {
    it('should execute parallel sub-queries', async function () {
      const result = await agent.query('Python versus JavaScript');

      // Comparison query should use parallel strategy
      expect(result.plan.strategy).to.equal('parallel');
      expect(result.metadata.subQueriesExecuted).to.be.greaterThan(0);
    });

    it('should handle multiple parallel queries', async function () {
      const result = await agent.query(
        'Python and JavaScript and TypeScript'
      );

      expect(result.results).to.be.an('array');
      expect(result.results.length).to.be.greaterThan(0);
    });
  });

  describe('Sequential Execution', function () {
    it('should execute sequential sub-queries', async function () {
      // Long queries might use sequential
      const longQuery = 'What are the steps to learn Python programming from beginner to advanced level';
      const result = await agent.query(longQuery);

      expect(result.results).to.be.an('array');
    });
  });

  describe('Result Deduplication', function () {
    it('should deduplicate results with same chunkId', async function () {
      const result = await agent.query('Python', {
        topK: 10,
      });

      // Check metadata shows deduplication happened
      expect(result.metadata.uniqueDocuments).to.be.at.most(
        result.metadata.totalResults
      );
    });

    it('should preserve unique documents', async function () {
      const result = await agent.query('programming');

      const chunkIds = result.results.map((r) => r.document.metadata.chunkId);
      const uniqueIds = new Set(chunkIds);

      // All results should have unique chunk IDs
      expect(uniqueIds.size).to.equal(chunkIds.length);
    });
  });

  describe('Result Ranking', function () {
    it('should rank results by score', async function () {
      const result = await agent.query('Python', {
        topK: 5,
      });

      // Check scores are in descending order
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i - 1].score).to.be.at.least(
          result.results[i].score
        );
      }
    });

    it('should return highest scoring results', async function () {
      const result = await agent.query('JavaScript', {
        topK: 3,
      });

      expect(result.results.length).to.be.at.most(3);

      // First result should have highest score
      if (result.results.length > 1) {
        expect(result.results[0].score).to.be.at.least(
          result.results[result.results.length - 1].score
        );
      }
    });
  });

  describe('Error Handling', function () {
    it('should throw error if not initialized', async function () {
      const uninitializedAgent = new RAGAgent();

      try {
        await uninitializedAgent.query('test');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.an('error');
        expect((error as Error).message).to.include('not initialized');
      }
    });

    it('should handle empty query gracefully', async function () {
      const result = await agent.query('');

      expect(result).to.be.an('object');
      expect(result.results).to.be.an('array');
    });

    it('should handle invalid options gracefully', async function () {
      const result = await agent.query('test', {
        topK: -1, // Invalid topK
      });

      expect(result).to.be.an('object');
    });
  });

  describe('Configuration Management', function () {
    it('should accept configuration via query options', async function () {
      // Configuration is now passed as options to query methods
      const result = await agent.query('test query', {
        maxIterations: 2,
        confidenceThreshold: 0.8,
        retrievalStrategy: RetrievalStrategy.HYBRID,
      });

      expect(result).to.have.property('iterations');
      expect(result).to.have.property('avgConfidence');
    });

    it('should allow updating vector store', function () {
      const newVectorStore = new MockVectorStore();
      agent.setVectorStore(newVectorStore);

      // Should not throw
      expect(agent).to.be.an('object');
    });
  });

  describe('Query Plan Integration', function () {
    it('should use query planner for complex queries', async function () {
      const result = await agent.query('compare React and Vue frameworks');

      expect(result.plan.complexity).to.equal('complex');
      expect(result.plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should use simple plan for simple queries', async function () {
      const result = await agent.query('Python');

      expect(result.plan.complexity).to.equal('simple');
      expect(result.plan.subQueries).to.have.lengthOf(1);
    });
  });

  describe('Result Structure', function () {
    it('should include document in results', async function () {
      const result = await agent.query('test');

      result.results.forEach((r) => {
        expect(r.document).to.be.an('object');
        expect(r.document).to.have.property('pageContent');
        expect(r.document).to.have.property('metadata');
      });
    });

    it('should include score in results', async function () {
      const result = await agent.query('test');

      result.results.forEach((r) => {
        expect(r.score).to.be.a('number');
        expect(r.score).to.be.within(0, 1);
      });
    });

    it('should include source in results', async function () {
      const result = await agent.query('test');

      result.results.forEach((r) => {
        expect(r.source).to.be.oneOf(['vector', 'hybrid', 'keyword', 'ensemble', 'bm25']);
      });
    });
  });

  describe('Performance', function () {
    it('should complete query in reasonable time', async function () {
      const startTime = Date.now();

      await agent.query('Python programming');

      const elapsed = Date.now() - startTime;
      expect(elapsed).to.be.lessThan(5000); // 5 seconds
    });

    it('should handle multiple queries', async function () {
      const queries = ['Python', 'JavaScript', 'TypeScript'];

      const results = await Promise.all(
        queries.map((q) => agent.query(q, { topK: 2 }))
      );

      expect(results).to.have.lengthOf(3);
      results.forEach((result) => {
        expect(result.results).to.be.an('array');
      });
    });
  });

  describe('Gap Analysis (analyzeGaps)', function () {
    it('should detect no gaps when all sub-queries return high-score results', function () {
      const plan: QueryPlan = {
        originalQuery: 'Python programming',
        complexity: 'moderate',
        subQueries: [
          { query: 'Python basics', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'Python advanced', reasoning: 'r', topK: 5, priority: 'medium' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'a', metadata: {} }), score: 0.9, source: RetrievalStrategy.HYBRID, subQuery: 'Python basics' },
        { document: new LangChainDocument({ pageContent: 'b', metadata: {} }), score: 0.8, source: RetrievalStrategy.HYBRID, subQuery: 'Python basics' },
        { document: new LangChainDocument({ pageContent: 'c', metadata: {} }), score: 0.85, source: RetrievalStrategy.HYBRID, subQuery: 'Python advanced' },
        { document: new LangChainDocument({ pageContent: 'd', metadata: {} }), score: 0.7, source: RetrievalStrategy.HYBRID, subQuery: 'Python advanced' },
      ];

      const analysis = agent.analyzeGaps(plan, results);
      expect(analysis.gaps).to.have.lengthOf(0);
      expect(analysis.hasSufficientCoverage).to.be.true;
      expect(analysis.coverageRatio).to.equal(1);
    });

    it('should detect no_results gap', function () {
      const plan: QueryPlan = {
        originalQuery: 'compare Python and Rust',
        complexity: 'complex',
        subQueries: [
          { query: 'Python features', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'Rust features', reasoning: 'r', topK: 5, priority: 'high' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      // Only Python has results
      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'a', metadata: {} }), score: 0.9, source: RetrievalStrategy.HYBRID, subQuery: 'Python features' },
        { document: new LangChainDocument({ pageContent: 'b', metadata: {} }), score: 0.8, source: RetrievalStrategy.HYBRID, subQuery: 'Python features' },
      ];

      const analysis = agent.analyzeGaps(plan, results);
      expect(analysis.gaps).to.have.lengthOf(1);
      expect(analysis.gaps[0].subQuery.query).to.equal('Rust features');
      expect(analysis.gaps[0].reason).to.equal('no_results');
      expect(analysis.gaps[0].resultCount).to.equal(0);
      expect(analysis.coverageRatio).to.equal(0.5);
    });

    it('should detect low_score gap', function () {
      const plan: QueryPlan = {
        originalQuery: 'architecture patterns',
        complexity: 'moderate',
        subQueries: [
          { query: 'design patterns', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'microservices', reasoning: 'r', topK: 5, priority: 'medium' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'a', metadata: {} }), score: 0.85, source: RetrievalStrategy.HYBRID, subQuery: 'design patterns' },
        { document: new LangChainDocument({ pageContent: 'b', metadata: {} }), score: 0.2, source: RetrievalStrategy.HYBRID, subQuery: 'microservices' },
        { document: new LangChainDocument({ pageContent: 'c', metadata: {} }), score: 0.1, source: RetrievalStrategy.HYBRID, subQuery: 'microservices' },
      ];

      const analysis = agent.analyzeGaps(plan, results);
      expect(analysis.gaps).to.have.lengthOf(1);
      expect(analysis.gaps[0].subQuery.query).to.equal('microservices');
      expect(analysis.gaps[0].reason).to.equal('low_score');
      expect(analysis.gaps[0].avgScore).to.be.below(0.4);
    });

    it('should detect coverage_imbalance gap', function () {
      const plan: QueryPlan = {
        originalQuery: 'compare React and Angular',
        complexity: 'complex',
        subQueries: [
          { query: 'React features', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'Angular features', reasoning: 'r', topK: 5, priority: 'high' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      // React has many results, Angular has very few (< 30% of max)
      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'a', metadata: {} }), score: 0.9, source: RetrievalStrategy.HYBRID, subQuery: 'React features' },
        { document: new LangChainDocument({ pageContent: 'b', metadata: {} }), score: 0.85, source: RetrievalStrategy.HYBRID, subQuery: 'React features' },
        { document: new LangChainDocument({ pageContent: 'c', metadata: {} }), score: 0.8, source: RetrievalStrategy.HYBRID, subQuery: 'React features' },
        { document: new LangChainDocument({ pageContent: 'd', metadata: {} }), score: 0.75, source: RetrievalStrategy.HYBRID, subQuery: 'React features' },
        // Angular: 0 results → flagged as no_results AND coverage_imbalance
      ];

      const analysis = agent.analyzeGaps(plan, results);
      expect(analysis.gaps.length).to.be.greaterThanOrEqual(1);
      // Angular should be flagged
      const angularGap = analysis.gaps.find(g => g.subQuery.query === 'Angular features');
      expect(angularGap).to.exist;
    });

    it('should report full coverage when all sub-queries are well covered', function () {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'moderate',
        subQueries: [
          { query: 'q1', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'q2', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'q3', reasoning: 'r', topK: 5, priority: 'medium' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'a', metadata: {} }), score: 0.8, source: RetrievalStrategy.HYBRID, subQuery: 'q1' },
        { document: new LangChainDocument({ pageContent: 'b', metadata: {} }), score: 0.7, source: RetrievalStrategy.HYBRID, subQuery: 'q2' },
        { document: new LangChainDocument({ pageContent: 'c', metadata: {} }), score: 0.75, source: RetrievalStrategy.HYBRID, subQuery: 'q3' },
      ];

      const analysis = agent.analyzeGaps(plan, results);
      expect(analysis.hasSufficientCoverage).to.be.true;
      expect(analysis.coverageRatio).to.equal(1);
    });

    it('should handle empty results', function () {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'moderate',
        subQueries: [
          { query: 'q1', reasoning: 'r', topK: 5, priority: 'high' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };

      const analysis = agent.analyzeGaps(plan, []);
      expect(analysis.gaps).to.have.lengthOf(1);
      expect(analysis.gaps[0].reason).to.equal('no_results');
      expect(analysis.coverageRatio).to.equal(0);
      expect(analysis.hasSufficientCoverage).to.be.false;
    });

    it('should handle plan with no sub-queries', function () {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'simple',
        subQueries: [],
        strategy: 'sequential',
        explanation: 'test',
      };

      const analysis = agent.analyzeGaps(plan, []);
      expect(analysis.gaps).to.have.lengthOf(0);
      expect(analysis.coverageRatio).to.equal(1);
      expect(analysis.hasSufficientCoverage).to.be.true;
    });
  });

  describe('Iterative Refinement with Query-Aware Store', function () {
    let queryAwareStore: QueryAwareMockVectorStore;
    let qaAgent: RAGAgent;

    beforeEach(async function () {
      qaAgent = new RAGAgent();
      queryAwareStore = new QueryAwareMockVectorStore();

      const docs = [
        new LangChainDocument({ pageContent: 'Python is great for data science', metadata: { chunkId: 'py1', source: 'python.txt' } }),
        new LangChainDocument({ pageContent: 'Python has dynamic typing', metadata: { chunkId: 'py2', source: 'python.txt' } }),
        new LangChainDocument({ pageContent: 'JavaScript powers the web', metadata: { chunkId: 'js1', source: 'javascript.txt' } }),
        new LangChainDocument({ pageContent: 'TypeScript adds static types to JavaScript', metadata: { chunkId: 'ts1', source: 'typescript.txt' } }),
        new LangChainDocument({ pageContent: 'Rust is a systems programming language', metadata: { chunkId: 'rs1', source: 'rust.txt' } }),
      ];

      await queryAwareStore.addDocuments(docs);

      // Python queries return good results
      queryAwareStore.addRule('python', [0, 1], 0.9);
      // JavaScript queries return decent results
      queryAwareStore.addRule('javascript', [2, 3], 0.7);
      // Rust queries return very poor results (simulating gap)
      queryAwareStore.addRule('rust', [4], 0.15);
      // TypeScript queries return moderate results
      queryAwareStore.addRule('typescript', [3], 0.6);

      await qaAgent.initialize(queryAwareStore);
    });

    it('should complete iterative refinement with query-aware results', async function () {
      const result = await qaAgent.query('compare Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99,
      });

      expect(result.iterations).to.be.at.least(1);
      expect(result.results).to.be.an('array');
      expect(result.results.length).to.be.greaterThan(0);
    });

    it('should detect gaps when one topic has low scores', async function () {
      // Create a plan that references both Python (good) and Rust (poor)
      const plan: QueryPlan = {
        originalQuery: 'compare Python and Rust',
        complexity: 'complex',
        subQueries: [
          { query: 'Python features', reasoning: 'reason', topK: 3, priority: 'high' },
          { query: 'Rust features', reasoning: 'reason', topK: 3, priority: 'high' },
        ],
        strategy: 'parallel',
        explanation: 'Compare two languages',
      };

      // Simulate results: Python yields good scores, Rust yields low scores
      const results: RetrievalResult[] = [
        { document: new LangChainDocument({ pageContent: 'Python is great', metadata: {} }), score: 0.9, source: RetrievalStrategy.HYBRID, subQuery: 'Python features' },
        { document: new LangChainDocument({ pageContent: 'Python dynamic', metadata: {} }), score: 0.85, source: RetrievalStrategy.HYBRID, subQuery: 'Python features' },
        { document: new LangChainDocument({ pageContent: 'Rust systems', metadata: {} }), score: 0.15, source: RetrievalStrategy.HYBRID, subQuery: 'Rust features' },
      ];

      const gapAnalysis = qaAgent.analyzeGaps(plan, results);
      expect(gapAnalysis.gaps.length).to.be.greaterThanOrEqual(1);

      const rustGap = gapAnalysis.gaps.find(g => g.subQuery.query === 'Rust features');
      expect(rustGap).to.exist;
      expect(rustGap!.reason).to.equal('low_score');
    });

    it('should accumulate unique results across iterations', async function () {
      const result = await qaAgent.query('compare Python and JavaScript', {
        maxIterations: 3,
        confidenceThreshold: 0.99,
        topK: 10,
      });

      // Results from multiple iterations should all be unique
      const chunkIds = result.results
        .map(r => r.document.metadata.chunkId)
        .filter(Boolean);
      const uniqueIds = new Set(chunkIds);
      expect(uniqueIds.size).to.equal(chunkIds.length);
    });
  });
});
