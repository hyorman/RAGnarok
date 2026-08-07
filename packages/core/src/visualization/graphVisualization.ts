import { MultiUndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { MemoryEntity, MemoryRelationship } from "../memory/types";
import type { GraphEntity, GraphRelationship } from "../utils/graphTypes";

const DEFAULT_MAX_NODES = 500;
const MAX_NODES = 2_000;
const MAX_EDGES = 10_000;
const GROUP_PALETTE = [
  "#7c3aed",
  "#2563eb",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#0891b2",
  "#db2777",
  "#ca8a04",
  "#4f46e5",
  "#059669",
  "#9333ea",
  "#0d9488",
  "#e11d48",
  "#713f12",
  "#1e40af",
  "#b45309",
  "#be185d",
  "#15803d",
  "#1d4ed8",
  "#a16207",
] as const;

const ordinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key;
}

function jsonPropertyOrder(left: string, right: string): number {
  const leftIsIndex = isArrayIndex(left);
  const rightIsIndex = isArrayIndex(right);
  if (leftIsIndex && rightIsIndex) {
    return Number(left) - Number(right);
  }
  if (leftIsIndex) {
    return -1;
  }
  if (rightIsIndex) {
    return 1;
  }
  return ordinal(left, right);
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type GraphVisualizationSource =
  | { kind: "knowledge"; topicId: string; topicName: string }
  | { kind: "memory"; scope: "workspace" }
  | { kind: "memory"; scope: "branch"; branch: string };

export interface GraphVisualizationOptions {
  maxNodes?: number;
}

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

type TruncationReason = "maxNodes" | "maxEdges" | "responseBytes";

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
    truncationReasons: TruncationReason[];
    empty: boolean;
  };
}

interface ProjectedEntity {
  id: string;
  label: string;
  type: string;
  attributes: Record<string, unknown>;
}

interface ProjectedRelationship {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  attributes: Record<string, unknown>;
}

function validateMaxNodes(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_NODES;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_NODES) {
    throw new RangeError(`maxNodes must be an integer between 1 and ${MAX_NODES}`);
  }
  return normalized;
}

function toJsonValue(value: unknown, ancestors = new Set<object>(), key?: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported graph visualization value: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Cyclic graph visualization values are not supported");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Sparse graph visualization arrays are not supported");
        }
      }
      const result = value.map((item) => toJsonValue(item, ancestors));
      if (key === "sourceChunkIds" || key === "sourceMemoryIds") {
        result.sort((left, right) => ordinal(String(left), String(right)));
      }
      return result;
    }

    const result: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value).sort(([left], [right]) =>
      jsonPropertyOrder(left, right),
    )) {
      Object.defineProperty(result, entryKey, {
        value: toJsonValue(entryValue, ancestors, entryKey),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return toJsonValue(value) as Record<string, JsonValue>;
}

function createXorshift32(): () => number {
  let state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function normalizeGroups(communities: Map<string | number, string[]>): Map<string, number> {
  const ordered = [...communities.values()]
    .map((members) => members.sort(ordinal))
    .sort((left, right) => right.length - left.length || ordinal(left[0], right[0]));
  const groupByNode = new Map<string, number>();
  ordered.forEach((members, groupId) => {
    for (const member of members) {
      groupByNode.set(member, groupId);
    }
  });
  return groupByNode;
}

function knowledgeGroups(nodeIds: readonly string[], edges: readonly ProjectedRelationship[]): Map<string, number> {
  const graph = new MultiUndirectedGraph();
  for (const nodeId of [...nodeIds].sort(ordinal)) {
    graph.addNode(nodeId);
  }
  for (const edge of [...edges].sort((left, right) => ordinal(left.id, right.id))) {
    graph.addEdgeWithKey(edge.id, edge.source, edge.target, { weight: edge.weight });
  }

  const mapping = louvain(graph, { getEdgeWeight: "weight", randomWalk: true, rng: createXorshift32() });
  const communities = new Map<number, string[]>();
  for (const nodeId of nodeIds) {
    const community = mapping[nodeId];
    const members = communities.get(community);
    if (members) {
      members.push(nodeId);
    } else {
      communities.set(community, [nodeId]);
    }
  }
  return normalizeGroups(communities);
}

function memoryGroups(nodeIds: readonly string[], edges: readonly ProjectedRelationship[]): Map<string, number> {
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.source)!.push(edge.target);
    adjacency.get(edge.target)!.push(edge.source);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort(ordinal);
  }

  const visited = new Set<string>();
  const communities = new Map<number, string[]>();
  for (const start of [...nodeIds].sort(ordinal)) {
    if (visited.has(start)) {
      continue;
    }
    const members: string[] = [];
    const queue = [start];
    visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      members.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    communities.set(communities.size, members);
  }
  return normalizeGroups(communities);
}

function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

function nodeRadius(degree: number): number {
  return Math.max(6, Math.min(22, Math.round(Math.sqrt(degree) * 3 + 6)));
}

function jitter(id: string): { x: number; y: number } {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) / 0x1_0000_0000) * Math.PI * 2;
  const magnitude = ((hash >>> 16) / 0xffff) * 6;
  return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
}

