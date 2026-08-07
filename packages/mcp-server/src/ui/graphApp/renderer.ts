import { select } from "d3-selection";
import type {
  GraphVisualizationDocument,
  GraphVisualizationEdge,
  GraphVisualizationNode,
  GraphVisualizationSource,
} from "./documentTypes";
import { installGraphInteractions, type RenderedEdge, type RenderedNode } from "./interactions";
import { createDetailsPanel, resetPanel } from "./panel";
import { createViewport } from "./viewport";

const SHAPE_BY_TYPE: Record<string, "circle" | "rect" | "hex" | "rounded"> = {
  concept: "circle",
  person: "rect",
  organization: "hex",
  function: "circle",
  class: "circle",
  module: "rect",
  technology: "hex",
  location: "circle",
  event: "rounded",
  fact: "circle",
  preference: "rounded",
  episode: "rect",
  other: "circle",
  tool: "hex",
  project: "rect",
  convention: "rounded",
};

let destroyActiveRender: (() => void) | undefined;
let activeEdgeUpdater: ((nodeId: string) => void) | undefined;

export function renderDocument(graph: GraphVisualizationDocument): void {
  clearVisualization();
  if (graph.nodes.length === 0) {
    renderEmpty(graph.source);
    return;
  }

  const svgElement = document.querySelector<SVGSVGElement>("#graph");
  if (!svgElement) {
    return;
  }
  initializeSvg(svgElement);
  const svg = select(svgElement);
  const root = svg.append("g").attr("class", "zoom-root");
  root
    .append("rect")
    .attr("class", "viewport-bounds")
    .attr("x", graph.viewport.minX)
    .attr("y", graph.viewport.minY)
    .attr("width", graph.viewport.maxX - graph.viewport.minX)
    .attr("height", graph.viewport.maxY - graph.viewport.minY)
    .attr("data-min-x", graph.viewport.minX)
    .attr("data-min-y", graph.viewport.minY)
    .attr("data-max-x", graph.viewport.maxX)
    .attr("data-max-y", graph.viewport.maxY)
    .attr("aria-hidden", "true");

  const nodeData: GraphVisualizationNode[] = graph.nodes.map((node) => ({ ...node }));
  const edgeData: GraphVisualizationEdge[] = graph.edges.map((edge) => ({ ...edge }));
  const nodeById = new Map(nodeData.map((node) => [node.id, node]));
  const colorByGroup = new Map(graph.groups.map((group) => [group.id, group.color]));

  const edgeLayer = root.append("g").attr("class", "edge-layer");
  const lines = edgeLayer
    .selectAll<SVGLineElement, GraphVisualizationEdge>("line.edge")
    .data(edgeData)
    .enter()
    .append("line")
    .attr("class", "edge")
    .attr("data-edge-id", (edge) => edge.id)
    .attr("data-graph-item", "true")
    .attr("role", "button")
    .attr("aria-labelledby", (_edge, index) => `edge-title-${index}`)
    .attr("stroke-width", (edge) => Math.max(1, Math.min(8, 0.75 + edge.weight)));
  lines
    .append("title")
    .attr("id", (_edge, index) => `edge-title-${index}`)
    .text((edge) => edgeAccessibleName(edge, nodeById));

  const edgeLabels = edgeLayer
    .selectAll<SVGTextElement, GraphVisualizationEdge>("text.edge-label")
    .data(edgeData)
    .enter()
    .append("text")
    .attr("class", "edge-label")
    .attr("text-anchor", "middle")
    .attr("aria-hidden", "true")
    .text((edge) => edge.label);

  const nodeLayer = root.append("g").attr("class", "node-layer");
  const nodes = nodeLayer
    .selectAll<SVGGElement, GraphVisualizationNode>("g.node")
    .data(nodeData)
    .enter()
    .append("g")
    .attr("class", "node")
    .attr("data-node-id", (node) => node.id)
    .attr("data-graph-item", "true")
    .attr("role", "button")
    .attr("aria-labelledby", (_node, index) => `node-title-${index}`)
    .attr("transform", (node) => nodeTransform(node));
  nodes
    .append("title")
    .attr("id", (_node, index) => `node-title-${index}`)
    .text((node) => `${node.label}, ${node.type} node`);
  nodes.each(function (node) {
    appendNodeShape(this, node, colorByGroup.get(node.groupId ?? -1) ?? "#64748b");
  });
  const nodeLabels = nodes
    .append("text")
    .attr("class", "node-label")
    .attr("x", 0)
    .attr("y", (node) => -node.radius - 8)
    .attr("text-anchor", "middle")
    .attr("aria-hidden", "true")
    .text((node) => node.label);

  const updateEdge = (line: SVGLineElement, edge: GraphVisualizationEdge): void => {
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    line.setAttribute("x1", String(source.x));
    line.setAttribute("y1", String(source.y));
    line.setAttribute("x2", String(target.x));
    line.setAttribute("y2", String(target.y));
  };
  const updateEdgeLabel = (label: SVGTextElement, edge: GraphVisualizationEdge): void => {
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    label.setAttribute("x", String((source.x + target.x) / 2));
    label.setAttribute("y", String((source.y + target.y) / 2));
  };
  lines.each(function (edge) {
    updateEdge(this, edge);
  });
  edgeLabels.each(function (edge) {
    updateEdgeLabel(this, edge);
  });

  const edgeLabelsByIndex = edgeLabels.nodes();
  const edgeGeometryByNode = new Map<
    string,
    Array<{ line: SVGLineElement; label: SVGTextElement; edge: GraphVisualizationEdge }>
  >();
  lines.each(function (edge, index) {
    const geometry = { line: this, label: edgeLabelsByIndex[index], edge };
    const endpointIds = edge.source === edge.target ? [edge.source] : [edge.source, edge.target];
    for (const endpointId of endpointIds) {
      const connected = edgeGeometryByNode.get(endpointId) ?? [];
      connected.push(geometry);
      edgeGeometryByNode.set(endpointId, connected);
    }
  });

  const updateConnected = (nodeId: string): void => {
    for (const geometry of edgeGeometryByNode.get(nodeId) ?? []) {
      updateEdge(geometry.line, geometry.edge);
      updateEdgeLabel(geometry.label, geometry.edge);
    }
  };
  activeEdgeUpdater = updateConnected;

  const viewport = createViewport(svgElement, root.node()!);
  const panel = createDetailsPanel();
  const renderedNodes: RenderedNode[] = [];
  nodes.each(function (data) {
    renderedNodes.push({ element: this, data });
  });
  const renderedEdges: RenderedEdge[] = [];
  lines.each(function (data) {
    renderedEdges.push({ element: this, data });
  });
  const destroyInteractions = installGraphInteractions({
    svg: svgElement,
    nodes: renderedNodes,
    edges: renderedEdges,
    viewport,
    panel,
    nodeById,
    updateNode(node) {
      node.element.setAttribute("transform", nodeTransform(node.data));
    },
    updateConnectedEdges: updateConnected,
  });

  let labelsVisible = true;
  const resetButton = document.querySelector<HTMLButtonElement>("#reset-view");
  const labelsButton = document.querySelector<HTMLButtonElement>("#toggle-labels");
  const onReset = (): void => viewport.reset();
  const onToggleLabels = (): void => {
    labelsVisible = !labelsVisible;
    nodeLabels.text((node) => (labelsVisible ? node.label : ""));
    edgeLabels.text((edge) => (labelsVisible ? edge.label : ""));
    labelsButton?.setAttribute("aria-pressed", String(labelsVisible));
    viewport.fit();
  };
  resetButton?.addEventListener("click", onReset);
  labelsButton?.addEventListener("click", onToggleLabels);
  labelsButton?.setAttribute("aria-pressed", "true");

  setText(
    "#status",
    `${graph.nodes.length} nodes and ${graph.edges.length} ${graph.edges.length === 1 ? "edge" : "edges"} displayed.`,
  );
  const status = document.querySelector<HTMLElement>("#status");
  status?.setAttribute("role", "status");
  status?.setAttribute("aria-live", "polite");
  setText(
    "#truncation-banner",
    graph.metadata.truncated
      ? `Showing ${graph.metadata.retainedNodeCount} of ${graph.metadata.originalNodeCount} nodes and ${graph.metadata.retainedEdgeCount} of ${graph.metadata.originalEdgeCount} edges`
      : "",
  );
  hide("#loading");
  hide("#error");
  viewport.fit();

  destroyActiveRender = () => {
    resetButton?.removeEventListener("click", onReset);
    labelsButton?.removeEventListener("click", onToggleLabels);
    destroyInteractions();
    panel.destroy();
    viewport.destroy();
  };
}

