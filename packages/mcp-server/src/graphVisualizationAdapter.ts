import type { ServerContext } from "@modelcontextprotocol/server";
import {
  reduceGraphVisualizationDocument,
  type GraphVisualizationDocument,
  type GraphVisualizationService,
} from "@ragnarok/core";

type GraphToolInput =
  | { source: "memory"; memoryScope: "workspace"; maxNodes?: number }
  | { source: "memory"; memoryScope: "branch"; branch: string; maxNodes?: number };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

type MeasureResult = (value: ToolResult, maximumBytes: number) => { fits: boolean };

class GraphVisualizationRecordTooLargeError extends Error {
  constructor() {
    super("A graph visualization record exceeds the response byte limit");
    this.name = "GraphVisualizationRecordTooLargeError";
  }
}

function toolJson(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function utf8Prefix(value: Buffer, maximumBytes: number): string {
  let end = Math.min(maximumBytes, value.length);
  while (end > 0 && end < value.length && (value[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return value.subarray(0, end).toString("utf8");
}

function graphError(code: string, message: string, maximumBytes: number, measure: MeasureResult): ToolResult {
  const create = (candidateMessage: string) => toolJson({ error: { code, message: candidateMessage } }, true);
  const full = create(message);
  if (measure(full, maximumBytes).fits) {
    return full;
  }

  const encoded = Buffer.from(message, "utf8");
  let fittingBytes = 0;
  let rejectedBytes = encoded.length;
  while (rejectedBytes - fittingBytes > 1) {
    const candidateBytes = Math.floor((fittingBytes + rejectedBytes) / 2);
    if (measure(create(`${utf8Prefix(encoded, candidateBytes)}...`), maximumBytes).fits) {
      fittingBytes = candidateBytes;
    } else {
      rejectedBytes = candidateBytes;
    }
  }
  return create(`${utf8Prefix(encoded, fittingBytes)}...`);
}

function fitGraphVisualizationResult(
  document: GraphVisualizationDocument,
  maximumBytes: number,
  measureResult: MeasureResult,
): GraphVisualizationDocument {
  let measurements = 0;
  const measure = (candidateDocument: GraphVisualizationDocument): boolean => {
    measurements += 1;
    if (measurements > 24) {
      throw new Error("Graph visualization response reduction exceeded 24 measurements");
    }
    return measureResult(toolJson(candidateDocument), maximumBytes).fits;
  };

  if (measure(document)) {
    return document;
  }

  const nodeCount = document.nodes.length;
  const edgeCount = document.edges.length;
  const zeroEdgeDocument = edgeCount === 0 ? document : reduceGraphVisualizationDocument(document, nodeCount, 0);
  const zeroEdgesFit = edgeCount === 0 ? false : measure(zeroEdgeDocument);
  if (zeroEdgesFit) {
    let fittingEdgeCount = 0;
    let rejectedEdgeCount = edgeCount;
    while (rejectedEdgeCount - fittingEdgeCount > 1) {
      const candidateEdgeCount = Math.floor((fittingEdgeCount + rejectedEdgeCount) / 2);
      if (measure(reduceGraphVisualizationDocument(document, nodeCount, candidateEdgeCount))) {
        fittingEdgeCount = candidateEdgeCount;
      } else {
        rejectedEdgeCount = candidateEdgeCount;
      }
    }
    return reduceGraphVisualizationDocument(document, nodeCount, fittingEdgeCount);
  }

  if (nodeCount === 1) {
    throw new GraphVisualizationRecordTooLargeError();
  }

  let fittingNodeCount = 0;
  let rejectedNodeCount = nodeCount;
  while (rejectedNodeCount - fittingNodeCount > 1) {
    const candidateNodeCount = Math.floor((fittingNodeCount + rejectedNodeCount) / 2);
    if (measure(reduceGraphVisualizationDocument(document, candidateNodeCount, 0))) {
      fittingNodeCount = candidateNodeCount;
    } else {
      rejectedNodeCount = candidateNodeCount;
    }
  }
  if (fittingNodeCount === 0) {
    throw new GraphVisualizationRecordTooLargeError();
  }
  return reduceGraphVisualizationDocument(document, fittingNodeCount, 0);
}

export async function invokeGraphVisualizationTool(
  input: GraphToolInput,
  context: ServerContext,
  graphService: Pick<GraphVisualizationService, "generate">,
  maximumBytes: number,
  measureResult: MeasureResult,
): Promise<ToolResult> {
  try {
    const request =
      input.memoryScope === "branch"
        ? { scope: "branch" as const, branch: input.branch, maxNodes: input.maxNodes }
        : { scope: "workspace" as const, maxNodes: input.maxNodes };
    const document = await graphService.generate(request, context.mcpReq.signal);
    return toolJson(fitGraphVisualizationResult(document, maximumBytes, measureResult));
  } catch (error) {
    if (error instanceof GraphVisualizationRecordTooLargeError) {
      return graphError("GRAPH_VISUALIZATION_RECORD_TOO_LARGE", error.message, maximumBytes, measureResult);
    }
    return graphError(
      "GRAPH_VISUALIZATION_FAILED",
      error instanceof Error ? error.message : String(error),
      maximumBytes,
      measureResult,
    );
  }
}
