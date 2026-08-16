import type {
  GraphVisualizationDocument,
  GraphVisualizationEdge,
  GraphVisualizationGroup,
  GraphVisualizationNode,
  GraphVisualizationSource,
  JsonValue,
} from "@ragnarok/core";

export type {
  GraphVisualizationDocument,
  GraphVisualizationEdge,
  GraphVisualizationGroup,
  GraphVisualizationNode,
  GraphVisualizationSource,
  JsonValue,
};

export interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
}
