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
});
