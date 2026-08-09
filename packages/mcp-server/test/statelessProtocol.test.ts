import { expect } from "chai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../src/httpServer";
import type { McpConfig } from "../src/config";
import { registerGraphUiResource } from "../src/uiResource";

const token = "stateless-test-token";

type RequestMutation = (headers: Headers, body: any) => void;

async function rewriteRequest(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  mutate: RequestMutation,
): Promise<Response> {
  const original = new Request(input, init);
  const body = await original.clone().json();
  const headers = new Headers(original.headers);
  mutate(headers, body);
  return fetch(
    new Request(original, {
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function expectProtocolError(action: () => Promise<unknown>, code: number): Promise<void> {
  let observed: unknown;
  try {
    await action();
  } catch (error) {
    observed = error;
  }
  expect(observed).to.be.instanceOf(Error);
  expect((observed as { code?: number }).code).to.equal(code);
}

function testConfig(): McpConfig {
  return {
    storageDir: "/tmp/ragnarok-stateless-test",
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
    port: 0,
    llmProvider: "none",
    llmApiKey: "",
    llmModel: "",
    llmBaseUrl: "",
    embeddingProvider: "huggingface",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    apiKey: token,
    writeApiKey: "",
    corsOrigin: "loopback",
    httpHost: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "::1"],
    rerankerModel: "test-reranker",
    rerankerEnabled: false,
    rerankerMaxCandidates: 20,
    rerankerCandidateMultiplier: 4,
    queryMemoryEnabled: false,
    rateLimitPerMinute: 1_000,
    exportDir: "/tmp/ragnarok-stateless-exports",
    githubHosts: ["github.com"],
    githubToken: "",
    resetStorage: false,
  };
}

function makeClient(url: URL, token: string, fetchFn: typeof fetch = fetch) {
  const client = new Client(
    { name: "ragnarok-stateless-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: fetchFn,
  });
  return { client, transport };
}

function fixtureServer(): McpServer {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  server.registerTool("fixture_echo", { inputSchema: z.object({ value: z.string() }) }, async ({ value }) => ({
    content: [{ type: "text", text: value }],
  }));
  server.registerTool(
    "fixture_header",
    {
      inputSchema: z.object({
        tenant: z.string().meta({ "x-mcp-header": "Tenant" }),
      }),
    },
    async ({ tenant }) => ({ content: [{ type: "text", text: tenant }] }),
  );
  server.registerTool("fixture_requires_elicitation", { inputSchema: z.object({}) }, async () =>
    inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: "Confirm fixture",
          requestedSchema: z.object({ confirm: z.boolean() }),
        }),
      },
    }),
  );
  server.registerPrompt("fixture_prompt", { argsSchema: z.object({}) }, async () => ({
    messages: [{ role: "user", content: { type: "text", text: "fixture" } }],
  }));
  server.registerResource("fixture_resource", "fixture://cache", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
  }));
  registerGraphUiResource(server);
  return server;
}

const modernEnvelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-conformance-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function postModern(endpoint: URL, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("stateless modern MCP protocol", function () {
  this.timeout(30_000);

  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
  });

  it("serves pinned modern clients without session headers or session methods", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const observedResponseHeaders: Headers[] = [];
    const observingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      observedResponseHeaders.push(new Headers(response.headers));
      return response;
    };
    const { client, transport } = makeClient(endpoint, token, observingFetch);

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).to.equal("modern");
      expect((await client.listTools()).tools.map(({ name }) => name)).to.include("fixture_echo");
      expect(observedResponseHeaders.some((headers) => headers.has("mcp-session-id"))).to.equal(false);

      const getResponse = await fetch(endpoint, { method: "GET" });
      const deleteResponse = await fetch(endpoint, { method: "DELETE" });
      expect(getResponse.status).to.equal(405);
      expect(deleteResponse.status).to.equal(405);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("rejects legacy initialize with the unsupported protocol version error", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    });
    const body = (await response.json()) as { error?: { code?: number } };

    expect(body.error?.code).to.equal(-32022);
  });

  it("accepts a valid modern envelope without MCP-Protocol-Version because the SDK treats it as a cross-check", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const response = await postModern(
      endpoint,
      { jsonrpc: "2.0", id: 901, method: "server/discover", params: { _meta: modernEnvelope } },
      { "Mcp-Method": "server/discover" },
    );

    expect(response.status).to.equal(200);
    expect(response.body).to.have.property("id", 901);
    expect(response.body).to.have.deep.nested.property("result.supportedVersions", ["2026-07-28"]);
  });

  it("returns the SDK's exact invalid-params response for a malformed modern envelope", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const response = await postModern(
      endpoint,
      {
        jsonrpc: "2.0",
        id: 902,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": modernEnvelope["io.modelcontextprotocol/clientInfo"],
          },
        },
      },
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    );

    expect(response).to.deep.equal({
      status: 400,
      body: {
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message:
            "Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing",
          data: { envelope: { key: "io.modelcontextprotocol/clientCapabilities", problem: "missing" } },
        },
        id: 902,
      },
    });
  });

  it("returns the SDK's exact header-mismatch response when protocol versions disagree", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const mismatchDescription =
      "the body envelope names protocol version 2026-07-28 but the MCP-Protocol-Version header names 2025-11-25";
    const response = await postModern(
      endpoint,
      { jsonrpc: "2.0", id: 903, method: "tools/list", params: { _meta: modernEnvelope } },
      { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/list" },
    );

    expect(response).to.deep.equal({
      status: 400,
      body: {
        jsonrpc: "2.0",
        error: {
          code: -32020,
          message: `Bad Request: the request headers and body disagree: ${mismatchDescription}`,
          data: { mismatch: { header: "2025-11-25", body: mismatchDescription } },
        },
        id: 903,
      },
    });
  });

  it("advertises private zero-TTL caching on every cacheable modern response", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const wireResults: any[] = [];
    const observingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        wireResults.push(await response.clone().json());
      }
      return response;
    };
    const { client, transport } = makeClient(endpoint, token, observingFetch);

    try {
      await client.connect(transport);
      await client.listTools();
      await client.listPrompts();
      await client.listResources();
      await client.listResourceTemplates();
      await client.readResource({ uri: "fixture://cache" });

      expect(wireResults).to.have.length(6);
      for (const result of wireResults) {
        expect(result.result.ttlMs).to.equal(0);
        expect(result.result.cacheScope).to.equal("private");
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("serves resources/list and resources/read through the graph visualization protocol", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const { client, transport } = makeClient(endpoint, token);

    try {
      await client.connect(transport);
      const resources = (await client.listResources(undefined, { cacheMode: "refresh" })).resources;
      expect(resources).to.deep.include({
        name: "ragnarok-graph",
        uri: "ui://ragnarok/graph",
        description: "Interactive graph visualization for RAGnarōk knowledge and memory graphs.",
        mimeType: "text/html;profile=mcp-app",
        annotations: { audience: ["user"], priority: 1 },
      });

      const read = await client.readResource({ uri: "ui://ragnarok/graph" });
      expect(read.contents).to.have.length(1);
      const resource = read.contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(resource).to.include({
        uri: "ui://ragnarok/graph",
        mimeType: "text/html;profile=mcp-app",
      });
      expect(resource.text).to.be.a("string").and.not.equal("");
      expect(resource.text).to.include("data-ragnarok-graph-app");
      expect(resource.text).to.include("<svg");
      expect(resource.text).to.include('id="reset-view"');
      expect(resource.text).not.to.match(/<script\s+[^>]*src\s*=/i);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("serializes sorted catalogs identically across requests and fresh servers", async () => {
    const snapshots: Array<[string, string, string, string]> = [];

    for (let serverIndex = 0; serverIndex < 2; serverIndex += 1) {
      handle = await startHttpTransport(fixtureServer, testConfig());
      const address = handle.httpServer.address() as { port: number };
      const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
      const { client, transport } = makeClient(endpoint, token);

      try {
        await client.connect(transport);
        for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
          const tools = await client.listTools(undefined, { cacheMode: "refresh" });
          const prompts = await client.listPrompts(undefined, { cacheMode: "refresh" });
          const resources = await client.listResources(undefined, { cacheMode: "refresh" });
          const resourceTemplates = await client.listResourceTemplates(undefined, { cacheMode: "refresh" });
          snapshots.push([
            JSON.stringify(tools.tools),
            JSON.stringify(prompts.prompts),
            JSON.stringify(resources.resources),
            JSON.stringify(resourceTemplates.resourceTemplates),
          ]);

          const toolNames = tools.tools.map(({ name }) => name);
          expect(toolNames).to.deep.equal([...toolNames].sort());
        }
      } finally {
        await client.close().catch(() => undefined);
        await handle.shutdown();
        handle = undefined;
      }
    }

    for (let catalogIndex = 0; catalogIndex < snapshots[0].length; catalogIndex += 1) {
      expect(snapshots.map((snapshot) => snapshot[catalogIndex])).to.deep.equal(
        Array(snapshots.length).fill(snapshots[0][catalogIndex]),
      );
    }
  });

  it("enforces SDK routing headers, protocol versions, parameter headers, capabilities, and resource misses", async () => {
    handle = await startHttpTransport(fixtureServer, testConfig());
    const address = handle.httpServer.address() as { port: number };
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    let mutation: RequestMutation | undefined;
    let responseStatus: number | undefined;
    const mutatingFetch: typeof fetch = async (input, init) => {
      const response = mutation ? await rewriteRequest(input, init, mutation) : await fetch(input, init);
      responseStatus = response.status;
      return response;
    };
    const { client, transport } = makeClient(endpoint, token, mutatingFetch);
    const rejected = async (mutate: RequestMutation, action: () => Promise<unknown>, code: number) => {
      mutation = mutate;
      try {
        await expectProtocolError(action, code);
        expect(responseStatus).to.equal(400);
      } finally {
        mutation = undefined;
      }
    };

    try {
      await client.connect(transport);

      await rejected(
        (headers) => headers.delete("Mcp-Method"),
        () => client.listPrompts(undefined, { cacheMode: "refresh" }),
        -32020,
      );
      await rejected(
        (headers) => headers.set("Mcp-Method", "resources/read"),
        () => client.listPrompts(undefined, { cacheMode: "refresh" }),
        -32020,
      );
      await rejected(
        (headers) => headers.delete("Mcp-Name"),
        () => client.getPrompt({ name: "fixture_prompt" }),
        -32020,
      );
      await rejected(
        (headers) => headers.set("Mcp-Name", "another_tool"),
        () => client.getPrompt({ name: "fixture_prompt" }),
        -32020,
      );
      await rejected(
        (headers, body) => {
          headers.set("MCP-Protocol-Version", "2099-01-01");
          body.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
        },
        () => client.listPrompts(undefined, { cacheMode: "refresh" }),
        -32022,
      );

      await client.listTools(undefined, { cacheMode: "refresh" });
      await rejected(
        (headers, body) => {
          if (body.method === "tools/call") {
            headers.delete("Mcp-Param-Tenant");
          }
        },
        () => client.callTool({ name: "fixture_header", arguments: { tenant: "alpha" } }),
        -32020,
      );
      await rejected(
        (headers, body) => {
          if (body.method === "tools/call") {
            headers.set("Mcp-Param-Tenant", "beta");
          }
        },
        () => client.callTool({ name: "fixture_header", arguments: { tenant: "alpha" } }),
        -32020,
      );

      await expectProtocolError(() => client.callTool({ name: "fixture_requires_elicitation", arguments: {} }), -32021);
      expect(responseStatus).to.equal(400);
      await expectProtocolError(() => client.readResource({ uri: "fixture://missing" }), -32602);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
