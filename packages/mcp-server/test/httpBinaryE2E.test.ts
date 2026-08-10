/**
 * Shared-deployment e2e over the real binary (`--http` + auth tokens):
 * - unauthenticated requests are rejected;
 * - memory tools are structurally absent for reader AND writer sessions;
 * - write tools are absent for readers, present for writers;
 * - every tool description carries the "[Team shared KB]" prefix and the
 *   server advertises shared-KB instructions;
 * - SIGTERM produces exit code 0 with no native-abort traces (MB-2, HTTP path).
 */
import { expect } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioHarness } from "./helpers/stdioHarness";

const READ_TOKEN = "e2e-read-token-32-bytes-minimum-value";
const WRITE_TOKEN = "e2e-write-token-32-bytes-minimum-value";
const ADMIN_TOKEN = "e2e-admin-token-32-bytes-minimum-value";

const READER_TOOLS = [
  "rag_embedding_info",
  "rag_list_documents",
  "rag_list_embedding_models",
  "rag_list_reranker_models",
  "rag_list_topics",
  "rag_llm_status",
  "rag_query",
  "rag_reranker_info",
  "rag_storage_status",
  "rag_topic_stats",
];
const CURATOR_TOOLS = [
  ...READER_TOOLS,
  "rag_add_github_repo",
  "rag_add_url",
  "rag_create_document_upload",
  "rag_create_topic",
  "rag_delete_topic",
  "rag_ingest_upload",
  "rag_remove_document",
  "rag_rename_topic",
];
const ADMIN_TOOLS = [
  ...CURATOR_TOOLS,
  "rag_create_archive_upload",
  "rag_export_topic",
  "rag_import_upload",
  "rag_switch_embedding_model",
  "rag_switch_reranker_model",
];

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { "x-forwarded-proto": "https" },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`/ready did not come up on port ${port} within ${timeoutMs}ms`);
}

