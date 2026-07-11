import { expect } from "chai";
import { RerankerModelRegistry } from "../src/index";

describe("RerankerModelRegistry", () => {
  beforeEach(() => {
    RerankerModelRegistry.resetInstance();
  });

  describe("singleton", () => {
    it("should return same instance", () => {
      const a = RerankerModelRegistry.getInstance();
      const b = RerankerModelRegistry.getInstance();
      expect(a).to.equal(b);
    });

    it("should return new instance after reset", () => {
      const a = RerankerModelRegistry.getInstance();
      RerankerModelRegistry.resetInstance();
      const b = RerankerModelRegistry.getInstance();
      expect(a).to.not.equal(b);
    });
  });

  describe("CURATED_MODELS", () => {
    it("should have at least 3 curated models", () => {
      expect(RerankerModelRegistry.CURATED_MODELS.length).to.be.at.least(3);
    });

    it("should include the default model", () => {
      expect(RerankerModelRegistry.CURATED_MODELS).to.include("Xenova/ms-marco-MiniLM-L-6-v2");
    });

    it("should all be in namespace/model format", () => {
      for (const model of RerankerModelRegistry.CURATED_MODELS) {
        expect(model).to.include("/");
      }
    });
  });

  describe("getDefaultModel", () => {
    it("should return a non-empty string", () => {
      const registry = RerankerModelRegistry.getInstance();
      const model = registry.getDefaultModel();
      expect(model).to.be.a("string").with.length.greaterThan(0);
    });

    it("should return a curated model when no bundled models exist", () => {
      const registry = RerankerModelRegistry.getInstance();
      const model = registry.getDefaultModel();
      expect(RerankerModelRegistry.CURATED_MODELS).to.include(model);
    });
  });

  describe("resolveModelIdentifier", () => {
    it("should block path traversal attempts", () => {
      const registry = RerankerModelRegistry.getInstance();
      expect(() => registry.resolveModelIdentifier("../../../etc/passwd")).to.throw("path traversal blocked");
    });

    it("should block absolute paths", () => {
      const registry = RerankerModelRegistry.getInstance();
      expect(() => registry.resolveModelIdentifier("/absolute/path/model")).to.throw("path traversal blocked");
    });

    it("should return model name as-is for non-bundled models", () => {
      const registry = RerankerModelRegistry.getInstance();
      const result = registry.resolveModelIdentifier("some-org/some-model");
      expect(result).to.equal("some-org/some-model");
    });
  });

  describe("listAvailableModels", () => {
    it("should return an array with curated models", async () => {
      const registry = RerankerModelRegistry.getInstance();
      const models = await registry.listAvailableModels();
      expect(models).to.be.an("array").with.length.greaterThan(0);
    });

    it("should include source field on each model", async () => {
      const registry = RerankerModelRegistry.getInstance();
      const models = await registry.listAvailableModels();
      for (const m of models) {
        expect(m).to.have.property("source");
        expect(["curated", "bundled"]).to.include(m.source);
      }
    });

    it("should have name field on each model", async () => {
      const registry = RerankerModelRegistry.getInstance();
      const models = await registry.listAvailableModels();
      for (const m of models) {
        expect(m.name).to.be.a("string").with.length.greaterThan(0);
      }
    });

    it("should not have duplicate models", async () => {
      const registry = RerankerModelRegistry.getInstance();
      const models = await registry.listAvailableModels();
      const names = models.map((m) => m.name);
      expect(new Set(names).size).to.equal(names.length);
    });
  });

  describe("listBundledModels", () => {
    it("should return an array", () => {
      const registry = RerankerModelRegistry.getInstance();
      const models = registry.listBundledModels();
      expect(models).to.be.an("array");
    });
  });
});
