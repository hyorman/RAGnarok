/**
 * Unit Tests for MCP Server Adapters and Config
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CONFIG, setLoggerFactory, ILoggerFactory } from "@ragnarok/core";
import { loadConfig, assertNoRemovedEnvVars } from "../src/config";
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
      "RAGNAROK_LLM_PROVIDER",
      "RAGNAROK_LLM_API_KEY",
      "RAGNAROK_LLM_MODEL",
      "RAGNAROK_LLM_BASE_URL",
      "RAGNAROK_LLM_REQUEST_TIMEOUT_MS",
      "RAGNAROK_EMBEDDING_PROVIDER",
      "RAGNAROK_EMBEDDING_BASE_URL",
      "RAGNAROK_EMBEDDING_API_KEY",
      "RAGNAROK_WORKING_DIR",
      "RAGNAROK_ALLOWED_PATHS",
      "RAGNAROK_SHUTDOWN_DRAIN_MS",
      "RAGNAROK_MAX_RESPONSE_BYTES",
      "RAGNAROK_RERANKER_MODEL",
      "RAGNAROK_RERANKER_ENABLED",
      "RAGNAROK_RERANKER_MAX_CANDIDATES",
      "RAGNAROK_RERANKER_CANDIDATE_MULTIPLIER",
      "RAGNAROK_EXPORT_DIR",
      "RAGNAROK_GITHUB_HOSTS",
      "RAGNAROK_GITHUB_TOKEN",
      "GITHUB_ACCESS_TOKEN",
      "RAGNAROK_RESET_STORAGE",
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
    });

    it("defaults the runtime limits that survived the HTTP transport", () => {
      const config = loadConfig();
      expect(config.shutdownDrainMs).to.equal(10_000);
      expect(config.llmRequestTimeoutMs).to.equal(30_000);
      expect(config.maxResponseBytes).to.equal(1_048_576);
    });

    it("defaults the reranker to enabled with its bundled model", () => {
      const config = loadConfig();
      expect(config.rerankerEnabled).to.be.true;
      expect(config.rerankerModel).to.equal("Xenova/ms-marco-MiniLM-L-6-v2");
      expect(config.rerankerMaxCandidates).to.equal(20);
      expect(config.rerankerCandidateMultiplier).to.equal(4);
    });

    it("treats only '0' and 'false' as disabling the reranker", () => {
      process.env.RAGNAROK_RERANKER_ENABLED = "0";
      expect(loadConfig().rerankerEnabled).to.be.false;
      process.env.RAGNAROK_RERANKER_ENABLED = "false";
      expect(loadConfig().rerankerEnabled).to.be.false;
      process.env.RAGNAROK_RERANKER_ENABLED = "1";
      expect(loadConfig().rerankerEnabled).to.be.true;
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

    it("should reject chunk overlap >= chunk size", () => {
      process.env.RAGNAROK_CHUNK_SIZE = "200";
      process.env.RAGNAROK_CHUNK_OVERLAP = "200";
      expect(() => loadConfig()).to.throw(/chunkOverlap/);
    });

    it("should reject an invalid RAGNAROK_LOG_LEVEL at startup", () => {
      process.env.RAGNAROK_LOG_LEVEL = "verbose";
      expect(() => loadConfig()).to.throw(/logLevel/);
    });

    it("rejects a shutdown drain budget outside its range", () => {
      process.env.RAGNAROK_SHUTDOWN_DRAIN_MS = "999";
      expect(() => loadConfig()).to.throw(/shutdownDrainMs/);
      process.env.RAGNAROK_SHUTDOWN_DRAIN_MS = "120001";
      expect(() => loadConfig()).to.throw(/shutdownDrainMs/);
      process.env.RAGNAROK_SHUTDOWN_DRAIN_MS = "30000";
      expect(loadConfig().shutdownDrainMs).to.equal(30_000);
    });

    it("rejects a response ceiling above the protocol maximum", () => {
      process.env.RAGNAROK_MAX_RESPONSE_BYTES = String(32 * 1024 * 1024);
      expect(() => loadConfig()).to.throw(/maxResponseBytes/);
    });

    it("requires an embedding base URL for non-huggingface providers", () => {
      process.env.RAGNAROK_EMBEDDING_PROVIDER = "openai";
      expect(() => loadConfig()).to.throw(/RAGNAROK_EMBEDDING_BASE_URL/);
      process.env.RAGNAROK_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
      expect(loadConfig().embeddingBaseUrl).to.equal("https://api.openai.com/v1");
    });

    it("rejects provider base URLs that embed credentials or a non-HTTP scheme", () => {
      process.env.RAGNAROK_LLM_PROVIDER = "ollama";
      process.env.RAGNAROK_LLM_BASE_URL = "http://user:secret@ollama.internal:11434";
      expect(() => loadConfig()).to.throw(/llmBaseUrl/);

      process.env.RAGNAROK_LLM_BASE_URL = "file:///etc/passwd";
      expect(() => loadConfig()).to.throw(/llmBaseUrl/);

      process.env.RAGNAROK_LLM_BASE_URL = "http://localhost:11434";
      expect(loadConfig().llmBaseUrl).to.equal("http://localhost:11434");
    });

    it("splits RAGNAROK_ALLOWED_PATHS on the platform delimiter, trimming blanks", () => {
      process.env.RAGNAROK_ALLOWED_PATHS = ["/srv/docs", "  /srv/notes  ", ""].join(path.delimiter);
      expect(loadConfig().allowedPaths).to.deep.equal(["/srv/docs", "/srv/notes"]);
    });

    it("defaults allowedPaths to empty so the working directory is the only root", () => {
      expect(loadConfig().allowedPaths).to.deep.equal([]);
    });

    it("derives exportDir from the storage dir unless overridden", () => {
      process.env.RAGNAROK_STORAGE_DIR = "/tmp/ragnarok-store";
      expect(loadConfig().exportDir).to.equal(path.join("/tmp/ragnarok-store", "exports"));
      process.env.RAGNAROK_EXPORT_DIR = "/tmp/elsewhere";
      expect(loadConfig().exportDir).to.equal("/tmp/elsewhere");
    });

    it("normalises RAGNAROK_GITHUB_HOSTS and defaults to github.com", () => {
      expect(loadConfig().githubHosts).to.deep.equal(["github.com"]);
      process.env.RAGNAROK_GITHUB_HOSTS = "GitHub.com, ghe.Example.COM ,";
      expect(loadConfig().githubHosts).to.deep.equal(["github.com", "ghe.example.com"]);
    });

    it("falls back to GITHUB_ACCESS_TOKEN when RAGNAROK_GITHUB_TOKEN is unset", () => {
      process.env.GITHUB_ACCESS_TOKEN = "gh-fallback";
      expect(loadConfig().githubToken).to.equal("gh-fallback");
      process.env.RAGNAROK_GITHUB_TOKEN = "gh-explicit";
      expect(loadConfig().githubToken).to.equal("gh-explicit");
    });

    it("enables resetStorage from RAGNAROK_RESET_STORAGE", () => {
      expect(loadConfig().resetStorage).to.be.false;
      process.env.RAGNAROK_RESET_STORAGE = "true";
      expect(loadConfig().resetStorage).to.be.true;
    });

    it("no longer carries any HTTP transport field", () => {
      // The removed-variable guard is the operator-facing half of this; the
      // config object itself must not resurrect the fields it once fed.
      const config = loadConfig() as unknown as Record<string, unknown>;
      for (const field of [
        "deploymentMode",
        "deploymentModeExplicit",
        "port",
        "httpHost",
        "allowedHosts",
        "corsOrigin",
        "tlsCertPath",
        "tlsKeyPath",
        "apiKey",
        "writeApiKey",
        "adminApiKey",
        "rateLimitPerMinute",
        "trustedProxies",
        "maxRequestBytes",
        "transferMaxFileBytes",
        "transferMaxAggregateBytes",
        "transferMaxSessions",
        "transferTtlMs",
      ]) {
        expect(config, field).to.not.have.property(field);
      }
    });
  });

  // A stdio-only server must not silently ignore HTTP-era configuration:
  // someone who set TLS certificates and API keys believes they are running a
  // hardened network service, and a quiet startup would leave that belief intact.
  describe("assertNoRemovedEnvVars()", () => {
    const removed = [
      "RAGNAROK_DEPLOYMENT_MODE",
      "RAGNAROK_PORT",
      "RAGNAROK_HTTP_HOST",
      "RAGNAROK_ALLOWED_HOSTS",
      "RAGNAROK_CORS_ORIGIN",
      "RAGNAROK_TLS_CERT_PATH",
      "RAGNAROK_TLS_KEY_PATH",
      "RAGNAROK_API_KEY",
      "RAGNAROK_WRITE_API_KEY",
      "RAGNAROK_ADMIN_API_KEY",
      "RAGNAROK_RATE_LIMIT_PER_MINUTE",
      "RAGNAROK_TRUSTED_PROXIES",
      "RAGNAROK_TRANSFER_TTL_MS",
      "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
      "RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES",
      "RAGNAROK_TRANSFER_MAX_SESSIONS",
    ];

    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of removed) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of removed) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    });

    for (const name of ["RAGNAROK_DEPLOYMENT_MODE", "RAGNAROK_PORT", "RAGNAROK_TLS_CERT_PATH", "RAGNAROK_API_KEY"]) {
      it(`rejects ${name}`, () => {
        process.env[name] = "x";
        expect(() => assertNoRemovedEnvVars()).to.throw(new RegExp(name));
      });
    }

    it("accepts an environment with none of them set", () => {
      expect(() => assertNoRemovedEnvVars()).to.not.throw();
    });

    // Not covered here: an empty-string value (`RAGNAROK_API_KEY=`). The guard
    // tests `!== undefined` rather than truthiness so it still fires, but
    // Windows deletes an env var assigned "", and this suite runs on
    // windows-2022 (.github/workflows/release.yml native matrix).

    it("names every offending variable in one message", () => {
      process.env.RAGNAROK_PORT = "3000";
      process.env.RAGNAROK_TLS_KEY_PATH = "/etc/tls/key.pem";
      expect(() => assertNoRemovedEnvVars()).to.throw(/RAGNAROK_PORT.*RAGNAROK_TLS_KEY_PATH/);
    });

    it("explains that the server is stdio-only", () => {
      process.env.RAGNAROK_TRANSFER_TTL_MS = "1000";
      expect(() => assertNoRemovedEnvVars()).to.throw(/stdio only/);
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

  describe("config file precedence", () => {
    let dir: string;
    const saved = { ...process.env };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-prec-"));
      process.env.RAGNAROK_STORAGE_DIR = dir;
    });
    afterEach(() => {
      process.env = { ...saved };
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const writeConfig = (value: unknown) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value));

    it("uses the built-in default when neither env nor file sets a key", () => {
      expect(loadConfig().topK).to.equal(10);
    });

    it("uses the file value when env does not set the key", () => {
      writeConfig({ retrieval: { topK: 42 } });
      expect(loadConfig().topK).to.equal(42);
    });

    it("lets env beat the file", () => {
      writeConfig({ retrieval: { topK: 42 } });
      process.env.RAGNAROK_TOP_K = "7";
      expect(loadConfig().topK).to.equal(7);
    });

    it("uses the CURRENT default for an absent key even when $defaults records an older one", () => {
      // The regression test for "absence is the signal". $defaults is documentation,
      // never configuration: a stale value in it must not pin behaviour.
      writeConfig({ $defaults: { retrieval: { topK: 3 } } });
      expect(loadConfig().topK).to.equal(10);
    });

    it("applies file values for booleans and arrays too", () => {
      writeConfig({ reranker: { enabled: false }, security: { githubHosts: ["ghe.example.com"] } });
      const config = loadConfig();
      expect(config.rerankerEnabled).to.equal(false);
      expect(config.githubHosts).to.deep.equal(["ghe.example.com"]);
    });

    it("keeps env-only settings out of the file's reach", () => {
      writeConfig({ retrieval: { topK: 42 } });
      process.env.RAGNAROK_LLM_API_KEY = "from-env";
      expect(loadConfig().llmApiKey).to.equal("from-env");
    });
  });
});
