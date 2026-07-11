import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { cosineSimilarity } from "../utils/vectorMath";

import { Logger } from "../logger";
import {
  GraphEntity,
  GraphRelationship,
  GraphCommunity,
  KnowledgeGraphData,
  KnowledgeGraphStats,
  EntityType,
} from "../utils/graphTypes";

/**
 * In-memory knowledge graph wrapping graphology DirectedGraph.
 * Scoped to a single topic — one KnowledgeGraph per topic.
 */
export class KnowledgeGraph {
  private graph: Graph;
  private topicId: string;
  private logger: Logger;
  private communities: GraphCommunity[] = [];

  constructor(topicId: string) {
    this.topicId = topicId;
    this.graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });
    this.logger = new Logger("KnowledgeGraph");
  }

  // ── Entity operations ──────────────────────────────────────────────

  addEntity(entity: GraphEntity): void {
    if (this.graph.hasNode(entity.id)) {
      throw new Error(`Entity already exists: ${entity.id}`);
    }
    const { id, ...attrs } = entity;
    this.graph.addNode(id, attrs);
    this.logger.debug(`Added entity: ${id}`);
  }

  updateEntity(id: string, updates: Partial<Omit<GraphEntity, "id">>): void {
    if (!this.graph.hasNode(id)) {
      throw new Error(`Entity not found: ${id}`);
    }
    this.graph.mergeNodeAttributes(id, updates);
    this.logger.debug(`Updated entity: ${id}`);
  }

  getEntity(id: string): GraphEntity | null {
    if (!this.graph.hasNode(id)) {
      return null;
    }
    return this.nodeToEntity(id);
  }

  removeEntity(id: string): void {
    if (!this.graph.hasNode(id)) {
      throw new Error(`Entity not found: ${id}`);
    }
    this.graph.dropNode(id);
    this.logger.debug(`Removed entity: ${id}`);
  }

  findEntitiesByName(name: string): GraphEntity[] {
    const lowerName = name.toLowerCase();
    const results: GraphEntity[] = [];
    this.graph.forEachNode((node, attrs) => {
      if ((attrs.name as string).toLowerCase().includes(lowerName)) {
        results.push(this.nodeToEntity(node));
      }
    });
    return results;
  }

  findEntitiesByExactName(name: string): GraphEntity[] {
    const lowerName = name.toLowerCase();
    const results: GraphEntity[] = [];
    this.graph.forEachNode((node, attrs) => {
      if ((attrs.name as string).toLowerCase() === lowerName) {
        results.push(this.nodeToEntity(node));
      }
    });
    return results;
  }

  findEntitiesByType(type: EntityType): GraphEntity[] {
    const results: GraphEntity[] = [];
    this.graph.forEachNode((node, attrs) => {
      if (attrs.type === type) {
        results.push(this.nodeToEntity(node));
      }
    });
    return results;
  }

  getAllEntities(): GraphEntity[] {
    return this.graph.nodes().map((node) => this.nodeToEntity(node));
  }

  /**
   * Search entities by embedding vector similarity (cosine similarity).
   * Operates on in-memory entity vectors — no external DB call.
   */
  searchEntitiesByEmbedding(queryVector: number[], k: number): Array<{ entity: GraphEntity; score: number }> {
    const results: Array<{ entity: GraphEntity; score: number }> = [];
    this.graph.forEachNode((node, attrs) => {
      const entityVector = attrs.vector as number[] | undefined;
      if (!entityVector || entityVector.length === 0) {
        return;
      }
      const score = cosineSimilarity(queryVector, entityVector);
      results.push({ entity: this.nodeToEntity(node), score });
    });
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  // ── Relationship operations ────────────────────────────────────────

  addRelationship(rel: GraphRelationship): void {
    if (this.graph.hasEdge(rel.id)) {
      throw new Error(`Relationship already exists: ${rel.id}`);
    }
    if (!this.graph.hasNode(rel.sourceId)) {
      throw new Error(`Source entity not found: ${rel.sourceId}`);
    }
    if (!this.graph.hasNode(rel.targetId)) {
      throw new Error(`Target entity not found: ${rel.targetId}`);
    }
    const { id, sourceId, targetId, ...attrs } = rel;
    this.graph.addEdgeWithKey(id, sourceId, targetId, attrs);
    this.logger.debug(`Added relationship: ${id} (${sourceId} → ${targetId})`);
  }

  updateRelationship(id: string, updates: Partial<Omit<GraphRelationship, "id" | "sourceId" | "targetId">>): void {
    if (!this.graph.hasEdge(id)) {
      throw new Error(`Relationship not found: ${id}`);
    }
    this.graph.mergeEdgeAttributes(id, updates);
    this.logger.debug(`Updated relationship: ${id}`);
  }

  getRelationship(id: string): GraphRelationship | null {
    if (!this.graph.hasEdge(id)) {
      return null;
    }
    return this.edgeToRelationship(id);
  }

  removeRelationship(id: string): void {
    if (!this.graph.hasEdge(id)) {
      throw new Error(`Relationship not found: ${id}`);
    }
    this.graph.dropEdge(id);
    this.logger.debug(`Removed relationship: ${id}`);
  }

  getRelationshipsBetween(sourceId: string, targetId: string): GraphRelationship[] {
    return this.graph.edges(sourceId, targetId).map((edge) => this.edgeToRelationship(edge));
  }

  getAllRelationships(): GraphRelationship[] {
    return this.graph.edges().map((edge) => this.edgeToRelationship(edge));
  }

  // ── Graph traversal ────────────────────────────────────────────────

  getNeighbors(entityId: string, options?: { direction?: "in" | "out" | "both"; maxDepth?: number }): GraphEntity[] {
    const direction = options?.direction ?? "both";
    const maxDepth = options?.maxDepth ?? 1;
    if (!this.graph.hasNode(entityId)) {
      return [];
    }

    if (maxDepth === 1) {
      const neighborIds = this.getImmediateNeighborIds(entityId, direction);
      return neighborIds.map((id) => this.nodeToEntity(id));
    }

    const visited = new Set<string>([entityId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: entityId, depth: 0 }];
    const results: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        continue;
      }

      for (const neighborId of this.getImmediateNeighborIds(current.id, direction)) {
        if (visited.has(neighborId)) {
          continue;
        }
        visited.add(neighborId);
        results.push(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
      }
    }

    return results.map((id) => this.nodeToEntity(id));
  }

  getSubgraph(entityIds: string[]): KnowledgeGraphData {
    const idSet = new Set(entityIds);
    const entities = entityIds.filter((id) => this.graph.hasNode(id)).map((id) => this.nodeToEntity(id));
    const relationships = this.graph
      .edges()
      .filter((edge) => {
        const source = this.graph.source(edge);
        const target = this.graph.target(edge);
        return idSet.has(source) && idSet.has(target);
      })
      .map((edge) => this.edgeToRelationship(edge));

    return {
      entities,
      relationships,
      communities: [],
      metadata: {
        topicId: this.topicId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: entities.length,
        edgeCount: relationships.length,
        communityCount: 0,
        embeddingModel: "",
      },
    };
  }

  traverseBFS(
    startId: string,
    callback: (entity: GraphEntity, depth: number) => boolean | void,
    maxDepth?: number,
  ): void {
    if (!this.graph.hasNode(startId)) {
      throw new Error(`Entity not found: ${startId}`);
    }

    const visited = new Set<string>([startId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const shouldStop = callback(this.nodeToEntity(current.id), current.depth);
      if (shouldStop) {
        return;
      }

      if (maxDepth !== undefined && current.depth >= maxDepth) {
        continue;
      }

      for (const neighborId of this.getImmediateNeighborIds(current.id, "both")) {
        if (visited.has(neighborId)) {
          continue;
        }
        visited.add(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
      }
    }
  }

  // ── Community detection ────────────────────────────────────────────

  detectCommunities(options?: { resolution?: number }): Map<number, string[]> {
    const communityMap = new Map<number, string[]>();
    if (this.graph.order === 0) {
      return communityMap;
    }

    louvain.assign(this.graph, { resolution: options?.resolution ?? 1.0 });

    this.graph.forEachNode((node, attrs) => {
      const communityId = attrs.community as number;
      if (!communityMap.has(communityId)) {
        communityMap.set(communityId, []);
      }
      communityMap.get(communityId)!.push(node);
    });

    this.communities = Array.from(communityMap.entries()).map(([id, entityIds]) => ({
      id,
      entityIds,
      level: 0,
      metadata: {},
    }));

    this.logger.debug(`Detected ${this.communities.length} communities`);
    return communityMap;
  }

  getCommunities(): GraphCommunity[] {
    return this.communities;
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON(): KnowledgeGraphData {
    return {
      entities: this.getAllEntities(),
      relationships: this.getAllRelationships(),
      communities: this.communities,
      metadata: {
        topicId: this.topicId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: this.graph.order,
        edgeCount: this.graph.size,
        communityCount: this.communities.length,
        embeddingModel: "",
      },
    };
  }

  static fromJSON(data: KnowledgeGraphData): KnowledgeGraph {
    const kg = new KnowledgeGraph(data.metadata.topicId);
    for (const entity of data.entities) {
      kg.addEntity(entity);
    }
    for (const rel of data.relationships) {
      kg.addRelationship(rel);
    }
    kg.communities = data.communities;
    return kg;
  }

  // ── Statistics ─────────────────────────────────────────────────────

  getStats(): KnowledgeGraphStats {
    const entityCount = this.graph.order;
    const edgeCount = this.graph.size;
    return {
      entityCount,
      edgeCount,
      averageDegree: entityCount > 0 ? (edgeCount * 2) / entityCount : 0,
      communityCount: this.communities.length,
      density: entityCount > 1 ? edgeCount / (entityCount * (entityCount - 1)) : 0,
      connectedComponents: this.countConnectedComponents(),
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private nodeToEntity(nodeId: string): GraphEntity {
    const attrs = this.graph.getNodeAttributes(nodeId);
    return { id: nodeId, ...attrs } as GraphEntity;
  }

  private edgeToRelationship(edgeId: string): GraphRelationship {
    const attrs = this.graph.getEdgeAttributes(edgeId);
    return {
      id: edgeId,
      sourceId: this.graph.source(edgeId),
      targetId: this.graph.target(edgeId),
      ...attrs,
    } as GraphRelationship;
  }

  private countConnectedComponents(): number {
    if (this.graph.order === 0) {
      return 0;
    }
    const visited = new Set<string>();
    let components = 0;
    for (const node of this.graph.nodes()) {
      if (!visited.has(node)) {
        components++;
        const queue = [node];
        visited.add(node);
        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const neighborId of this.getImmediateNeighborIds(current, "both")) {
            if (visited.has(neighborId)) {
              continue;
            }
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
      }
    }
    return components;
  }

  private getImmediateNeighborIds(nodeId: string, direction: "in" | "out" | "both"): string[] {
    if (direction === "out") {
      return this.graph.outNeighbors(nodeId);
    }
    if (direction === "in") {
      return this.graph.inNeighbors(nodeId);
    }
    return Array.from(new Set([...this.graph.outNeighbors(nodeId), ...this.graph.inNeighbors(nodeId)]));
  }
}
