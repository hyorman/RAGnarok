/**
 * Tests for shared keyword extraction utility
 */

import { expect } from "chai";
import { extractKeywords, BASE_STOP_WORDS, QUERY_INTENT_WORDS } from "../src/utils/keywords";

describe("Keywords Utility", function () {
  describe("BASE_STOP_WORDS", function () {
    it("should contain common English stop words", function () {
      const expected = ["the", "a", "an", "is", "are", "in", "of", "to", "and", "or", "but", "not"];
      for (const word of expected) {
        expect(BASE_STOP_WORDS.has(word), `missing: "${word}"`).to.be.true;
      }
    });

    it("should not contain content words", function () {
      const contentWords = ["python", "machine", "learning", "data", "code", "function"];
      for (const word of contentWords) {
        expect(BASE_STOP_WORDS.has(word), `should not contain: "${word}"`).to.be.false;
      }
    });
  });

  describe("QUERY_INTENT_WORDS", function () {
    it("should contain query-intent verbs and nouns", function () {
      expect(QUERY_INTENT_WORDS).to.include("explain");
      expect(QUERY_INTENT_WORDS).to.include("describe");
      expect(QUERY_INTENT_WORDS).to.include("definition");
      expect(QUERY_INTENT_WORDS).to.include("example");
    });

    it("should not overlap with BASE_STOP_WORDS", function () {
      for (const word of QUERY_INTENT_WORDS) {
        expect(BASE_STOP_WORDS.has(word), `"${word}" in both BASE_STOP_WORDS and QUERY_INTENT_WORDS`).to.be.false;
      }
    });
  });

  describe("extractKeywords", function () {
    it("should extract keywords with default options", function () {
      const result = extractKeywords("Python is a great language for machine learning");
      expect(result).to.include("python");
      expect(result).to.include("great");
      expect(result).to.include("language");
      expect(result).to.include("machine");
      expect(result).to.include("learning");
      expect(result).not.to.include("is");
      expect(result).not.to.include("a");
      expect(result).not.to.include("for");
    });

    it("should filter short words (< 3 chars by default)", function () {
      const result = extractKeywords("I go to my AI lab");
      expect(result).not.to.include("go");
      expect(result).not.to.include("to");
      expect(result).not.to.include("my");
      expect(result).not.to.include("ai");
      expect(result).to.include("lab");
    });

    it("should deduplicate by default", function () {
      const result = extractKeywords("Python Python Python code");
      expect(result.filter((w) => w === "python")).to.have.length(1);
    });

    it("should not deduplicate when deduplicate=false", function () {
      const result = extractKeywords("Python Python code", { deduplicate: false });
      expect(result.filter((w) => w === "python")).to.have.length(2);
    });

    it("should support custom sanitize regex", function () {
      const result = extractKeywords("machine-learning is great!", {
        sanitizeRegex: /[^a-zA-Z0-9-]/g,
        replacement: "",
      });
      expect(result).to.include("machine-learning");
    });

    it("should support custom min length", function () {
      const result = extractKeywords("AI and ML are hot", { minLength: 2 });
      // "ai" and "ml" are length 2, min >= 2
      expect(result).to.include("ai");
      expect(result).to.include("ml");
      expect(result).to.include("hot");
    });

    it("should support extra stop words", function () {
      const result = extractKeywords("explain the Python definition", {
        extraStopWords: QUERY_INTENT_WORDS,
      });
      expect(result).to.include("python");
      expect(result).not.to.include("explain");
      expect(result).not.to.include("definition");
    });

    it("should return empty array for all-stop-word input", function () {
      const result = extractKeywords("is the a an");
      expect(result).to.deep.equal([]);
    });

    it("should handle empty input", function () {
      const result = extractKeywords("");
      expect(result).to.deep.equal([]);
    });

    describe("Behavioral equivalence with former callers", function () {
      it("should match KeywordRetriever extraction pattern", function () {
        // KeywordRetriever used: default regex, minLength 3, deduplicate true
        const query = "What are the main features of Python's machine learning libraries?";
        const result = extractKeywords(query);
        expect(result).to.include("features");
        expect(result).to.include("python");
        expect(result).to.include("machine");
        expect(result).to.include("learning");
        expect(result).to.include("libraries");
        expect(result).not.to.include("what");
        expect(result).not.to.include("are");
        expect(result).not.to.include("the");
      });

      it("should match QueryPlannerAgent extraction pattern", function () {
        // QueryPlannerAgent used: punctuation regex, minLength 2, deduplicate false, + intent words
        const query = "What does 'machine learning' mean in Python?";
        const result = extractKeywords(query, {
          extraStopWords: QUERY_INTENT_WORDS,
          sanitizeRegex: /[?!.,;:'"()[\]{}]/g,
          minLength: 2,
          deduplicate: false,
        });
        expect(result).to.include("machine");
        expect(result).to.include("learning");
        expect(result).to.include("python");
        expect(result).not.to.include("mean");
        expect(result).not.to.include("what");
        expect(result).not.to.include("does");
      });

      it("should match RAGAgent broadenQuery pattern", function () {
        // RAGAgent used: alphanumeric+hyphen regex, empty replacement, minLength 3, deduplicate false
        const query = "What is the best-practice for Python?";
        const result = extractKeywords(query, {
          sanitizeRegex: /[^a-zA-Z0-9-]/g,
          replacement: "",
          deduplicate: false,
        });
        expect(result).to.include("best-practice");
        expect(result).to.include("python");
        expect(result).not.to.include("what");
        expect(result).not.to.include("the");
        expect(result).not.to.include("for");
      });
    });
  });
});
