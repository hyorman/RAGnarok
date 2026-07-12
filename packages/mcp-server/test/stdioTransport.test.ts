/**
 * Stdio transport E2E test.
 *
 * Launches the built server (dist/index.js) as a real child process, completes
 * an MCP initialize → initialized → tools/list handshake over stdio, and
 * asserts that stdout carried ONLY JSON-RPC protocol frames. Any diagnostic
 * text on stdout corrupts the protocol stream for strict clients.
 *
 * Skips when dist/index.js has not been built (run `npm run build` first;
 * `npm run test:all` at the repo root builds before testing).
 */
import { expect } from "chai";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import AdmZip from "adm-zip";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ENTRY = path.join(PACKAGE_ROOT, "dist", "index.js");

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: any;
  error?: any;
}

class StdioHarness {
  proc: ChildProcess;
  private buffer = "";
  readonly messages: JsonRpcMessage[] = [];
  readonly nonProtocolLines: string[] = [];
  private waiters: Array<{ predicate: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];

  constructor(storageDir: string, allowedDir: string, overrides: Record<string, string> = {}) {
    // Scrub developer RAGNAROK_* config so the test is deterministic.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RAGNAROK_")));
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...env,
        RAGNAROK_STORAGE_DIR: storageDir,
        RAGNAROK_WORKING_DIR: allowedDir,
        RAGNAROK_ALLOWED_PATHS: allowedDir,
        ...overrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // stderr is the designated diagnostics channel; drain and ignore.
    this.proc.stderr!.on("data", () => {});
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (w.predicate(msg)) {
            w.resolve(msg);
            return false;
          }
          return true;
        });
      } catch {
        this.nonProtocolLines.push(line);
      }
    }
  }

  send(msg: object): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  waitFor(predicate: (m: JsonRpcMessage) => boolean, timeoutMs: number): Promise<JsonRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for message`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async callTool(id: number, name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<JsonRpcMessage> {
    this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return this.waitFor((message) => message.id === id, timeoutMs);
  }

  dispose(): void {
    this.proc.stdin?.end();
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return this.proc.exitCode;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.proc.kill();
        reject(new Error("Timed out waiting for the stdio server to shut down"));
      }, 15000);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.stdin?.end();
    });
  }
}

describe("stdio transport E2E", function () {
  // Server startup loads config + topic manager; allow headroom.
  this.timeout(120000);

  let harness: StdioHarness | undefined;
  let storageDir: string;
  let sourceDir: string;

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping stdio E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-stdio-e2e-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-source-e2e-"));
  });

  after(async function () {
    if (harness) {
      try {
        await harness.close();
      } catch {
        harness.proc.kill();
      }
    }
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    if (sourceDir) {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("completes initialize + tools/list with a protocol-clean stdout", async function () {
    harness = new StdioHarness(storageDir, sourceDir);

    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-e2e", version: "1.0.0" },
      },
    });

    const initResponse = await harness.waitFor((m) => m.id === 1, 20000);
    expect(initResponse.error, "initialize returned an error").to.equal(undefined);
    expect(initResponse.result?.serverInfo?.name).to.equal("ragnarok");

    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    harness.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const toolsResponse = await harness.waitFor((m) => m.id === 2, 10000);
    expect(toolsResponse.error, "tools/list returned an error").to.equal(undefined);
    expect(toolsResponse.result?.tools).to.be.an("array").with.length.greaterThan(0);
    const listedTools = toolsResponse.result?.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    expect(listedTools.find((tool) => tool.name === "rag_list_documents")?.annotations?.readOnlyHint).to.equal(true);
    expect(listedTools.find((tool) => tool.name === "rag_delete_topic")?.annotations?.destructiveHint).to.equal(true);
    expect(listedTools.find((tool) => tool.name === "rag_add_url")?.annotations?.openWorldHint).to.equal(true);

    expect(
      harness.nonProtocolLines,
      `stdout must carry only JSON-RPC frames; got: ${harness.nonProtocolLines.slice(0, 3).join(" | ")}`,
    ).to.deep.equal([]);

    const sourcePath = path.join(sourceDir, "release-facts.md");
    fs.writeFileSync(
      sourcePath,
      "# RAGnarok release facts\n\nThe Aurora protocol uses a violet compass for deterministic navigation.\n",
      "utf8",
    );

    const createResponse = await harness.callTool(3, "rag_create_topic", {
      name: "stdio-flow",
      description: "Real-process ingestion and query verification",
    });
    expect(createResponse.error, "rag_create_topic returned a protocol error").to.equal(undefined);
    expect(createResponse.result?.isError, JSON.stringify(createResponse.result)).not.to.equal(true);

    const ingestResponse = await harness.callTool(
      4,
      "rag_add_documents",
      { topic: "stdio-flow", filePaths: [sourcePath] },
      60000,
    );
    expect(ingestResponse.error, "rag_add_documents returned a protocol error").to.equal(undefined);
    expect(ingestResponse.result?.isError, JSON.stringify(ingestResponse.result)).not.to.equal(true);
    const ingestPayload = JSON.parse(ingestResponse.result?.content?.[0]?.text ?? "{}");
    expect(ingestPayload.documentsAdded, JSON.stringify(ingestPayload)).to.equal(1);

    const documentsResponse = await harness.callTool(5, "rag_list_documents", { topic: "stdio-flow" });
    expect(documentsResponse.result?.isError, JSON.stringify(documentsResponse.result)).not.to.equal(true);
    const documentsPayload = JSON.parse(documentsResponse.result?.content?.[0]?.text ?? "{}");
    expect(documentsPayload.documents).to.have.length(1);
    expect(documentsPayload.documents[0].documentId).to.match(/^doc-[a-f0-9]{64}$/);

    const queryResponse = await harness.callTool(
      6,
      "rag_query",
      { topic: "stdio-flow", query: "What color and object does the Aurora protocol use?", topK: 3 },
      60000,
    );
    expect(queryResponse.error, "rag_query returned a protocol error").to.equal(undefined);
    expect(queryResponse.result?.isError, JSON.stringify(queryResponse.result)).not.to.equal(true);
    const queryText = queryResponse.result?.content?.[0]?.text ?? "";
    expect(queryText.toLowerCase()).to.include("violet compass");

    const reingestResponse = await harness.callTool(
      7,
      "rag_add_documents",
      { topic: "stdio-flow", filePaths: [sourcePath] },
      60000,
    );
    expect(reingestResponse.result?.isError, JSON.stringify(reingestResponse.result)).not.to.equal(true);

    const reingestedDocuments = await harness.callTool(8, "rag_list_documents", { topic: "stdio-flow" });
    const reingestedPayload = JSON.parse(reingestedDocuments.result?.content?.[0]?.text ?? "{}");
    expect(reingestedPayload.documents, "reingestion must replace, not duplicate, the source").to.have.length(1);

    const statsResponse = await harness.callTool(9, "rag_topic_stats", { topic: "stdio-flow" });
    const statsPayload = JSON.parse(statsResponse.result?.content?.[0]?.text ?? "{}");
    expect(statsPayload.documentCount).to.equal(1);
    expect(statsPayload.chunkCount).to.equal(1);

    expect(harness.nonProtocolLines, "ingestion/query diagnostics leaked onto stdout").to.deep.equal([]);

    expect(await harness.close(), "first stdio server did not exit cleanly").to.equal(0);
    harness = new StdioHarness(storageDir, sourceDir);
    harness.send({
      jsonrpc: "2.0",
      id: 20,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-restart-e2e", version: "1.0.0" },
      },
    });
    const restartInit = await harness.waitFor((message) => message.id === 20, 20000);
    expect(restartInit.error, "restart initialize returned an error").to.equal(undefined);
    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const restartQuery = await harness.callTool(
      21,
      "rag_query",
      { topic: "stdio-flow", query: "Which compass is used for Aurora navigation?", topK: 3 },
      60000,
    );
    expect(restartQuery.result?.isError, JSON.stringify(restartQuery.result)).not.to.equal(true);
    expect((restartQuery.result?.content?.[0]?.text ?? "").toLowerCase()).to.include("violet compass");

    const strategies = ["vector", "hybrid", "ensemble", "bm25", "graph", "graph_hybrid"];
    for (const [index, retrievalStrategy] of strategies.entries()) {
      const strategyQuery = await harness.callTool(
        30 + index,
        "rag_query",
        {
          topic: "stdio-flow",
          query: "What does the Aurora protocol use for deterministic navigation?",
          retrievalStrategy,
          topK: 3,
        },
        60000,
      );
      expect(
        strategyQuery.result?.isError,
        `${retrievalStrategy}: ${JSON.stringify(strategyQuery.result)}`,
      ).not.to.equal(true);
      expect((strategyQuery.result?.content?.[0]?.text ?? "").toLowerCase(), retrievalStrategy).to.include(
        "violet compass",
      );
    }

    const exportResponse = await harness.callTool(40, "rag_export_topic", { topic: "stdio-flow" });
    expect(exportResponse.result?.isError, JSON.stringify(exportResponse.result)).not.to.equal(true);
    const exported = JSON.parse(exportResponse.result?.content?.[0]?.text ?? "{}");
    expect(exported.path).to.match(/\.rag$/);
    expect(exported.size).to.be.greaterThan(0);
    expect(exported.sha256).to.match(/^[a-f0-9]{64}$/);

    const corruptPath = path.join(sourceDir, "corrupt-checksum.rag");
    const exportedArchive = new AdmZip(exported.path);
    const corruptArchive = new AdmZip();
    for (const entry of exportedArchive.getEntries()) {
      if (!entry.isDirectory) {
        corruptArchive.addFile(
          entry.entryName,
          entry.entryName === "topic.json" ? Buffer.from('{"tampered":true}', "utf8") : entry.getData(),
        );
      }
    }
    corruptArchive.writeZip(corruptPath);
    const corruptImport = await harness.callTool(60, "rag_import_topic", {
      archivePath: corruptPath,
      confirm: true,
    });
    expect(corruptImport.result?.isError).to.equal(true);
    expect(corruptImport.result?.content?.[0]?.text ?? "").to.include("checksum mismatch");

    const oldFormatPath = path.join(sourceDir, "old-format.rag");
    const oldFormatArchive = new AdmZip();
    const manifest = JSON.parse(exportedArchive.readAsText("manifest.json"));
    manifest.formatVersion = "1.0";
    for (const entry of exportedArchive.getEntries()) {
      if (!entry.isDirectory) {
        oldFormatArchive.addFile(
          entry.entryName,
          entry.entryName === "manifest.json" ? Buffer.from(JSON.stringify(manifest), "utf8") : entry.getData(),
        );
      }
    }
    oldFormatArchive.writeZip(oldFormatPath);
    const oldFormatImport = await harness.callTool(61, "rag_import_topic", {
      archivePath: oldFormatPath,
      confirm: true,
    });
    expect(oldFormatImport.result?.isError).to.equal(true);
    expect(oldFormatImport.result?.content?.[0]?.text ?? "").to.include("Invalid archive manifest");

    const removeResponse = await harness.callTool(41, "rag_remove_document", {
      topic: "stdio-flow",
      documentId: documentsPayload.documents[0].documentId,
      confirm: true,
    });
    expect(removeResponse.result?.isError, JSON.stringify(removeResponse.result)).not.to.equal(true);
    const emptyStatsResponse = await harness.callTool(42, "rag_topic_stats", { topic: "stdio-flow" });
    const emptyStats = JSON.parse(emptyStatsResponse.result?.content?.[0]?.text ?? "{}");
    expect(emptyStats.documentCount).to.equal(0);
    expect(emptyStats.chunkCount).to.equal(0);

    const deleteResponse = await harness.callTool(43, "rag_delete_topic", { topic: "stdio-flow", confirm: true });
    expect(deleteResponse.result?.isError, JSON.stringify(deleteResponse.result)).not.to.equal(true);
    const importResponse = await harness.callTool(44, "rag_import_topic", {
      archivePath: exported.path,
      confirm: true,
    });
    expect(importResponse.result?.isError, JSON.stringify(importResponse.result)).not.to.equal(true);
    const imported = JSON.parse(importResponse.result?.content?.[0]?.text ?? "{}");
    expect(imported.topic.name).to.equal("stdio-flow");

    const importedQuery = await harness.callTool(
      45,
      "rag_query",
      { topic: "stdio-flow", query: "What is the Aurora navigation object?", topK: 3 },
      60000,
    );
    expect(importedQuery.result?.isError, JSON.stringify(importedQuery.result)).not.to.equal(true);
    expect((importedQuery.result?.content?.[0]?.text ?? "").toLowerCase()).to.include("violet compass");

    const renameResponse = await harness.callTool(46, "rag_rename_topic", {
      topic: "stdio-flow",
      newName: "restored-flow",
    });
    expect(renameResponse.result?.isError, JSON.stringify(renameResponse.result)).not.to.equal(true);
    const storageStatus = await harness.callTool(47, "rag_storage_status", {});
    const storagePayload = JSON.parse(storageStatus.result?.content?.[0]?.text ?? "{}");
    expect(storagePayload.formatVersion).to.equal(2);
    expect(storagePayload.topicCount).to.be.greaterThan(0);
    const resetMemory = await harness.callTool(48, "rag_reset_memory", { confirm: true });
    expect(resetMemory.result?.isError, JSON.stringify(resetMemory.result)).not.to.equal(true);

    expect(harness.nonProtocolLines, "restart diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close(), "restarted stdio server did not exit cleanly").to.equal(0);
    harness = undefined;
  });

  it("runs ingestion and query through the opt-in LangGraph pipeline", async function () {
    const sourcePath = path.join(sourceDir, "langgraph-facts.txt");
    fs.writeFileSync(sourcePath, "The Borealis workflow confirms delivery with an amber sextant.\n", "utf8");
    harness = new StdioHarness(storageDir, sourceDir, { RAGNAROK_LANGGRAPH_ENABLED: "true" });
    harness.send({
      jsonrpc: "2.0",
      id: 100,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-langgraph-e2e", version: "1.0.0" },
      },
    });
    const init = await harness.waitFor((message) => message.id === 100, 20000);
    expect(init.error).to.equal(undefined);
    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const create = await harness.callTool(101, "rag_create_topic", { name: "langgraph-flow" });
    expect(create.result?.isError, JSON.stringify(create.result)).not.to.equal(true);
    const ingest = await harness.callTool(
      102,
      "rag_add_documents",
      { topic: "langgraph-flow", filePaths: [sourcePath] },
      60000,
    );
    expect(ingest.result?.isError, JSON.stringify(ingest.result)).not.to.equal(true);

    const strategies = ["vector", "hybrid", "ensemble", "bm25", "graph", "graph_hybrid"];
    for (const [index, retrievalStrategy] of strategies.entries()) {
      const query = await harness.callTool(
        103 + index,
        "rag_query",
        {
          topic: "langgraph-flow",
          query: "How does Borealis confirm delivery?",
          topK: 3,
          retrievalStrategy,
        },
        60000,
      );
      expect(query.result?.isError, `${retrievalStrategy}: ${JSON.stringify(query.result)}`).not.to.equal(true);
      const payload = JSON.parse(query.result?.content?.[0]?.text ?? "{}");
      expect(JSON.stringify(payload).toLowerCase(), retrievalStrategy).to.include("amber sextant");
      expect(payload.agenticMetadata, retrievalStrategy).to.be.an("object");
    }
    expect(harness.nonProtocolLines, "LangGraph diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close(), "LangGraph stdio server did not exit cleanly").to.equal(0);
    harness = undefined;
  });
});
