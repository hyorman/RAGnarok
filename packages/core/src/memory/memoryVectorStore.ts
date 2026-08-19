/**
 * LanceDB persistence layer for standalone memory entries, entities, and relationships.
 *
 * Table naming convention:
 *   - Workspace memories:  `_memory-entries-workspace`
 *   - Branch memories:     `_memory-entries-branch-{encodedBranchName}`
 *   - Workspace entities:  `_memory-entities-workspace`
 *   - Branch entities:     `_memory-entities-branch-{encodedBranchName}`
 *   - Workspace edges:     `_memory-edges-workspace`
 *   - Branch edges:        `_memory-edges-branch-{encodedBranchName}`
 *
 * Branch names are base64url-encoded in table names: the encoding is
 * reversible (listBranches returns the original name) and collision-free —
 * lossy sanitization previously mapped distinct branches like `feature/foo`
 * and `feature_foo` onto the same table, leaking memory across branches.
 */

import { connect } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from "apache-arrow";
import { Mutex } from "async-mutex";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { Logger } from "../logger";
import { atomicWriteJson } from "../utils/storageV2";
import { MemoryEntry, MemoryGraphData, MemoryScope, MEMORY_TABLE_PREFIX } from "./types";

export class MemoryVectorStore {
  private logger = new Logger("MemoryVectorStore");
  // Memoized connection — every operation used to reconnect, so a single
  // store() paid 5+ connects and each recall reconnected again.
  private dbPromise: ReturnType<typeof connect> | null = null;
  private db: Connection | null = null;
  private openTables = new Set<Table>();
  private readonly maxOpenTables = 32;
  // Persistence is drop-table + recreate, so data operations must not
  // interleave: a concurrent save would race the drop ("table already
  // exists") and an overlapping read can hit files deleted mid-drop.
  private opMutex = new Mutex();

  constructor(private lanceDbUri: string) {}

  private getDb(): ReturnType<typeof connect> {
    this.dbPromise ??= connect(this.lanceDbUri).then((db) => {
      this.db = db;
      return db;
    });
    return this.dbPromise;
  }

