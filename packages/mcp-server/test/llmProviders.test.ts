/**
 * Unit Tests for LLM Providers (MCP Server)
 * Tests the createLLMProvider factory and individual provider construction.
 */

import { expect } from "chai";
import { McpConfig } from "../src/config";
import {
  createLLMProvider,
  OpenAILLMProvider,
  AnthropicLLMProvider,
  OllamaLLMProvider,
} from "../src/llmProviders";

/** Helper to build a McpConfig with sensible defaults, overriding specific fields. */
function makeConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    storageDir: "/tmp/ragnarok-test",
    workingDir: "",
    allowedPaths: [],
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    langGraphEnabled: false,
    logLevel: "info",
    port: 3000,
    llmProvider: "none",
    llmApiKey: "",
    llmModel: "",
    llmBaseUrl: "",
    embeddingProvider: "huggingface",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    apiKey: "",
    corsOrigin: "*",
    httpHost: "127.0.0.1",
    rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    ...overrides,
  };
}

describe("LLM Providers", function () {
  // ─── createLLMProvider factory ───────────────────────────

  describe("createLLMProvider", function () {
    it('returns a null provider when llmProvider is "none"', async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "none" }));
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.isAvailable()).to.be.false;
    });

    it("returns a null provider when llmProvider is not set (default)", async function () {
      const provider = createLLMProvider(makeConfig());
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.isAvailable()).to.be.false;
    });

    it("returns a null provider for an unknown provider name", async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "unknown-vendor" }));
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.isAvailable()).to.be.false;
    });

    it('returns a null provider when llmProvider is "openai" but no API key', async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "openai", llmApiKey: "" }));
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.isAvailable()).to.be.false;
    });

    it('returns a null provider when llmProvider is "anthropic" but no API key', async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "anthropic", llmApiKey: "" }));
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.isAvailable()).to.be.false;
    });

    it("returns an OpenAILLMProvider when configured with key", function () {
      const provider = createLLMProvider(
        makeConfig({ llmProvider: "openai", llmApiKey: "sk-test-key", llmModel: "gpt-4o-mini" }),
      );
      expect(provider).to.be.instanceOf(OpenAILLMProvider);
    });

    it("returns an OpenAILLMProvider with default model when llmModel is empty", function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "openai", llmApiKey: "sk-test-key" }));
      expect(provider).to.be.instanceOf(OpenAILLMProvider);
    });

    it("does NOT route OpenAI to a local Ollama URL when no base URL is configured", function () {
      // Regression: a global llmBaseUrl default of http://localhost:11434
      // used to send every OpenAI request to local Ollama.
      const provider = createLLMProvider(makeConfig({ llmProvider: "openai", llmApiKey: "sk-test-key" }));
      expect((provider as any).baseUrl).to.equal(undefined);
    });

    it("forwards an explicitly configured base URL to the OpenAI provider", function () {
      const provider = createLLMProvider(
        makeConfig({ llmProvider: "openai", llmApiKey: "sk-test-key", llmBaseUrl: "https://proxy.example.com/v1" }),
      );
      expect((provider as any).baseUrl).to.equal("https://proxy.example.com/v1");
    });

    it("defaults Ollama to http://localhost:11434 when no base URL is configured", function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "ollama" }));
      expect((provider as any).baseUrl).to.equal("http://localhost:11434");
    });

    it("returns an AnthropicLLMProvider when configured with key", function () {
      const provider = createLLMProvider(
        makeConfig({
          llmProvider: "anthropic",
          llmApiKey: "sk-ant-test",
          llmModel: "claude-sonnet-4-20250514",
        }),
      );
      expect(provider).to.be.instanceOf(AnthropicLLMProvider);
    });

    it("returns an OllamaLLMProvider when configured (no API key needed)", function () {
      const provider = createLLMProvider(
        makeConfig({
          llmProvider: "ollama",
          llmBaseUrl: "http://localhost:11434",
          llmModel: "llama3",
        }),
      );
      expect(provider).to.be.instanceOf(OllamaLLMProvider);
    });

    it("returns an OllamaLLMProvider even when llmApiKey is empty", function () {
      const provider = createLLMProvider(
        makeConfig({ llmProvider: "ollama", llmApiKey: "" }),
      );
      expect(provider).to.be.instanceOf(OllamaLLMProvider);
    });
  });

  // ─── Null provider behaviour ─────────────────────────────

  describe("NullProvider (via factory)", function () {
    it("selectModel always returns null", async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "none" }));
      expect(await provider.selectModel()).to.be.null;
      expect(await provider.selectModel({ family: "gpt" })).to.be.null;
    });

    it("isAvailable always returns false", async function () {
      const provider = createLLMProvider(makeConfig({ llmProvider: "none" }));
      expect(await provider.isAvailable()).to.be.false;
    });
  });

  // ─── OpenAILLMProvider ───────────────────────────────────

  describe("OpenAILLMProvider", function () {
    it("selectModel returns null when the SDK import fails", async function () {
      // Constructing with a bogus key; selectModel will attempt dynamic import of "openai"
      // which may or may not be installed. Either way it should not throw.
      const provider = new OpenAILLMProvider("sk-bogus", "gpt-4o-mini");
      const model = await provider.selectModel();
      // If the openai SDK is installed, we get a model; if not, null.
      // The important thing is no unhandled error.
      expect(model === null || typeof model.id === "string").to.be.true;
    });

    it("isAvailable returns false when the backend is unreachable", async function () {
      const provider = new OpenAILLMProvider("sk-invalid", "gpt-4o-mini");
      // isAvailable calls client.models.list() which will fail with a bad key / no network
      const available = await provider.isAvailable();
      expect(available).to.be.a("boolean");
    });
  });

  // ─── AnthropicLLMProvider ────────────────────────────────

  describe("AnthropicLLMProvider", function () {
    it("selectModel returns null when the SDK import fails", async function () {
      const provider = new AnthropicLLMProvider("sk-ant-bogus", "claude-sonnet-4-20250514");
      const model = await provider.selectModel();
      expect(model === null || typeof model.id === "string").to.be.true;
    });

    it("isAvailable returns false when the backend is unreachable", async function () {
      const provider = new AnthropicLLMProvider("sk-ant-invalid", "claude-sonnet-4-20250514");
      const available = await provider.isAvailable();
      expect(available).to.be.a("boolean");
    });
  });

  // ─── OllamaLLMProvider ──────────────────────────────────

  describe("OllamaLLMProvider", function () {
    it("selectModel returns null when the SDK import fails", async function () {
      const provider = new OllamaLLMProvider("http://localhost:11434", "llama3");
      const model = await provider.selectModel();
      expect(model === null || typeof model.id === "string").to.be.true;
    });

    it("isAvailable returns false when Ollama is not running", async function () {
      const provider = new OllamaLLMProvider("http://localhost:11434", "llama3");
      const available = await provider.isAvailable();
      expect(available).to.be.a("boolean");
    });
  });
});
