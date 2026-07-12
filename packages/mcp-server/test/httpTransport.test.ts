/**
 * Unit & integration tests for the HTTP transport layer (httpServer.ts)
 * and the HTTP-related config fields.
 */

import { expect } from "chai";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpTransport, HttpTransportHandle } from "../src/httpServer";
import { McpConfig, loadConfig } from "../src/config";

function createTestConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    storageDir: "/tmp/ragnarok-test",
    workingDir: "",
    allowedPaths: [],
    embeddingModel: "test-model",
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    retrievalStrategy: "hybrid",
    maxIterations: 3,
    confidenceThreshold: 0.7,
    langGraphEnabled: false,
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
    writeApiKey: "",
    corsOrigin: "*",
    httpHost: "127.0.0.1",
    rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerEnabled: true,
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    queryMemoryEnabled: false,
    sessionIdleTtlMs: 30_000,
    maxSessions: 20,
    rateLimitPerMinute: 1_000,
    exportDir: "/tmp/ragnarok-exports",
    githubHosts: ["github.com"],
    githubToken: "",
    checkpointRetentionMs: 0,
    resetStorage: false,
    ...overrides,
  };
}

/** Factory producing a fresh test McpServer with one tool. */
function testServerFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: "test-server", version: "0.0.1" });
    server.tool("test_ping", "A test tool", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };
}