  /** Serialize a data operation against the drop-and-recreate persistence. */
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    return this.opMutex.runExclusive(async () => {
      await this.recoverResetUnlocked();
      return operation();
    });
  }

  // ── Public API (serialized) ────────────────────────────────────────

  async saveEntries(entries: MemoryEntry[], scope: MemoryScope, branch?: string): Promise<void> {
    return this.locked(() =>
      this.withScopeJournal(scope, branch, () => this.saveEntriesUnlocked(entries, scope, branch)),
    );
  }

  async loadEntries(scope: MemoryScope, branch?: string): Promise<MemoryEntry[]> {
    return this.locked(async () => {
      await this.recoverScopeUnlocked(scope, branch);
      return this.loadEntriesUnlocked(scope, branch);
    });
  }

  async searchEntries(
    queryVector: number[],
    scope: MemoryScope,
    branch: string | undefined,
    topK: number,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    return this.locked(async () => {
      await this.recoverScopeUnlocked(scope, branch);
      return this.searchEntriesUnlocked(queryVector, scope, branch, topK);
    });
  }

  async saveGraph(data: MemoryGraphData, scope: MemoryScope, branch?: string): Promise<void> {
    return this.locked(() => this.withScopeJournal(scope, branch, () => this.saveGraphUnlocked(data, scope, branch)));
  }

  async loadGraph(scope: MemoryScope, branch?: string): Promise<MemoryGraphData | null> {
    return this.locked(async () => {
      await this.recoverScopeUnlocked(scope, branch);
      return this.loadGraphUnlocked(scope, branch);
    });
  }

  /** Atomically persist the entry and graph views of one memory scope. */
  async saveScopeAtomic(
    entries: MemoryEntry[],
    graph: MemoryGraphData,
    scope: MemoryScope,
    branch?: string,
  ): Promise<void> {
    return this.locked(() =>
      this.withScopeJournal(scope, branch, async () => {
        await this.saveEntriesUnlocked(entries, scope, branch);
        await this.saveGraphUnlocked(graph, scope, branch);
      }),
    );
  }

  async deleteBranchMemories(branch: string): Promise<void> {
    return this.locked(() => this.withScopeJournal("branch", branch, () => this.deleteBranchMemoriesUnlocked(branch)));
  }

  async deleteAll(): Promise<void> {
    return this.locked(() => this.deleteAllAtomicallyUnlocked());
  }

  // ── Table naming ───────────────────────────────────────────────────

  private entriesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-entries-branch-${this.encodeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-entries-workspace`;
  }

  private entitiesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-entities-branch-${this.encodeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-entities-workspace`;
  }

  private edgesTable(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch
      ? `${MEMORY_TABLE_PREFIX}-edges-branch-${this.encodeBranch(branch)}`
      : `${MEMORY_TABLE_PREFIX}-edges-workspace`;
  }

  /**
   * Reversible, collision-free branch → table-segment encoding.
   * base64url uses only [A-Za-z0-9_-], which is valid in LanceDB table names.
   */
  private encodeBranch(branch: string): string {
    return Buffer.from(branch, "utf8").toString("base64url");
  }

  /** Decode a table-name segment back to the original branch name. */
  private decodeBranch(encoded: string): string {
    return Buffer.from(encoded, "base64url").toString("utf8");
  }

  private scopeJournalPath(scope: MemoryScope, branch?: string): string {
    const identity = scope === "branch" ? `branch:${branch ?? ""}` : "workspace";
    const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
    return path.join(path.dirname(this.lanceDbUri), `.memory-scope-${digest}.journal.json`);
  }

  private resetJournalPath(): string {
    return path.join(path.dirname(this.lanceDbUri), ".memory-reset.journal.json");
  }

  private async snapshotAllScopesUnlocked(): Promise<
    Array<{ scope: MemoryScope; branch?: string; entries: MemoryEntry[]; graph: MemoryGraphData | null }>
  > {
    const db = await this.getDb();
    const tableNames = await db.tableNames();
    const branchPrefixes = [
      `${MEMORY_TABLE_PREFIX}-entries-branch-`,
      `${MEMORY_TABLE_PREFIX}-entities-branch-`,
      `${MEMORY_TABLE_PREFIX}-edges-branch-`,
    ];
    const branches = new Set<string>();
    for (const name of tableNames) {
      for (const prefix of branchPrefixes) {
        if (name.startsWith(prefix)) {
          branches.add(this.decodeBranch(name.slice(prefix.length)));
        }
      }
    }
    const scopes: Array<{ scope: MemoryScope; branch?: string }> = [
      { scope: "workspace" },
      ...[...branches].sort().map((branch) => ({ scope: "branch" as const, branch })),
    ];
    const snapshots = [];
    for (const { scope, branch } of scopes) {
      snapshots.push({
        scope,
        branch,
        entries: await this.loadEntriesUnlocked(scope, branch),
        graph: await this.loadGraphUnlocked(scope, branch),
      });
    }
    return snapshots;
  }

  private async restoreResetSnapshotUnlocked(
    scopes: Array<{ scope: MemoryScope; branch?: string; entries: MemoryEntry[]; graph: MemoryGraphData | null }>,
  ): Promise<void> {
    for (const snapshot of scopes) {
      await this.saveEntriesUnlocked(snapshot.entries, snapshot.scope, snapshot.branch);
      await this.saveGraphUnlocked(
        snapshot.graph ?? { entities: [], relationships: [] },
        snapshot.scope,
        snapshot.branch,
      );
    }
  }

  private async deleteAllAtomicallyUnlocked(): Promise<void> {
    const journalPath = this.resetJournalPath();
    const journal = {
      version: 1,
      state: "prepared" as const,
      scopes: await this.snapshotAllScopesUnlocked(),
      createdAt: Date.now(),
    };
    await atomicWriteJson(journalPath, journal);
    try {
      await this.deleteAllUnlocked();
      await atomicWriteJson(journalPath, { ...journal, state: "committed", committedAt: Date.now() });
      await fs.unlink(journalPath);
    } catch (error) {
      try {
        await this.restoreResetSnapshotUnlocked(journal.scopes);
        await fs.unlink(journalPath);
      } catch (rollbackError) {
        this.logger.error(`Memory reset rollback failed; recovery journal retained at ${journalPath}`, rollbackError);
      }
      throw error;
    }
  }

  private async recoverResetUnlocked(): Promise<void> {
    const journalPath = this.resetJournalPath();
    let journal: {
      version: number;
      state: "prepared" | "committed";
      scopes: Array<{ scope: MemoryScope; branch?: string; entries: MemoryEntry[]; graph: MemoryGraphData | null }>;
    };
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw new Error(`Memory reset journal is corrupt at ${journalPath}; refusing to expose partially reset storage`);
    }
    if (journal.version !== 1 || !Array.isArray(journal.scopes)) {
      throw new Error(`Memory reset journal is invalid at ${journalPath}`);
    }
    if (journal.state === "committed") {
      await fs.unlink(journalPath);
      return;
    }
    if (journal.state !== "prepared") {
      throw new Error(`Memory reset journal has invalid state at ${journalPath}`);
    }
    await this.restoreResetSnapshotUnlocked(journal.scopes);
    await fs.unlink(journalPath);
  }

  private trackTable(table: Table): void {
    this.openTables.add(table);
    while (this.openTables.size > this.maxOpenTables) {
      const oldest = this.openTables.values().next().value as Table | undefined;
      if (!oldest) {
        break;
      }
      this.openTables.delete(oldest);
      oldest.close();
    }
  }

  private async withScopeJournal<T>(
    scope: MemoryScope,
    branch: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.recoverScopeUnlocked(scope, branch);
    const previousEntries = await this.loadEntriesUnlocked(scope, branch);
    const previousGraph = await this.loadGraphUnlocked(scope, branch);
    const journalPath = this.scopeJournalPath(scope, branch);
    const journal = {
      version: 1,
      state: "prepared",
      scope,
      branch,
      previousEntries,
      previousGraph,
      createdAt: Date.now(),
    };
    await atomicWriteJson(journalPath, journal);
    try {
      const result = await operation();
      await atomicWriteJson(journalPath, { ...journal, state: "committed", committedAt: Date.now() });
      await fs.unlink(journalPath);
      return result;
    } catch (error) {
      try {
        await this.saveEntriesUnlocked(previousEntries, scope, branch);
        await this.saveGraphUnlocked(previousGraph ?? { entities: [], relationships: [] }, scope, branch);
        await fs.unlink(journalPath);
      } catch (rollbackError) {
        this.logger.error(`Memory scope rollback failed; recovery journal retained at ${journalPath}`, rollbackError);
      }
      throw error;
    }
  }

  private async recoverScopeUnlocked(scope: MemoryScope, branch?: string): Promise<void> {
    const journalPath = this.scopeJournalPath(scope, branch);
    let journal: {
      version: number;
      state: "prepared" | "committed";
      scope: MemoryScope;
      branch?: string;
      previousEntries: MemoryEntry[];
      previousGraph: MemoryGraphData | null;
    };
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw new Error(
        `Memory transaction journal is corrupt at ${journalPath}; refusing to read a potentially torn scope`,
      );
    }
    if (journal.version !== 1 || journal.scope !== scope || journal.branch !== branch) {
      throw new Error(`Memory transaction journal identity mismatch at ${journalPath}`);
    }
    if (journal.state === "committed") {
      await fs.unlink(journalPath);
      return;
    }
    if (journal.state !== "prepared") {
      throw new Error(`Memory transaction journal has invalid state at ${journalPath}`);
    }
    await this.saveEntriesUnlocked(journal.previousEntries, scope, branch);
    await this.saveGraphUnlocked(journal.previousGraph ?? { entities: [], relationships: [] }, scope, branch);
    await fs.unlink(journalPath);
  }

  // ── Memory Entry CRUD ──────────────────────────────────────────────

  private async saveEntriesUnlocked(entries: MemoryEntry[], scope: MemoryScope, branch?: string): Promise<void> {
    const db = await this.getDb();
    const tableName = this.entriesTable(scope, branch);

    const rows = entries.map((e) => ({
      id: e.id,
      content: e.content,
      scope: e.scope,
      branch: e.branch ?? "",
      vector: Array.from(e.vector),
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
      const tableNames = await db.tableNames();
      if (!tableNames.includes(tableName)) {
        if (entries.length === 0) {
          return;
        }
        const created = await db.createEmptyTable(tableName, this.entriesSchema(entries[0].vector.length));
        this.trackTable(created);
      }
      const table = await db.openTable(tableName);
      this.trackTable(table);
      if (rows.length === 0) {
        await table.delete("true");
      } else {
        await table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .whenNotMatchedBySourceDelete()
          .execute(rows);
      }
    } catch (error) {
      this.logger.error(`Failed to save entries to ${tableName}`, error);
      throw error;
    }
  }

  private async loadEntriesUnlocked(scope: MemoryScope, branch?: string): Promise<MemoryEntry[]> {
    const db = await this.getDb();
    const tableName = this.entriesTable(scope, branch);

    // Only a missing table means "no data". Any other failure (corrupt rows,
    // schema mismatch, I/O) must propagate — returning [] here would make
    // corruption indistinguishable from an empty store, and the next save
    // would overwrite recoverable data.
    const tableNames = await db.tableNames();
    if (!tableNames.includes(tableName)) {
      return [];
    }

    try {
      const table = await db.openTable(tableName);
      this.trackTable(table);
      const rows = await table.query().limit(100000).toArray();

      return rows.map((row) => ({
        id: row.id as string,
        content: row.content as string,
        scope: row.scope as MemoryScope,
        branch: (row.branch as string) || undefined,
        vector: Array.from(row.vector as ArrayLike<number>),
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
      throw new Error(
        `Memory store read failed for table ${tableName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async searchEntriesUnlocked(
    queryVector: number[],
    scope: MemoryScope,
    branch: string | undefined,
    topK: number,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const db = await this.getDb();
    const tableName = this.entriesTable(scope, branch);

    const tableNames = await db.tableNames();
    if (!tableNames.includes(tableName)) {
      return [];
    }

    try {
      const table = await db.openTable(tableName);
      this.trackTable(table);
      // Filter superseded versions at query time, BEFORE the limit: a query
      // close to many historical versions would otherwise fill the top-K with
      // superseded rows and crowd out current memories entirely.
      // The column name must be backtick-quoted: Lance's SQL dialect
      // lowercases unquoted identifiers (no column "islatest") and treats
      // double-quoted tokens as string literals, silently matching nothing.
      const rows = await table.vectorSearch(queryVector).where("`isLatest` = 1").limit(topK).toArray();

      return rows.map((row) => ({
        entry: {
          id: row.id as string,
          content: row.content as string,
          scope: row.scope as MemoryScope,
          branch: (row.branch as string) || undefined,
          vector: Array.from(row.vector as ArrayLike<number>),
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
      throw new Error(
        `Memory store search failed for table ${tableName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Graph Persistence ──────────────────────────────────────────────

  private async saveGraphUnlocked(data: MemoryGraphData, scope: MemoryScope, branch?: string): Promise<void> {
    const db = await this.getDb();

    const entitiesTableName = this.entitiesTable(scope, branch);
    try {
      const entityRows = data.entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
        vector: Array.from(e.vector),
        scope: e.scope,
        branch: e.branch ?? "",
        confidence: e.confidence,
        strength: e.strength,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        sourceMemoryIds: JSON.stringify(e.sourceMemoryIds),
        metadata: JSON.stringify(e.metadata),
      }));
      let tableNames = await db.tableNames();
      if (!tableNames.includes(entitiesTableName) && entityRows.length > 0) {
        this.trackTable(
          await db.createEmptyTable(entitiesTableName, this.entitiesSchema(data.entities[0].vector.length)),
        );
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(entitiesTableName)) {
        const table = await db.openTable(entitiesTableName);
        this.trackTable(table);
        if (entityRows.length === 0) {
          await table.delete("true");
        } else {
          await table
            .mergeInsert("id")
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .whenNotMatchedBySourceDelete()
            .execute(entityRows);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to save entities to ${entitiesTableName}`, error);
      throw error;
    }

    const edgesTableName = this.edgesTable(scope, branch);
    try {
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
      let tableNames = await db.tableNames();
      if (!tableNames.includes(edgesTableName) && edgeRows.length > 0) {
        this.trackTable(await db.createEmptyTable(edgesTableName, this.edgesSchema()));
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(edgesTableName)) {
        const table = await db.openTable(edgesTableName);
        this.trackTable(table);
        if (edgeRows.length === 0) {
          await table.delete("true");
        } else {
          await table
            .mergeInsert("id")
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .whenNotMatchedBySourceDelete()
            .execute(edgeRows);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to save edges to ${edgesTableName}`, error);
      throw error;
    }
  }

  private async loadGraphUnlocked(scope: MemoryScope, branch?: string): Promise<MemoryGraphData | null> {
    const db = await this.getDb();
    const entitiesTableName = this.entitiesTable(scope, branch);
    const edgesTableName = this.edgesTable(scope, branch);

    try {
      const tableNames = await db.tableNames();
      if (!tableNames.includes(entitiesTableName) && tableNames.includes(edgesTableName)) {
        throw new Error(
          `Memory graph is corrupt for scope ${scope}${branch ? `/${branch}` : ""}: edge table exists without entities`,
        );
      }

      const entities = [];
      if (tableNames.includes(entitiesTableName)) {
        const table = await db.openTable(entitiesTableName);
        this.trackTable(table);
        const rows = await table.query().limit(100000).toArray();
        for (const row of rows) {
          entities.push({
            id: row.id as string,
            name: row.name as string,
            type: row.type as string,
            description: row.description as string,
            vector: Array.from(row.vector as ArrayLike<number>),
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
        this.trackTable(table);
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

      const entityIds = new Set(entities.map((entity) => entity.id));
      const dangling = relationships.find(
        (relationship) => !entityIds.has(relationship.sourceId) || !entityIds.has(relationship.targetId),
      );
      if (dangling) {
        throw new Error(
          `Memory graph is corrupt for scope ${scope}${branch ? `/${branch}` : ""}: ` +
            `relationship ${dangling.id} references a missing entity`,
        );
      }

      return { entities, relationships } as MemoryGraphData;
    } catch (error) {
      // Missing tables are handled above; anything reaching here is real
      // corruption or I/O failure and must not masquerade as "no graph".
      this.logger.error("Failed to load graph", error);
      throw new Error(
        `Memory graph read failed for scope ${scope}${branch ? `/${branch}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Scope Management ───────────────────────────────────────────────

  async listBranches(): Promise<string[]> {
    return this.locked(async () => {
      const db = await this.getDb();
      const tableNames = await db.tableNames();

      const prefix = `${MEMORY_TABLE_PREFIX}-entries-branch-`;
      const branches = new Set<string>();

      for (const name of tableNames) {
        if (name.startsWith(prefix)) {
          branches.add(this.decodeBranch(name.slice(prefix.length)));
        }
      }

      return Array.from(branches);
    });
  }

  /** List branches that have entity graph tables (may differ from entry branches). */
  async listEntityBranches(): Promise<string[]> {
    return this.locked(async () => {
      const db = await this.getDb();
      const tableNames = await db.tableNames();

      const prefix = `${MEMORY_TABLE_PREFIX}-entities-branch-`;
      const branches = new Set<string>();

      for (const name of tableNames) {
        if (name.startsWith(prefix)) {
          branches.add(this.decodeBranch(name.slice(prefix.length)));
        }
      }

      return Array.from(branches);
    });
  }

  private async deleteBranchMemoriesUnlocked(branch: string): Promise<void> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();

    // Exact table names only — substring matching could drop tables of
    // branches whose encoded name contains this branch's encoding as a prefix.
    const targets = [
      this.entriesTable("branch", branch),
      this.entitiesTable("branch", branch),
      this.edgesTable("branch", branch),
    ];

    for (const tableName of targets) {
      if (tableNames.includes(tableName)) {
        await db.dropTable(tableName);
      }
    }
  }

  private async deleteAllUnlocked(): Promise<void> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();

    for (const tableName of tableNames) {
      if (tableName.startsWith(MEMORY_TABLE_PREFIX)) {
        await db.dropTable(tableName);
      }
    }
  }

  async dispose(): Promise<void> {
    await this.locked(async () => {
      for (const table of this.openTables) {
        table.close();
      }
      this.openTables.clear();
      this.db?.close();
      this.db = null;
      this.dbPromise = null;
    });
  }

  private vectorField(dimension: number): Field {
    return new Field("vector", new FixedSizeList(dimension, new Field("item", new Float32(), false)), false);
  }

  private entriesSchema(dimension: number): Schema {
    const strings = [
      "id",
      "content",
      "scope",
      "branch",
      "tags",
      "entityIds",
      "metadata",
      "supersededBy",
      "previousVersionId",
    ].map((name) => new Field(name, new Utf8(), false));
    const numbers = [
      "createdAt",
      "updatedAt",
      "accessCount",
      "lastAccessedAt",
      "confidence",
      "expiresAt",
      "isLatest",
      "version",
    ].map((name) => new Field(name, new Float64(), false));
    return new Schema([...strings.slice(0, 4), this.vectorField(dimension), ...strings.slice(4), ...numbers]);
  }

  private entitiesSchema(dimension: number): Schema {
    const strings = ["id", "name", "type", "description", "scope", "branch", "sourceMemoryIds", "metadata"].map(
      (name) => new Field(name, new Utf8(), false),
    );
    const numbers = ["confidence", "strength", "createdAt", "updatedAt"].map(
      (name) => new Field(name, new Float64(), false),
    );
    return new Schema([...strings.slice(0, 4), this.vectorField(dimension), ...strings.slice(4), ...numbers]);
  }

  private edgesSchema(): Schema {
    const strings = ["id", "sourceId", "targetId", "type", "description", "scope", "branch", "metadata"].map(
      (name) => new Field(name, new Utf8(), false),
    );
    return new Schema([...strings, new Field("weight", new Float64(), false)]);
  }
}
