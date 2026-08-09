/**
 * Unit & integration tests for the HTTP transport layer (httpServer.ts)
 * and the HTTP-related config fields.
 */

import { expect } from "chai";
import http from "http";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Logger } from "@ragnarok/core";
import * as sinon from "sinon";
import { startHttpTransport, HttpTransportHandle, resolveForwardedClientIp, type AccessRole } from "../src/httpServer";
import { McpConfig, loadConfig } from "../src/config";
import { TransferManager } from "../src/transferManager";
import { markMcpToolResult } from "../src/auditContext";
import { z } from "zod";

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
    corsOrigin: "loopback",
    httpHost: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "::1"],
    rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankerEnabled: true,
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    queryMemoryEnabled: false,
    rateLimitPerMinute: 1_000,
    exportDir: "/tmp/ragnarok-exports",
    githubHosts: ["github.com"],
    githubToken: "",
    resetStorage: false,
    ...overrides,
  };
}

/** Factory producing a fresh test McpServer with one tool. */
function testServerFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: "test-server", version: "0.0.1" });
    server.registerTool("test_ping", { description: "A test tool", inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };
}

function roleAwareServerFactory(): (role: AccessRole) => McpServer {
  return (role) => {
    const server = new McpServer({ name: "role-test-server", version: "0.0.1" });
    server.registerTool("rag_list_topics", { description: "A read tool", inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    if (role === "curator" || role === "admin") {
      server.registerTool(
        "rag_create_topic",
        { description: "A curator tool", inputSchema: z.object({}) },
        async () => ({
          content: [{ type: "text", text: "written" }],
        }),
      );
    }
    if (role === "admin") {
      server.registerTool(
        "rag_export_topic",
        { description: "An admin tool", inputSchema: z.object({}) },
        async () => ({
          content: [{ type: "text", text: "exported" }],
        }),
      );
    }
    return server;
  };
}

function modernClient(name: string): Client {
  return new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
}

function serverPort(handle: HttpTransportHandle): number {
  return (handle.httpServer.address() as { port: number }).port;
}

/** Make an HTTP request and return status + parsed JSON body */
function httpRequest(
  url: string,
  options: http.RequestOptions & { _body?: string | Buffer } = {},
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
    const httpEnvVars = ["RAGNAROK_API_KEY", "RAGNAROK_CORS_ORIGIN", "RAGNAROK_HTTP_HOST", "RAGNAROK_ALLOWED_HOSTS"];
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

    it("should default corsOrigin to the loopback browser policy", () => {
      const config = loadConfig();
      expect(config.corsOrigin).to.equal("loopback");
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

    it("parses exact allowed HTTP hosts without ports or wildcards", () => {
      process.env.RAGNAROK_ALLOWED_HOSTS = "kb.example.test,127.0.0.1";
      expect(loadConfig().allowedHosts).to.deep.equal(["kb.example.test", "127.0.0.1"]);
      process.env.RAGNAROK_ALLOWED_HOSTS = "*.example.test";
      expect(() => loadConfig()).to.throw(/ALLOWED_HOSTS.*exact DNS names/i);
    });
  });

  describe("trusted proxy attribution", () => {
    it("uses the closest untrusted forwarded hop instead of a spoofable leftmost value", () => {
      const trusted = new Set(["127.0.0.1", "192.0.2.10"]);
      expect(resolveForwardedClientIp("127.0.0.1", "198.51.100.99, 203.0.113.7", trusted)).to.equal("203.0.113.7");
      expect(resolveForwardedClientIp("127.0.0.1", "203.0.113.7, 192.0.2.10", trusted)).to.equal("203.0.113.7");
    });

    it("ignores forwarded headers from an untrusted direct peer", () => {
      expect(resolveForwardedClientIp("203.0.113.10", "198.51.100.99", new Set(["127.0.0.1"]))).to.equal(
        "203.0.113.10",
      );
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
      sinon.restore();
    });

    it("should start and expose a /health endpoint", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/health`);

      expect(status).to.equal(200);
      expect(body).to.have.property("status", "ok");
      expect(body).to.have.property("version");
      expect(body).to.have.property("uptime").that.is.a("number");
    });

    it("records an MCP tool isError response as a failed audit outcome", async () => {
      const audit = sinon.spy(Logger.prototype, "info");
      const client = modernClient("audit-client");
      try {
        handle = await startHttpTransport(() => {
          const server = new McpServer({ name: "audit-server", version: "0.0.1" });
          server.registerTool(
            "fail_tool",
            { description: "Return a tool failure", inputSchema: z.object({}) },
            async () => {
              const result = {
                isError: true,
                content: [{ type: "text" as const, text: JSON.stringify({ error: "expected" }) }],
              };
              markMcpToolResult(result);
              return result;
            },
          );
          return server;
        }, createTestConfig());
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`)));
        const result = await client.callTool({ name: "fail_tool", arguments: {} });
        expect(result.isError).to.equal(true);
        const auditCalls = audit.getCalls().map((call) => call.args);
        expect(
          auditCalls.some(
            ([message, record]) =>
              message === "audit" &&
              (record as { method?: string; name?: string; outcome?: string })?.method === "tools/call" &&
              (record as { method?: string; name?: string; outcome?: string })?.name === "fail_tool" &&
              (record as { method?: string; name?: string; outcome?: string })?.outcome === "failed",
          ),
          JSON.stringify(auditCalls),
        ).to.equal(true);
      } finally {
        await client.close().catch(() => undefined);
        audit.restore();
      }
    });

    it("rejects forwarded HTTPS spoofing from a peer that is not explicitly trusted", async () => {
      handle = await startHttpTransport(
        testServerFactory(),
        createTestConfig({
          deploymentMode: "shared",
          apiKey: "reader-token-for-shared-mode-32-bytes",
          trustedProxies: ["192.0.2.10"],
        }),
      );
      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/health`, {
        headers: { "x-forwarded-proto": "https" },
      });
      expect(status).to.equal(400);
      expect(body.error.code).to.equal("TLS_REQUIRED");
    });

    it("refuses shared HTTP startup without an explicit Host allowlist", async () => {
      let failure: unknown;
      try {
        await startHttpTransport(
          testServerFactory(),
          createTestConfig({
            deploymentMode: "shared",
            apiKey: "reader-token-for-shared-mode-32-bytes",
            trustedProxies: ["127.0.0.1"],
            allowedHosts: [],
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.match(/requires at least one exact RAGNAROK_ALLOWED_HOSTS/);
    });

    it("accepts forwarded HTTPS only through the explicitly trusted direct proxy", async () => {
      handle = await startHttpTransport(
        testServerFactory(),
        createTestConfig({
          deploymentMode: "shared",
          apiKey: "reader-token-for-shared-mode-32-bytes",
          trustedProxies: ["127.0.0.1"],
        }),
      );
      const url = `http://127.0.0.1:${serverPort(handle)}/health`;
      expect((await httpRequest(url)).status).to.equal(400);
      expect((await httpRequest(url, { headers: { "x-forwarded-proto": "https" } })).status).to.equal(200);
    });

    it("enforces the shared public Host allowlist and accepts forwarded Host only from a trusted proxy", async () => {
      handle = await startHttpTransport(
        testServerFactory(),
        createTestConfig({
          deploymentMode: "shared",
          apiKey: "reader-token-for-shared-mode-32-bytes",
          trustedProxies: ["127.0.0.1"],
          allowedHosts: ["kb.example.test"],
        }),
      );
      const url = `http://127.0.0.1:${serverPort(handle)}/health`;
      expect(
        (
          await httpRequest(url, {
            headers: { host: "kb.example.test", "x-forwarded-proto": "https" },
          })
        ).status,
      ).to.equal(200);
      expect(
        (
          await httpRequest(url, {
            headers: { host: "evil.example.test", "x-forwarded-proto": "https" },
          })
        ).status,
      ).to.equal(403);
      expect(
        (
          await httpRequest(url, {
            headers: {
              host: "proxy.internal",
              "x-forwarded-host": "untrusted.example.test, kb.example.test",
              "x-forwarded-proto": "https",
            },
          })
        ).status,
      ).to.equal(200);
    });

    it("ignores X-Forwarded-Host from an untrusted direct peer", async () => {
      handle = await startHttpTransport(
        testServerFactory(),
        createTestConfig({
          allowedHosts: ["kb.example.test"],
          trustedProxies: ["192.0.2.10"],
        }),
      );
      const response = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/health`, {
        headers: { host: "evil.example.test", "x-forwarded-host": "kb.example.test" },
      });
      expect(response.status).to.equal(403);
      expect(response.body.error.code).to.equal("HOST_NOT_ALLOWED");
    });

    it("marks readiness unavailable after admission closes while health stays live", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      handle.closeAdmission();
      expect((await httpRequest(`http://127.0.0.1:${serverPort(handle)}/ready`)).status).to.equal(503);
      expect((await httpRequest(`http://127.0.0.1:${serverPort(handle)}/health`)).status).to.equal(200);
    });

    it("streams an owned chunked upload and rejects curator archive creation", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-http-transfer-"));
      const manager = new TransferManager(root, {
        maxFileBytes: 1024 * 1024,
        maxAggregateBytes: 2 * 1024 * 1024,
        maxSessionsPerPrincipal: 2,
        ttlMs: 5_000,
      });
      await manager.initialize();
      const curatorToken = "curator-transfer-token";
      const adminToken = "admin-transfer-token";
      handle = await startHttpTransport(
        testServerFactory(),
        createTestConfig({ writeApiKey: curatorToken, adminApiKey: adminToken }),
        { transferManager: manager },
      );
      const bytes = Buffer.from("# transferred");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const base = `http://127.0.0.1:${serverPort(handle)}`;
      const create = await httpRequest(`${base}/transfer/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${curatorToken}` },
        _body: JSON.stringify({
          kind: "document",
          filename: "notes.md",
          contentType: "text/markdown",
          size: bytes.length,
          sha256,
        }),
      });
      expect(create.status).to.equal(201);
      expect(JSON.stringify(create.body)).to.not.include(root);
      const put = await httpRequest(`${base}/${create.body.uploadEndpoint}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown", authorization: `Bearer ${curatorToken}` },
        _body: bytes,
      });
      expect(put.status).to.equal(200);
      const principal = `curator:${createHash("sha256").update(curatorToken).digest("hex").slice(0, 16)}`;
      const consumed = await manager.consumeUpload(principal, create.body.id, "document", (filePath) =>
        fs.readFile(filePath),
      );
      expect(consumed).to.deep.equal(bytes);

      for (const fixture of [
        {
          token: curatorToken,
          principal,
          kind: "document",
          filename: "sample.pdf",
          contentType: "application/pdf",
          bytes: Buffer.from("%PDF-1.4\ntransfer fixture"),
        },
        {
          token: adminToken,
          principal: `admin:${createHash("sha256").update(adminToken).digest("hex").slice(0, 16)}`,
          kind: "archive",
          filename: "topic.rag",
          contentType: "application/vnd.ragnarok.archive",
          bytes: Buffer.from("PK\u0003\u0004archive fixture"),
        },
      ]) {
        const fixtureDigest = createHash("sha256").update(fixture.bytes).digest("hex");
        const fixtureCreate = await httpRequest(`${base}/transfer/uploads`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${fixture.token}` },
          _body: JSON.stringify({
            kind: fixture.kind,
            filename: fixture.filename,
            contentType: fixture.contentType,
            size: fixture.bytes.length,
            sha256: fixtureDigest,
          }),
        });
        expect(fixtureCreate.status).to.equal(201);
        expect(
          (
            await httpRequest(`${base}/${fixtureCreate.body.uploadEndpoint}`, {
              method: "PUT",
              headers: { "content-type": fixture.contentType, authorization: `Bearer ${fixture.token}` },
              _body: fixture.bytes,
            })
          ).status,
        ).to.equal(200);
        const fixtureSize = await manager.consumeUpload(
          fixture.principal,
          fixtureCreate.body.id,
          fixture.kind as "document" | "archive",
          async (filePath) => (await fs.stat(filePath)).size,
        );
        expect(fixtureSize).to.equal(fixture.bytes.length);
      }

      const archive = await httpRequest(`${base}/transfer/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${curatorToken}` },
        _body: JSON.stringify({
          kind: "archive",
          filename: "topic.rag",
          contentType: "application/vnd.ragnarok.archive",
          size: 1,
          sha256: "0".repeat(64),
        }),
      });
      expect(archive.status).to.equal(403);
      await manager.dispose();
      await fs.rm(root, { recursive: true, force: true });
    });

    it("enforces the configured MCP JSON byte limit for chunked bodies", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ maxRequestBytes: 1024 }));
      const response = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        _body: JSON.stringify({ padding: "x".repeat(2_000) }),
      });
      expect(response.status).to.equal(413);
      expect(response.body.error.code).to.equal("REQUEST_TOO_LARGE");
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

    it("rejects an arbitrary browser Origin before creating a tokenless writer session", async () => {
      let createdServers = 0;
      handle = await startHttpTransport(
        () => {
          createdServers++;
          return testServerFactory()();
        },
        createTestConfig({ apiKey: "", writeApiKey: "" }),
      );

      const { status, body } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        _body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "attacker", version: "1.0.0" },
          },
        }),
      });

      expect(status).to.equal(403);
      expect(body).to.deep.equal({ error: "Origin not allowed" });
      expect(createdServers).to.equal(0);
    });

    it("rejects an untrusted CORS preflight before session handling", async () => {
      let createdServers = 0;
      handle = await startHttpTransport(() => {
        createdServers++;
        return testServerFactory()();
      }, createTestConfig());

      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });

      expect(status).to.equal(403);
      expect(createdServers).to.equal(0);
    });

    it("allows a loopback browser Origin under the safe default", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());

      const { status } = await httpRequest(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });

      expect(status).to.equal(204);
    });

    it("allows non-browser clients without an Origin header", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const client = modernClient("cli-client");
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).to.include("test_ping");
      await client.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent stateless requests
  // ---------------------------------------------------------------------------

  describe("concurrent stateless clients", () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
    });

    it("serves two concurrent clients independently", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);

      const clientA = modernClient("client-a");
      const clientB = modernClient("client-b");
      const transportA = new StreamableHTTPClientTransport(url);
      const transportB = new StreamableHTTPClientTransport(url);

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

    it("shutdown() closes modern exchanges and stops listening", async () => {
      handle = await startHttpTransport(testServerFactory(), createTestConfig());
      const port = serverPort(handle);
      const url = new URL(`http://127.0.0.1:${port}/mcp`);

      const client = modernClient("client");
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

    it("uses one absolute drain deadline and still closes active MCP handlers", async () => {
      const drainBudgetMs = 120;
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      let handlerClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        handlerClosed = resolve;
      });
      handle = await startHttpTransport(
        () => {
          const server = new McpServer({ name: "deadline-test", version: "0.0.1" });
          server.server.onclose = handlerClosed;
          server.registerTool(
            "wait",
            { description: "Wait until transport shutdown", inputSchema: z.object({}) },
            async (_args, ctx) => {
              handlerStarted();
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => reject(ctx.mcpReq.signal.reason ?? new Error("transport closed"));
                if (ctx.mcpReq.signal.aborted) {
                  onAbort();
                } else {
                  ctx.mcpReq.signal.addEventListener("abort", onAbort, { once: true });
                }
              });
              return { content: [{ type: "text", text: "unexpected" }] };
            },
          );
          return server;
        },
        createTestConfig({ shutdownDrainMs: drainBudgetMs }),
      );
      const client = modernClient("deadline-client");
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`)));
      const request = client.callTool({ name: "wait", arguments: {} }).catch(() => undefined);
      await started;

      const start = Date.now();
      const deadline = start + drainBudgetMs;
      await new Promise((resolve) => setTimeout(resolve, 90));
      await (handle.shutdown as (absoluteDeadline?: number) => Promise<void>)(deadline);
      const elapsed = Date.now() - start;
      handle = undefined;

      expect(elapsed).to.be.lessThan(190);
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP handler did not close")), 500)),
      ]);
      await request;
      await client.close().catch(() => undefined);
    });
  });

  describe("request controls and cancellation", () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      await handle?.shutdown();
      handle = undefined;
      sinon.restore();
    });

    it("applies one IP quota across changing routing headers and logs bounded diagnostics", async () => {
      const warnings = sinon.spy(Logger.prototype, "warn");
      handle = await startHttpTransport(testServerFactory(), createTestConfig({ rateLimitPerMinute: 2 }));
      const healthUrl = `http://127.0.0.1:${serverPort(handle)}/health`;
      const mcpUrl = `http://127.0.0.1:${serverPort(handle)}/mcp`;
      expect((await httpRequest(healthUrl)).status).to.equal(200);
      expect((await httpRequest(healthUrl)).status).to.equal(200);
      const modernMcpRequest = (method: string, name: string) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", "Mcp-Method": method, "Mcp-Name": name },
        _body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "rate-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const firstMcpResponse = await httpRequest(mcpUrl, modernMcpRequest("tools/list", "first"));
      expect(firstMcpResponse.status, JSON.stringify(firstMcpResponse.body)).to.equal(200);
      expect((await httpRequest(mcpUrl, modernMcpRequest("tools/list", "second"))).status).to.equal(200);
      const longMethod = "m".repeat(300);
      const longName = "n".repeat(300);
      expect((await httpRequest(mcpUrl, modernMcpRequest(longMethod, longName))).status).to.equal(429);
      expect(
        warnings.calledWith("MCP rate limit exceeded", {
          clientIp: "127.0.0.1",
          method: longMethod.slice(0, 256),
          name: longName.slice(0, 256),
        }),
      ).to.equal(true);
      warnings.restore();
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
        server.registerTool(
          "wait",
          { description: "Wait until cancelled", inputSchema: z.object({}) },
          async (_args, ctx) => {
            handlerStarted();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                handlerAborted = true;
                notifyHandlerAborted();
                reject(ctx.mcpReq.signal.reason ?? new Error("cancelled"));
              };
              if (ctx.mcpReq.signal.aborted) {
                onAbort();
              } else {
                ctx.mcpReq.signal.addEventListener("abort", onAbort, { once: true });
              }
            });
            return { content: [{ type: "text", text: "unexpected" }] };
          },
        );
        return server;
      }, createTestConfig());
      const client = modernClient("cancel-client");
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`)));
      const controller = new AbortController();
      const request = client.callTool({ name: "wait", arguments: {} }, { signal: controller.signal });
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
      sinon.restore();
    });

    it("should return a sanitized bearer challenge when authentication fails", async () => {
      const config = createTestConfig({ apiKey: TEST_API_KEY });
      handle = await startHttpTransport(testServerFactory(), config);

      const response = await fetch(`http://127.0.0.1:${serverPort(handle)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).to.equal(401);
      expect(response.headers.get("www-authenticate")).to.equal('Bearer realm="ragnarok"');
      expect(await response.text()).not.to.include(config.apiKey);
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

    it("isolates reader, curator, and admin facades per request, audits calls, and applies rotations immediately", async () => {
      const readToken = "reader-token-123";
      const curatorToken = "curator-token-456";
      const adminToken = "admin-token-789";
      const audit = sinon.spy(Logger.prototype, "info");
      handle = await startHttpTransport(
        roleAwareServerFactory(),
        createTestConfig({
          deploymentMode: "shared",
          apiKey: readToken,
          writeApiKey: curatorToken,
          adminApiKey: adminToken,
          trustedProxies: ["127.0.0.1"],
        }),
      );
      const url = new URL(`http://127.0.0.1:${serverPort(handle)}/mcp`);
      const requestHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, "x-forwarded-proto": "https" });
      const listTools = async (name: string, token: string): Promise<string[]> => {
        const client = modernClient(name);
        await client.connect(
          new StreamableHTTPClientTransport(url, { requestInit: { headers: requestHeaders(token) } }),
        );
        try {
          return (await client.listTools()).tools.map((tool) => tool.name);
        } finally {
          await client.close();
        }
      };

      expect(await listTools("reader", readToken)).to.deep.equal(["rag_list_topics"]);
      expect(await listTools("curator", curatorToken)).to.deep.equal(["rag_list_topics", "rag_create_topic"]);
      expect(await listTools("admin", adminToken)).to.deep.equal([
        "rag_list_topics",
        "rag_create_topic",
        "rag_export_topic",
      ]);
      expect(await listTools("reader-after-admin", readToken)).to.deep.equal(["rag_list_topics"]);

      const reader = modernClient("audit-reader");
      await reader.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: requestHeaders(readToken) } }),
      );
      await reader.callTool({ name: "rag_list_topics", arguments: {} });
      await reader.close();
      const expectedPrincipal = `reader:${createHash("sha256").update(readToken).digest("hex").slice(0, 16)}`;
      const record = audit
        .getCalls()
        .map((call) => call.args)
        .find(
          ([message, candidate]) =>
            message === "audit" &&
            (candidate as { method?: string; name?: string })?.method === "tools/call" &&
            (candidate as { method?: string; name?: string })?.name === "rag_list_topics",
        )?.[1] as Record<string, unknown> | undefined;
      expect(record).to.include({
        principal: expectedPrincipal,
        role: "reader",
        method: "tools/call",
        name: "rag_list_topics",
        outcome: "success",
      });
      expect(record?.correlationId).to.be.a("string").and.not.empty;

      const nextReadToken = "reader-token-rotated";
      await handle.rotateTokens({ reader: nextReadToken }, "reader");
      const modernRequest = async (requestToken: string): Promise<Response> =>
        fetch(url, {
          method: "POST",
          headers: {
            ...requestHeaders(requestToken),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "rotation-test", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
      expect((await modernRequest(readToken)).status).to.equal(401);
      expect((await modernRequest(nextReadToken)).status).to.equal(200);
      audit.restore();
    });
  });
});
