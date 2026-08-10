import type { GraphVisualizationDocument, GraphVisualizationSource, JsonValue, ToolResultLike } from "./documentTypes";

const MAX_NODES = 2_000;
const MAX_EDGES = 10_000;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TRUNCATION_REASONS = new Set(["maxNodes", "maxEdges", "responseBytes"]);
const TRUNCATION_REASON_ORDER = new Map(
  ["maxNodes", "maxEdges", "responseBytes"].map((reason, index) => [reason, index]),
);

function invalid(reason: string): never {
  throw new TypeError(`Invalid graph visualization document: ${reason}`);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !isPlainObject(value)) {
    invalid(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${path} has unexpected or missing fields`);
  }
}

function string(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    invalid(`${path} must be ${nonEmpty ? "a non-empty string" : "a string"}`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${path} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative integer`);
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${path} must be an array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(`${path} must not be sparse`);
    }
  }
  return value;
}

function jsonValue(value: unknown, path: string, ancestors: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    finiteNumber(value, path);
    return;
  }
  if (typeof value !== "object") {
    invalid(`${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    invalid(`${path} must not contain cycles`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      array(value, path);
      value.forEach((entry, index) => jsonValue(entry, `${path}[${index}]`, ancestors));
      return;
    }
    if (!isPlainObject(value)) {
      invalid(`${path} must contain only arrays and plain objects`);
    }
    for (const [key, entry] of Object.entries(value)) {
      jsonValue(entry, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function source(value: unknown): GraphVisualizationSource {
  const candidate = record(value, "source");
  if (candidate.kind === "memory" && candidate.scope === "workspace") {
    exactKeys(candidate, ["kind", "scope"], "source");
    return { kind: "memory", scope: "workspace" };
  }
  if (candidate.kind === "memory" && candidate.scope === "branch") {
    exactKeys(candidate, ["kind", "scope", "branch"], "source");
    return {
      kind: "memory",
      scope: "branch",
      branch: string(candidate.branch, "source.branch", true),
    };
  }
  return invalid("source has an unsupported discriminant");
}

function validateDocument(value: unknown): GraphVisualizationDocument {
  const document = record(value, "document");
  exactKeys(document, ["schema", "source", "nodes", "edges", "groups", "viewport", "metadata"], "document");
  if (document.schema !== "ragnarok.graph.visualization.v1") {
    invalid("schema must be ragnarok.graph.visualization.v1");
  }
  source(document.source);

  const nodes = array(document.nodes, "nodes");
  if (nodes.length > MAX_NODES) {
    invalid("documents may contain at most 2,000 nodes");
  }
  const nodeIds = new Set<string>();
  const groupReferences = new Map<number, number>();
  for (const [index, valueNode] of nodes.entries()) {
    const node = record(valueNode, `nodes[${index}]`);
    exactKeys(node, ["id", "label", "type", "x", "y", "radius", "groupId", "attributes"], `nodes[${index}]`);
    const id = string(node.id, `nodes[${index}].id`, true);
    if (nodeIds.has(id)) {
      invalid(`duplicate node ID ${id}`);
    }
    nodeIds.add(id);
    string(node.label, `nodes[${index}].label`);
    string(node.type, `nodes[${index}].type`, true);
    finiteNumber(node.x, `nodes[${index}].x`);
    finiteNumber(node.y, `nodes[${index}].y`);
    if (finiteNumber(node.radius, `nodes[${index}].radius`) <= 0) {
      invalid(`nodes[${index}].radius must be positive`);
    }
    if (node.groupId !== null) {
      const groupId = nonNegativeInteger(node.groupId, `nodes[${index}].groupId`);
      groupReferences.set(groupId, (groupReferences.get(groupId) ?? 0) + 1);
    }
    const attributes = record(node.attributes, `nodes[${index}].attributes`);
    jsonValue(attributes, `nodes[${index}].attributes`, new Set());
  }

  const edges = array(document.edges, "edges");
  if (edges.length > MAX_EDGES) {
    invalid("documents may contain at most 10,000 edges");
  }
  const edgeIds = new Set<string>();
  for (const [index, valueEdge] of edges.entries()) {
    const edge = record(valueEdge, `edges[${index}]`);
    exactKeys(edge, ["id", "source", "target", "label", "weight", "attributes"], `edges[${index}]`);
    const id = string(edge.id, `edges[${index}].id`, true);
    if (edgeIds.has(id)) {
      invalid(`duplicate edge ID ${id}`);
    }
    edgeIds.add(id);
    const edgeSource = string(edge.source, `edges[${index}].source`, true);
    const edgeTarget = string(edge.target, `edges[${index}].target`, true);
    if (!nodeIds.has(edgeSource) || !nodeIds.has(edgeTarget)) {
      invalid(`dangling edge endpoint on ${id}`);
    }
    string(edge.label, `edges[${index}].label`);
    finiteNumber(edge.weight, `edges[${index}].weight`);
    const attributes = record(edge.attributes, `edges[${index}].attributes`);
    jsonValue(attributes, `edges[${index}].attributes`, new Set());
  }

  const groups = array(document.groups, "groups");
  const groupIds = new Set<number>();
  for (const [index, valueGroup] of groups.entries()) {
    const group = record(valueGroup, `groups[${index}]`);
    exactKeys(group, ["id", "label", "color", "retainedNodeCount"], `groups[${index}]`);
    const id = nonNegativeInteger(group.id, `groups[${index}].id`);
    if (groupIds.has(id)) {
      invalid(`duplicate group ID ${id}`);
    }
    groupIds.add(id);
    string(group.label, `groups[${index}].label`);
    const color = string(group.color, `groups[${index}].color`);
    if (!COLOR_PATTERN.test(color)) {
      invalid(`groups[${index}].color must be a six-digit hexadecimal color`);
    }
    const retainedNodeCount = nonNegativeInteger(group.retainedNodeCount, `groups[${index}].retainedNodeCount`);
    if (!groupReferences.has(id) || groupReferences.get(id) !== retainedNodeCount) {
      invalid(`dangling group ${id}`);
    }
  }
  for (const id of groupReferences.keys()) {
    if (!groupIds.has(id)) {
      invalid(`dangling group reference ${id}`);
    }
  }

  const viewport = record(document.viewport, "viewport");
  exactKeys(viewport, ["minX", "minY", "maxX", "maxY"], "viewport");
  const minX = finiteNumber(viewport.minX, "viewport.minX");
  const minY = finiteNumber(viewport.minY, "viewport.minY");
  const maxX = finiteNumber(viewport.maxX, "viewport.maxX");
  const maxY = finiteNumber(viewport.maxY, "viewport.maxY");
  if (minX > maxX || minY > maxY) {
    invalid("viewport minimums must not exceed maximums");
  }

  const metadata = record(document.metadata, "metadata");
  exactKeys(
    metadata,
    [
      "originalNodeCount",
      "retainedNodeCount",
      "originalEdgeCount",
      "retainedEdgeCount",
      "truncated",
      "truncationReasons",
      "empty",
    ],
    "metadata",
  );
  const originalNodeCount = nonNegativeInteger(metadata.originalNodeCount, "metadata.originalNodeCount");
  const retainedNodeCount = nonNegativeInteger(metadata.retainedNodeCount, "metadata.retainedNodeCount");
  const originalEdgeCount = nonNegativeInteger(metadata.originalEdgeCount, "metadata.originalEdgeCount");
  const retainedEdgeCount = nonNegativeInteger(metadata.retainedEdgeCount, "metadata.retainedEdgeCount");
  if (retainedNodeCount !== nodes.length || retainedEdgeCount !== edges.length) {
    invalid("metadata retained counts must match the document arrays");
  }
  if (originalNodeCount < retainedNodeCount || originalEdgeCount < retainedEdgeCount) {
    invalid("metadata original counts must not be below retained counts");
  }
  if (typeof metadata.truncated !== "boolean" || typeof metadata.empty !== "boolean") {
    invalid("metadata truncated and empty fields must be booleans");
  }
  if (metadata.empty !== (nodes.length === 0)) {
    invalid("metadata.empty must match the node array");
  }
  const reasons = array(metadata.truncationReasons, "metadata.truncationReasons");
  const seenReasons = new Set<string>();
  let previousReasonOrder = -1;
  for (const reason of reasons) {
    if (typeof reason !== "string" || !TRUNCATION_REASONS.has(reason) || seenReasons.has(reason)) {
      invalid("metadata.truncationReasons contains an unsupported or duplicate reason");
    }
    const reasonOrder = TRUNCATION_REASON_ORDER.get(reason)!;
    if (reasonOrder < previousReasonOrder) {
      invalid("metadata.truncationReasons must use canonical order");
    }
    seenReasons.add(reason);
    previousReasonOrder = reasonOrder;
  }
  if (metadata.truncated !== reasons.length > 0) {
    invalid("metadata.truncated must match metadata.truncationReasons");
  }

  return value as GraphVisualizationDocument;
}

function parseText(result: ToolResultLike): unknown | undefined {
  const block = result.content?.find((candidate) => candidate.type === "text" && typeof candidate.text === "string");
  if (!block) {
    return undefined;
  }
  try {
    return JSON.parse(block.text as string) as unknown;
  } catch {
    throw new TypeError("Graph tool result text is not valid JSON.");
  }
}

function canonical(value: JsonValue | GraphVisualizationDocument): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    invalid("canonical values must contain only arrays and plain objects");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, JsonValue>)[key])}`)
    .join(",")}}`;
}

export function parseGraphVisualizationResult(result: ToolResultLike): GraphVisualizationDocument {
  if (result.isError) {
    throw new TypeError("Graph tool returned an error.");
  }
  const textContent = parseText(result);
  if (result.structuredContent === undefined && textContent === undefined) {
    throw new TypeError("Graph tool result did not include graph visualization content.");
  }

  const structuredDocument =
    result.structuredContent === undefined ? undefined : validateDocument(result.structuredContent);
  const textDocument = textContent === undefined ? undefined : validateDocument(textContent);
  if (structuredDocument && textDocument && canonical(structuredDocument) !== canonical(textDocument)) {
    throw new TypeError("Graph tool result representations do not match.");
  }
  return structuredDocument ?? textDocument!;
}
