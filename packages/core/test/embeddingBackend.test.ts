/**
 * Unit tests for HuggingFaceBackend embedding backend
 *
 * Tests cover:
 * - HuggingFaceBackend cache-dir registration with transformers env
 */

import { expect } from "chai";
import { HuggingFaceBackend, INotifier } from "../src/index";

const mockNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

describe("EmbeddingBackend Abstraction", function () {
  this.timeout(10000);

  describe("HuggingFaceBackend cache-dir registration", () => {
    it("should register transformers env.cacheDir with the model registry", () => {
      const modelRegistry = {
        getDefaultModel: () => "Xenova/all-MiniLM-L6-v2",
        getResolvedLocalModelPath: () => null,
        getBundledModelsRoot: () => "/tmp/models",
        setTransformersCacheDir: function (this: any, dir: string | null) {
          this.cacheDir = dir;
        },
      } as any;

      const backend = new HuggingFaceBackend(modelRegistry, mockNotifier);

      (backend as any).configureTransformersEnvironment({
        env: {
          cacheDir: "/tmp/transformers-cache",
        },
      });

      expect(modelRegistry.cacheDir).to.equal("/tmp/transformers-cache");
    });

    it("should clear the registered cache dir when transformers env.cacheDir is unavailable", () => {
      const modelRegistry = {
        getDefaultModel: () => "Xenova/all-MiniLM-L6-v2",
        getResolvedLocalModelPath: () => null,
        getBundledModelsRoot: () => "/tmp/models",
        setTransformersCacheDir: function (this: any, dir: string | null) {
          this.cacheDir = dir;
        },
        cacheDir: "/tmp/old-cache",
      } as any;

      const backend = new HuggingFaceBackend(modelRegistry, mockNotifier);

      (backend as any).configureTransformersEnvironment({
        env: {},
      });

      expect(modelRegistry.cacheDir).to.equal(null);
    });
  });

  describe("HuggingFaceBackend model-scoped init failure caching", () => {
    interface StubbedBackend {
      backend: HuggingFaceBackend;
      failingModels: Set<string>;
      initCalls: string[];
    }

    const makeRegistry = (defaultModel: string) =>
      ({
        getDefaultModel: () => defaultModel,
        getResolvedLocalModelPath: () => null,
        getBundledModelsRoot: () => "/tmp/models",
        setTransformersCacheDir: () => {},
        resolveModelIdentifier: (model: string) => model,
      }) as any;

    // Replaces the real (network + ONNX) pipeline initialization with a fast
    // stub so the cached-error logic can be exercised without downloading
    // models. Models added to `failingModels` throw on init; everything else
    // "loads" successfully.
    const createStubbedBackend = (defaultModel: string, initialModel?: string): StubbedBackend => {
      const failingModels = new Set<string>();
      const initCalls: string[] = [];
      const backend = new HuggingFaceBackend(makeRegistry(defaultModel), mockNotifier, initialModel);

      (backend as any)._initializePipeline = async (modelName: string): Promise<void> => {
        initCalls.push(modelName);
        if (failingModels.has(modelName)) {
          (backend as any).pipeline = null;
          throw new Error(`Failed to initialize embedding model "${modelName}"`);
        }
        (backend as any).pipeline = () => ({ data: new Float32Array(3) });
        (backend as any).currentModel = modelName;
        (backend as any).lastSuccessfulModel = modelName;
      };

      return { backend, failingModels, initCalls };
    };

    const expectRejection = async (promise: Promise<unknown>): Promise<void> => {
      try {
        await promise;
      } catch {
        return;
      }
      expect.fail("Expected initialization to reject");
    };

    it("does not let a failed model block initialization of a different model", async () => {
      const { backend, failingModels } = createStubbedBackend("Xenova/all-MiniLM-L6-v2", "model-a");
      failingModels.add("model-a");

      await expectRejection(backend.initialize("model-a"));

      // The cached failure of model-a must not leak into model-b.
      await backend.initialize("model-b");
      expect(backend.getCurrentModel()).to.equal("model-b");
    });

    it("falls back to the default model when the configured model fails", async () => {
      // Config-driven init (no explicit model): the current/configured model
      // fails, so initialize() should fall back to the default model instead of
      // rethrowing model-a's cached error before the fallback is tried.
      const { backend, failingModels } = createStubbedBackend("model-default", "model-a");
      failingModels.add("model-a");

      await backend.initialize();

      expect(backend.getCurrentModel()).to.equal("model-default");
    });

    it("clears the cached failure on dispose so the backend can be reused", async () => {
      const { backend, failingModels } = createStubbedBackend("Xenova/all-MiniLM-L6-v2", "model-a");
      failingModels.add("model-a");

      await expectRejection(backend.initialize("model-a"));

      backend.dispose();

      // model-a is now healthy; a disposed+reused backend must retry it rather
      // than rethrow the stale cached error.
      failingModels.delete("model-a");
      await backend.initialize("model-a");
      expect(backend.getCurrentModel()).to.equal("model-a");
    });

    it("caches a repeated failure of the same model to avoid re-initializing", async () => {
      const { backend, failingModels, initCalls } = createStubbedBackend("Xenova/all-MiniLM-L6-v2", "model-a");
      failingModels.add("model-a");

      await expectRejection(backend.initialize("model-a"));
      await expectRejection(backend.initialize("model-a"));

      // The second attempt at the same broken model short-circuits on the
      // cached error instead of re-running initialization.
      expect(initCalls).to.deep.equal(["model-a"]);
    });
  });
});
