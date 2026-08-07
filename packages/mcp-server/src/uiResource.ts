import type { McpServer } from "@modelcontextprotocol/server";
import { GRAPH_APP_HTML } from "./ui/graphAppBundle";

const RESOURCE_URI = "ui://ragnarok/graph";
export const GRAPH_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Register the interactive graph visualization MCP App resource.
 * The tool `rag_graph_visualize` declares `_meta.ui.resourceUri` pointing here;
 * the host fetches this resource and renders it in a sandboxed iframe.
 */
export function registerGraphUiResource(server: McpServer): void {
  server.registerResource(
    "ragnarok-graph",
    RESOURCE_URI,
    {
      description: "Interactive graph visualization for RAGnarōk knowledge and memory graphs.",
      mimeType: GRAPH_RESOURCE_MIME_TYPE,
      annotations: { audience: ["user"], priority: 1 },
    },
    () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          text: GRAPH_APP_HTML,
          mimeType: GRAPH_RESOURCE_MIME_TYPE,
        },
      ],
    }),
  );
}

export const GRAPH_RESOURCE_URI = RESOURCE_URI;
