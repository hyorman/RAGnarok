import { expect } from "chai";
import { RemoteEmbeddingBackend } from "../src/embeddings/remoteEmbeddingBackend";

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

type MockRoute = {
  method: string;
  pattern: string;
  response: { status: number; body: unknown };
};

let originalFetch: typeof globalThis.fetch;

function mockFetch(routes: MockRoute[]): void {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    for (const route of routes) {
      if (method === route.method.toUpperCase() && url.includes(route.pattern)) {
        return {
          ok: route.response.status >= 200 && route.response.status < 300,
          status: route.response.status,
          json: async () => route.response.body,
          text: async () => JSON.stringify(route.response.body),
        } as Response;
      }
    }

    return { ok: false, status: 404, text: async () => "not found" } as Response;
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const OPENAI_EMBED_RESPONSE = {
  data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
  model: "text-embedding-3-small",
};

const OPENAI_BATCH_RESPONSE = {
  data: [
    { embedding: [0.1, 0.2, 0.3], index: 0 },
    { embedding: [0.4, 0.5, 0.6], index: 1 },
  ],
  model: "text-embedding-3-small",
};

const OPENAI_MODELS_RESPONSE = {
  data: [{ id: "text-embedding-3-small" }, { id: "text-embedding-3-large" }],
};

const OLLAMA_EMBED_RESPONSE = {
  model: "all-minilm",
  embeddings: [[0.1, 0.2, 0.3]],
};

const OLLAMA_BATCH_RESPONSE = {
  model: "all-minilm",
  embeddings: [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ],
};

const OLLAMA_MODELS_RESPONSE = {
  models: [{ name: "all-minilm:latest", model: "all-minilm:latest" }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RemoteEmbeddingBackend", function () {
  this.timeout(5000);

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // OpenAI format
  // -------------------------------------------------------------------------

  describe("OpenAI format", () => {
    let backend: RemoteEmbeddingBackend;

    beforeEach(async () => {
      mockFetch([
        { method: "POST", pattern: "/embeddings", response: { status: 200, body: OPENAI_EMBED_RESPONSE } },
        { method: "GET", pattern: "/models", response: { status: 200, body: OPENAI_MODELS_RESPONSE } },
      ]);
      backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:1234",
        apiKey: "test-key",
        format: "openai",
        modelName: "text-embedding-3-small",
      });
      await backend.initialize();
    });

    it("should embed a single text", async () => {
      const result = await backend.embed("hello");
      expect(result).to.deep.equal([0.1, 0.2, 0.3]);
    });

    it("should embed a batch of texts", async () => {
      mockFetch([{ method: "POST", pattern: "/embeddings", response: { status: 200, body: OPENAI_BATCH_RESPONSE } }]);
      const results = await backend.embedBatch(["hello", "world"]);
      expect(results).to.have.length(2);
      expect(results[0]).to.deep.equal([0.1, 0.2, 0.3]);
      expect(results[1]).to.deep.equal([0.4, 0.5, 0.6]);
    });

    it("should list models", async () => {
      const models = await backend.listModels();
      expect(models).to.have.length(2);
      expect(models[0].id).to.equal("text-embedding-3-small");
      expect(models[1].id).to.equal("text-embedding-3-large");
    });

    it("should throw when initialized without a model name", async () => {
      const auto = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:1234",
        format: "openai",
      });
      try {
        await auto.initialize();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("requires a model name");
      }
    });

    it("should handle API errors", async () => {
      mockFetch([{ method: "POST", pattern: "/embeddings", response: { status: 500, body: "internal error" } }]);
      try {
        await backend.embed("fail");
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("500");
      }
    });

    it("should cache dimension from first response", async () => {
      expect(backend.getDimension()).to.be.null;
      await backend.embed("hello");
      expect(backend.getDimension()).to.equal(3);
    });
  });

  // -------------------------------------------------------------------------
  // Ollama format
  // -------------------------------------------------------------------------

  describe("Ollama format", () => {
    let backend: RemoteEmbeddingBackend;

    beforeEach(async () => {
      mockFetch([
        { method: "POST", pattern: "/api/embed", response: { status: 200, body: OLLAMA_EMBED_RESPONSE } },
        { method: "GET", pattern: "/api/tags", response: { status: 200, body: OLLAMA_MODELS_RESPONSE } },
      ]);
      backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:11434",
        format: "ollama",
        modelName: "all-minilm",
      });
      await backend.initialize();
    });

    it("should embed a single text", async () => {
      const result = await backend.embed("hello");
      expect(result).to.deep.equal([0.1, 0.2, 0.3]);
    });

    it("should embed a batch of texts", async () => {
      mockFetch([{ method: "POST", pattern: "/api/embed", response: { status: 200, body: OLLAMA_BATCH_RESPONSE } }]);
      const results = await backend.embedBatch(["hello", "world"]);
      expect(results).to.have.length(2);
      expect(results[0]).to.deep.equal([0.1, 0.2, 0.3]);
      expect(results[1]).to.deep.equal([0.4, 0.5, 0.6]);
    });

    it("should list models", async () => {
      const models = await backend.listModels();
      expect(models).to.have.length(1);
      expect(models[0].id).to.equal("all-minilm:latest");
      expect(models[0].name).to.equal("all-minilm:latest");
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe("isAvailable", () => {
    it("should return true when server is reachable", async () => {
      mockFetch([{ method: "GET", pattern: "/models", response: { status: 200, body: OPENAI_MODELS_RESPONSE } }]);
      const backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:1234",
        format: "openai",
      });
      expect(await backend.isAvailable()).to.be.true;
    });

    it("should return false when server is unreachable", async () => {
      global.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch;
      const backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:9999",
        format: "openai",
      });
      expect(await backend.isAvailable()).to.be.false;
    });

    it("should return false when baseUrl is empty", async () => {
      const backend = new RemoteEmbeddingBackend({
        baseUrl: "",
        format: "openai",
      });
      expect(await backend.isAvailable()).to.be.false;
    });
  });

  // -------------------------------------------------------------------------
  // error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("should throw on HTTP error", async () => {
      mockFetch([{ method: "POST", pattern: "/embeddings", response: { status: 401, body: "unauthorized" } }]);
      const backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:1234",
        format: "openai",
        modelName: "text-embedding-3-small",
      });
      await backend.initialize();
      try {
        await backend.embed("test");
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("401");
      }
    });

    it("should throw when model not set", async () => {
      const backend = new RemoteEmbeddingBackend({
        baseUrl: "http://localhost:1234",
        format: "openai",
      });
      try {
        await backend.initialize();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("requires a model name");
      }
    });
  });
});
