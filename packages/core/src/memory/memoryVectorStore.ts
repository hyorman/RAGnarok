/**
 * LanceDB persistence layer for standalone memory entries, entities, and relationships.
 *
 * Table naming convention:
 *   - Workspace memories:  `_memory-entries-workspace`
 *   - Branch memories:     `_memory-entries-branch-{sanitizedBranchName}`
 *   - Workspace entities:  `_memory-entities-workspace`
 *   - Branch entities:     `_memory-entities-branch-{sanitizedBranchName}`
 *   - Workspace edges:     `_memory-edges-workspace`
 *   - Branch edges:        `_memory-edges-branch-{sanitizedBranchName}`
 */

import { connect } from "@lancedb/lancedb";
import { Logger } from "../logger";
import {
  MemoryEntry,
  MemoryGraphData,
  MemoryScope,
  MEMORY_TABLE_PREFIX,
} from "./types";

export class MemoryVectorStore {
  private logger = new Logger("MemoryVectorStore");

  constructor(private lanceDbUri: string) {}

  // ── Table naming ───────────────────────────────────────────────────

  private entriesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-entries-branch-${this.sanitizeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-entries-workspace`;
  }

  private entitiesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-entities-branch-${this.sanitizeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-entities-workspace`;
  }

  private edgesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-edges-branch-${this.sanitizeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-edges-workspace`;
  }

  private sanitizeBranch(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * Drop a table if it exists. Persistence is drop-and-recreate, so an empty
   * collection MUST drop the old table — skipping the write would leave stale
   * rows on disk that resurrect after cache eviction or restart.
   */
  private async dropTableIfExists(db: Awaited<ReturnType<typeof connect>>, tableName: string): Promise<void> {
    const tableNames = await db.tableNames();
    if (tableNames.includes(tableName)) {
      await db.dropTable(tableName);
    }
  }

  // ── Memory Entry CRUD ──────────────────────────────────────────────

  async saveEntries(entries: MemoryEntry[], scope: MemoryScope, branch?: string): Promise<void> {
    const db = await connect(this.lanceDbUri);
    const tableName = this.entriesTable(scope, branch);

    if (entries.length === 0) {
      // Deleting the last entry must be persisted: drop the stale table.
      // (LanceDB cannot create a table from zero rows without a schema.)
      try {
        await this.dropTableIfExists(db, tableName);
      } catch (error) {
        this.logger.error(`Failed to drop emptied table ${tableName}`, error);
        throw error;
      }
      return;
    }

    const rows = entries.map((e) => ({
      id: e.id,
      content: e.content,
      scope: e.scope,
      branch: e.branch ?? "",
      vector: e.vector,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      accessCount: e.accessCount,
      lastAccessedAt: e.lastAccessedAt,
      tags: JSON.stringify(e.tags),
      entityIds: JSON.stringify(e.entityIds),
      metadata: JSON.stringify(e.metadata),
      confidence: e.confidence ?? 1.0,
      expiresAt: e.expiresAt ?? 0,
      isLatest: e.isLatest !== false ? 1 : 0,
      supersededBy: e.supersededBy ?? "",
      previousVersionId: e.previousVersionId ?? "",
      version: e.version ?? 1,
    }));

    try {
      await this.dropTableIfExists(db, tableName);
      await db.createTable(tableName, rows);
    } catch (error) {
      this.logger.error(`Failed to save entries to ${tableName}`, error);
      throw error;
    }
  }

  async loadEntries(scope: MemoryScope, branch?: string): Promise<MemoryEntry[]> {
    const db = await connect(this.lanceDbUri);
    const tableName = this.entriesTable(scope, branch);

    try {
      const tableNames = await db.tableNames();
      if (!tableNames.includes(tableName)) {
        return [];
      }

      const table = await db.openTable(tableName);
      const rows = await table.query().limit(100000).toArray();

      return rows.map((row) => ({
        id: row.id as string,
        content: row.content as string,
        scope: row.scope as MemoryScope,
        branch: (row.branch as string) || undefined,
        vector: row.vector as number[],
        createdAt: row.createdAt as number,
        updatedAt: row.updatedAt as number,
        accessCount: row.accessCount as number,
        lastAccessedAt: row.lastAccessedAt as number,
        tags: JSON.parse(row.tags as string),
        entityIds: JSON.parse(row.entityIds as string),
        metadata: JSON.parse(row.metadata as string),
        confidence: (row.confidence as number) ?? 1.0,
        expiresAt: (row.expiresAt as number) || undefined,
        isLatest: row.isLatest === 0 ? false : true,
        supersededBy: (row.supersededBy as string) || undefined,
        previousVersionId: (row.previousVersionId as string) || undefined,
        version: (row.version as number) ?? 1,
      }));
    } catch (error) {
      this.logger.error(`Failed to load entries from ${tableName}`, error);
      return [];
    }
  }

  async searchEntries(
    queryVector: number[],
    scope: MemoryScope,
    branch: string | undefined,
    topK: number,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const db = await connect(this.lanceDbUri);
    const tableName = this.entriesTable(scope, branch);

    try {
      const tableNames = await db.tableNames();
      if (!tableNames.includes(tableName)) {
        return [];
      }

      const table = await db.openTable(tableName);
      const rows = await table.vectorSearch(queryVector).limit(topK).toArray();

      return rows.map((row) => ({
        entry: {
          id: row.id as string,
          content: row.content as string,
          scope: row.scope as MemoryScope,
          branch: (row.branch as string) || undefined,
          vector: row.vector as number[],
          createdAt: row.createdAt as number,
          updatedAt: row.updatedAt as number,
          accessCount: row.accessCount as number,
          lastAccessedAt: row.lastAccessedAt as number,
          tags: JSON.parse(row.tags as string),
          entityIds: JSON.parse(row.entityIds as string),
          metadata: JSON.parse(row.metadata as string),
          confidence: (row.confidence as number) ?? 1.0,
          expiresAt: (row.expiresAt as number) || undefined,
          isLatest: row.isLatest === 0 ? false : true,
          supersededBy: (row.supersededBy as string) || undefined,
          previousVersionId: (row.previousVersionId as string) || undefined,
          version: (row.version as number) ?? 1,
        },
        // LanceDB returns _distance (L2), convert to similarity: 1 / (1 + distance)
        score: 1 / (1 + ((row._distance as number) ?? 0)),
      }));
    } catch (error) {
      this.logger.error(`Failed to search entries in ${tableName}`, error);
      return [];
    }
  }

  // ── Graph Persistence ──────────────────────────────────────────────

  async saveGraph(data: MemoryGraphData, scope: MemoryScope, branch?: string): Promise<void> {
    const db = await connect(this.lanceDbUri);

    // Both tables are always reconciled: dropping the old table even when the
    // new collection is empty is what persists "the last entity/edge was
    // removed". Recreate only when there are rows.

    const entitiesTableName = this.entitiesTable(scope, branch);
    try {
      await this.dropTableIfExists(db, entitiesTableName);
      if (data.entities.length > 0) {
        const entityRows = data.entities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
          vector: e.vector,
          scope: e.scope,
          branch: e.branch ?? "",
          confidence: e.confidence,
          strength: e.strength,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          sourceMemoryIds: JSON.stringify(e.sourceMemoryIds),
          metadata: JSON.stringify(e.metadata),
        }));
        await db.createTable(entitiesTableName, entityRows);
      }
    } catch (error) {
      this.logger.error(`Failed to save entities to ${entitiesTableName}`, error);
      throw error;
    }

    const edgesTableName = this.edgesTable(scope, branch);
    try {
      await this.dropTableIfExists(db, edgesTableName);
      if (data.relationships.length > 0) {
        const edgeRows = data.relationships.map((r) => ({
          id: r.id,
          sourceId: r.sourceId,
          targetId: r.targetId,
          type: r.type,
          description: r.description,
          weight: r.weight,
          scope: r.scope,
          branch: r.branch ?? "",
          metadata: JSON.stringify(r.metadata),
        }));
        await db.createTable(edgesTableName, edgeRows);
      }
    } catch (error) {
      this.logger.error(`Failed to save edges to ${edgesTableName}`, error);
      throw error;
    }
  }

  async loadGraph(scope: MemoryScope, branch?: string): Promise<MemoryGraphData | null> {
    const db = await connect(this.lanceDbUri);
    const entitiesTableName = this.entitiesTable(scope, branch);
    const edgesTableName = this.edgesTable(scope, branch);

    try {
      const tableNames = await db.tableNames();

      const entities = [];
      if (tableNames.includes(entitiesTableName)) {
        const table = await db.openTable(entitiesTableName);
        const rows = await table.query().limit(100000).toArray();
        for (const row of rows) {
          entities.push({
            id: row.id as string,
            name: row.name as string,
            type: row.type as string,
            description: row.description as string,
            vector: row.vector as number[],
            scope: row.scope as MemoryScope,
            branch: (row.branch as string) || undefined,
            confidence: row.confidence as number,
            strength: row.strength as number,
            createdAt: row.createdAt as number,
            updatedAt: row.updatedAt as number,
            sourceMemoryIds: JSON.parse(row.sourceMemoryIds as string),
            metadata: JSON.parse(row.metadata as string),
          });
        }
      }

      const relationships = [];
      if (tableNames.includes(edgesTableName)) {
        const table = await db.openTable(edgesTableName);
        const rows = await table.query().limit(100000).toArray();
        for (const row of rows) {
          relationships.push({
            id: row.id as string,
            sourceId: row.sourceId as string,
            targetId: row.targetId as string,
            type: row.type as string,
            description: row.description as string,
            weight: row.weight as number,
            scope: row.scope as MemoryScope,
            branch: (row.branch as string) || undefined,
            metadata: JSON.parse(row.metadata as string),
          });
        }
      }

      if (entities.length === 0 && relationships.length === 0) {
        return null;
      }

      return { entities, relationships } as MemoryGraphData;
    } catch (error) {
      this.logger.error("Failed to load graph", error);
      return null;
    }
  }

  // ── Scope Management ───────────────────────────────────────────────

  async listBranches(): Promise<string[]> {
    const db = await connect(this.lanceDbUri);
    const tableNames = await db.tableNames();

    const prefix = `${MEMORY_TABLE_PREFIX}-entries-branch-`;
    const branches = new Set<string>();

    for (const name of tableNames) {
      if (name.startsWith(prefix)) {
        branches.add(name.slice(prefix.length));
      }
    }

    return Array.from(branches);
  }

  /** List branches that have entity graph tables (may differ from entry branches). */
  async listEntityBranches(): Promise<string[]> {
    const db = await connect(this.lanceDbUri);
    const tableNames = await db.tableNames();

    const prefix = `${MEMORY_TABLE_PREFIX}-entities-branch-`;
    const branches = new Set<string>();

    for (const name of tableNames) {
      if (name.startsWith(prefix)) {
        branches.add(name.slice(prefix.length));
      }
    }

    return Array.from(branches);
  }

  async deleteBranchMemories(branch: string): Promise<void> {
    const db = await connect(this.lanceDbUri);
    const sanitized = this.sanitizeBranch(branch);
    const tableNames = await db.tableNames();

    for (const tableName of tableNames) {
      if (tableName.includes(`branch-${sanitized}`)) {
        await db.dropTable(tableName);
      }
    }
  }

  async deleteAll(): Promise<void> {
    const db = await connect(this.lanceDbUri);
    const tableNames = await db.tableNames();

    for (const tableName of tableNames) {
      if (tableName.startsWith(MEMORY_TABLE_PREFIX)) {
        await db.dropTable(tableName);
      }
    }
  }
}
