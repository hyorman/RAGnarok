/**
 * Cross-scope entity linking for the standalone memory module.
 *
 * Connects entities that appear in both workspace and branch scopes
 * (or across branches) by matching on name + type (case-insensitive).
 */

import { Logger } from "../logger";
import { cosineSimilarity } from "../utils/vectorMath";
import { MemoryVectorStore } from "./memoryVectorStore";
import { MemoryEntity, MemoryGraphData, MemoryRelationship, ScopeLink, DUPLICATE_SIMILARITY_THRESHOLD } from "./types";

export class MemoryScopeLinker {
  private logger = new Logger("MemoryScopeLinker");

  constructor(private vectorStore: MemoryVectorStore) {}

  /**
   * Compare entities in source vs target scope.
   * Match by name + type (case-insensitive). Return links for matching entities.
   */
  async discoverLinks(sourceScope: string, targetScope: string): Promise<ScopeLink[]> {
    const sourceEntities = await this.loadEntitiesForScope(sourceScope);
    const targetEntities = await this.loadEntitiesForScope(targetScope);

    if (sourceEntities.length === 0 || targetEntities.length === 0) {
      return [];
    }

    // Build a lookup map for target entities: key = "name|type" (lowercased)
    const targetMap = new Map<string, MemoryEntity[]>();
    for (const entity of targetEntities) {
      const key = `${entity.name.toLowerCase()}|${entity.type}`;
      const existing = targetMap.get(key) ?? [];
      existing.push(entity);
      targetMap.set(key, existing);
    }

    const links: ScopeLink[] = [];
    for (const source of sourceEntities) {
      const key = `${source.name.toLowerCase()}|${source.type}`;
      const matches = targetMap.get(key);
      if (!matches) {
        continue;
      }
      for (const target of matches) {
        links.push({
          sourceScope,
          targetScope,
          sourceEntityId: source.id,
          targetEntityId: target.id,
          entityName: source.name,
          entityType: source.type,
          confidence: 1.0, // Exact name+type match
        });
      }
    }

    this.logger.debug(`Discovered ${links.length} cross-scope links between "${sourceScope}" and "${targetScope}"`);
    return links;
  }

  /**
   * Copy branch memories to workspace scope (e.g. after branch merge).
   * If entryIds provided, only promote those. Dedup against existing workspace entries.
   *
   * Promotion is graph-consistent: the entities and relationships the promoted
   * entries reference are merged into the workspace graph (deduplicated by
   * name+type with entity-ID remapping), so no promoted entry ends up with
   * entityIds that don't resolve in the workspace scope.
   *
   * Returns count of entries promoted.
   */
  async promoteToWorkspace(branchScope: string, workspaceScope: string, entryIds?: string[]): Promise<number> {
    const branch = this.extractBranch(branchScope);
    if (!branch) {
      this.logger.warn(`Invalid branch scope: "${branchScope}"`);
      return 0;
    }

    const branchEntries = await this.vectorStore.loadEntries("branch", branch);
    const workspaceEntries = await this.vectorStore.loadEntries("workspace");

    // Filter to requested IDs if provided
    const candidates = entryIds ? branchEntries.filter((e) => entryIds.includes(e.id)) : branchEntries;

    // Dedup: skip entries whose embedding is too similar to existing workspace entries
    const toPromote = candidates.filter((e) => {
      if (!e.vector || e.vector.length === 0) {
        return true;
      }
      for (const ws of workspaceEntries) {
        if (ws.vector && ws.vector.length > 0) {
          const similarity = cosineSimilarity(Array.from(e.vector), Array.from(ws.vector));
          if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
            return false;
          }
        }
      }
      return true;
    });

    if (toPromote.length === 0) {
      return 0;
    }

    // Merge the referenced slice of the branch graph into the workspace graph.
    // Yields a branch-entity-ID → workspace-entity-ID remap for the entries.
    const promotedIds = new Set(toPromote.map((e) => e.id));
    const entityIdRemap = await this.mergeGraphForPromotion(
      branch,
      toPromote.flatMap((e) => e.entityIds),
      promotedIds,
    );

    // Re-scope entries to workspace, remapping entity references and
    // converting vectors to plain arrays for LanceDB
    const promoted = toPromote.map((e) => ({
      ...e,
      scope: "workspace" as const,
      branch: undefined,
      // Drop entity IDs that don't resolve (dangling references never made it
      // into the branch graph) instead of carrying them over broken.
      entityIds: e.entityIds.map((id) => entityIdRemap.get(id)).filter((id): id is string => id !== undefined),
      vector: Array.from(e.vector),
      updatedAt: Date.now(),
    }));

    // Ensure existing workspace vectors are also plain arrays before re-save
    const normalized = workspaceEntries.map((e) => ({
      ...e,
      vector: Array.from(e.vector),
    }));
    const merged = [...normalized, ...promoted];
    await this.vectorStore.saveEntries(merged, "workspace");

