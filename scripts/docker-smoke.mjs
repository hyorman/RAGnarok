import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const phase = process.argv[2] ?? "verify";
const endpoint = process.env.RAGNAROK_SMOKE_URL ?? "http://127.0.0.1:4000/mcp";
const token = phase === "create" ? process.env.RAGNAROK_WRITE_API_KEY : process.env.RAGNAROK_API_KEY;
const topicName = "Docker Persistence Smoke";

if (!token) {
  throw new Error(`Missing ${phase === "create" ? "RAGNAROK_WRITE_API_KEY" : "RAGNAROK_API_KEY"}`);
}

const client = new Client({ name: "ragnarok-docker-smoke", version: "0.4.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
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

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const minimumTools = phase === "create" ? 20 : 10;
  if (tools.tools.length < minimumTools || !toolNames.has("rag_query")) {
    throw new Error(`Expected the complete ${phase} MCP tool surface, got ${tools.tools.length} tools`);
  }
  if (phase === "verify" && toolNames.has("rag_create_topic")) {
    throw new Error("Reader token unexpectedly received write tools");
  }

  if (phase === "create") {
    parseToolBody(
      await client.callTool({
        name: "rag_create_topic",
        arguments: { name: topicName, description: "Docker restart persistence gate" },
      }),
    );
  } else if (phase !== "verify") {
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
