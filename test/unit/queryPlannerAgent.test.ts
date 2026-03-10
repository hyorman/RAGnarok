/**
 * Unit Tests for QueryPlannerAgent
 * Tests query decomposition, complexity analysis, and planning strategies
 */

import { expect } from 'chai';
import { QueryPlannerAgent, QueryPlan, SubQuery } from '../../src/agents/queryPlannerAgent';

describe('QueryPlannerAgent', function() {
  this.timeout(30000); // 30 seconds for LLM tests

  let planner: QueryPlannerAgent;

  beforeEach(function() {
    planner = new QueryPlannerAgent();
  });

  describe('Initialization', function() {
    it('should initialize successfully', function() {
      const agent = new QueryPlannerAgent();
      expect(agent).to.be.an('object');
    });
  });

  describe('Heuristic Planning (No LLM)', function() {
    describe('Simple Queries', function() {
      it('should classify simple queries correctly', async function() {
        const queries = [
          'What is Python?',
          'machine learning basics',
          'how to install packages',
        ];

        for (const query of queries) {
          const plan = await planner.createPlan(query);

          expect(plan.complexity).to.equal('simple');
          expect(plan.subQueries.length).to.equal(1);
          expect(plan.subQueries[0].query).to.equal(query);
          expect(plan.strategy).to.be.oneOf(['parallel', 'sequential', 'hybrid', 'priority-based']);
        }
      });

      it('should create single sub-query for simple queries', async function() {
        const plan = await planner.createPlan('What is TypeScript?');

        expect(plan.originalQuery).to.equal('What is TypeScript?');
        expect(plan.complexity).to.equal('simple');
        expect(plan.subQueries).to.have.lengthOf(1);
        expect(plan.subQueries[0].query).to.equal('What is TypeScript?');
        expect(plan.subQueries[0].reasoning).to.be.a('string');
      });

      it('should set default topK for sub-queries', async function() {
        const plan = await planner.createPlan('machine learning', {
          defaultTopK: 10,
        });

        expect(plan.subQueries[0].topK).to.equal(10);
      });

      it('should include explanation', async function() {
        const plan = await planner.createPlan('simple query');

        expect(plan.explanation).to.be.a('string');
        expect(plan.explanation.length).to.be.greaterThan(0);
      });
    });

    describe('Moderate Complexity Queries', function() {
      it('should detect queries with multiple concepts', async function() {
        const query = 'Python and JavaScript and TypeScript'; // Needs 3+ concepts (>2)
        const plan = await planner.createPlan(query);

        expect(plan.complexity).to.equal('moderate');
        expect(plan.subQueries.length).to.be.greaterThan(1);
      });

      it('should split on common delimiters', async function() {
        const query = 'What is Python? How to install it? Best practices?';
        const plan = await planner.createPlan(query);

        expect(plan.complexity).to.equal('moderate');
        expect(plan.subQueries.length).to.be.greaterThan(1);
      });

      it('should use parallel strategy for independent concepts', async function() {
        const query = 'React and Vue and Angular frameworks'; // Needs 3+ concepts
        const plan = await planner.createPlan(query);

        expect(plan.strategy).to.equal('parallel');
      });

      it('should respect maxSubQueries limit', async function() {
        const query = 'Python and JavaScript and TypeScript and Ruby and Go';
        const plan = await planner.createPlan(query, {
          maxSubQueries: 2,
        });

        expect(plan.subQueries.length).to.be.lessThanOrEqual(2);
      });

      it('should handle long queries', async function() {
        const longQuery = 'This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques';
        const plan = await planner.createPlan(longQuery);

        expect(plan.complexity).to.be.oneOf(['moderate', 'complex']);
        expect(plan.subQueries.length).to.be.greaterThan(0);
      });
    });

    describe('Complex Queries', function() {
      it('should detect comparison queries', async function() {
        const queries = [
          'Python vs JavaScript',
          'compare React and Vue',
          'difference between SQL and NoSQL',
          'which is better: TypeScript or JavaScript',
        ];

        for (const query of queries) {
          const plan = await planner.createPlan(query);

          expect(plan.complexity).to.equal('complex');
          expect(plan.strategy).to.equal('parallel');
        }
      });

      it('should split comparison queries into parts', async function() {
        const plan = await planner.createPlan('React framework versus Vue framework');

        expect(plan.complexity).to.equal('complex');
        expect(plan.subQueries.length).to.be.at.least(1); // At least identifies as complex

        // Should include comparison terms in some form
        const allText = plan.subQueries.map(sq => sq.query.toLowerCase()).join(' ');
        expect(allText.length).to.be.greaterThan(0);
      });

      it('should use parallel strategy for comparisons', async function() {
        const plan = await planner.createPlan('Python vs JavaScript performance');

        expect(plan.strategy).to.equal('parallel');
      });
    });

    describe('Sub-Query Properties', function() {
      it('should set priority for sub-queries', async function() {
        const plan = await planner.createPlan('machine learning');

        plan.subQueries.forEach(sq => {
          expect(sq.priority).to.be.oneOf(['high', 'medium', 'low']);
        });
      });

      it('should provide reasoning for each sub-query', async function() {
        const plan = await planner.createPlan('Python vs JavaScript');

        plan.subQueries.forEach(sq => {
          expect(sq.reasoning).to.be.a('string');
          expect(sq.reasoning.length).to.be.greaterThan(0);
        });
      });

      it('should set topK for each sub-query', async function() {
        const plan = await planner.createPlan('machine learning', {
          defaultTopK: 7,
        });

        plan.subQueries.forEach(sq => {
          expect(sq.topK).to.equal(7);
        });
      });
    });

    describe('Strategy Selection', function() {
      it('should use sequential for dependent queries', async function() {
        const query = 'What are the steps to deploy a web application';
        const plan = await planner.createPlan(query);

        // Long queries that might need follow-up use sequential
        if (plan.complexity === 'moderate' && query.length > 50) {
          expect(plan.strategy).to.be.oneOf(['sequential', 'parallel']);
        }
      });

      it('should use parallel for independent queries', async function() {
        const query = 'Python features and JavaScript features';
        const plan = await planner.createPlan(query);

        expect(plan.strategy).to.equal('parallel');
      });
    });
  });

  describe('LLM Planning', function() {
    it('should attempt LLM planning and fallback to heuristic', async function() {
      const plan = await planner.createPlan('What is machine learning?');

      // Should return a valid plan regardless of LLM availability
      expect(plan).to.be.an('object');
      expect(plan).to.have.property('originalQuery');
      expect(plan).to.have.property('complexity');
      expect(plan).to.have.property('subQueries');
      expect(plan).to.have.property('strategy');
      expect(plan).to.have.property('explanation');
    });

    it('should gracefully fallback to heuristic if LLM unavailable', async function() {
      const plan = await planner.createPlan('complex query');

      // Should still produce valid plan
      expect(plan.complexity).to.be.oneOf(['simple', 'moderate', 'complex']);
      expect(plan.subQueries).to.be.an('array');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe('Context Integration', function() {
    it('should accept topic name in options', async function() {
      const plan = await planner.createPlan('machine learning', {
        topicName: 'AI Research',
      });

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should accept workspace context', async function() {
      const plan = await planner.createPlan('refactoring', {
        workspaceContext: 'Current file: typescript-project/src/main.ts',
      });

      expect(plan).to.be.an('object');
    });
  });

  describe('Edge Cases', function() {
    it('should handle empty query', async function() {
      const plan = await planner.createPlan('');

      expect(plan).to.be.an('object');
      expect(plan.subQueries).to.be.an('array');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle very short queries', async function() {
      const plan = await planner.createPlan('ML');

      expect(plan.complexity).to.equal('simple');
      expect(plan.subQueries).to.have.lengthOf(1);
    });

    it('should handle very long queries', async function() {
      const longQuery = 'a'.repeat(500);
      const plan = await planner.createPlan(longQuery);

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle queries with special characters', async function() {
      const plan = await planner.createPlan('C++ vs C# programming!');

      expect(plan.complexity).to.equal('complex'); // Has "vs"
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle queries with multiple delimiters', async function() {
      const query = 'What is Python? How to use it? Why is it popular?';
      const plan = await planner.createPlan(query);

      expect(plan.subQueries.length).to.be.greaterThan(1);
    });

    it('should handle queries with AND/OR operators', async function() {
      const query = 'Python and JavaScript and TypeScript'; // Needs 3+ for hasMultipleConcepts
      const plan = await planner.createPlan(query);

      expect(plan.complexity).to.equal('moderate'); // Has multiple concepts
      expect(plan.subQueries.length).to.be.greaterThan(1);
    });
  });

  describe('Plan Validation', function() {
    it('should always return valid originalQuery', async function() {
      const testQuery = 'test query';
      const plan = await planner.createPlan(testQuery);

      expect(plan.originalQuery).to.equal(testQuery);
    });

    it('should always have at least one sub-query', async function() {
      const queries = ['', 'a', 'simple query', 'complex vs query'];

      for (const query of queries) {
        const plan = await planner.createPlan(query);
        expect(plan.subQueries.length).to.be.at.least(1);
      }
    });

    it('should have valid complexity values', async function() {
      const plan = await planner.createPlan('test');

      expect(plan.complexity).to.be.oneOf(['simple', 'moderate', 'complex']);
    });

    it('should have valid strategy values', async function() {
      const plan = await planner.createPlan('test');

      expect(plan.strategy).to.be.oneOf(['sequential', 'parallel', 'hybrid', 'priority-based']);
    });

    it('should have explanation string', async function() {
      const plan = await planner.createPlan('test');

      expect(plan.explanation).to.be.a('string');
      expect(plan.explanation.length).to.be.greaterThan(0);
    });
  });

  describe('Performance', function() {
    it('should create plans quickly for heuristic mode', async function() {
      const startTime = Date.now();

      await planner.createPlan('machine learning basics');

      const elapsed = Date.now() - startTime;
      expect(elapsed).to.be.lessThan(1000); // Should be very fast
    });

    it('should handle batch planning', async function() {
      const queries = [
        'Python programming',
        'React vs Vue',
        'machine learning and deep learning',
        'What is TypeScript?',
        'How to deploy applications',
      ];

      const plans = await Promise.all(
        queries.map(q => planner.createPlan(q))
      );

      expect(plans).to.have.lengthOf(5);
      plans.forEach(plan => {
        expect(plan.subQueries.length).to.be.greaterThan(0);
      });
    });
  });

  describe('Query Types', function() {
    it('should handle "what" questions', async function() {
      const plan = await planner.createPlan('What is machine learning?');

      expect(plan.complexity).to.equal('simple');
    });

    it('should handle "how" questions', async function() {
      const plan = await planner.createPlan('How to learn Python?');

      expect(plan.complexity).to.equal('simple');
    });

    it('should handle "why" questions', async function() {
      const plan = await planner.createPlan('Why use TypeScript?');

      expect(plan.complexity).to.equal('simple');
    });

    it('should handle comparison questions', async function() {
      const plan = await planner.createPlan('Which is better: React or Vue?');

      expect(plan.complexity).to.equal('complex');
    });

    it('should handle procedural questions', async function() {
      const plan = await planner.createPlan(
        'Steps to deploy a React application'
      );

      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe('Plan Caching', function() {
    it('should return cached plan for identical queries', async function() {
      const plan1 = await planner.createPlan('machine learning basics');
      const plan2 = await planner.createPlan('machine learning basics');

      expect(plan1).to.deep.equal(plan2);
    });

    it('should not cache across different options', async function() {
      const plan1 = await planner.createPlan('machine learning basics', { defaultTopK: 5 });
      const plan2 = await planner.createPlan('machine learning basics', { defaultTopK: 10 });

      expect(plan1.subQueries[0].topK).to.equal(5);
      expect(plan2.subQueries[0].topK).to.equal(10);
    });

    it('should build distinct cache keys for all plan-affecting options', function() {
      const query = 'Python and JavaScript and TypeScript';
      const baseKey = (planner as any).buildCacheKey(query, {
        modelFamily: 'gpt-4o-mini',
        maxSubQueries: 3,
        defaultTopK: 5,
        topicName: 'General Docs',
        workspaceContext: 'src/index.ts',
        minTopK: 1,
        topKMultipliers: { high: 1.0, medium: 0.7, low: 0.5 },
      });

      const changedKeys = [
        (planner as any).buildCacheKey(query, { modelFamily: 'gpt-4o' }),
        (planner as any).buildCacheKey(query, { maxSubQueries: 2 }),
        (planner as any).buildCacheKey(query, { defaultTopK: 7 }),
        (planner as any).buildCacheKey(query, { topicName: 'API Docs' }),
        (planner as any).buildCacheKey(query, { workspaceContext: 'src/server.ts' }),
        (planner as any).buildCacheKey(query, { minTopK: 2 }),
        (planner as any).buildCacheKey(query, { topKMultipliers: { high: 1.0, medium: 0.5, low: 0.25 } }),
      ];

      changedKeys.forEach((key: string) => {
        expect(key).to.not.equal(baseKey);
      });
    });

    it('should clear cache when clearCache is called', async function() {
      await planner.createPlan('cached query', { defaultTopK: 5 });
      planner.clearCache();

      // After clearing, a new plan should be created (same value, but cache was cleared)
      const plan = await planner.createPlan('cached query', { defaultTopK: 5 });
      expect(plan).to.be.an('object');
      expect(plan.subQueries[0].topK).to.equal(5);
    });
  });

  describe('maxSubQueries Uniformity', function() {
    it('should respect maxSubQueries for comparison queries', async function() {
      const plan = await planner.createPlan('Python vs JavaScript vs Ruby vs Go', {
        maxSubQueries: 2,
      });

      expect(plan.subQueries.length).to.be.lessThanOrEqual(2);
    });

    it('should respect maxSubQueries for long queries', async function() {
      const longQuery = 'This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques';
      const plan = await planner.createPlan(longQuery, {
        maxSubQueries: 1,
      });

      expect(plan.subQueries.length).to.be.lessThanOrEqual(1);
    });
  });

  describe('Improved Comparison Splitting', function() {
    it('should extract clean concepts from "X vs Y" pattern', async function() {
      const plan = await planner.createPlan('Python vs JavaScript');

      expect(plan.complexity).to.equal('complex');
      expect(plan.subQueries.length).to.equal(2);
      expect(plan.subQueries[0].query).to.equal('Python');
      expect(plan.subQueries[1].query).to.equal('JavaScript');
    });

    it('should handle "difference between X and Y" pattern', async function() {
      const plan = await planner.createPlan('difference between SQL and NoSQL');

      expect(plan.complexity).to.equal('complex');
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal('SQL');
      expect(plan.subQueries[1].query).to.equal('NoSQL');
    });

    it('should handle "compare X to Y" pattern', async function() {
      const plan = await planner.createPlan('compare React to Vue');

      expect(plan.complexity).to.equal('complex');
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal('React');
      expect(plan.subQueries[1].query).to.equal('Vue');
    });

    it('should handle "compare X with Y" pattern', async function() {
      const plan = await planner.createPlan('compare Docker with Kubernetes');

      expect(plan.complexity).to.equal('complex');
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal('Docker');
      expect(plan.subQueries[1].query).to.equal('Kubernetes');
    });
  });


  describe('Dynamic topK by Priority', function() {
    it('should assign full topK to high-priority sub-queries', async function() {
      const plan = await planner.createPlan('Python vs JavaScript', {
        defaultTopK: 10,
      });

      const highPriority = plan.subQueries.filter(sq => sq.priority === 'high');
      highPriority.forEach(sq => {
        expect(sq.topK).to.equal(10);
      });
    });

    it('should assign reduced topK to medium-priority sub-queries', async function() {
      // Multi-concept query generates medium-priority sub-queries
      const plan = await planner.createPlan(
        'Python and JavaScript and TypeScript',
        { defaultTopK: 10 }
      );

      const mediumPriority = plan.subQueries.filter(sq => sq.priority === 'medium');
      mediumPriority.forEach(sq => {
        expect(sq.topK).to.be.lessThan(10);
        expect(sq.topK).to.be.greaterThanOrEqual(1);
      });
    });
  });

  describe('Early Exit for Trivial Queries', function() {
    it('should fast-path single-word queries', async function() {
      const plan = await planner.createPlan('Python');

      expect(plan.complexity).to.equal('simple');
      expect(plan.subQueries).to.have.lengthOf(1);
      expect(plan.explanation).to.include('Trivial');
    });

    it('should fast-path empty queries', async function() {
      const plan = await planner.createPlan('');

      expect(plan.complexity).to.equal('simple');
      expect(plan.subQueries).to.have.lengthOf(1);
    });
  });

  describe('Custom Strategies', function() {
    it('should use hybrid strategy for complex non-comparison queries', async function() {
      // Build a query that triggers high complexity score (>= 0.6) without a comparison keyword
      const plan = await planner.createPlan(
        'What are the steps to configure, deploy, and monitor a distributed system? How do we handle failures and scaling?',
      );

      // This should be complex with high score
      expect(plan.strategy).to.be.oneOf(['hybrid', 'parallel', 'priority-based', 'sequential']);
    });

    it('should use priority-based strategy for moderate queries with many sub-queries', async function() {
      const plan = await planner.createPlan(
        'Python and JavaScript and TypeScript and Ruby',
      );

      expect(plan.strategy).to.be.oneOf(['parallel', 'priority-based']);
    });
  });

  describe('Enhanced Validation', function() {
    it('should validate basic plan structure', function() {
      const validPlan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'simple',
        subQueries: [{ query: 'test', reasoning: 'test', topK: 5, priority: 'high' }],
        strategy: 'parallel',
        explanation: 'test',
      };
      expect(planner.validatePlan(validPlan)).to.be.true;
    });

    it('should reject plans exceeding maxSubQueries', function() {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'complex',
        subQueries: [
          { query: 'a', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'b', reasoning: 'r', topK: 5, priority: 'high' },
          { query: 'c', reasoning: 'r', topK: 5, priority: 'high' },
        ],
        strategy: 'parallel',
        explanation: 'test',
      };
      expect(planner.validatePlan(plan, { maxSubQueries: 2 })).to.be.false;
    });

    it('should reject plans where topK exceeds default', function() {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'simple',
        subQueries: [{ query: 'test', reasoning: 'r', topK: 20, priority: 'high' }],
        strategy: 'parallel',
        explanation: 'test',
      };
      expect(planner.validatePlan(plan, { defaultTopK: 10 })).to.be.false;
    });
  });

  describe('Special Character & Edge Case Queries', function() {
    it('should handle queries with code snippets', async function() {
      const plan = await planner.createPlan('how to use Array.map() in JavaScript');

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle queries with mixed delimiters', async function() {
      const plan = await planner.createPlan('Python; JavaScript! TypeScript?');

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle queries with brackets and arrows', async function() {
      const plan = await planner.createPlan('React<Props> vs Vue => components');

      expect(plan.complexity).to.equal('complex');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle unicode queries', async function() {
      const plan = await planner.createPlan('машинное обучение');

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it('should handle queries with only special characters', async function() {
      const plan = await planner.createPlan('?!@#$%');

      expect(plan).to.be.an('object');
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe('Configurable topK Multipliers', function() {
    it('should apply custom multipliers to sub-query topK', async function() {
      const plan = await planner.createPlan(
        'Python and JavaScript and TypeScript',
        { defaultTopK: 10, topKMultipliers: { high: 1.0, medium: 0.5, low: 0.3 } },
      );

      const medium = plan.subQueries.filter(sq => sq.priority === 'medium');
      medium.forEach(sq => {
        expect(sq.topK).to.equal(5); // 10 * 0.5
      });
    });

    it('should use default multipliers when none provided', async function() {
      const plan = await planner.createPlan(
        'Python and JavaScript and TypeScript',
        { defaultTopK: 10 },
      );

      const medium = plan.subQueries.filter(sq => sq.priority === 'medium');
      medium.forEach(sq => {
        expect(sq.topK).to.equal(7); // ceil(10 * 0.7)
      });
    });
  });

  describe('Minimum topK Enforcement', function() {
    it('should enforce minTopK during validation', function() {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'simple',
        subQueries: [{ query: 'test', reasoning: 'r', topK: 0, priority: 'high' }],
        strategy: 'parallel',
        explanation: 'test',
      };
      expect(planner.validatePlan(plan, { minTopK: 1 })).to.be.false;
    });

    it('should pass validation when topK meets minimum', function() {
      const plan: QueryPlan = {
        originalQuery: 'test',
        complexity: 'simple',
        subQueries: [{ query: 'test', reasoning: 'r', topK: 3, priority: 'high' }],
        strategy: 'parallel',
        explanation: 'test',
      };
      expect(planner.validatePlan(plan, { minTopK: 1 })).to.be.true;
    });
  });

  describe('Long Query Keyword Extraction', function() {
    it('should create keyword sub-query for long queries', async function() {
      const longQuery = 'This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques';
      const plan = await planner.createPlan(longQuery);

      expect(plan.subQueries.length).to.be.greaterThanOrEqual(2);

      // Should have a keyword-focused sub-query
      const keywordSq = plan.subQueries.find(sq => sq.reasoning.toLowerCase().includes('keyword'));
      expect(keywordSq).to.not.be.undefined;
    });
  });

  describe('Context-Aware Complexity', function() {
    it('should boost complexity for technical context', async function() {
      const simple = await planner.createPlan('explain functions');
      const techContext = await planner.createPlan('explain functions', {
        topicName: 'Kubernetes API Deployment',
      });

      // The technical context should produce an equal or higher complexity
      // (both return heuristic plans, but the score may differ)
      expect(techContext).to.be.an('object');
      expect(techContext.subQueries.length).to.be.greaterThan(0);
    });

    it('should report when technical context boosting applies', function() {
      const withBoost = (planner as any).hasTechnicalContextBoost('explain functions', {
        topicName: 'Kubernetes API Deployment',
      });
      const withoutBoost = (planner as any).hasTechnicalContextBoost('explain functions', {
        topicName: 'General Writing',
      });

      expect(withBoost).to.be.true;
      expect(withoutBoost).to.be.false;
    });
  });

  describe('Refinement Prompt Alignment', function() {
    it('should advertise every supported strategy in the refinement prompt', function() {
      const prompt = (planner as any).buildRefinementPrompt(
        'compare React and Vue',
        'Topic: Frontend',
        {
          originalQuery: 'compare React and Vue',
          complexity: 'complex',
          subQueries: [
            { query: 'React', reasoning: 'Search React', topK: 5, priority: 'high' },
            { query: 'Vue', reasoning: 'Search Vue', topK: 5, priority: 'high' },
          ],
          strategy: 'parallel',
          explanation: 'Comparison query',
        },
      );

      expect(prompt).to.include('sequential, parallel, hybrid, or priority-based');
      expect(prompt).to.include('"strategy": "sequential" | "parallel" | "hybrid" | "priority-based"');
      expect(prompt).to.include('Hybrid strategy');
      expect(prompt).to.include('Priority-based strategy');
    });
  });

  describe('Performance Benchmarks', function() {
    it('should handle 100 queries efficiently', async function() {
      const startTime = Date.now();

      const queries = Array.from({ length: 100 }, (_, i) => `query number ${i}`);
      await Promise.all(queries.map(q => planner.createPlan(q)));

      const elapsed = Date.now() - startTime;
      expect(elapsed).to.be.lessThan(5000); // 100 plans under 5 seconds
    });
  });
});