export function updateConnectedEdges(nodeId: string): void {
  activeEdgeUpdater?.(nodeId);
}

export function clearVisualization(): void {
  const panel = document.querySelector<HTMLElement>("#panel");
  const moveFocus = panel?.contains(document.activeElement) ?? false;
  destroyActiveRender?.();
  destroyActiveRender = undefined;
  activeEdgeUpdater = undefined;
  const svg = document.querySelector<SVGSVGElement>("#graph");
  svg?.replaceChildren();
  if (svg) {
    setSvgFallbackName(svg);
  }
  resetPanel();
  setText("#truncation-banner", "");
  setText("#status", "");
  setText("#error", "");
  hide("#error");
  hide("#loading");
  document.querySelector("#toggle-labels")?.setAttribute("aria-pressed", "true");
  if (moveFocus) {
    svg?.focus();
  }
}

export function showEmpty(source: GraphVisualizationSource): void {
  clearVisualization();
  renderEmpty(source);
}

export function showError(message: string): void {
  clearVisualization();
  const error = document.querySelector<HTMLElement>("#error");
  if (error) {
    error.textContent = message;
    error.hidden = false;
    error.setAttribute("role", "alert");
  }
}

function renderEmpty(source: GraphVisualizationSource): void {
  const svgElement = document.querySelector<SVGSVGElement>("#graph");
  if (!svgElement) {
    return;
  }
  initializeSvg(svgElement);
  const message =
    source.kind === "memory"
      ? "No memories yet in this scope/branch."
      : "Ingest documents into this topic to populate the graph.";
  select(svgElement)
    .append("text")
    .attr("class", "empty")
    .attr("text-anchor", "middle")
    .attr("x", "50%")
    .attr("y", "50%")
    .text(message);
  setText("#status", "Graph is empty.");
  const status = document.querySelector<HTMLElement>("#status");
  status?.setAttribute("role", "status");
  status?.setAttribute("aria-live", "polite");
  hide("#loading");
}

