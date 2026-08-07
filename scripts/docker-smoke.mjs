import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const phase = process.argv[2] ?? "verify";
const endpoint = process.env.RAGNAROK_SMOKE_URL ?? "https://localhost:4000/mcp";
const token =
  phase === "create"
    ? process.env.RAGNAROK_WRITE_API_KEY
    : phase === "admin"
      ? process.env.RAGNAROK_ADMIN_API_KEY
      : process.env.RAGNAROK_API_KEY;
const topicName = "Docker Persistence Smoke";

if (!token) throw new Error(`Missing token for Docker smoke phase ${phase}`);

const client = new Client(
  { name: "ragnarok-smoke", version: "0.5.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (response.headers.has("mcp-session-id")) {
      throw new Error("Modern HTTP response unexpectedly carried Mcp-Session-Id");
    }
    return response;
  },
});

function parseToolBody(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("MCP tool returned no text content");
  }
  const body = JSON.parse(text);
  if (result.isError || body.error) {
    throw new Error(body.error ?? "MCP tool failed");
  }
  return body;
}

function transferUrl(relativeEndpoint) {
  const origin = new URL(endpoint).origin;
  return new URL(`/${String(relativeEndpoint).replace(/^\/+/, "")}`, origin);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const minimumTools = phase === "create" ? 16 : phase === "admin" || phase === "local" ? 20 : 10;
  if (tools.tools.length < minimumTools || !toolNames.has("rag_query")) {
    throw new Error(`Expected the complete ${phase} MCP tool surface, got ${tools.tools.length} tools`);
  }
  if (phase === "verify" && toolNames.has("rag_create_topic")) {
    throw new Error("Reader token unexpectedly received write tools");
  }
  if (
    phase === "create" &&
    (!toolNames.has("rag_create_topic") ||
      !toolNames.has("rag_ingest_upload") ||
      toolNames.has("rag_switch_embedding_model") ||
      toolNames.has("rag_export_topic"))
  ) {
    throw new Error("Curator token did not receive the expected least-privilege tool surface");
  }
  if (
    phase === "admin" &&
    (!toolNames.has("rag_switch_embedding_model") ||
      !toolNames.has("rag_export_topic") ||
      !toolNames.has("rag_import_upload") ||
      toolNames.has("rag_memory"))
  ) {
    throw new Error("Admin token did not receive the expected shared administrative surface");
  }
  if (
    phase === "local" &&
    (!toolNames.has("rag_memory") ||
      !toolNames.has("rag_add_documents") ||
      !toolNames.has("rag_import_topic") ||
      toolNames.has("rag_create_document_upload"))
  ) {
    throw new Error("Local owner did not receive the expected local-only tool surface");
  }

  if (phase === "create") {
    parseToolBody(
      await client.callTool({
        name: "rag_create_topic",
        arguments: { name: topicName, description: "Docker restart persistence gate" },
      }),
    );
    const document = Buffer.from("RAGnarok Docker transfer persistence evidence.");
    const digest = createHash("sha256").update(document).digest("hex");
    const upload = parseToolBody(
      await client.callTool({
        name: "rag_create_document_upload",
        arguments: {
          filename: "docker-smoke.txt",
          contentType: "text/plain",
          size: document.length,
          sha256: digest,
        },
      }),
    );
    const uploadResponse = await fetch(transferUrl(upload.uploadEndpoint), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: document,
    });
    if (!uploadResponse.ok) {
      throw new Error(`Docker upload transfer failed: HTTP ${uploadResponse.status} ${await uploadResponse.text()}`);
    }
    const ingestion = parseToolBody(
      await client.callTool({
        name: "rag_ingest_upload",
        arguments: { topic: topicName, uploadId: upload.id },
      }),
    );
    if (!ingestion.success) throw new Error("Docker upload transfer did not ingest the document");
  } else if (phase === "admin") {
    const exported = parseToolBody(
      await client.callTool({ name: "rag_export_topic", arguments: { topic: topicName } }),
    );
    const handle = exported.transfer;
    if (!handle?.downloadEndpoint || !handle?.sha256 || !Number.isSafeInteger(handle?.size)) {
      throw new Error("Docker export did not return a complete download handle");
    }
    const download = await fetch(transferUrl(handle.downloadEndpoint), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!download.ok) throw new Error(`Docker download transfer failed: HTTP ${download.status}`);
    const archive = Buffer.from(await download.arrayBuffer());
    if (archive.length !== handle.size || createHash("sha256").update(archive).digest("hex") !== handle.sha256) {
      throw new Error("Docker download transfer bytes did not match the declared size/digest");
    }
    const replay = await fetch(transferUrl(handle.downloadEndpoint), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (replay.status !== 404) throw new Error(`Single-use Docker download replay returned ${replay.status}`);
  } else if (phase !== "verify" && phase !== "local") {
    throw new Error(`Unknown Docker smoke phase: ${phase}`);
  }

  const topics = parseToolBody(await client.callTool({ name: "rag_list_topics", arguments: {} }));
  const names = (topics.topics ?? topics).map((topic) => topic.name);
  if (!names.includes(topicName)) {
    throw new Error(`Persisted topic was not found during ${phase} phase`);
  }
  console.log(`Docker MCP ${phase} smoke passed with ${tools.tools.length} tools.`);
} finally {
  await client.close();
}
