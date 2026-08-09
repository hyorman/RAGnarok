/**
 * In-memory entity graph for the standalone memory module.
 * Wraps graphology DirectedGraph, scoped to a single partition (workspace or branch).
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { Logger } from "../logger";
import { cosineSimilarity } from "../utils/vectorMath";
import { MemoryEntity, MemoryRelationship, MemoryGraphData, MemoryEntityType, MemoryCommunity } from "./types";

export class MemoryGraph {
  private graph: Graph;
  private communities: MemoryCommunity[] = [];
  private logger = new Logger("MemoryGraph");

  constructor() {
    // Different semantic relationship types may connect the same ordered
    // entity pair. Graphology must therefore preserve keyed parallel edges.
    this.graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });
  }

  // ── Entity Operations ──────────────────────────────────────────────

  addEntity(entity: MemoryEntity): void {
    if (this.graph.hasNode(entity.id)) {
      this.logger.warn(`Entity ${entity.id} already exists, updating instead`);
      this.updateEntity(entity.id, entity);
      return;
    }
    this.graph.addNode(entity.id, { ...entity });
  }

  updateEntity(id: string, updates: Partial<Omit<MemoryEntity, "id">>): void {
    if (!this.graph.hasNode(id)) {
      this.logger.warn(`Entity ${id} not found for update`);
      return;
    }
    const current = this.graph.getNodeAttributes(id) as MemoryEntity;
    this.graph.replaceNodeAttributes(id, { ...current, ...updates, id });
  }

  getEntity(id: string): MemoryEntity | null {
    if (!this.graph.hasNode(id)) {
      return null;
    }
    return this.graph.getNodeAttributes(id) as MemoryEntity;
  }

  removeEntity(id: string): void {
    if (!this.graph.hasNode(id)) {
      return;
    }
    // Remove all connected edges first
    const edges = this.graph.edges(id);
    for (const edgeId of edges) {
      this.graph.dropEdge(edgeId);
    }
    this.graph.dropNode(id);
  }

  /** Find entities by exact name+type key (case-insensitive) */
  findDuplicate(name: string, type: MemoryEntityType): MemoryEntity | null {
    const normalizedName = name.toLowerCase();
    for (const nodeId of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(nodeId) as MemoryEntity;
      if (attrs.name.toLowerCase() === normalizedName && attrs.type === type) {
        return attrs;
      }
    }
    return null;
  }

  /** Find entities by name substring (case-insensitive) */
  findByName(name: string): MemoryEntity[] {
    const results: MemoryEntity[] = [];
    const normalizedName = name.toLowerCase();
    for (const nodeId of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(nodeId) as MemoryEntity;
      if (attrs.name.toLowerCase().includes(normalizedName)) {
        results.push(attrs);
      }
    }
    return results;
  }

  /** Vector similarity search across all entities */
  searchByEmbedding(queryVector: number[], k: number): Array<{ entity: MemoryEntity; score: number }> {
    const results: Array<{ entity: MemoryEntity; score: number }> = [];

    for (const nodeId of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(nodeId) as MemoryEntity;
      if (!attrs.vector || attrs.vector.length === 0) {
        continue;
      }
      const score = cosineSimilarity(queryVector, attrs.vector);
      results.push({ entity: attrs, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  getAllEntities(): MemoryEntity[] {
    return this.graph.nodes().map((id) => this.graph.getNodeAttributes(id) as MemoryEntity);
  }

  // ── Relationship Operations ────────────────────────────────────────

  addRelationship(rel: MemoryRelationship): void {
    if (!this.graph.hasNode(rel.sourceId) || !this.graph.hasNode(rel.targetId)) {
      this.logger.warn(
        `Cannot add relationship ${rel.id}: source (${rel.sourceId}) or target (${rel.targetId}) not found`,
      );
      return;
    }
    if (this.graph.hasEdge(rel.id)) {
      return;
    }
    try {
      this.graph.addEdgeWithKey(rel.id, rel.sourceId, rel.targetId, { ...rel });
    } catch (error) {
      this.logger.debug(`Unable to add relationship ${rel.id}`, error);
    }
  }

  getRelationship(id: string): MemoryRelationship | null {
    if (!this.graph.hasEdge(id)) {
      return null;
    }
    return this.graph.getEdgeAttributes(id) as MemoryRelationship;
  }

  removeRelationship(id: string): void {
    if (this.graph.hasEdge(id)) {
      this.graph.dropEdge(id);
    }
  }

  getAllRelationships(): MemoryRelationship[] {
    return this.graph.edges().map((id) => this.graph.getEdgeAttributes(id) as MemoryRelationship);
  }

  getEntityRelationships(entityId: string): MemoryRelationship[] {
    if (!this.graph.hasNode(entityId)) {
      return [];
    }
    return this.graph.edges(entityId).map((id) => this.graph.getEdgeAttributes(id) as MemoryRelationship);
  }

  // ── Traversal ──────────────────────────────────────────────────────

  getNeighbors(entityId: string, maxDepth: number = 1): MemoryEntity[] {
    if (!this.graph.hasNode(entityId)) {
      return [];
    }

    const visited = new Set<string>([entityId]);
    let frontier = [entityId];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        for (const neighbor of this.graph.neighbors(nodeId)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }

    // Return all visited except the start node
    visited.delete(entityId);
    return Array.from(visited).map((id) => this.graph.getNodeAttributes(id) as MemoryEntity);
  }

  // ── Community detection ────────────────────────────────────────────

  /**
   * Group entities into communities with Louvain modularity optimisation.
   *
   * Ported from the deleted document KnowledgeGraph, where it was implemented
   * and tested but never called. Communities are what let memory recall answer
   * holistic questions ("what do you know about X overall") instead of only
   * nearest-neighbour lookups.
   */
  detectCommunities(options?: { resolution?: number }): Map<number, string[]> {
    const communityMap = new Map<number, string[]>();
    if (this.graph.order === 0) {
      this.communities = [];
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
    }));

    this.logger.debug(`Detected ${this.communities.length} memory communities`);
    return communityMap;
  }

  getCommunities(): MemoryCommunity[] {
    return this.communities;
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON(): MemoryGraphData {
    return {
      entities: this.getAllEntities(),
      relationships: this.getAllRelationships(),
    };
  }

  static fromJSON(data: MemoryGraphData): MemoryGraph {
    const graph = new MemoryGraph();
    for (const entity of data.entities) {
      graph.addEntity(entity);
    }
    for (const rel of data.relationships) {
      graph.addRelationship(rel);
    }
    return graph;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  get entityCount(): number {
    return this.graph.order;
  }

  get edgeCount(): number {
    return this.graph.size;
  }
}