function calculateViewport(nodes: readonly GraphVisualizationNode[]): GraphVisualizationDocument["viewport"] {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return {
    minX: Math.min(...nodes.map((node) => node.x - node.radius)),
    minY: Math.min(...nodes.map((node) => node.y - node.radius)),
    maxX: Math.max(...nodes.map((node) => node.x + node.radius)),
    maxY: Math.max(...nodes.map((node) => node.y + node.radius)),
  };
}

function placeNodes(
  retainedIds: readonly string[],
  entityById: ReadonlyMap<string, ProjectedEntity>,
  totalDegree: ReadonlyMap<string, number>,
  retainedEdges: readonly ProjectedRelationship[],
  detectedGroups: ReadonlyMap<string, number>,
): { nodes: GraphVisualizationNode[]; groups: GraphVisualizationGroup[] } {
  const retainedDegree = new Map<string, number>();
  for (const edge of retainedEdges) {
    retainedDegree.set(edge.source, (retainedDegree.get(edge.source) ?? 0) + 1);
    retainedDegree.set(edge.target, (retainedDegree.get(edge.target) ?? 0) + 1);
  }

  const membersByDetectedGroup = new Map<number, string[]>();
  const isolatedIds: string[] = [];
  for (const nodeId of retainedIds) {
    if ((retainedDegree.get(nodeId) ?? 0) === 0) {
      isolatedIds.push(nodeId);
      continue;
    }
    const detectedGroup = detectedGroups.get(nodeId)!;
    const members = membersByDetectedGroup.get(detectedGroup);
    if (members) {
      members.push(nodeId);
    } else {
      membersByDetectedGroup.set(detectedGroup, [nodeId]);
    }
  }

  const orderedMemberGroups = [...membersByDetectedGroup.values()]
    .map((members) => members.sort(ordinal))
    .sort((left, right) => right.length - left.length || ordinal(left[0], right[0]));
  const groupByNode = new Map<string, number>();
  orderedMemberGroups.forEach((members, groupId) => {
    for (const member of members) {
      groupByNode.set(member, groupId);
    }
  });

  const inGroupDegree = new Map<string, number>();
  for (const edge of retainedEdges) {
    const sourceGroup = groupByNode.get(edge.source);
    if (sourceGroup !== undefined && sourceGroup === groupByNode.get(edge.target)) {
      inGroupDegree.set(edge.source, (inGroupDegree.get(edge.source) ?? 0) + 1);
      inGroupDegree.set(edge.target, (inGroupDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const maximumMemberRingRadius = orderedMemberGroups.reduce(
    (maximum, members) => Math.max(maximum, 48 + Math.floor((members.length - 1) / 8) * 36),
    0,
  );
  const groupCount = orderedMemberGroups.length;
  const centroidRadius = groupCount > 1 ? Math.max(240, 2 * maximumMemberRingRadius + groupCount * 120) : 0;
  const positions = new Map<string, { x: number; y: number }>();

  orderedMemberGroups.forEach((members, groupId) => {
    const centroidAngle = (Math.PI * 2 * groupId) / groupCount;
    const centerX = Math.cos(centroidAngle) * centroidRadius;
    const centerY = Math.sin(centroidAngle) * centroidRadius;
    members.sort(
      (left, right) =>
        (inGroupDegree.get(right) ?? 0) - (inGroupDegree.get(left) ?? 0) ||
        (totalDegree.get(right) ?? 0) - (totalDegree.get(left) ?? 0) ||
        ordinal(left, right),
    );
    members.forEach((nodeId, memberIndex) => {
      const ringIndex = Math.floor(memberIndex / 8);
      const ringOffset = ringIndex * 8;
      const ringSize = Math.min(8, members.length - ringOffset);
      const angle = (Math.PI * 2 * (memberIndex - ringOffset)) / ringSize;
      const ringRadius = 48 + ringIndex * 36;
      const offset = jitter(nodeId);
      positions.set(nodeId, {
        x: roundCoordinate(centerX + Math.cos(angle) * ringRadius + offset.x),
        y: roundCoordinate(centerY + Math.sin(angle) * ringRadius + offset.y),
      });
    });
  });

  let maximumOccupiedGroupExtent = 0;
  for (const members of orderedMemberGroups) {
    for (const nodeId of members) {
      const position = positions.get(nodeId)!;
      maximumOccupiedGroupExtent = Math.max(
        maximumOccupiedGroupExtent,
        Math.hypot(position.x, position.y) + nodeRadius(totalDegree.get(nodeId) ?? 0),
      );
    }
  }
  const isolatedRingRadius = maximumOccupiedGroupExtent + 120;
  isolatedIds.forEach((nodeId, index) => {
    const angle = (Math.PI * 2 * index) / isolatedIds.length;
    const offset = jitter(nodeId);
    positions.set(nodeId, {
      x: roundCoordinate(Math.cos(angle) * isolatedRingRadius + offset.x),
      y: roundCoordinate(Math.sin(angle) * isolatedRingRadius + offset.y),
    });
  });

  const nodes = retainedIds.map((nodeId) => {
    const entity = entityById.get(nodeId)!;
    const position = positions.get(nodeId)!;
    return {
      id: nodeId,
      label: entity.label,
      type: entity.type,
      x: position.x,
      y: position.y,
      radius: nodeRadius(totalDegree.get(nodeId) ?? 0),
      groupId: groupByNode.get(nodeId) ?? null,
      attributes: toJsonRecord(entity.attributes),
    };
  });
  const groups = orderedMemberGroups.map((members, id) => ({
    id,
    label: `Group ${id + 1}`,
    color: GROUP_PALETTE[id % GROUP_PALETTE.length],
    retainedNodeCount: members.length,
  }));
  return { nodes, groups };
}

function projectGraphVisualization(
  entities: readonly ProjectedEntity[],
  relationships: readonly ProjectedRelationship[],
  source: GraphVisualizationSource,
  graphKind: "knowledge" | "memory",
  maxNodes: number,
): GraphVisualizationDocument {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const degree = new Map<string, number>();
  for (const edge of relationships) {
    if (!entityById.has(edge.source) || !entityById.has(edge.target)) {
      continue;
    }
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const rankedIds = [...entityById.keys()].sort(
    (left, right) => (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || ordinal(left, right),
  );
  const retainedIds = rankedIds.slice(0, maxNodes);
  const retainedIdSet = new Set(retainedIds);
  const eligibleEdges = relationships.filter(
    (edge) => retainedIdSet.has(edge.source) && retainedIdSet.has(edge.target),
  );
  const retainedEdges = eligibleEdges
    .sort((left, right) => right.weight - left.weight || ordinal(left.id, right.id))
    .slice(0, MAX_EDGES);
  const detectedGroups =
    graphKind === "knowledge" ? knowledgeGroups(retainedIds, retainedEdges) : memoryGroups(retainedIds, retainedEdges);
  const { nodes, groups } = placeNodes(retainedIds, entityById, degree, retainedEdges, detectedGroups);
  const edges = retainedEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    weight: edge.weight,
    attributes: toJsonRecord(edge.attributes),
  }));
  const truncationReasons: TruncationReason[] = [];
  if (rankedIds.length > maxNodes) {
    truncationReasons.push("maxNodes");
  }
  if (eligibleEdges.length > MAX_EDGES) {
    truncationReasons.push("maxEdges");
  }

  return {
    schema: "ragnarok.graph.visualization.v1",
    source,
    nodes,
    edges,
    groups,
    viewport: calculateViewport(nodes),
    metadata: {
      originalNodeCount: entities.length,
      retainedNodeCount: nodes.length,
      originalEdgeCount: relationships.length,
      retainedEdgeCount: edges.length,
      truncated: truncationReasons.length > 0,
      truncationReasons,
      empty: nodes.length === 0,
    },
  };
}

export function projectKnowledgeGraphVisualization(
  snapshot: { entities: readonly GraphEntity[]; relationships: readonly GraphRelationship[] },
  source: Extract<GraphVisualizationSource, { kind: "knowledge" }>,
  options: GraphVisualizationOptions = {},
): GraphVisualizationDocument {
  const entities: ProjectedEntity[] = snapshot.entities.map((entity) => ({
    id: entity.id,
    label: entity.name,
    type: entity.type,
    attributes: {
      description: entity.description,
      sourceChunkIds: entity.sourceChunkIds,
      confidence: entity.confidence,
      strength: entity.strength,
      lastAccessedAt: entity.lastAccessedAt,
      metadata: entity.metadata,
    },
  }));
  const relationships: ProjectedRelationship[] = snapshot.relationships.map((relationship) => ({
    id: relationship.id,
    source: relationship.sourceId,
    target: relationship.targetId,
    label: relationship.type,
    weight: relationship.weight,
    attributes: {
      ...(relationship.description === undefined ? {} : { description: relationship.description }),
      sourceChunkIds: relationship.sourceChunkIds,
      confidence: relationship.confidence,
      metadata: relationship.metadata,
    },
  }));
  return projectGraphVisualization(entities, relationships, source, "knowledge", validateMaxNodes(options.maxNodes));
}

export function projectMemoryGraphVisualization(
  snapshot: { entities: readonly Omit<MemoryEntity, "vector">[]; relationships: readonly MemoryRelationship[] },
  source: Extract<GraphVisualizationSource, { kind: "memory" }>,
  options: GraphVisualizationOptions = {},
): GraphVisualizationDocument {
  const entities: ProjectedEntity[] = snapshot.entities.map((entity) => ({
    id: entity.id,
    label: entity.name,
    type: entity.type,
    attributes: {
      description: entity.description,
      scope: entity.scope,
      ...(entity.branch === undefined ? {} : { branch: entity.branch }),
      confidence: entity.confidence,
      strength: entity.strength,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      sourceMemoryIds: entity.sourceMemoryIds,
      metadata: entity.metadata,
    },
  }));
  const relationships: ProjectedRelationship[] = snapshot.relationships.map((relationship) => ({
    id: relationship.id,
    source: relationship.sourceId,
    target: relationship.targetId,
    label: relationship.type,
    weight: relationship.weight,
    attributes: {
      description: relationship.description,
      scope: relationship.scope,
      ...(relationship.branch === undefined ? {} : { branch: relationship.branch }),
      metadata: relationship.metadata,
    },
  }));
  return projectGraphVisualization(entities, relationships, source, "memory", validateMaxNodes(options.maxNodes));
}

export function reduceGraphVisualizationDocument(
  document: GraphVisualizationDocument,
  retainedNodeCount: number,
  retainedEdgeCount: number,
): GraphVisualizationDocument {
  const nodes = document.nodes.slice(0, retainedNodeCount);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgePrefix = document.edges.slice(0, retainedEdgeCount);
  const edges = edgePrefix.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const groupCounts = new Map<number, number>();
  for (const node of nodes) {
    if (node.groupId !== null) {
      groupCounts.set(node.groupId, (groupCounts.get(node.groupId) ?? 0) + 1);
    }
  }
  const groups = document.groups
    .filter((group) => groupCounts.has(group.id))
    .map((group) => ({ ...group, retainedNodeCount: groupCounts.get(group.id)! }));
  const reduced = nodes.length < document.nodes.length || edgePrefix.length < document.edges.length;
  const truncationReasons = [...new Set(document.metadata.truncationReasons)] as TruncationReason[];
  if (reduced && !truncationReasons.includes("responseBytes")) {
    truncationReasons.push("responseBytes");
  }

  return {
    ...document,
    nodes,
    edges,
    groups,
    viewport: calculateViewport(nodes),
    metadata: {
      ...document.metadata,
      retainedNodeCount: nodes.length,
      retainedEdgeCount: edges.length,
      truncated: truncationReasons.length > 0,
      truncationReasons,
      empty: nodes.length === 0,
    },
  };
}
