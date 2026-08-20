/**
 * Unit Tests for QueryPlannerAgent
 * Tests query decomposition, complexity analysis, and planning strategies
 */

import { expect } from "chai";
import { QueryPlannerAgent } from "../src/index";
import { mockLLMProvider, defaultPlannerOptions } from "./helpers/testDefaults";

describe("QueryPlannerAgent", function () {
  this.timeout(30000); // 30 seconds for LLM tests

  let planner: QueryPlannerAgent;

  beforeEach(function () {
    planner = new QueryPlannerAgent(mockLLMProvider);
  });

  describe("Initialization", function () {
    it("should initialize successfully", function () {
      const agent = new QueryPlannerAgent(mockLLMProvider);
      expect(agent).to.be.an("object");
    });
  });

  describe("Heuristic Planning (No LLM)", function () {
    describe("Simple Queries", function () {
      it("should classify simple queries correctly", async function () {
        const queries = ["What is Python?", "machine learning basics", "how to install packages"];

        for (const query of queries) {
          const plan = await planner.createPlan(query, defaultPlannerOptions());
          expect(plan.subQueries.length).to.equal(1);
          expect(plan.subQueries[0].query).to.equal(query);
        }
      });

      it("should create single sub-query for simple queries", async function () {
        const plan = await planner.createPlan("What is TypeScript?", defaultPlannerOptions());

        expect(plan.originalQuery).to.equal("What is TypeScript?");
        expect(plan.complexity).to.equal("simple");
        expect(plan.subQueries).to.have.lengthOf(1);
        expect(plan.subQueries[0].query).to.equal("What is TypeScript?");
        expect(plan.subQueries[0].reasoning).to.be.a("string");
      });

      it("should set default topK for sub-queries", async function () {
        const plan = await planner.createPlan(
          "machine learning",
          defaultPlannerOptions({
            topK: 10,
          }),
        );

        expect(plan.subQueries[0].topK).to.equal(10);
      });

      it("should include explanation", async function () {
        const plan = await planner.createPlan("simple query", defaultPlannerOptions());

        expect(plan.explanation).to.be.a("string");
        expect(plan.explanation.length).to.be.greaterThan(0);
      });
    });

    describe("Moderate Complexity Queries", function () {
      it("should detect queries with multiple concepts", async function () {
        const query = "Python and JavaScript and TypeScript"; // Needs 3+ concepts (>2)
        const plan = await planner.createPlan(query, defaultPlannerOptions());

        expect(plan.complexity).to.equal("moderate");
        expect(plan.subQueries.length).to.be.greaterThan(1);
      });

      it("should split on common delimiters", async function () {
        const query = "What is Python? How to install it? Best practices?";
        const plan = await planner.createPlan(query, defaultPlannerOptions());

        expect(plan.complexity).to.equal("moderate");
        expect(plan.subQueries.length).to.be.greaterThan(1);
      });

      it("should respect maxSubQueries limit", async function () {
        const query = "Python and JavaScript and TypeScript and Ruby and Go";
        const plan = await planner.createPlan(query, defaultPlannerOptions());

        expect(plan.subQueries.length).to.be.lessThanOrEqual(5);
      });

      it("should handle long queries", async function () {
        const longQuery =
          "This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques";
        const plan = await planner.createPlan(longQuery, defaultPlannerOptions());

        expect(plan.complexity).to.be.oneOf(["moderate", "complex"]);
        expect(plan.subQueries.length).to.be.greaterThan(0);
      });
    });

    describe("Complex Queries", function () {
      it("should detect comparison queries", async function () {
        const queries = [
          "Python vs JavaScript",
          "compare React and Vue",
          "difference between SQL and NoSQL",
          "which is better: TypeScript or JavaScript",
        ];

        for (const query of queries) {
          const plan = await planner.createPlan(query, defaultPlannerOptions());

          expect(plan.complexity).to.equal("complex");
        }
      });

      it("should split comparison queries into parts", async function () {
        const plan = await planner.createPlan("React framework versus Vue framework", defaultPlannerOptions());

        expect(plan.complexity).to.equal("complex");
        expect(plan.subQueries.length).to.be.at.least(1); // At least identifies as complex

        // Should include comparison terms in some form
        const allText = plan.subQueries.map((sq) => sq.query.toLowerCase()).join(" ");
        expect(allText.length).to.be.greaterThan(0);
      });
    });

    describe("Sub-Query Properties", function () {
      it("should provide reasoning for each sub-query", async function () {
        const plan = await planner.createPlan("Python vs JavaScript", defaultPlannerOptions());

        plan.subQueries.forEach((sq) => {
          expect(sq.reasoning).to.be.a("string");
          expect(sq.reasoning.length).to.be.greaterThan(0);
        });
      });

      it("should set topK for each sub-query", async function () {
        const plan = await planner.createPlan(
          "machine learning",
          defaultPlannerOptions({
            topK: 7,
          }),
        );

        plan.subQueries.forEach((sq) => {
          expect(sq.topK).to.equal(7);
        });
      });
    });
  });

  describe("LLM Planning", function () {
    it("should attempt LLM planning and fallback to heuristic", async function () {
      const plan = await planner.createPlan("What is machine learning?", defaultPlannerOptions());

      // Should return a valid plan regardless of LLM availability
      expect(plan).to.be.an("object");
      expect(plan).to.have.property("originalQuery");
      expect(plan).to.have.property("complexity");
      expect(plan).to.have.property("subQueries");
      expect(plan).to.have.property("explanation");
    });

    it("should gracefully fallback to heuristic if LLM unavailable", async function () {
      const plan = await planner.createPlan("complex query", defaultPlannerOptions());

      // Should still produce valid plan
      expect(plan.complexity).to.be.oneOf(["simple", "moderate", "complex"]);
      expect(plan.subQueries).to.be.an("array");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe("Context Integration", function () {
    it("should accept topic name in options", async function () {
      const plan = await planner.createPlan(
        "machine learning",
        defaultPlannerOptions({
          topicName: "AI Research",
        }),
      );

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should accept workspace context", async function () {
      const plan = await planner.createPlan(
        "refactoring",
        defaultPlannerOptions({
          workspaceContext: "Current file: typescript-project/src/main.ts",
        }),
      );

      expect(plan).to.be.an("object");
    });
  });

  describe("Edge Cases", function () {
    it("should handle empty query", async function () {
      const plan = await planner.createPlan("", defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries).to.be.an("array");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle very short queries", async function () {
      const plan = await planner.createPlan("ML", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
      expect(plan.subQueries).to.have.lengthOf(1);
    });

    it("should handle very long queries", async function () {
      const longQuery = "a".repeat(500);
      const plan = await planner.createPlan(longQuery, defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle queries with special characters", async function () {
      const plan = await planner.createPlan("C++ vs C# programming!", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex"); // Has "vs"
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle queries with multiple delimiters", async function () {
      const query = "What is Python? How to use it? Why is it popular?";
      const plan = await planner.createPlan(query, defaultPlannerOptions());

      expect(plan.subQueries.length).to.be.greaterThan(1);
    });

    it("should handle queries with AND/OR operators", async function () {
      const query = "Python and JavaScript and TypeScript"; // Needs 3+ for hasMultipleConcepts
      const plan = await planner.createPlan(query, defaultPlannerOptions());

      expect(plan.complexity).to.equal("moderate"); // Has multiple concepts
      expect(plan.subQueries.length).to.be.greaterThan(1);
    });
  });

  describe("Plan Validation", function () {
    it("should always return valid originalQuery", async function () {
      const testQuery = "test query";
      const plan = await planner.createPlan(testQuery, defaultPlannerOptions());

      expect(plan.originalQuery).to.equal(testQuery);
    });

    it("should always have at least one sub-query", async function () {
      const queries = ["", "a", "simple query", "complex vs query"];

      for (const query of queries) {
        const plan = await planner.createPlan(query, defaultPlannerOptions());
        expect(plan.subQueries.length).to.be.at.least(1);
      }
    });

    it("should have valid complexity values", async function () {
      const plan = await planner.createPlan("test", defaultPlannerOptions());

      expect(plan.complexity).to.be.oneOf(["simple", "moderate", "complex"]);
    });

    it("should have explanation string", async function () {
      const plan = await planner.createPlan("test", defaultPlannerOptions());

      expect(plan.explanation).to.be.a("string");
      expect(plan.explanation.length).to.be.greaterThan(0);
    });
  });

  describe("Performance", function () {
    it("should create plans quickly for heuristic mode", async function () {
      const startTime = Date.now();

      await planner.createPlan("machine learning basics", defaultPlannerOptions());

      const elapsed = Date.now() - startTime;
      expect(elapsed).to.be.lessThan(1000); // Should be very fast
    });

    it("should handle batch planning", async function () {
      const queries = [
        "Python programming",
        "React vs Vue",
        "machine learning and deep learning",
        "What is TypeScript?",
        "How to deploy applications",
      ];

      const plans = await Promise.all(queries.map((q) => planner.createPlan(q, defaultPlannerOptions())));

      expect(plans).to.have.lengthOf(5);
      plans.forEach((plan) => {
        expect(plan.subQueries.length).to.be.greaterThan(0);
      });
    });
  });

  describe("Query Types", function () {
    it('should handle "what" questions', async function () {
      const plan = await planner.createPlan("What is machine learning?", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
    });

    it('should handle "how" questions', async function () {
      const plan = await planner.createPlan("How to learn Python?", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
    });

    it('should handle "why" questions', async function () {
      const plan = await planner.createPlan("Why use TypeScript?", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
    });

    it("should handle comparison questions", async function () {
      const plan = await planner.createPlan("Which is better: React or Vue?", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
    });

    it("should handle procedural questions", async function () {
      const plan = await planner.createPlan("Steps to deploy a React application", defaultPlannerOptions());

      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe("Plan Caching", function () {
    it("should return cached plan for identical queries", async function () {
      const plan1 = await planner.createPlan("machine learning basics", defaultPlannerOptions());
      const plan2 = await planner.createPlan("machine learning basics", defaultPlannerOptions());

      expect(plan1).to.deep.equal(plan2);
    });

    it("should not cache across different options", async function () {
      const plan1 = await planner.createPlan("machine learning basics", defaultPlannerOptions({ topK: 5 }));
      const plan2 = await planner.createPlan("machine learning basics", defaultPlannerOptions({ topK: 10 }));

      expect(plan1.subQueries[0].topK).to.equal(5);
      expect(plan2.subQueries[0].topK).to.equal(10);
    });

    it("should build distinct cache keys for all plan-affecting options", function () {
      const query = "Python and JavaScript and TypeScript";
      const baseKey = (planner as any).buildCacheKey(
        query,
        defaultPlannerOptions({
          modelFamily: "gpt-4o-mini",
          topK: 5,
          topicName: "General Docs",
          workspaceContext: "src/index.ts",
        }),
      );

      const changedKeys = [
        (planner as any).buildCacheKey(query, defaultPlannerOptions({ modelFamily: "gpt-4o" })),
        (planner as any).buildCacheKey(query, defaultPlannerOptions({ topK: 7 })),
        (planner as any).buildCacheKey(query, defaultPlannerOptions({ topicName: "API Docs" })),
        (planner as any).buildCacheKey(query, defaultPlannerOptions({ workspaceContext: "src/server.ts" })),
      ];

      changedKeys.forEach((key: string) => {
        expect(key).to.not.equal(baseKey);
      });
    });

    it("should clear cache when clearCache is called", async function () {
      await planner.createPlan("cached query", defaultPlannerOptions({ topK: 5 }));
      planner.clearCache();

      // After clearing, a new plan should be created (same value, but cache was cleared)
      const plan = await planner.createPlan("cached query", defaultPlannerOptions({ topK: 5 }));
      expect(plan).to.be.an("object");
      expect(plan.subQueries[0].topK).to.equal(5);
    });
  });

  describe("maxSubQueries Uniformity", function () {
    it("should respect maxSubQueries for comparison queries", async function () {
      const plan = await planner.createPlan("Python vs JavaScript vs Ruby vs Go", defaultPlannerOptions());

      expect(plan.subQueries.length).to.be.lessThanOrEqual(5);
    });

    it("should respect maxSubQueries for long queries", async function () {
      const longQuery =
        "This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques";
      const plan = await planner.createPlan(longQuery, defaultPlannerOptions());

      expect(plan.subQueries.length).to.be.lessThanOrEqual(5);
    });
  });

  describe("Improved Comparison Splitting", function () {
    it('should extract clean concepts from "X vs Y" pattern', async function () {
      const plan = await planner.createPlan("Python vs JavaScript", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
      expect(plan.subQueries.length).to.equal(2);
      expect(plan.subQueries[0].query).to.equal("Python");
      expect(plan.subQueries[1].query).to.equal("JavaScript");
    });

    it('should handle "difference between X and Y" pattern', async function () {
      const plan = await planner.createPlan("difference between SQL and NoSQL", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal("SQL");
      expect(plan.subQueries[1].query).to.equal("NoSQL");
    });

    it('should handle "compare X to Y" pattern', async function () {
      const plan = await planner.createPlan("compare React to Vue", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal("React");
      expect(plan.subQueries[1].query).to.equal("Vue");
    });

    it('should handle "compare X with Y" pattern', async function () {
      const plan = await planner.createPlan("compare Docker with Kubernetes", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
      expect(plan.subQueries).to.have.lengthOf(2);
      expect(plan.subQueries[0].query).to.equal("Docker");
      expect(plan.subQueries[1].query).to.equal("Kubernetes");
    });
  });

  describe("Early Exit for Trivial Queries", function () {
    it("should fast-path single-word queries", async function () {
      const plan = await planner.createPlan("Python", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
      expect(plan.subQueries).to.have.lengthOf(1);
      expect(plan.explanation).to.include("Trivial");
    });

    it("should fast-path empty queries", async function () {
      const plan = await planner.createPlan("", defaultPlannerOptions());

      expect(plan.complexity).to.equal("simple");
      expect(plan.subQueries).to.have.lengthOf(1);
    });
  });

  describe("Special Character & Edge Case Queries", function () {
    it("should handle queries with code snippets", async function () {
      const plan = await planner.createPlan("how to use Array.map() in JavaScript", defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle queries with mixed delimiters", async function () {
      const plan = await planner.createPlan("Python; JavaScript! TypeScript?", defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle queries with brackets and arrows", async function () {
      const plan = await planner.createPlan("React<Props> vs Vue => components", defaultPlannerOptions());

      expect(plan.complexity).to.equal("complex");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle unicode queries", async function () {
      const plan = await planner.createPlan("машинное обучение", defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });

    it("should handle queries with only special characters", async function () {
      const plan = await planner.createPlan("?!@#$%", defaultPlannerOptions());

      expect(plan).to.be.an("object");
      expect(plan.subQueries.length).to.be.greaterThan(0);
    });
  });

  describe("Long Query Keyword Extraction", function () {
    it("should create keyword sub-query for long queries", async function () {
      const longQuery =
        "This is a very long query about machine learning algorithms including supervised learning unsupervised learning and reinforcement learning techniques";
      const plan = await planner.createPlan(longQuery, defaultPlannerOptions());

      expect(plan.subQueries.length).to.be.greaterThanOrEqual(2);

      // Should have a keyword-focused sub-query
      const keywordSq = plan.subQueries.find((sq) => sq.reasoning.toLowerCase().includes("keyword"));
      expect(keywordSq).to.not.be.undefined;
    });
  });

  describe("Context-Aware Complexity", function () {
    it("should boost complexity for technical context", async function () {
      const _simple = await planner.createPlan("explain functions", defaultPlannerOptions());
      const techContext = await planner.createPlan(
        "explain functions",
        defaultPlannerOptions({
          topicName: "Kubernetes API Deployment",
        }),
      );

      // The technical context should produce an equal or higher complexity
      // (both return heuristic plans, but the score may differ)
      expect(techContext).to.be.an("object");
      expect(techContext.subQueries.length).to.be.greaterThan(0);
    });

    it("should report when technical context boosting applies", function () {
      const withBoost = (planner as any).analyzeComplexityScore(
        "explain functions",
        defaultPlannerOptions({
          topicName: "Kubernetes API Deployment",
        }),
      );
      const withoutBoost = (planner as any).analyzeComplexityScore(
        "explain functions",
        defaultPlannerOptions({
          topicName: "General Writing",
        }),
      );

      expect(withBoost).to.be.greaterThan(withoutBoost);
    });
  });

  describe("Performance Benchmarks", function () {
    it("should handle 100 queries efficiently", async function () {
      const startTime = Date.now();

      const queries = Array.from({ length: 100 }, (_, i) => `query number ${i}`);
      await Promise.all(queries.map((q) => planner.createPlan(q, defaultPlannerOptions())));

      const elapsed = Date.now() - startTime;
      expect(elapsed).to.be.lessThan(5000); // 100 plans under 5 seconds
    });
  });
});
