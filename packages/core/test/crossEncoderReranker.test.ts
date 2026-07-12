/**
 * Unit Tests for CrossEncoderReranker
 * Tests cross-encoder reranking, logit shape handling, and sigmoid utility
 */

import { expect } from "chai";
import sinon from "sinon";
import { CrossEncoderReranker } from "../src/index";
import type { ScoredDocument } from "../src/index";
import { sigmoid } from "../src/rerankers/reranker";
import { Document as LangChainDocument } from "@langchain/core/documents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(content: string, score: number): ScoredDocument {
  return {
    document: new LangChainDocument({ pageContent: content }),
    score,
  };
}

function createMockTokenizer() {
  return (queries: string[], _opts: any) => ({
    input_ids: queries.map((_, i) => [i]),
  });
}

/**
 * Creates a mock model that returns the given logit values.
 * @param logitValues Flat array of logit values
 * @param numClasses Number of classes per sample (1 for single-logit, 2 for binary)
 */
function createMockModel(logitValues: number[], numClasses: number = 1) {
  return async (_inputs: any) => ({
    logits: {
      dims: [logitValues.length / numClasses, numClasses],
      data: new Float32Array(logitValues),
    },
  });
}

/**
 * Creates a mock model that throws on invocation.
 */
function createFailingModel(message: string) {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CrossEncoderReranker", function () {
  this.timeout(10000);

  let reranker: CrossEncoderReranker;

  beforeEach(() => {
    reranker = new CrossEncoderReranker();
  });

  afterEach(() => {
    reranker.dispose();
  });

  // -----------------------------------------------------------------------
  // sigmoid
  // -----------------------------------------------------------------------

  describe("sigmoid", () => {
    it("should return 0.5 for input 0", () => {
      expect(sigmoid(0)).to.equal(0.5);
    });

    it("should approach 1 for large positive input", () => {
      expect(sigmoid(10)).to.be.greaterThan(0.9999);
      expect(sigmoid(10)).to.be.lessThanOrEqual(1);
    });

    it("should approach 0 for large negative input", () => {
      expect(sigmoid(-10)).to.be.lessThan(0.0001);
      expect(sigmoid(-10)).to.be.greaterThanOrEqual(0);
    });

    it("should return values in (0,1) range", () => {
      for (const x of [-5, -1, 0, 1, 5]) {
        const result = sigmoid(x);
        expect(result).to.be.greaterThan(0);
        expect(result).to.be.lessThan(1);
      }
    });

    it("should be monotonically increasing", () => {
      const values = [-5, -2, -1, 0, 1, 2, 5];
      for (let i = 1; i < values.length; i++) {
        expect(sigmoid(values[i])).to.be.greaterThan(sigmoid(values[i - 1]));
      }
    });
  });

  // -----------------------------------------------------------------------
  // constructor
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("should use default model name", () => {
      const r = new CrossEncoderReranker();
      expect((r as any).modelName).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
      r.dispose();
    });

    it("should accept custom model name", () => {
      const r = new CrossEncoderReranker("custom/model");
      expect((r as any).modelName).to.equal("custom/model");
      r.dispose();
    });

    it("should use default maxCandidates of 20", () => {
      expect((reranker as any).maxCandidates).to.equal(20);
    });

    it("should accept custom maxCandidates", () => {
      const r = new CrossEncoderReranker(undefined, { maxCandidates: 10 });
      expect((r as any).maxCandidates).to.equal(10);
      r.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe("isAvailable", () => {
    it("should return false when model and tokenizer are null", () => {
      expect(reranker.isAvailable()).to.be.false;
    });

    it("should return false when only model is set", () => {
      (reranker as any).model = {};
      expect(reranker.isAvailable()).to.be.false;
    });

    it("should return false when only tokenizer is set", () => {
      (reranker as any).tokenizer = {};
      expect(reranker.isAvailable()).to.be.false;
    });

    it("should return true when both model and tokenizer are set", () => {
      (reranker as any).model = {};
      (reranker as any).tokenizer = {};
      expect(reranker.isAvailable()).to.be.true;
    });
  });

  // -----------------------------------------------------------------------
  // rerank
  // -----------------------------------------------------------------------

  describe("rerank", () => {
    beforeEach(() => {
      (reranker as any).tokenizer = createMockTokenizer();
    });

    it("should return empty array for empty candidates", async () => {
      const result = await reranker.rerank("query", [], 5);
      expect(result).to.deep.equal([]);
    });

    it("should handle single candidate", async () => {
      (reranker as any).model = createMockModel([2.0]);
      const candidates = [makeDoc("doc1", 0.8)];

      const result = await reranker.rerank("query", candidates, 5);

      expect(result).to.have.length(1);
      expect(result[0].document.pageContent).to.equal("doc1");
      expect(result[0].score).to.equal(sigmoid(2.0));
    });

    it("should sort by reranker score descending", async () => {
      // logit values: doc1=-1.0, doc2=3.0, doc3=1.0
      (reranker as any).model = createMockModel([-1.0, 3.0, 1.0]);
      const candidates = [makeDoc("doc1", 0.9), makeDoc("doc2", 0.5), makeDoc("doc3", 0.7)];

      const result = await reranker.rerank("query", candidates, 3);

      expect(result[0].document.pageContent).to.equal("doc2");
      expect(result[1].document.pageContent).to.equal("doc3");
      expect(result[2].document.pageContent).to.equal("doc1");
    });

    it("should preserve originalScore from first-stage retrieval", async () => {
      (reranker as any).model = createMockModel([1.0, 2.0]);
      const candidates = [makeDoc("a", 0.95), makeDoc("b", 0.8)];

      const result = await reranker.rerank("query", candidates, 2);

      for (const r of result) {
        expect(r.originalScore).to.be.a("number");
      }
      // doc "b" gets higher reranker score (logit=2.0), its originalScore should be 0.80
      const docB = result.find((r) => r.document.pageContent === "b")!;
      expect(docB.originalScore).to.equal(0.8);
    });

    it("should cap candidates to maxCandidates", async () => {
      const r = new CrossEncoderReranker(undefined, { maxCandidates: 2 });
      (r as any).tokenizer = createMockTokenizer();
      // Only 2 logits even though we pass 3 candidates
      (r as any).model = createMockModel([1.0, 2.0]);

      const candidates = [makeDoc("doc1", 0.9), makeDoc("doc2", 0.8), makeDoc("doc3", 0.7)];

      const result = await r.rerank("query", candidates, 5);

      // Only 2 candidates should be scored (maxCandidates=2)
      expect(result).to.have.length(2);
      r.dispose();
    });

    it("should respect custom maxCandidates via constructor", async () => {
      const r = new CrossEncoderReranker(undefined, { maxCandidates: 1 });
      (r as any).tokenizer = createMockTokenizer();
      (r as any).model = createMockModel([5.0]);

      const candidates = [makeDoc("a", 0.9), makeDoc("b", 0.8)];
      const result = await r.rerank("query", candidates, 5);

      expect(result).to.have.length(1);
      expect(result[0].document.pageContent).to.equal("a");
      r.dispose();
    });

    it("should truncate results to topK", async () => {
      (reranker as any).model = createMockModel([1.0, 2.0, 3.0]);
      const candidates = [makeDoc("doc1", 0.9), makeDoc("doc2", 0.8), makeDoc("doc3", 0.7)];

      const result = await reranker.rerank("query", candidates, 2);

      expect(result).to.have.length(2);
      // Highest reranker scores should be kept
      expect(result[0].score).to.equal(sigmoid(3.0));
      expect(result[1].score).to.equal(sigmoid(2.0));
    });

    it("should return all candidates when topK exceeds candidate count", async () => {
      (reranker as any).model = createMockModel([1.0, 2.0]);
      const candidates = [makeDoc("a", 0.9), makeDoc("b", 0.8)];

      const result = await reranker.rerank("query", candidates, 100);

      expect(result).to.have.length(2);
    });

    it("should truncate long documents before tokenization", async () => {
      let capturedDocs: string[] = [];
      (reranker as any).tokenizer = (queries: string[], opts: any) => {
        capturedDocs = opts.text_pair;
        return { input_ids: queries.map((_, i) => [i]) };
      };
      (reranker as any).model = createMockModel([1.0]);

      const longContent = "x".repeat(2000);
      const candidates = [makeDoc(longContent, 0.9)];

      await reranker.rerank("query", candidates, 1);

      expect(capturedDocs[0]).to.have.length(1500);
    });

    it("should not truncate documents shorter than 1500 chars", async () => {
      let capturedDocs: string[] = [];
      (reranker as any).tokenizer = (queries: string[], opts: any) => {
        capturedDocs = opts.text_pair;
        return { input_ids: queries.map((_, i) => [i]) };
      };
      (reranker as any).model = createMockModel([1.0]);

      const shortContent = "y".repeat(500);
      const candidates = [makeDoc(shortContent, 0.9)];

      await reranker.rerank("query", candidates, 1);

      expect(capturedDocs[0]).to.have.length(500);
    });

    it("should gracefully degrade on scoring error, returning original order", async () => {
      (reranker as any).model = createFailingModel("ONNX runtime error");
      const candidates = [makeDoc("doc1", 0.9), makeDoc("doc2", 0.8), makeDoc("doc3", 0.7)];

      const result = await reranker.rerank("query", candidates, 2);

      // Should return first topK from original order
      expect(result).to.have.length(2);
      expect(result[0].document.pageContent).to.equal("doc1");
      expect(result[1].document.pageContent).to.equal("doc2");
      // Scores should be original, not reranker scores
      expect(result[0].score).to.equal(0.9);
      expect(result[1].score).to.equal(0.8);
    });

    it("propagates cancellation instead of degrading to stale first-stage results", async () => {
      const controller = new AbortController();
      (reranker as any).model = async () => {
        controller.abort(new Error("reranking cancelled"));
        return { logits: { dims: [1, 1], data: new Float32Array([1]) } };
      };
      try {
        await reranker.rerank("query", [makeDoc("candidate", 0.9)], 1, controller.signal);
        expect.fail("expected cancellation");
      } catch (error) {
        expect((error as Error).message).to.equal("reranking cancelled");
      }
    });
  });

  // -----------------------------------------------------------------------
  // logit shape handling
  // -----------------------------------------------------------------------

  describe("logit shape handling", () => {
    beforeEach(() => {
      (reranker as any).tokenizer = createMockTokenizer();
    });

    it("should handle [N,1] single-logit shape", async () => {
      (reranker as any).model = createMockModel([2.0, -1.0], 1);
      const candidates = [makeDoc("a", 0.9), makeDoc("b", 0.8)];

      const result = await reranker.rerank("query", candidates, 2);

      // doc "a" logit=2.0, doc "b" logit=-1.0
      expect(result[0].document.pageContent).to.equal("a");
      expect(result[0].score).to.equal(sigmoid(2.0));
      expect(result[1].document.pageContent).to.equal("b");
      expect(result[1].score).to.equal(sigmoid(-1.0));
    });

    it("should handle [N,2] binary classification shape using positive class", async () => {
      // For [N,2] shape: [neg0, pos0, neg1, pos1]
      // doc0: negative=-5, positive=3 → uses 3
      // doc1: negative=1, positive=-2 → uses -2
      (reranker as any).model = createMockModel([-5, 3, 1, -2], 2);
      const candidates = [makeDoc("a", 0.9), makeDoc("b", 0.8)];

      const result = await reranker.rerank("query", candidates, 2);

      // doc "a" should use positive class logit = 3
      // doc "b" should use positive class logit = -2
      expect(result[0].document.pageContent).to.equal("a");
      expect(result[0].score).to.equal(sigmoid(3));
      expect(result[1].document.pageContent).to.equal("b");
      expect(result[1].score).to.equal(sigmoid(-2));
    });

    it("should handle flat array fallback", async () => {
      // Flat array: dims has only one dimension
      (reranker as any).model = async () => ({
        logits: {
          dims: [3],
          data: new Float32Array([0.5, 1.5, -0.5]),
        },
      });
      const candidates = [makeDoc("a", 0.9), makeDoc("b", 0.8), makeDoc("c", 0.7)];

      const result = await reranker.rerank("query", candidates, 3);

      // Flat fallback uses logits.data[i] directly
      // doc "b" logit=1.5 (highest), doc "a" logit=0.5, doc "c" logit=-0.5
      expect(result[0].document.pageContent).to.equal("b");
      expect(result[0].score).to.equal(sigmoid(1.5));
      expect(result[1].document.pageContent).to.equal("a");
      expect(result[1].score).to.equal(sigmoid(0.5));
      expect(result[2].document.pageContent).to.equal("c");
      expect(result[2].score).to.equal(sigmoid(-0.5));
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe("dispose", () => {
    it("should null out model, tokenizer, and transformers", () => {
      (reranker as any).model = {};
      (reranker as any).tokenizer = {};
      (reranker as any).transformers = {};

      reranker.dispose();

      expect((reranker as any).model).to.be.null;
      expect((reranker as any).tokenizer).to.be.null;
      expect((reranker as any).transformers).to.be.null;
    });

    it("should report not available after dispose", () => {
      (reranker as any).model = {};
      (reranker as any).tokenizer = {};
      expect(reranker.isAvailable()).to.be.true;

      reranker.dispose();

      expect(reranker.isAvailable()).to.be.false;
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentModel
  // -----------------------------------------------------------------------

  describe("getCurrentModel", () => {
    it("should return the default model", () => {
      const r = new CrossEncoderReranker();
      expect(r.getCurrentModel()).to.include("ms-marco-MiniLM");
      r.dispose();
    });

    it("should return custom model when provided", () => {
      const r = new CrossEncoderReranker("custom-org/custom-model");
      expect(r.getCurrentModel()).to.equal("custom-org/custom-model");
      r.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // listAvailableModels
  // -----------------------------------------------------------------------

  describe("listAvailableModels", () => {
    it("should return available models from registry", async () => {
      const r = new CrossEncoderReranker();
      const models = await r.listAvailableModels();
      expect(models).to.be.an("array").with.length.greaterThan(0);
      expect(models[0]).to.have.property("name");
      expect(models[0]).to.have.property("source");
      r.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // switchModel
  // -----------------------------------------------------------------------

  describe("switchModel", () => {
    it("should retain the working model when replacement initialization fails", async () => {
      const r = new CrossEncoderReranker("Xenova/ms-marco-MiniLM-L-6-v2");
      const workingModel = { id: "working-model" };
      const workingTokenizer = { id: "working-tokenizer" };
      (r as any).model = workingModel;
      (r as any).tokenizer = workingTokenizer;
      const initialize = sinon.stub(CrossEncoderReranker.prototype, "initialize").rejects(new Error("probe failed"));
      let failed = false;
      try {
        await r.switchModel("Xenova/ms-marco-MiniLM-L-12-v2");
      } catch {
        failed = true;
      } finally {
        initialize.restore();
      }
      expect(failed).to.equal(true);
      expect(r.getCurrentModel()).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
      expect((r as any).model).to.equal(workingModel);
      expect((r as any).tokenizer).to.equal(workingTokenizer);
      await r.dispose();
    });

    it("should be no-op when switching to same model that is loaded", async () => {
      const r = new CrossEncoderReranker("Xenova/ms-marco-MiniLM-L-6-v2");
      // Not initialized, so switchModel should try to load
      try {
        await r.switchModel("Xenova/ms-marco-MiniLM-L-6-v2");
      } catch {
        // Expected — model loading fails
      }
      expect(r.getCurrentModel()).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
      r.dispose();
    });

    it("should reject path traversal with ..", async () => {
      try {
        await reranker.switchModel("../malicious/model");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Invalid model name");
      }
    });

    it("should reject absolute paths", async () => {
      try {
        await reranker.switchModel("/etc/passwd/model");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Invalid model name");
      }
    });

    it("should reject Windows absolute paths", async () => {
      // On non-Windows, path.isAbsolute doesn't catch C:\, so test with a
      // drive-letter path that also contains '..' for cross-platform coverage
      try {
        await reranker.switchModel("C:\\..\\model/name");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Invalid model name");
      }
    });

    it("should reject embedded backslash traversal", async () => {
      try {
        await reranker.switchModel("org\\..\\..\\etc/passwd");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Invalid model name");
      }
    });

    it("should reject model without namespace", async () => {
      try {
        await reranker.switchModel("model-without-namespace");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Model name must include namespace");
      }
    });
  });
});
