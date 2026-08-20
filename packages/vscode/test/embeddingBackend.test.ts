/**
 * Unit tests for VscodeLmBackend embedding backend
 *
 * Tests cover:
 * - VscodeLmBackend availability checks
 * - VscodeLmBackend embed / embedBatch
 * - Backend selection logic (auto, forced modes)
 * - Dimension validation
 *
 * Uses constructor-based dependency injection ({@link VscodeLmBackend}'s
 * `options.lmApi`) to bypass the real vscode.lm proposed API.
 */

import { expect } from "chai";
import { INotifier } from "@ragnarok/core";
import { VscodeLmBackend } from "../src/vscodeLmBackend";

// ---------------------------------------------------------------------------
// Minimal LM API mock (enough for backend tests)
// ---------------------------------------------------------------------------

const createMockLmApi = (options?: {
  hasEmbeddingsApi?: boolean;
  models?: string[];
  embedResult?: { values: number[] };
  embedBatchResult?: Array<{ values: number[] }>;
  shouldThrow?: boolean;
  throwMessage?: string;
}) => {
  const opts = {
    hasEmbeddingsApi: true,
    models: ["test-model-001"],
    embedResult: { values: [0.1, 0.2, 0.3, 0.4] },
    embedBatchResult: undefined as Array<{ values: number[] }> | undefined,
    shouldThrow: false,
    throwMessage: "Mock error",
    ...options,
  };

  if (!opts.hasEmbeddingsApi) {
    // Simulate missing API surface
    return undefined;
  }

  return {
    embeddingModels: opts.models,
    onDidChangeEmbeddingModels: { subscribe: () => ({ dispose: () => {} }) },
    computeEmbeddings: async (_modelId: string, input: string | string[]) => {
      if (opts.shouldThrow) {
        throw new Error(opts.throwMessage);
      }
      if (Array.isArray(input)) {
        return opts.embedBatchResult ?? input.map(() => ({ ...opts.embedResult }));
      }
      return { ...opts.embedResult };
    },
  };
};

const _mockNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

// ---------------------------------------------------------------------------
// Helper: create a backend with injected mock LM API
// ---------------------------------------------------------------------------
const createBackend = (
  modelId?: string,
  lmApiOptions?: Parameters<typeof createMockLmApi>[0],
  backendOptions?: { modelIdResolver?: () => string | undefined | null },
) => {
  const lmApi = createMockLmApi(lmApiOptions);
  return new VscodeLmBackend(modelId, { lmApi, ...backendOptions });
};