    this.logger.debug(`Promoted ${promoted.length} entries from branch "${branch}" to workspace`);
    return promoted.length;
  }

  /**
   * Merge the branch-graph entities referenced by promoted entries (and the
   * relationships among them) into the workspace graph.
   *
   * Entities matching an existing workspace entity by name+type are
   * deduplicated: the branch ID remaps onto the workspace entity, whose
   * sourceMemoryIds gain the promoted entry IDs. Unmatched entities are
   * copied over re-scoped to workspace, keeping their IDs.
   *
   * Returns the branch-entity-ID → workspace-entity-ID remap.
   */
  private async mergeGraphForPromotion(
    branch: string,
    referencedEntityIds: string[],
    promotedEntryIds: Set<string>,
  ): Promise<Map<string, string>> {
    const remap = new Map<string, string>();
    const referenced = new Set(referencedEntityIds);
    if (referenced.size === 0) {
      return remap;
    }

    const branchGraph = await this.vectorStore.loadGraph("branch", branch);
    if (!branchGraph) {
      return remap;
    }

    const workspaceGraph: MemoryGraphData = (await this.vectorStore.loadGraph("workspace")) ?? {
      entities: [],
      relationships: [],
    };

    const workspaceByKey = new Map<string, MemoryEntity>();
    for (const entity of workspaceGraph.entities) {
      workspaceByKey.set(`${entity.name.toLowerCase()}|${entity.type}`, entity);
    }

    let graphChanged = false;
    for (const entity of branchGraph.entities) {
      if (!referenced.has(entity.id)) {
        continue;
      }
      const key = `${entity.name.toLowerCase()}|${entity.type}`;
      const existing = workspaceByKey.get(key);
      if (existing) {
        remap.set(entity.id, existing.id);
        const promotedSources = entity.sourceMemoryIds.filter((id) => promotedEntryIds.has(id));
        const mergedSources = new Set([...existing.sourceMemoryIds, ...promotedSources]);
        if (mergedSources.size !== existing.sourceMemoryIds.length) {
          existing.sourceMemoryIds = [...mergedSources];
          existing.updatedAt = Date.now();
          graphChanged = true;
        }
      } else {
        const copied: MemoryEntity = {
          ...entity,
          scope: "workspace",
          branch: undefined,
          vector: Array.from(entity.vector),
          sourceMemoryIds: entity.sourceMemoryIds.filter((id) => promotedEntryIds.has(id)),
          updatedAt: Date.now(),
        };
        workspaceGraph.entities.push(copied);
        workspaceByKey.set(key, copied);
        remap.set(entity.id, copied.id);
        graphChanged = true;
      }
    }

    // Copy relationships whose endpoints both resolved into the workspace,
    // skipping duplicates (same remapped source/target/type).
    const existingRelKeys = new Set(workspaceGraph.relationships.map((r) => `${r.sourceId}|${r.targetId}|${r.type}`));
    for (const rel of branchGraph.relationships) {
      const sourceId = remap.get(rel.sourceId) ?? this.workspaceEntityId(workspaceGraph, rel.sourceId);
      const targetId = remap.get(rel.targetId) ?? this.workspaceEntityId(workspaceGraph, rel.targetId);
      if (!sourceId || !targetId) {
        continue;
      }
      const relKey = `${sourceId}|${targetId}|${rel.type}`;
      if (existingRelKeys.has(relKey)) {
        continue;
      }
      const copied: MemoryRelationship = {
        ...rel,
        sourceId,
        targetId,
        scope: "workspace",
        branch: undefined,
      };
      workspaceGraph.relationships.push(copied);
      existingRelKeys.add(relKey);
      graphChanged = true;
    }

    if (graphChanged) {
      // Normalize vectors to plain arrays before persisting
      const toSave: MemoryGraphData = {
        entities: workspaceGraph.entities.map((e) => ({ ...e, vector: Array.from(e.vector) })),
        relationships: workspaceGraph.relationships,
      };
      await this.vectorStore.saveGraph(toSave, "workspace");
    }

    return remap;
  }

  private workspaceEntityId(graph: MemoryGraphData, id: string): string | undefined {
    return graph.entities.some((e) => e.id === id) ? id : undefined;
  }

  /**
   * Find entities matching name+type across all scopes.
   * Optionally exclude a scope from results.
   */
  async findLinkedEntities(
    entityName: string,
    entityType: string,
    excludeScope?: string,
  ): Promise<Array<{ scope: string; entity: MemoryEntity }>> {
    const results: Array<{ scope: string; entity: MemoryEntity }> = [];
    const normalizedName = entityName.toLowerCase();

    const scopes = await this.listAllScopes();
    for (const scope of scopes) {
      if (excludeScope && scope === excludeScope) {
        continue;
      }
      const entities = await this.loadEntitiesForScope(scope);
      for (const entity of entities) {
        if (entity.name.toLowerCase() === normalizedName && entity.type === entityType) {
          results.push({ scope, entity });
        }
      }
    }

    return results;
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private async loadEntitiesForScope(scope: string): Promise<MemoryEntity[]> {
    const { memoryScope, branch } = this.parseScope(scope);
    const data: MemoryGraphData | null = await this.vectorStore.loadGraph(memoryScope, branch);
    return data?.entities ?? [];
  }

  private async listAllScopes(): Promise<string[]> {
    const scopes: string[] = ["workspace"];
    // Check both entry and entity tables for branch scopes
    const branches = await this.vectorStore.listBranches();
    const entityBranches = await this.vectorStore.listEntityBranches();
    const allBranches = new Set([...branches, ...entityBranches]);
    for (const branch of allBranches) {
      scopes.push(`branch:${branch}`);
    }
    return scopes;
  }

  private parseScope(scope: string): { memoryScope: "workspace" | "branch"; branch?: string } {
    if (scope.startsWith("branch:")) {
      return { memoryScope: "branch", branch: scope.slice("branch:".length) };
    }
    return { memoryScope: "workspace" };
  }

  private extractBranch(branchScope: string): string | undefined {
    if (branchScope.startsWith("branch:")) {
      return branchScope.slice("branch:".length);
    }
    return undefined;
  }
}
