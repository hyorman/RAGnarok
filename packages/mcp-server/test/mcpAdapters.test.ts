/**
 * Unit Tests for MCP Server Adapters and Config
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import * as os from "os";
import { CONFIG, setLoggerFactory, ILoggerFactory } from "@ragnarok/core";
import { loadConfig } from "../src/config";
import { EnvConfigProvider, ConsoleLoggerFactory, ConsoleNotifier } from "../src/adapters";

describe("MCP Server", () => {
  before(() => {
    const factory: ILoggerFactory = new ConsoleLoggerFactory();
    setLoggerFactory(factory);
  });

  describe("loadConfig()", () => {
    const envVars = [
      "RAGNAROK_STORAGE_DIR",
      "RAGNAROK_EMBEDDING_MODEL",
      "RAGNAROK_CHUNK_SIZE",
      "RAGNAROK_CHUNK_OVERLAP",
      "RAGNAROK_TOP_K",
      "RAGNAROK_RETRIEVAL_STRATEGY",
      "RAGNAROK_MAX_ITERATIONS",
      "RAGNAROK_CONFIDENCE_THRESHOLD",
      "RAGNAROK_LOG_LEVEL",
      "RAGNAROK_PORT",
      "RAGNAROK_LLM_PROVIDER",
      "RAGNAROK_LLM_API_KEY",
      "RAGNAROK_LLM_MODEL",
      "RAGNAROK_LLM_BASE_URL",
    ];

    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of envVars) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of envVars) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("should return correct defaults when no env vars are set", () => {
      const config = loadConfig();
      expect(config.embeddingModel).to.equal("Xenova/all-MiniLM-L6-v2");
      expect(config.chunkSize).to.equal(1000);
      expect(config.chunkOverlap).to.equal(200);
      expect(config.topK).to.equal(10);
      expect(config.retrievalStrategy).to.equal("hybrid");
      expect(config.maxIterations).to.equal(3);
      expect(config.confidenceThreshold).to.equal(0.7);
      expect(config.logLevel).to.equal("info");
      expect(config.port).to.equal(3000);
    });

    it("should default llmProvider to 'none'", () => {
      const config = loadConfig();
      expect(config.llmProvider).to.equal("none");
    });

    it("should default llmApiKey to empty string", () => {
      const config = loadConfig();
      expect(config.llmApiKey).to.equal("");
    });

    it("should default llmModel to empty string (providers pick their own default)", () => {
      const config = loadConfig();
      expect(config.llmModel).to.equal("");
    });

    it("should default llmBaseUrl to empty (each provider applies its own default)", () => {
      // A global Ollama default would silently route OpenAI/Anthropic
      // requests to localhost; the Ollama factory applies its own fallback.
      const config = loadConfig();
      expect(config.llmBaseUrl).to.equal("");
    });

    it("should read values from environment variables", () => {
      process.env.RAGNAROK_CHUNK_SIZE = "500";
      process.env.RAGNAROK_TOP_K = "10";
      process.env.RAGNAROK_LLM_PROVIDER = "openai";
      process.env.RAGNAROK_LLM_API_KEY = "sk-test";
      process.env.RAGNAROK_LLM_MODEL = "gpt-4";
      process.env.RAGNAROK_LLM_BASE_URL = "https://api.openai.com";

      const config = loadConfig();
      expect(config.chunkSize).to.equal(500);
      expect(config.topK).to.equal(10);
      expect(config.llmProvider).to.equal("openai");
      expect(config.llmApiKey).to.equal("sk-test");
      expect(config.llmModel).to.equal("gpt-4");
      expect(config.llmBaseUrl).to.equal("https://api.openai.com");
    });

    it("should default storageDir to ~/.ragnarok", () => {
      const config = loadConfig();
      expect(config.storageDir).to.equal(path.join(os.homedir(), ".ragnarok"));
    });

    it("should use RAGNAROK_STORAGE_DIR when set", () => {
      process.env.RAGNAROK_STORAGE_DIR = "/tmp/custom-ragnarok";
      const config = loadConfig();
      expect(config.storageDir).to.equal("/tmp/custom-ragnarok");
    });

    it("should use RAGNAROK_EMBEDDING_MODEL when set", () => {
      process.env.RAGNAROK_EMBEDDING_MODEL = "custom/model-v2";
      const config = loadConfig();
      expect(config.embeddingModel).to.equal("custom/model-v2");
    });

    it("should reject non-numeric RAGNAROK_CHUNK_SIZE at startup", () => {
      process.env.RAGNAROK_CHUNK_SIZE = "abc";
      expect(() => loadConfig()).to.throw(/chunkSize/);
    });

    it("should reject an invalid RAGNAROK_LLM_PROVIDER at startup", () => {
      process.env.RAGNAROK_LLM_PROVIDER = "chatgpt";
      expect(() => loadConfig()).to.throw(/llmProvider/);
    });

    it("should reject openai provider without an API key", () => {
      process.env.RAGNAROK_LLM_PROVIDER = "openai";
      delete process.env.RAGNAROK_LLM_API_KEY;
      expect(() => loadConfig()).to.throw(/RAGNAROK_LLM_API_KEY/);
    });

    it("should reject an out-of-range port", () => {
      process.env.RAGNAROK_PORT = "70000";
      expect(() => loadConfig()).to.throw(/port/);
    });

    it("should reject chunk overlap >= chunk size", () => {
      process.env.RAGNAROK_CHUNK_SIZE = "200";
      process.env.RAGNAROK_CHUNK_OVERLAP = "200";
      expect(() => loadConfig()).to.throw(/chunkOverlap/);
    });
  });

  describe("EnvConfigProvider", () => {
    let mcpConfig: ReturnType<typeof loadConfig>;
    let provider: EnvConfigProvider;

    before(() => {
      // Clean embedding env vars so loadConfig() returns defaults
      const savedProvider = process.env.RAGNAROK_EMBEDDING_PROVIDER;
      const savedUrl = process.env.RAGNAROK_EMBEDDING_BASE_URL;
      const savedKey = process.env.RAGNAROK_EMBEDDING_API_KEY;
      delete process.env.RAGNAROK_EMBEDDING_PROVIDER;
      delete process.env.RAGNAROK_EMBEDDING_BASE_URL;
      delete process.env.RAGNAROK_EMBEDDING_API_KEY;

      mcpConfig = loadConfig();
      provider = new EnvConfigProvider(mcpConfig);

      // Restore
      if (savedProvider !== undefined) {
        process.env.RAGNAROK_EMBEDDING_PROVIDER = savedProvider;
      }
      if (savedUrl !== undefined) {
        process.env.RAGNAROK_EMBEDDING_BASE_URL = savedUrl;
      }
      if (savedKey !== undefined) {
        process.env.RAGNAROK_EMBEDDING_API_KEY = savedKey;
      }
    });

    it("should return mapped values for known CONFIG keys", () => {
      expect(provider.get(CONFIG.TOP_K, 0)).to.equal(mcpConfig.topK);
      expect(provider.get(CONFIG.CHUNK_SIZE, 0)).to.equal(mcpConfig.chunkSize);
      expect(provider.get(CONFIG.CHUNK_OVERLAP, 0)).to.equal(mcpConfig.chunkOverlap);
      expect(provider.get(CONFIG.RETRIEVAL_STRATEGY, "")).to.equal(mcpConfig.retrievalStrategy);
      expect(provider.get(CONFIG.MAX_ITERATIONS, 0)).to.equal(mcpConfig.maxIterations);
      expect(provider.get(CONFIG.CONFIDENCE_THRESHOLD, 0)).to.equal(mcpConfig.confidenceThreshold);
      expect(provider.get(CONFIG.LOG_LEVEL, "")).to.equal(mcpConfig.logLevel);
    });

    it("should return default value for unknown keys", () => {
      expect(provider.get("unknownKey", "fallback")).to.equal("fallback");
      expect(provider.get("anotherUnknown", 42)).to.equal(42);
    });

    it("should return mcpConfig.llmModel for CONFIG.LLM_MODEL", () => {
      expect(provider.get(CONFIG.LLM_MODEL, "")).to.equal(mcpConfig.llmModel);
    });

    it('should return "huggingface" for CONFIG.EMBEDDING_BACKEND', () => {
      expect(provider.get(CONFIG.EMBEDDING_BACKEND, "")).to.equal("huggingface");
    });

    it('should return "" for CONFIG.COMMON_DATABASE_PATH', () => {
      expect(provider.get(CONFIG.COMMON_DATABASE_PATH, "/fallback")).to.equal("");
    });

    it("should return 0.3 for CONFIG.GAP_SCORE_THRESHOLD", () => {
      expect(provider.get(CONFIG.GAP_SCORE_THRESHOLD, 0)).to.equal(0.3);
    });
  });

  describe("ConsoleLoggerFactory", () => {
    it("should create loggers with debug/info/warn/error methods", () => {
      const factory = new ConsoleLoggerFactory();
      const logger = factory.createLogger("TestContext");

      expect(logger).to.have.property("debug").that.is.a("function");
      expect(logger).to.have.property("info").that.is.a("function");
      expect(logger).to.have.property("warn").that.is.a("function");
      expect(logger).to.have.property("error").that.is.a("function");
    });
  });

  describe("ConsoleLogger output format", () => {
    let factory: ConsoleLoggerFactory;
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      factory = new ConsoleLoggerFactory();
    });

    afterEach(() => {
      sandbox.restore();
    });

    // All levels write to console.error (stderr): stdout is reserved for the
    // stdio JSON-RPC transport and must never carry diagnostic text.
    it("debug() writes to stderr with correct format", () => {
      const stub = sandbox.stub(console, "error");
      const logger = factory.createLogger("TestContext");
      logger.debug("msg");
      expect(stub.calledOnce).to.be.true;
      expect(stub.firstCall.args[0]).to.equal("[DEBUG] [TestContext] msg");
    });

    it("info() writes to stderr with correct format", () => {
      const stub = sandbox.stub(console, "error");
      const logger = factory.createLogger("TestContext");
      logger.info("msg");
      expect(stub.calledOnce).to.be.true;
      expect(stub.firstCall.args[0]).to.equal("[INFO] [TestContext] msg");
    });

    it("warn() writes to stderr with correct format", () => {
      const stub = sandbox.stub(console, "error");
      const logger = factory.createLogger("TestContext");
      logger.warn("msg");
      expect(stub.calledOnce).to.be.true;
      expect(stub.firstCall.args[0]).to.equal("[WARN] [TestContext] msg");
    });

    it("error() writes to stderr with correct format", () => {
      const stub = sandbox.stub(console, "error");
      const logger = factory.createLogger("TestContext");
      logger.error("msg");
      expect(stub.calledOnce).to.be.true;
      expect(stub.firstCall.args[0]).to.equal("[ERROR] [TestContext] msg");
    });

    it("never writes to stdout (console.log)", () => {
      const logStub = sandbox.stub(console, "log");
      sandbox.stub(console, "error");
      sandbox.stub(console, "warn");
      sandbox.stub(console, "debug");
      const logger = factory.createLogger("TestContext");
      logger.debug("msg");
      logger.info("msg");
      logger.warn("msg");
      logger.error("msg");
      expect(logStub.called).to.be.false;
    });

    it("logger includes context and optional data", () => {
      const stub = sandbox.stub(console, "error");
      const logger = factory.createLogger("TestContext");
      logger.info("msg", { key: "value" });
      expect(stub.calledOnce).to.be.true;
      expect(stub.firstCall.args[0]).to.equal("[INFO] [TestContext] msg");
      expect(stub.firstCall.args[1]).to.deep.equal({ key: "value" });
    });
  });

  describe("ConsoleNotifier", () => {
    let notifier: ConsoleNotifier;

    before(() => {
      notifier = new ConsoleNotifier();
    });

    it("should execute withProgress task and return result", async () => {
      const result = await notifier.withProgress("test", async (report) => {
        report("step 1");
        return 42;
      });
      expect(result).to.equal(42);
    });

    it("should not throw on showInfo", () => {
      expect(() => notifier.showInfo("info message")).to.not.throw();
    });

    it("should not throw on showWarning", () => {
      expect(() => notifier.showWarning("warning message")).to.not.throw();
    });

    it("should not throw on showError", () => {
      expect(() => notifier.showError("error message")).to.not.throw();
    });

    it("withProgress reports progress messages to stderr, never stdout", async () => {
      const errStub = sinon.stub(console, "error");
      const logStub = sinon.stub(console, "log");
      try {
        await notifier.withProgress("Loading", async (report) => {
          report("step 1");
          report("step 2");
          return true;
        });
        expect(errStub.calledWith("[PROGRESS] Loading")).to.be.true;
        expect(errStub.calledWith("[PROGRESS] Loading: step 1")).to.be.true;
        expect(errStub.calledWith("[PROGRESS] Loading: step 2")).to.be.true;
        expect(logStub.called).to.be.false;
      } finally {
        errStub.restore();
        logStub.restore();
      }
    });
  });
});
