export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type GraphVisualizationSource =
  | { kind: "memory"; scope: "workspace" }
  | { kind: "memory"; scope: "branch"; branch: string };

export interface GraphVisualizationNode {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  radius: number;
  groupId: number | null;
  attributes: Record<string, JsonValue>;
}

export interface GraphVisualizationEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  attributes: Record<string, JsonValue>;
}

export interface GraphVisualizationGroup {
  id: number;
  label: string;
  color: string;
  retainedNodeCount: number;
}

export interface GraphVisualizationDocument {
  schema: "ragnarok.graph.visualization.v1";
  source: GraphVisualizationSource;
  nodes: GraphVisualizationNode[];
  edges: GraphVisualizationEdge[];
  groups: GraphVisualizationGroup[];
  viewport: { minX: number; minY: number; maxX: number; maxY: number };
  metadata: {
    originalNodeCount: number;
    retainedNodeCount: number;
    originalEdgeCount: number;
    retainedEdgeCount: number;
    truncated: boolean;
    truncationReasons: Array<"maxNodes" | "maxEdges" | "responseBytes">;
    empty: boolean;
  };
}

export interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
}