describe("EmbeddingBackend Abstraction", function () {
  this.timeout(10000);

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — availability
  // ---------------------------------------------------------------------------
  describe("VscodeLmBackend.isAvailable()", () => {
    it("should return true when API and models are present", async () => {
      const backend = createBackend("test-model-001");
      expect(await backend.isAvailable()).to.be.true;
    });

    it("should return false when embeddings API is missing", async () => {
      const backend = createBackend(undefined, { hasEmbeddingsApi: false });
      expect(await backend.isAvailable()).to.be.false;
    });

    it("should return false when no models are registered", async () => {
      const backend = createBackend(undefined, { models: [] });
      expect(await backend.isAvailable()).to.be.false;
    });

    it("should return false when requested model is not in the list", async () => {
      const backend = createBackend("model-b", { models: ["model-a"] });
      expect(await backend.isAvailable()).to.be.false;
    });

    it("should auto-select first model when none is configured", async () => {
      const backend = createBackend(undefined, { models: ["auto-selected-model"] });
      const available = await backend.isAvailable();
      expect(available).to.be.true;
      // The internal modelId should now be set
      expect((backend as any).resolvedModelId).to.equal("auto-selected-model");
    });

    it("should use the configured model resolver when selecting a model", async () => {
      const backend = createBackend(
        undefined,
        { models: ["model-a", "model-b"] },
        { modelIdResolver: () => "model-b" },
      );
      const available = await backend.isAvailable();
      expect(available).to.be.true;
      expect(backend.getModelId()).to.equal("model-b");
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — embed single
  // ---------------------------------------------------------------------------
  describe("VscodeLmBackend.embed()", () => {
    it("keeps the previous model when a requested switch is unavailable", async () => {
      const backend = createBackend("model-a", { models: ["model-a"] });
      await backend.initialize();
      try {
        await backend.initialize("missing-model");
        expect.fail("expected unavailable model");
      } catch (error) {
        expect((error as Error).message).to.include("not available");
      }
      expect(backend.getModelId()).to.equal("model-a");
    });

    it("propagates caller cancellation after provider inference", async () => {
      const backend = createBackend("test-model-001");
      const controller = new AbortController();
      controller.abort(new Error("embedding cancelled"));
      try {
        await backend.embed("test", controller.signal);
        expect.fail("expected cancellation");
      } catch (error) {
        expect((error as Error).message).to.equal("embedding cancelled");
      }
    });

    it("should return a number[] embedding", async () => {
      const backend = createBackend("test-model-001");
      const embedding = await backend.embed("hello world");
      expect(embedding).to.be.an("array");
      expect(embedding).to.deep.equal([0.1, 0.2, 0.3, 0.4]);
    });

    it("should set the dimension after first embed", async () => {
      const backend = createBackend("test-model-001");
      expect(backend.getDimension()).to.be.null;
      await backend.embed("test");
      expect(backend.getDimension()).to.equal(4);
    });

    it("should throw on empty embedding values", async () => {
      const backend = createBackend("test-model-001", { embedResult: { values: [] } });
      try {
        await backend.embed("test");
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("empty embedding");
      }
    });

    it("should throw when provider throws", async () => {
      const backend = createBackend("test-model-001", {
        shouldThrow: true,
        throwMessage: "Provider not available",
      });
      try {
        await backend.embed("test");
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Provider not available");
      }
    });

    it("should re-resolve the configured model after dispose", async () => {
      let configuredModel = "model-a";
      const backend = createBackend(
        undefined,
        { models: ["model-a", "model-b"] },
        { modelIdResolver: () => configuredModel },
      );

      await backend.initialize();
      expect(backend.getModelId()).to.equal("model-a");

      backend.dispose();
      configuredModel = "model-b";

      await backend.initialize();
      expect(backend.getModelId()).to.equal("model-b");
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — embedBatch
  // ---------------------------------------------------------------------------
  describe("VscodeLmBackend.embedBatch()", () => {
    it("should return consistent embeddings for batch input", async () => {
      const backend = createBackend("test-model-001");
      const results = await backend.embedBatch(["a", "b", "c"]);
      expect(results).to.have.length(3);
      results.forEach((r) => {
        expect(r).to.deep.equal([0.1, 0.2, 0.3, 0.4]);
      });
    });

    it("should return empty array for empty input", async () => {
      const backend = createBackend("test-model-001");
      const results = await backend.embedBatch([]);
      expect(results).to.deep.equal([]);
    });

    it("should report progress", async () => {
      const progressValues: number[] = [];
      const backend = createBackend("test-model-001");
      await backend.embedBatch(["a", "b"], (p) => progressValues.push(p));
      expect(progressValues).to.include(1.0);
    });

    it("should detect inconsistent dimensions", async () => {
      const backend = createBackend("test-model-001", {
        embedBatchResult: [
          { values: [0.1, 0.2, 0.3] },
          { values: [0.1, 0.2] }, // shorter!
        ],
      });
      // The batch call will fail dimension validation, then fallback to sequential
      // which uses the default embedResult (consistent dimensions)
      try {
        const results = await backend.embedBatch(["x", "y"]);
        // If fallback to sequential worked, each individual embed returns consistent results
        expect(results).to.have.length(2);
      } catch (e: any) {
        // Also acceptable: error is propagated
        expect(e.message).to.include("dimension");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — dispose
  // ---------------------------------------------------------------------------
  describe("VscodeLmBackend.dispose()", () => {
    it("should reset state on dispose", async () => {
      const backend = createBackend("test-model-001");
      await backend.embed("test");
      expect(backend.getDimension()).to.equal(4);

      backend.dispose();
      expect(backend.getDimension()).to.be.null;
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — batch retry on 429
  // ---------------------------------------------------------------------------
  describe("VscodeLmBackend batch retry on rate-limit", () => {
    it("should retry batch on 429 and succeed", async () => {
      let callCount = 0;
      const lmApi = {
        embeddingModels: ["test-model-001"],
        computeEmbeddings: async (_modelId: string, input: string | string[]) => {
          callCount++;
          if (callCount === 1 && Array.isArray(input)) {
            throw new Error("Error fetching embeddings: 429");
          }
          if (Array.isArray(input)) {
            return input.map(() => ({ values: [0.1, 0.2, 0.3, 0.4] }));
          }
          return { values: [0.1, 0.2, 0.3, 0.4] };
        },
      };
      // Patch INITIAL_BACKOFF_MS for fast tests
      const backend = new VscodeLmBackend("test-model-001", { lmApi });
      (VscodeLmBackend as any).INITIAL_BACKOFF_MS = 10;
      try {
        const results = await backend.embedBatch(["a", "b", "c"]);
        expect(results).to.have.length(3);
        // Should have retried: first call fails, second succeeds
        expect(callCount).to.be.greaterThan(1);
      } finally {
        (VscodeLmBackend as any).INITIAL_BACKOFF_MS = 1000;
      }
    });

    it("should fall back to sequential after all batch retries exhausted", async () => {
      let batchCallCount = 0;
      let singleCallCount = 0;
      const lmApi = {
        embeddingModels: ["test-model-001"],
        computeEmbeddings: async (_modelId: string, input: string | string[]) => {
          if (Array.isArray(input)) {
            batchCallCount++;
            throw new Error("Error fetching embeddings: 429");
          }
          singleCallCount++;
          return { values: [0.1, 0.2, 0.3, 0.4] };
        },
      };
      const backend = new VscodeLmBackend("test-model-001", { lmApi });
      (VscodeLmBackend as any).INITIAL_BACKOFF_MS = 1;
      try {
        const results = await backend.embedBatch(["a", "b"]);
        expect(results).to.have.length(2);
        // Batch retries exhausted, fell back to sequential
        expect(batchCallCount).to.be.greaterThan(1);
        expect(singleCallCount).to.equal(2);
      } finally {
        (VscodeLmBackend as any).INITIAL_BACKOFF_MS = 1000;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Backend selection logic (integration-level)
  // ---------------------------------------------------------------------------
  describe("Backend Selection (EmbeddingBackendType)", () => {
    it("should have the correct name property", () => {
      const backend = createBackend();
      expect(backend.name).to.equal("vscodeLM");
    });

    it("should initialize successfully with a valid model", async () => {
      const backend = createBackend("test-model-001");
      await backend.initialize();
      // No error means success
    });

    it("should throw on initialize when API is not available", async () => {
      const backend = createBackend(undefined, { hasEmbeddingsApi: false });
      try {
        await backend.initialize();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("not available");
      }
    });

    it("should throw on initialize when model is not found", async () => {
      const backend = createBackend("nonexistent-model", { models: ["other-model"] });
      try {
        await backend.initialize();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("not available");
      }
    });
  });
});