function initializeSvg(svg: SVGSVGElement): void {
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", "graph-title graph-description");
  svg.removeAttribute("aria-label");
  svg.setAttribute("tabindex", "-1");
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.id = "graph-title";
  title.textContent = "RAGnarok graph visualization";
  const description = document.createElementNS("http://www.w3.org/2000/svg", "desc");
  description.id = "graph-description";
  description.textContent = "Interactive graph of connected entities.";
  svg.append(title, description);
}

function setSvgFallbackName(svg: SVGSVGElement): void {
  svg.setAttribute("role", "img");
  svg.removeAttribute("aria-labelledby");
  svg.setAttribute("aria-label", "RAGnarok graph visualization");
  svg.setAttribute("tabindex", "-1");
}

function appendNodeShape(parent: SVGGElement, node: GraphVisualizationNode, color: string): void {
  const selection = select(parent);
  const shape = SHAPE_BY_TYPE[node.type] ?? "circle";
  if (shape === "circle") {
    selection.append("circle").attr("r", node.radius).attr("fill", color);
  } else if (shape === "hex") {
    selection.append("polygon").attr("points", hexPoints(node.radius)).attr("fill", color);
  } else {
    selection
      .append("rect")
      .attr("x", -node.radius)
      .attr("y", -node.radius)
      .attr("width", node.radius * 2)
      .attr("height", node.radius * 2)
      .attr("rx", shape === "rounded" ? node.radius / 3 : 2)
      .attr("fill", color);
  }
}

function edgeAccessibleName(
  edge: GraphVisualizationEdge,
  nodeById: ReadonlyMap<string, GraphVisualizationNode>,
): string {
  const source = nodeById.get(edge.source)?.label ?? edge.source;
  const target = nodeById.get(edge.target)?.label ?? edge.target;
  return `${edge.label}, ${source} to ${target}`;
}

function nodeTransform(node: GraphVisualizationNode): string {
  return `translate(${node.x},${node.y})`;
}

function hexPoints(radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return `${Math.cos(angle) * radius},${Math.sin(angle) * radius}`;
  }).join(" ");
}

function setText(selector: string, value: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}

function hide(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) {
    element.hidden = true;
  }
}
