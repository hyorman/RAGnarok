/**
 * Unit & integration tests for the HTTP transport layer (httpServer.ts)
 * and the HTTP-related config fields.
 */

import { expect } from "chai";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport } from "../src/httpServer";
import { McpConfig, loadConfig } from "../src/config";

function createTestConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    storageDir: "/tmp/ragnarok-test",
    embeddingModel: "test-model",
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    logLevel: "error",
    port: 0, // let OS assign a free port
    llmProvider: "none",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    llmBaseUrl: "http://localhost:11434",
    embeddingProvider: "huggingface",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    apiKey: "",
    corsOrigin: "*",
    httpHost: "127.0.0.1",
    ...overrides,
  };
}

/** Make an HTTP request and return status + parsed JSON body */
function httpRequest(
  url: string,
  options: http.RequestOptions = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on("error", reject);
    if (options.method === "POST" && (options as any)._body) {
      req.write((options as any)._body);
    }
    req.end();
  });
}

describe("HTTP Transport", function () {
  this.timeout(30000);

  // ---------------------------------------------------------------------------
  // Config tests
  // ---------------------------------------------------------------------------

  describe("loadConfig() HTTP fields", () => {
    const httpEnvVars = ["RAGNAROK_API_KEY", "RAGNAROK_CORS_ORIGIN", "RAGNAROK_HTTP_HOST"];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of httpEnvVars) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of httpEnvVars) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("should default apiKey to empty string", () => {
      const config = loadConfig();
      expect(config.apiKey).to.equal("");
    });

    it("should default corsOrigin to '*'", () => {
      const config = loadConfig();
      expect(config.corsOrigin).to.equal("*");
    });

    it("should default httpHost to '127.0.0.1'", () => {
      const config = loadConfig();
      expect(config.httpHost).to.equal("127.0.0.1");
    });

    it("should respect RAGNAROK_API_KEY env var", () => {
      process.env.RAGNAROK_API_KEY = "test-secret-key";
      const config = loadConfig();
      expect(config.apiKey).to.equal("test-secret-key");
    });

    it("should respect RAGNAROK_CORS_ORIGIN env var", () => {
      process.env.RAGNAROK_CORS_ORIGIN = "https://example.com";
      const config = loadConfig();
      expect(config.corsOrigin).to.equal("https://example.com");
    });

    it("should respect RAGNAROK_HTTP_HOST env var", () => {
      process.env.RAGNAROK_HTTP_HOST = "0.0.0.0";
      const config = loadConfig();
      expect(config.httpHost).to.equal("0.0.0.0");
    });
  });

  // ---------------------------------------------------------------------------
  // startHttpTransport integration tests
  // ---------------------------------------------------------------------------

  describe("startHttpTransport()", () => {
    let server: http.Server | undefined;

    afterEach((done) => {
      if (server) {
        server.close(() => done());
        server = undefined;
      } else {
        done();
      }
    });

    it("should start and expose a /health endpoint", async () => {
      const mcpServer = new McpServer({ name: "test-server", version: "0.0.1" });
      mcpServer.tool("test_ping", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const config = createTestConfig();
      server = await startHttpTransport(mcpServer, config);

      const addr = server!.address() as { port: number };
      const { status, body } = await httpRequest(`http://127.0.0.1:${addr.port}/health`);

      expect(status).to.equal(200);
      expect(body).to.have.property("status", "ok");
      expect(body).to.have.property("version");
      expect(body).to.have.property("uptime").that.is.a("number");
    });

    it("should allow /mcp requests when no API key is configured", async () => {
      const mcpServer = new McpServer({ name: "test-server", version: "0.0.1" });
      mcpServer.tool("test_ping", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const config = createTestConfig({ apiKey: "" });
      server = await startHttpTransport(mcpServer, config);

      const addr = server!.address() as { port: number };
      // POST to /mcp without auth — should NOT 401
      const { status } = await httpRequest(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      // The transport may reject the body shape, but it should not be 401
      expect(status).to.not.equal(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Auth middleware tests
  // ---------------------------------------------------------------------------

  describe("API key authentication", () => {
    const TEST_API_KEY = "test-secret-key-12345";
    let server: http.Server | undefined;

    afterEach((done) => {
      if (server) {
        server.close(() => done());
        server = undefined;
      } else {
        done();
      }
    });

    it("should return 401 when API key is configured but no Authorization header sent", async () => {
      const mcpServer = new McpServer({ name: "test-server", version: "0.0.1" });
      mcpServer.tool("test_ping", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const config = createTestConfig({ apiKey: TEST_API_KEY });
      server = await startHttpTransport(mcpServer, config);

      const addr = server!.address() as { port: number };
      const { status, body } = await httpRequest(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(status).to.equal(401);
      expect(body).to.have.property("error", "Unauthorized");
    });

    it("should return 401 when Authorization header has wrong key", async () => {
      const mcpServer = new McpServer({ name: "test-server", version: "0.0.1" });
      mcpServer.tool("test_ping", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const config = createTestConfig({ apiKey: TEST_API_KEY });
      server = await startHttpTransport(mcpServer, config);

      const addr = server!.address() as { port: number };
      const { status, body } = await httpRequest(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-key",
        },
      });

      expect(status).to.equal(401);
      expect(body).to.have.property("error", "Unauthorized");
    });

    it("should pass through when correct Bearer token is provided", async () => {
      const mcpServer = new McpServer({ name: "test-server", version: "0.0.1" });
      mcpServer.tool("test_ping", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const config = createTestConfig({ apiKey: TEST_API_KEY });
      server = await startHttpTransport(mcpServer, config);

      const addr = server!.address() as { port: number };
      const { status } = await httpRequest(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // With correct auth the transport handles the request — not 401
      expect(status).to.not.equal(401);
    });
  });
});