function authedClient(port: number, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "x-forwarded-proto": "https" } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      expect(response.headers.has("mcp-session-id"), "HTTP response must not carry Mcp-Session-Id").to.equal(false);
      return response;
    },
  });
  const client = new Client(
    { name: "http-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  return { client, transport };
}

describe("shared-mode HTTP E2E (real binary)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;
  let harness: StdioHarness | undefined;
  let port: number;

  before(async function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-work-"));
    port = await getFreePort();
    harness = new StdioHarness(
      storageDir,
      workDir,
      {
        RAGNAROK_PORT: String(port),
        RAGNAROK_DEPLOYMENT_MODE: "shared",
        RAGNAROK_API_KEY: READ_TOKEN,
        RAGNAROK_WRITE_API_KEY: WRITE_TOKEN,
        RAGNAROK_ADMIN_API_KEY: ADMIN_TOKEN,
        RAGNAROK_TRUSTED_PROXIES: "127.0.0.1",
        RAGNAROK_ALLOWED_HOSTS: "127.0.0.1",
        RAGNAROK_RERANKER_ENABLED: "false",
      },
      ["--http"],
    );
    await waitForReady(port, 60000);
  });

  after(async function () {
    if (harness && harness.proc.exitCode === null) {
      harness.proc.kill("SIGTERM");
      await harness.waitForExit(20000).catch(() => harness!.proc.kill("SIGKILL"));
    }
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated requests", async function () {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).to.equal(401);
    expect(response.headers.get("www-authenticate")).to.equal('Bearer realm="ragnarok"');
    expect(await response.text()).not.to.include(READ_TOKEN);
  });

  it("serves a memory-free, prefixed, role-scoped tool surface", async function () {
    const reader = authedClient(port, READ_TOKEN);
    await reader.client.connect(reader.transport);
    try {
      const readerTools = (await reader.client.listTools()).tools;
      const readerNames = readerTools.map((t) => t.name).sort();

      expect(readerNames).to.deep.equal([...READER_TOOLS].sort());
      expect(readerNames, "memory tools must be absent in shared mode").to.not.include("rag_memory");
      expect(readerNames).to.not.include("rag_reset_memory");
      expect(readerNames, "write tools must be absent for readers").to.not.include("rag_create_topic");
      for (const tool of readerTools) {
        expect(tool.description ?? "", `description of ${tool.name}`).to.match(/^\[Team shared KB\] /);
      }
      const instructions = reader.client.getInstructions() ?? "";
      expect(instructions.toLowerCase()).to.include("team shared knowledge base");
    } finally {
      await reader.client.close();
    }

    const curator = authedClient(port, WRITE_TOKEN);
    await curator.client.connect(curator.transport);
    try {
      const curatorNames = (await curator.client.listTools()).tools.map((t) => t.name).sort();
      expect(curatorNames).to.deep.equal([...CURATOR_TOOLS].sort());
      expect(curatorNames, "memory tools are absent for EVERY role in shared mode").to.not.include("rag_memory");
      expect(curatorNames, "curators cannot administer models or archives").to.not.include("rag_export_topic");
    } finally {
      await curator.client.close();
    }

    const admin = authedClient(port, ADMIN_TOKEN);
    await admin.client.connect(admin.transport);
    try {
      expect((await admin.client.listTools()).tools.map((t) => t.name).sort()).to.deep.equal([...ADMIN_TOOLS].sort());
    } finally {
      await admin.client.close();
    }
  });

  it("proves the graph UI resource stays while the graph tool is absent from shared deployments", async function () {
    const reader = authedClient(port, READ_TOKEN);
    const curator = authedClient(port, WRITE_TOKEN);
    await reader.client.connect(reader.transport);
    await curator.client.connect(curator.transport);
    try {
      // Memory is always personal, so the graph tool is structurally absent from
      // a shared deployment for every role — not merely gated behind an error.
      const readerTools = (await reader.client.listTools(undefined, { cacheMode: "refresh" })).tools;
      expect(readerTools.map(({ name }) => name)).not.to.include("rag_graph_visualize");
      const curatorTools = (await curator.client.listTools(undefined, { cacheMode: "refresh" })).tools;
      expect(curatorTools.map(({ name }) => name)).not.to.include("rag_graph_visualize");

      for (const { client, label } of [
        { client: reader.client, label: "reader" },
        { client: curator.client, label: "curator" },
      ]) {
        for (const arguments_ of [
          { source: "memory", memoryScope: "workspace" },
          { source: "memory", memoryScope: "branch", branch: "feature/protocol" },
        ]) {
          let absentToolCall: unknown;
          try {
            await client.callTool({ name: "rag_graph_visualize", arguments: arguments_ });
          } catch (error) {
            absentToolCall = error;
          }
          expect(absentToolCall, `${label} ${JSON.stringify(arguments_)}`).to.be.instanceOf(Error);
          expect((absentToolCall as { code?: number }).code).to.equal(-32602);
        }
      }

      // The MCP App resource is registered unconditionally so hosts can render a
      // graph document produced by a local deployment.
      const resources = (await curator.client.listResources(undefined, { cacheMode: "refresh" })).resources;
      expect(resources).to.deep.include({
        name: "ragnarok-graph",
        uri: "ui://ragnarok/graph",
        description: "Interactive graph visualization for RAGnarōk memory graphs.",
        mimeType: "text/html;profile=mcp-app",
        annotations: { audience: ["user"], priority: 1 },
      });
      const read = await curator.client.readResource({ uri: "ui://ragnarok/graph" });
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
      await Promise.allSettled([reader.client.close(), curator.client.close()]);
    }
  });

  it("ingests, queries, exports, downloads, and reimports through owned shared transfers", async function () {
    const curator = authedClient(port, WRITE_TOKEN);
    const reader = authedClient(port, READ_TOKEN);
    const admin = authedClient(port, ADMIN_TOKEN);
    await curator.client.connect(curator.transport);
    await reader.client.connect(reader.transport);
    await admin.client.connect(admin.transport);
    try {
      const created = await curator.client.callTool({
        name: "rag_create_topic",
        arguments: { name: "shared-transfer-flow", description: "real HTTP transfer qualification" },
      });
      expect(created.isError, JSON.stringify(created)).not.to.equal(true);

      const document = Buffer.from(
        "# Shared transfer\n\nThe Meridian relay authenticates navigation with a silver astrolabe.\n",
        "utf8",
      );
      const documentDigest = createHash("sha256").update(document).digest("hex");
      const uploadResult = await curator.client.callTool({
        name: "rag_create_document_upload",
        arguments: {
          filename: "shared-facts.md",
          contentType: "text/markdown",
          size: document.byteLength,
          sha256: documentDigest,
        },
      });
      expect(uploadResult.isError, JSON.stringify(uploadResult)).not.to.equal(true);
      const upload = JSON.parse((uploadResult.content as Array<{ text: string }>)[0].text);

      const crossPrincipal = await fetch(`http://127.0.0.1:${port}/${upload.uploadEndpoint}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "text/markdown",
          "x-forwarded-proto": "https",
        },
        body: document,
      });
      expect(crossPrincipal.status, "upload handles must be principal-bound").to.equal(404);

      const put = await fetch(`http://127.0.0.1:${port}/${upload.uploadEndpoint}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${WRITE_TOKEN}`,
          "content-type": "text/markdown",
          "x-forwarded-proto": "https",
        },
        body: document,
      });
      expect(put.status).to.equal(200);

      const ingested = await curator.client.callTool({
        name: "rag_ingest_upload",
        arguments: { topic: "shared-transfer-flow", uploadId: upload.id },
      });
      expect(ingested.isError, JSON.stringify(ingested)).not.to.equal(true);
      const replay = await curator.client.callTool({
        name: "rag_ingest_upload",
        arguments: { topic: "shared-transfer-flow", uploadId: upload.id },
      });
      expect(replay.isError, "upload handles must be single-use").to.equal(true);

      // Shared deployments must never leak server filesystem paths in tool output.
      const listedDocuments = await reader.client.callTool({
        name: "rag_list_documents",
        arguments: { topic: "shared-transfer-flow" },
      });
      expect(listedDocuments.isError, JSON.stringify(listedDocuments)).not.to.equal(true);
      const listedText = JSON.stringify(listedDocuments);
      expect(listedText).to.include("[server-managed]");
      expect(listedText).not.to.include(storageDir);
      expect(listedText).not.to.include(workDir);

      for (const retrievalStrategy of ["vector", "hybrid", "bm25"]) {
        const queried = await reader.client.callTool({
          name: "rag_query",
          arguments: {
            topic: "shared-transfer-flow",
            query: "How does the Meridian relay authenticate navigation?",
            retrievalStrategy,
            topK: 3,
          },
        });
        expect(queried.isError, `${retrievalStrategy}: ${JSON.stringify(queried)}`).not.to.equal(true);
        expect(JSON.stringify(queried).toLowerCase(), retrievalStrategy).to.include("silver astrolabe");
      }

      const exported = await admin.client.callTool({
        name: "rag_export_topic",
        arguments: { topic: "shared-transfer-flow" },
      });
      expect(exported.isError, JSON.stringify(exported)).not.to.equal(true);
      const exportPayload = JSON.parse((exported.content as Array<{ text: string }>)[0].text);
      const transfer = exportPayload.transfer;
      expect(transfer.downloadEndpoint).to.match(/^transfer\/downloads\//);

      const crossDownload = await fetch(`http://127.0.0.1:${port}/${transfer.downloadEndpoint}`, {
        headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "x-forwarded-proto": "https" },
      });
      expect(crossDownload.status, "download handles must be principal-bound").to.equal(404);
      const download = await fetch(`http://127.0.0.1:${port}/${transfer.downloadEndpoint}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "x-forwarded-proto": "https" },
      });
      expect(download.status).to.equal(200);
      const archive = Buffer.from(await download.arrayBuffer());
      expect(archive.byteLength).to.equal(transfer.size);
      expect(createHash("sha256").update(archive).digest("hex")).to.equal(transfer.sha256);

      const deleted = await curator.client.callTool({
        name: "rag_delete_topic",
        arguments: { topic: "shared-transfer-flow", confirm: true },
      });
      expect(deleted.isError, JSON.stringify(deleted)).not.to.equal(true);

      const archiveUploadResult = await admin.client.callTool({
        name: "rag_create_archive_upload",
        arguments: {
          filename: "shared-transfer-flow.rag",
          contentType: "application/vnd.ragnarok.archive",
          size: archive.byteLength,
          sha256: transfer.sha256,
        },
      });
      expect(archiveUploadResult.isError, JSON.stringify(archiveUploadResult)).not.to.equal(true);
      const archiveUpload = JSON.parse((archiveUploadResult.content as Array<{ text: string }>)[0].text);
      const archivePut = await fetch(`http://127.0.0.1:${port}/${archiveUpload.uploadEndpoint}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/vnd.ragnarok.archive",
          "x-forwarded-proto": "https",
        },
        body: archive,
      });
      expect(archivePut.status).to.equal(200);
      const imported = await admin.client.callTool({
        name: "rag_import_upload",
        arguments: { uploadId: archiveUpload.id, confirm: true },
      });
      expect(imported.isError, JSON.stringify(imported)).not.to.equal(true);

      const restored = await reader.client.callTool({
        name: "rag_query",
        arguments: { topic: "shared-transfer-flow", query: "What navigation artifact is used?", topK: 3 },
      });
      expect(restored.isError, JSON.stringify(restored)).not.to.equal(true);
      expect(JSON.stringify(restored).toLowerCase()).to.include("silver astrolabe");
    } finally {
      await Promise.allSettled([curator.client.close(), reader.client.close(), admin.client.close()]);
    }
  });

  it("exits 0 on SIGTERM with no native-abort traces (MB-2, HTTP path)", async function () {
    if (process.platform === "win32") {
      this.skip(); // SIGTERM-graceful-shutdown is not emulatable on Windows
    }
    expect(harness!.stderrText).to.include("audit");
    expect(harness!.stderrText).to.match(/role: '(reader|curator|admin)'/);
    expect(harness!.stderrText).to.match(/method: 'tools\/call'/);
    expect(harness!.stderrText).to.match(/name: 'rag_[a-z_]+'/);
    expect(harness!.stderrText).to.match(/outcome: 'success'/);
    expect(harness!.stderrText).to.match(/outcome: 'failed'/);
    expect(harness!.stderrText).to.not.include(READ_TOKEN);
    expect(harness!.stderrText).to.not.include(WRITE_TOKEN);
    expect(harness!.stderrText).to.not.include(ADMIN_TOKEN);
    harness!.proc.kill("SIGTERM");
    const exitCode = await harness!.waitForExit(20000);
    expect(exitCode, `stderr: ${harness!.stderrText.slice(-500)}`).to.equal(0);
    expect(harness!.stderrText).to.not.match(/SIGABRT|mutex lock failed|libc\+\+abi/);
    harness = undefined;
  });
});
