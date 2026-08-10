/**
 * Stdio transport E2E test.
 *
 * Launches the built server (dist/index.js) as a real child process, completes
 * a modern MCP discover → tools/list exchange over stdio, and
 * asserts that stdout carried ONLY JSON-RPC protocol frames. Any diagnostic
 * text on stdout corrupts the protocol stream for strict clients.
 *
 * Package pretest builds dist/index.js before compiling and running this suite.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import AdmZip from "adm-zip";
import { MemoryVectorStore } from "@ragnarok/core";
import { StdioHarness, withStdioHarness } from "./helpers/stdioHarness";

const LOCAL_ADMIN_TOOLS = [
  "rag_add_documents",
  "rag_add_github_repo",
  "rag_add_url",
  "rag_create_topic",
  "rag_delete_topic",
  "rag_embedding_info",
  "rag_export_topic",
  "rag_graph_visualize",
  "rag_import_topic",
  "rag_list_documents",
  "rag_list_embedding_models",
  "rag_list_reranker_models",
  "rag_list_topics",
  "rag_llm_status",
  "rag_memory",
  "rag_query",
  "rag_remove_document",
  "rag_rename_topic",
  "rag_reranker_info",
  "rag_reset_memory",
  "rag_storage_status",
  "rag_switch_embedding_model",
  "rag_switch_reranker_model",
  "rag_topic_stats",
];

const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "stdio-e2e", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function seedGraphProtocolFixtures(storageDir: string): Promise<void> {
  const memoryStore = new MemoryVectorStore(path.join(storageDir, "memory-lancedb"));
  try {
    for (const scopeCase of [
      { scope: "workspace" as const, branch: undefined },
      { scope: "branch" as const, branch: "feature/protocol" },
    ]) {
      await memoryStore.saveGraph(
        {
          entities: [
            {
              id: `${scopeCase.scope}-alpha`,
              name: `${scopeCase.scope} alpha`,
              type: "concept",
              description: `${scopeCase.scope} alpha detail`,
              vector: [1, 0],
              scope: scopeCase.scope,
              branch: scopeCase.branch,
              confidence: 0.9,
              strength: 0.8,
              createdAt: 1,
              updatedAt: 2,
              sourceMemoryIds: [`${scopeCase.scope}-memory-alpha`],
              metadata: { rank: 1 },
            },
            {
              id: `${scopeCase.scope}-beta`,
              name: `${scopeCase.scope} beta`,
              type: "tool",
              description: `${scopeCase.scope} beta detail`,
              vector: [0, 1],
              scope: scopeCase.scope,
              branch: scopeCase.branch,
              confidence: 0.8,
              strength: 0.7,
              createdAt: 3,
              updatedAt: 4,
              sourceMemoryIds: [`${scopeCase.scope}-memory-beta`],
              metadata: { rank: 2 },
            },
          ],
          relationships: [
            {
              id: `${scopeCase.scope}-edge`,
              sourceId: `${scopeCase.scope}-alpha`,
              targetId: `${scopeCase.scope}-beta`,
              type: "uses",
              description: `${scopeCase.scope} alpha uses beta`,
              weight: 0.75,
              scope: scopeCase.scope,
              branch: scopeCase.branch,
              metadata: { evidence: "protocol fixture" },
            },
          ],
        },
        scopeCase.scope,
        scopeCase.branch,
      );
    }
  } finally {
    await memoryStore.dispose();
  }
}

describe("stdio transport E2E", function () {
  // Server startup loads config + topic manager; allow headroom.
  this.timeout(120000);

  let harness: StdioHarness | undefined;
  let storageDir: string;
  let sourceDir: string;

  before(function () {
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

  it("proves the graph visualization protocol and keeps modern discovery protocol-clean", async function () {
    const fixtureTopic = await withStdioHarness(
      () => new StdioHarness(storageDir, sourceDir, { RAGNAROK_RERANKER_ENABLED: "false" }),
      async (fixtureHarness) => {
        expect((await fixtureHarness.discover(900)).error).to.equal(undefined);
        const fixtureTopicResponse = await fixtureHarness.callTool(901, "rag_create_topic", {
          name: "stdio-populated",
          description: "Persisted graph protocol fixture",
        });
        expect(fixtureTopicResponse.result?.isError, JSON.stringify(fixtureTopicResponse.result)).not.to.equal(true);
        return JSON.parse(fixtureTopicResponse.result?.content?.[0]?.text ?? "{}").topic;
      },
      "fixture stdio server",
    );
    await seedGraphProtocolFixtures(storageDir);

    harness = new StdioHarness(storageDir, sourceDir, { RAGNAROK_RERANKER_ENABLED: "false" });

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

    const legacyResponse = await harness.waitFor((m) => m.id === 1, 20000);
    expect(legacyResponse.error?.code).to.equal(-32022);

    const discoverResponse = await harness.discover(2);
    expect(discoverResponse.error, "server/discover returned an error").to.equal(undefined);
    const toolsResponse = await harness.listTools(200);
    expect(toolsResponse.error, "tools/list returned an error").to.equal(undefined);
    expect(toolsResponse.result?.tools).to.be.an("array").with.length.greaterThan(0);
    const listedTools = toolsResponse.result?.tools as Array<{
      name: string;
      annotations?: Record<string, boolean>;
      _meta?: Record<string, unknown>;
    }>;
    expect(listedTools.map((tool) => tool.name).sort()).to.deep.equal([...LOCAL_ADMIN_TOOLS].sort());
    expect(listedTools.find((tool) => tool.name === "rag_list_documents")?.annotations?.readOnlyHint).to.equal(true);
    expect(listedTools.find((tool) => tool.name === "rag_delete_topic")?.annotations?.destructiveHint).to.equal(true);
    expect(listedTools.find((tool) => tool.name === "rag_add_url")?.annotations?.openWorldHint).to.equal(true);

    const graphTool = listedTools.find((tool) => tool.name === "rag_graph_visualize");
    expect(graphTool, "rag_graph_visualize must be listed").to.exist;
    expect(graphTool?._meta).to.deep.equal({ ui: { resourceUri: "ui://ragnarok/graph" } });
    expect(graphTool?._meta).not.to.have.property("ui/resourceUri");

    harness.send({ jsonrpc: "2.0", id: 201, method: "resources/list", params: { _meta: MODERN_ENVELOPE } });
    const resourcesResponse = await harness.waitFor((message) => message.id === 201, 30_000);
    expect(resourcesResponse.error, "resources/list returned an error").to.equal(undefined);
    expect(resourcesResponse.result?.resources).to.deep.include({
      name: "ragnarok-graph",
      uri: "ui://ragnarok/graph",
      description: "Interactive graph visualization for RAGnarōk knowledge and memory graphs.",
      mimeType: "text/html;profile=mcp-app",
      annotations: { audience: ["user"], priority: 1 },
    });

    harness.send({
      jsonrpc: "2.0",
      id: 202,
      method: "resources/read",
      params: { uri: "ui://ragnarok/graph", _meta: MODERN_ENVELOPE },
    });
    const resourceRead = await harness.waitFor((message) => message.id === 202, 30_000);
    expect(resourceRead.error, "resources/read returned an error").to.equal(undefined);
    expect(resourceRead.result?.contents).to.have.length(1);
    const graphResource = resourceRead.result?.contents[0];
    expect(graphResource).to.include({
      uri: "ui://ragnarok/graph",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(graphResource.text).to.be.a("string").and.not.equal("");
    expect(graphResource.text).to.include("data-ragnarok-graph-app");
    expect(graphResource.text).to.include("<svg");
    expect(graphResource.text).to.include('id="reset-view"');
    expect(graphResource.text).not.to.match(/<script\s+[^>]*src\s*=/i);

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

    // The knowledge source was removed with the document graph; the tool must
    // reject it over the wire rather than silently serving a memory graph.
    const removedKnowledgeGraph = await harness.callTool(70, "rag_graph_visualize", {
      source: "knowledge",
      topic: "stdio-populated",
    });
    expect(removedKnowledgeGraph.error, "rag_graph_visualize returned a protocol error").to.equal(undefined);
    expect(removedKnowledgeGraph.result?.isError, JSON.stringify(removedKnowledgeGraph.result)).to.equal(true);
    expect(JSON.parse(removedKnowledgeGraph.result?.content?.[0]?.text ?? "{}").error.code).to.equal(
      "GRAPH_VISUALIZATION_FAILED",
    );

    for (const memoryCase of [
      { arguments: { source: "memory", memoryScope: "workspace" }, scope: "workspace" },
      {
        arguments: { source: "memory", memoryScope: "branch", branch: "feature/protocol" },
        scope: "branch",
      },
    ] as const) {
      const memoryGraphResponse = await harness.callTool(
        72 + (memoryCase.scope === "branch" ? 1 : 0),
        "rag_graph_visualize",
        {
          ...memoryCase.arguments,
        },
      );
      expect(memoryGraphResponse.error, `rag_graph_visualize ${memoryCase.scope} returned a protocol error`).to.equal(
        undefined,
      );
      expect(memoryGraphResponse.result?.isError, JSON.stringify(memoryGraphResponse.result)).not.to.equal(true);
      const memoryPayload = JSON.parse(memoryGraphResponse.result?.content?.[0]?.text ?? "{}");
      expect(memoryPayload.schema).to.equal("ragnarok.graph.visualization.v1");
      expect(memoryPayload.source).to.deep.equal(
        memoryCase.scope === "branch"
          ? { kind: "memory", scope: "branch", branch: "feature/protocol" }
          : { kind: "memory", scope: "workspace" },
      );
      expect(memoryPayload.nodes).to.have.length(2);
      expect(memoryPayload.edges).to.have.length(1);
      expect(memoryPayload.nodes[0].attributes).to.deep.include({
        description: `${memoryCase.scope} alpha detail`,
        scope: memoryCase.scope,
        ...(memoryCase.scope === "branch" ? { branch: "feature/protocol" } : {}),
        confidence: 0.9,
        strength: 0.8,
        createdAt: 1,
        updatedAt: 2,
        sourceMemoryIds: [`${memoryCase.scope}-memory-alpha`],
        metadata: { rank: 1 },
      });
      expect(memoryPayload.edges[0]).to.deep.include({
        id: `${memoryCase.scope}-edge`,
        source: `${memoryCase.scope}-alpha`,
        target: `${memoryCase.scope}-beta`,
        label: "uses",
        weight: 0.75,
      });
      expect(memoryPayload.edges[0].attributes).to.deep.include({
        description: `${memoryCase.scope} alpha uses beta`,
        scope: memoryCase.scope,
        ...(memoryCase.scope === "branch" ? { branch: "feature/protocol" } : {}),
        metadata: { evidence: "protocol fixture" },
      });
      expect(JSON.stringify(memoryPayload)).not.to.include("vector");
    }

    expect(harness.nonProtocolLines, "graph visualize diagnostics leaked onto stdout").to.deep.equal([]);

    expect(harness.nonProtocolLines, "ingestion/query diagnostics leaked onto stdout").to.deep.equal([]);

    expect(await harness.close(), "first stdio server did not exit cleanly").to.equal(0);
    harness = new StdioHarness(storageDir, sourceDir, { RAGNAROK_RERANKER_ENABLED: "false" });
    const restartDiscover = await harness.discover(20);
    expect(restartDiscover.error, "restart discovery returned an error").to.equal(undefined);

    const restartQuery = await harness.callTool(
      21,
      "rag_query",
      { topic: "stdio-flow", query: "Which compass is used for Aurora navigation?", topK: 3 },
      60000,
    );
    expect(restartQuery.result?.isError, JSON.stringify(restartQuery.result)).not.to.equal(true);
    expect((restartQuery.result?.content?.[0]?.text ?? "").toLowerCase()).to.include("violet compass");

    const strategies = ["vector", "hybrid", "bm25"];
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

    const listTopics = await harness.callTool(49, "rag_list_topics", {});
    expect(listTopics.result?.isError, JSON.stringify(listTopics.result)).not.to.equal(true);
    // The fixture topic was created by an earlier server process; it must survive the restart.
    expect(
      JSON.parse(listTopics.result?.content?.[0]?.text ?? "{}").topics?.map((topic: { name: string }) => topic.name),
    ).to.include(fixtureTopic.name);
    const embeddingModels = await harness.callTool(50, "rag_list_embedding_models", {});
    expect(embeddingModels.result?.isError, JSON.stringify(embeddingModels.result)).not.to.equal(true);
    const embeddingInfo = await harness.callTool(51, "rag_embedding_info", {});
    expect(embeddingInfo.result?.isError, JSON.stringify(embeddingInfo.result)).not.to.equal(true);
    const activeEmbedding = JSON.parse(embeddingInfo.result?.content?.[0]?.text ?? "{}").currentModel;
    const sameEmbedding = await harness.callTool(52, "rag_switch_embedding_model", { model: activeEmbedding }, 60000);
    expect(sameEmbedding.result?.isError, JSON.stringify(sameEmbedding.result)).not.to.equal(true);
    const llmStatus = await harness.callTool(53, "rag_llm_status", {});
    expect(llmStatus.result?.isError, JSON.stringify(llmStatus.result)).not.to.equal(true);
    expect(JSON.parse(llmStatus.result?.content?.[0]?.text ?? "{}").available).to.equal(false);
    const rerankerModels = await harness.callTool(54, "rag_list_reranker_models", {});
    expect(rerankerModels.result?.isError, JSON.stringify(rerankerModels.result)).not.to.equal(true);
    const rerankerInfo = await harness.callTool(55, "rag_reranker_info", {});
    expect(rerankerInfo.result?.isError, JSON.stringify(rerankerInfo.result)).not.to.equal(true);
    const rerankerSwitch = await harness.callTool(56, "rag_switch_reranker_model", {
      model: "Xenova/ms-marco-MiniLM-L-6-v2",
    });
    expect(rerankerSwitch.result?.isError, "disabled reranker must reject model switches").to.equal(true);
    const unsafeUrl = await harness.callTool(57, "rag_add_url", {
      topic: "restored-flow",
      url: "file:///etc/passwd",
    });
    expect(unsafeUrl.result?.isError, "non-HTTP URL must be rejected").to.equal(true);
    const unapprovedGithub = await harness.callTool(58, "rag_add_github_repo", {
      topic: "restored-flow",
      url: "https://example.invalid/org/repository",
    });
    expect(unapprovedGithub.result?.isError, "non-allowlisted GitHub host must be rejected").to.equal(true);
    const invalidSchema = await harness.callTool(59, "rag_query", {
      topic: "restored-flow",
      query: "invalid topK probe",
      topK: 21,
    });
    expect(invalidSchema.error ?? invalidSchema.result?.isError, JSON.stringify(invalidSchema)).to.be.ok;

    expect(harness.nonProtocolLines, "restart diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close(), "restarted stdio server did not exit cleanly").to.equal(0);
    harness = undefined;
  });
});