function roleAwareServerFactory(): (role: "reader" | "writer") => McpServer {
  return (role) => {
    const server = new McpServer({ name: "role-test-server", version: "0.0.1" });
    server.tool("read_ping", "A read tool", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
    if (role === "writer") {
      server.tool("write_ping", "A writer-only tool", {}, async () => ({
        content: [{ type: "text", text: "written" }],
      }));
    }
    return server;
  };
}

function serverPort(handle: HttpTransportHandle): number {
  return (handle.httpServer.address() as { port: number }).port;
}

/** Make an HTTP request and return status + parsed JSON body */
function httpRequest(
  url: string,
  options: http.RequestOptions & { _body?: string } = {},
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
    if (options._body) {
      req.write(options._body);
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
      process.env.RAGNAROK_API_KEY = "read-token";
      process.env.RAGNAROK_CORS_ORIGIN = "https://example.test";
      const config = loadConfig();
      expect(config.httpHost).to.equal("0.0.0.0");
    });
  });

  // ---------------------------------------------------------------------------
  // startHttpTransport integration tests
  // ---------------------------------------------------------------------------

  describe("startHttpTransport()", () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
    });

    it("should start and expose a /health endpoint", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/health`);

      expect(status).to.equal(200);
      expect(body).to.have.property("status", "ok");
      expect(body).to.have.property("version");
      expect(body).to.have.property("uptime").that.is.a("number");
    });

    it("should allow /mcp requests when no API key is configured", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ apiKey: "" }));

      // POST to /mcp without auth — should NOT 401
      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      // The transport may reject the body shape, but it should not be 401
      expect(status).to.not.equal(401);
    });

    it("should reject non-initialize requests without a session ID", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        _body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(status).to.equal(400);
      expect(body?.error?.message).to.include("session");
    });

    it("should reject requests carrying an unknown session ID", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());

      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "no-such-session",
        },
        _body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(status).to.equal(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-session support
  // ---------------------------------------------------------------------------

  describe("multi-session support", () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
    });

    it("serves two concurrent client sessions independently", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);

      const clientA = new Client({ name: "client-a", version: "1.0.0" });
      const clientB = new Client({ name: "client-b", version: "1.0.0" });
      const transportA = new StreamableHTTPClientTransport(url);
      const transportB = new StreamableHTTPClientTransport(url);

      // A stateful transport serves ONE session; a second concurrent client
      // must get its own session instead of hijacking or breaking the first.
      await clientA.connect(transportA);
      await clientB.connect(transportB);

      const toolsA = await clientA.listTools();
      const toolsB = await clientB.listTools();
      expect(toolsA.tools.map((t) => t.name)).to.include("test_ping");
      expect(toolsB.tools.map((t) => t.name)).to.include("test_ping");

      await clientA.close();

      // B keeps working after A is gone
      const toolsAfter = await clientB.listTools();
      expect(toolsAfter.tools.map((t) => t.name)).to.include("test_ping");

      await clientB.close();
    });

    it("terminates a session via DELETE and rejects further use of its ID", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);

      const client = new Client({ name: "client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);

      const sessionId = transport.sessionId;
      expect(sessionId, "client transport received no session ID").to.be.a("string");

      // DELETE /mcp with the session ID = explicit termination
      await transport.terminateSession();

      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        _body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      });
      expect(status).to.equal(400);
    });

    it("shutdown() closes active sessions and stops listening", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const port = serverPort(handle);
      const url = new URL(`http://127.0.0.1:${port}/mcp`);

      const client = new Client({ name: "client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url));

      await handle.shutdown();
      handle = undefined;

      let refused = false;
      try {
        await httpRequest(`http://127.0.0.1:${port}/health`);
      } catch {
        refused = true;
      }
      expect(refused, "server still accepting connections after shutdown").to.equal(true);
    });
  });

  describe("session limits and cancellation", () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
    });

    it("enforces the configured maximum session count", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ maxSessions: 1 }));
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);
      const first = new Client({ name: "first", version: "1.0.0" });
      await first.connect(new StreamableHTTPClientTransport(url));

      const second = new Client({ name: "second", version: "1.0.0" });
      let rejected = false;
      try {
        await second.connect(new StreamableHTTPClientTransport(url));
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      await first.close();
    });

    it("expires idle sessions", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ sessionIdleTtlMs: 1000 }));
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);
      const client = new Client({ name: "idle", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      const sessionId = transport.sessionId!;

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const { status } = await httpRequest(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        _body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      });
      expect(status).to.equal(400);
    });

    it("applies the configured request rate limit", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ rateLimitPerMinute: 2 }));
      const url = `http://127.0.0.1:${serverPort(handle)}/health`;
      expect((await httpRequest(url)).status).to.equal(200);
      expect((await httpRequest(url)).status).to.equal(200);
      expect((await httpRequest(url)).status).to.equal(429);
    });

    it("propagates client cancellation to the active MCP handler", async () => {
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      let handlerAborted = false;
      let notifyHandlerAborted!: () => void;
      const handlerAbortedSignal = new Promise<void>((resolve) => {
        notifyHandlerAborted = resolve;
      });
      handle = await startHttpTransport(() => {
        const server = new McpServer({ name: "cancel-test", version: "0.0.1" });
        server.tool("wait", "Wait until cancelled", {}, async (_args, extra) => {
          handlerStarted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              handlerAborted = true;
              notifyHandlerAborted();
              reject(extra.signal.reason ?? new Error("cancelled"));
            };
            if (extra.signal.aborted) {
              onAbort();
            } else {
              extra.signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          return { content: [{ type: "text", text: "unexpected" }] };
        });
        return server;
      }, createTestConfig());
      const client = new Client({ name: "cancel-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`)));
      const controller = new AbortController();
      const request = client.callTool({ name: "wait", arguments: {} }, undefined, { signal: controller.signal });
      await started;
      controller.abort();
      let rejected = false;
      try {
        await request;
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      // The SDK client fire-and-forgets the notifications/cancelled POST and
      // rejects the local promise immediately, so the server-side abort lands
      // an event-loop round-trip later — wait for it instead of racing it.
      await Promise.race([
        handlerAbortedSignal,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("handler abort signal never fired within 2s")), 2000),
        ),
      ]);
      expect(handlerAborted).to.equal(true);
      await client.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Auth middleware tests
  // ---------------------------------------------------------------------------

  describe("API key authentication", () => {
    const TEST_API_KEY = "test-secret-key-12345";
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
    });

    it("should return 401 when API key is configured but no Authorization header sent", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ apiKey: TEST_API_KEY }));

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(status).to.equal(401);
      expect(body).to.have.property("error", "Unauthorized");
    });

    it("should return 401 when Authorization header has wrong key", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ apiKey: TEST_API_KEY }));

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
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
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ apiKey: TEST_API_KEY }));

      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // With correct auth the transport handles the request — not 401
      expect(status).to.not.equal(401);
    });

    it("fixes reader and writer roles at initialization and rejects token switching", async () => {
      const readToken = "reader-token-123";
      const writeToken = "writer-token-456";
      handle = await startHttpTransport(
        roleAwareServerFactory(),
        createTestConfig({ apiKey: readToken, writeApiKey: writeToken }),
      );
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);
      const readerTransport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${readToken}` } },
      });
      const writerTransport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${writeToken}` } },
      });
      const reader = new Client({ name: "reader", version: "1.0.0" });
      const writer = new Client({ name: "writer", version: "1.0.0" });
      await reader.connect(readerTransport);
      await writer.connect(writerTransport);

      expect((await reader.listTools()).tools.map((tool) => tool.name)).to.deep.equal(["read_ping"]);
      expect((await writer.listTools()).tools.map((tool) => tool.name)).to.include.members(["read_ping", "write_ping"]);

      const { status } = await httpRequest(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${writeToken}`,
          "mcp-session-id": readerTransport.sessionId!,
        },
        _body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
      });
      expect(status).to.equal(401);

      await reader.close();
      await writer.close();
    });
  });
});
