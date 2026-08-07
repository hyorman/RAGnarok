/**
 * LanceDB persistence for knowledge graph entity and edge tables.
 * Uses raw @lancedb/lancedb API (same pattern as VectorStoreFactory).
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
import { GraphEntity, GraphRelationship, KnowledgeGraphData } from "../utils/graphTypes";

export class KnowledgeGraphCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphCorruptionError";
  }
}

export class KnowledgeGraphLimitError extends Error {
  constructor(topicId: string, entityLimit: number, edgeLimit: number) {
    super(
      `Knowledge graph ${topicId} exceeds the supported persisted limit ` +
        `(${entityLimit} entities, ${edgeLimit} relationships). Reduce/rebuild the graph before querying it.`,
    );
    this.name = "KnowledgeGraphLimitError";
  }
}

const MAX_GRAPH_ENTITIES = 100_000;
const MAX_GRAPH_RELATIONSHIPS = 100_000;

export class KnowledgeGraphStore {
  private lanceDbUri: string;
  private logger: Logger;
  private dbPromise: Promise<Connection> | null = null;
  private db: Connection | null = null;
  private tables = new Set<Table>();
  private readonly maxOpenTables = 32;
  private mutex = new Mutex();

  constructor(lanceDbUri: string) {
    this.lanceDbUri = lanceDbUri;
    this.logger = new Logger("KnowledgeGraphStore");
  }

  async saveGraph(topicId: string, data: KnowledgeGraphData): Promise<void> {
    if (data.entities.length > MAX_GRAPH_ENTITIES || data.relationships.length > MAX_GRAPH_RELATIONSHIPS) {
      throw new KnowledgeGraphLimitError(topicId, MAX_GRAPH_ENTITIES, MAX_GRAPH_RELATIONSHIPS);
    }
    return this.mutex.runExclusive(() =>
      this.withTopicJournal(topicId, async () => this.saveGraphUnlocked(topicId, data)),
    );
  }

  private async saveGraphUnlocked(topicId: string, data: KnowledgeGraphData): Promise<void> {
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;
    const metadataTableName = `kg-metadata-${topicId}`;

    this.logger.info("Saving knowledge graph", {
      topicId,
      entityCount: data.entities.length,
      edgeCount: data.relationships.length,
    });

    try {
      const db = await this.getDb();

      // Convert entities to flat rows
      const entityRows = data.entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
        vector: Array.from(e.vector),
        sourceChunkIds: JSON.stringify(e.sourceChunkIds),
        confidence: e.confidence,
        strength: e.strength,
        lastAccessedAt: e.lastAccessedAt,
        metadata: JSON.stringify(e.metadata),
      }));

      // Convert edges to flat rows
      const edgeRows = data.relationships.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        targetId: r.targetId,
        type: r.type,
        weight: r.weight,
        description: r.description ?? "",
        sourceChunkIds: JSON.stringify(r.sourceChunkIds),
        confidence: r.confidence,
        metadata: JSON.stringify(r.metadata),
      }));

      let tableNames = await db.tableNames();
      if (!tableNames.includes(entityTableName) && entityRows.length > 0) {
        this.trackTable(await db.createEmptyTable(entityTableName, this.entitySchema(entityRows[0].vector.length)));
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(entityTableName)) {
        const table = await db.openTable(entityTableName);
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
      if (!tableNames.includes(edgeTableName) && edgeRows.length > 0) {
        this.trackTable(await db.createEmptyTable(edgeTableName, this.edgeSchema()));
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(edgeTableName)) {
        const table = await db.openTable(edgeTableName);
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
      if (!tableNames.includes(metadataTableName)) {
        this.trackTable(await db.createEmptyTable(metadataTableName, this.metadataSchema()));
      }
      const metadataTable = await db.openTable(metadataTableName);
      this.trackTable(metadataTable);
      await metadataTable
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute([{ id: "graph", data: JSON.stringify(data.metadata) }]);

      this.logger.info("Knowledge graph saved successfully", {
        topicId,
        entityCount: entityRows.length,
        edgeCount: edgeRows.length,
      });
    } catch (error) {
      this.logger.error("Failed to save knowledge graph", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  async loadGraph(topicId: string): Promise<KnowledgeGraphData | null> {
    return this.mutex.runExclusive(async () => {
      await this.recoverTopicUnlocked(topicId);
      return this.loadGraphUnlocked(topicId);
    });
  }

  private async loadGraphUnlocked(topicId: string): Promise<KnowledgeGraphData | null> {
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;
    const metadataTableName = `kg-metadata-${topicId}`;

    this.logger.debug("Loading knowledge graph", { topicId });

    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();

      if (!tableNames.includes(entityTableName)) {
        if (tableNames.includes(edgeTableName)) {
          throw new KnowledgeGraphCorruptionError(
            `Knowledge graph ${topicId} is corrupt: entity table is missing while edge table remains. ` +
              "Restore a valid backup or rebuild the topic knowledge graph.",
          );
        }
        if (tableNames.includes(metadataTableName)) {
          const metadata = await this.readPersistedMetadata(db, metadataTableName, topicId);
          if (metadata.entityCount > 0 || metadata.edgeCount > 0) {
            throw new KnowledgeGraphCorruptionError(
              `Knowledge graph ${topicId} is corrupt: metadata records ${metadata.entityCount} entities and ` +
                `${metadata.edgeCount} relationships, but its data tables are missing. Restore a valid backup ` +
                "or rebuild the topic knowledge graph.",
            );
          }
          return null;
        }
        this.logger.debug("No knowledge graph found", { topicId });
        return null;
      }

      // Load entities
      const entityTable = await db.openTable(entityTableName);
      this.trackTable(entityTable);
      const entityRows = await entityTable
        .query()
        .limit(MAX_GRAPH_ENTITIES + 1)
        .toArray();

      // Load edges if table exists
      let edgeRows: Record<string, unknown>[] = [];
      if (tableNames.includes(edgeTableName)) {
        const edgeTable = await db.openTable(edgeTableName);
        this.trackTable(edgeTable);
        edgeRows = await edgeTable
          .query()
          .limit(MAX_GRAPH_RELATIONSHIPS + 1)
          .toArray();
      }
      if (entityRows.length > MAX_GRAPH_ENTITIES || edgeRows.length > MAX_GRAPH_RELATIONSHIPS) {
        throw new KnowledgeGraphLimitError(topicId, MAX_GRAPH_ENTITIES, MAX_GRAPH_RELATIONSHIPS);
      }
      let persistedMetadata: KnowledgeGraphData["metadata"] | null = null;
      if (tableNames.includes(metadataTableName)) {
        persistedMetadata = await this.readPersistedMetadata(db, metadataTableName, topicId);
      }

      // Deserialize entities
      const entities: GraphEntity[] = entityRows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        name: row.name as string,
        type: row.type as string,
        description: row.description as string,
        vector: Array.from(row.vector as Float32Array | number[]),
        sourceChunkIds: JSON.parse(row.sourceChunkIds as string),
        confidence: row.confidence as number,
        strength: row.strength as number,
        lastAccessedAt: row.lastAccessedAt as number,
        metadata: JSON.parse(row.metadata as string),
      })) as GraphEntity[];

      // Deserialize edges
      const relationships: GraphRelationship[] = edgeRows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        sourceId: row.sourceId as string,
        targetId: row.targetId as string,
        type: row.type as string,
        weight: row.weight as number,
        description: (row.description as string) || undefined,
        sourceChunkIds: JSON.parse(row.sourceChunkIds as string),
        confidence: row.confidence as number,
        metadata: JSON.parse(row.metadata as string),
      })) as GraphRelationship[];
      const entityIds = new Set(entities.map((entity) => entity.id));
      const dangling = relationships.find(
        (relationship) => !entityIds.has(relationship.sourceId) || !entityIds.has(relationship.targetId),
      );
      if (dangling) {
        throw new KnowledgeGraphCorruptionError(
          `Knowledge graph ${topicId} is corrupt: relationship ${dangling.id} references a missing entity. ` +
            "Restore a valid backup or rebuild the topic knowledge graph.",
        );
      }

      this.logger.info("Knowledge graph loaded", {
        topicId,
        entityCount: entities.length,
        edgeCount: relationships.length,
      });

      return {
        entities,
        relationships,
        communities: [], // Communities are derived at runtime, not persisted separately yet
        metadata: {
          ...persistedMetadata,
          topicId,
          createdAt: persistedMetadata?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          entityCount: entities.length,
          edgeCount: relationships.length,
          communityCount: 0,
          embeddingModel: persistedMetadata?.embeddingModel ?? "",
        },
      };
    } catch (error) {
      this.logger.error("Failed to load knowledge graph", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      if (error instanceof SyntaxError) {
        throw new KnowledgeGraphCorruptionError(
          `Knowledge graph ${topicId} contains malformed persisted metadata. ` +
            "Restore a valid backup or rebuild the topic knowledge graph.",
        );
      }
      throw error;
    }
  }

  async deleteGraph(topicId: string): Promise<void> {
    return this.mutex.runExclusive(() => this.withTopicJournal(topicId, () => this.deleteGraphUnlocked(topicId)));
  }

  private async deleteGraphUnlocked(topicId: string): Promise<void> {
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;
    const metadataTableName = `kg-metadata-${topicId}`;

    this.logger.info("Deleting knowledge graph", { topicId });

    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();

      if (tableNames.includes(entityTableName)) {
        await db.dropTable(entityTableName);
        this.logger.debug("Entity table dropped", { topicId });
      }
      if (tableNames.includes(edgeTableName)) {
        await db.dropTable(edgeTableName);
        this.logger.debug("Edge table dropped", { topicId });
      }
      if (tableNames.includes(metadataTableName)) {
        await db.dropTable(metadataTableName);
        this.logger.debug("Metadata table dropped", { topicId });
      }

      this.logger.info("Knowledge graph deleted successfully", { topicId });
    } catch (error) {
      this.logger.error("Failed to delete knowledge graph", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  async hasGraph(topicId: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      await this.recoverTopicUnlocked(topicId);
      const entityTableName = `kg-entities-${topicId}`;
      const edgeTableName = `kg-edges-${topicId}`;
      const metadataTableName = `kg-metadata-${topicId}`;
      try {
        const db = await this.getDb();
        const tableNames = await db.tableNames();
        if (!tableNames.includes(entityTableName) && tableNames.includes(edgeTableName)) {
          throw new KnowledgeGraphCorruptionError(
            `Knowledge graph ${topicId} is corrupt: incomplete table set. ` +
              "Restore a valid backup or rebuild the topic knowledge graph.",
          );
        }
        if (!tableNames.includes(entityTableName) && tableNames.includes(metadataTableName)) {
          const metadata = await this.readPersistedMetadata(db, metadataTableName, topicId);
          if (metadata.entityCount > 0 || metadata.edgeCount > 0) {
            throw new KnowledgeGraphCorruptionError(
              `Knowledge graph ${topicId} is corrupt: metadata records persisted graph data but its entity table ` +
                "is missing. Restore a valid backup or rebuild the topic knowledge graph.",
            );
          }
        }
        return tableNames.includes(entityTableName);
      } catch (error) {
        this.logger.error("Failed to check knowledge graph existence", {
          error: error instanceof Error ? error.message : String(error),
          topicId,
        });
        throw error;
      }
    });
  }

  dispose(): void {
    for (const table of this.tables) {
      table.close();
    }
    this.tables.clear();
    this.db?.close();
    this.db = null;
    this.dbPromise = null;
  }

  private getDb(): Promise<Connection> {
    this.dbPromise ??= connect(this.lanceDbUri).then((db) => {
      this.db = db;
      return db;
    });
    return this.dbPromise;
  }

  private async readPersistedMetadata(
    db: Connection,
    metadataTableName: string,
    topicId: string,
  ): Promise<KnowledgeGraphData["metadata"]> {
    const metadataTable = await db.openTable(metadataTableName);
    this.trackTable(metadataTable);
    const rows = await metadataTable.query().limit(1).toArray();
    if (typeof rows[0]?.data !== "string") {
      throw new KnowledgeGraphCorruptionError(
        `Knowledge graph ${topicId} is corrupt: its metadata table has no readable graph record.`,
      );
    }
    try {
      const metadata = JSON.parse(rows[0].data as string) as Partial<KnowledgeGraphData["metadata"]>;
      if (
        !metadata ||
        metadata.topicId !== topicId ||
        !Number.isInteger(metadata.entityCount) ||
        metadata.entityCount! < 0 ||
        !Number.isInteger(metadata.edgeCount) ||
        metadata.edgeCount! < 0
      ) {
        throw new Error("invalid metadata fields");
      }
      return metadata as KnowledgeGraphData["metadata"];
    } catch (error) {
      if (error instanceof KnowledgeGraphCorruptionError) {
        throw error;
      }
      throw new KnowledgeGraphCorruptionError(
        `Knowledge graph ${topicId} is corrupt: its persisted metadata is malformed.`,
      );
    }
  }

  private trackTable(table: Table): void {
    this.tables.add(table);
    while (this.tables.size > this.maxOpenTables) {
      const oldest = this.tables.values().next().value as Table | undefined;
      if (!oldest) {
        break;
      }
      this.tables.delete(oldest);
      oldest.close();
    }
  }

  private topicJournalPath(topicId: string): string {
    const digest = crypto.createHash("sha256").update(topicId).digest("hex").slice(0, 24);
    return path.join(this.lanceDbUri, `.knowledge-graph-${digest}.journal.json`);
  }

  private async withTopicJournal<T>(topicId: string, operation: () => Promise<T>): Promise<T> {
    await this.recoverTopicUnlocked(topicId);
    const previousGraph = await this.loadGraphUnlocked(topicId);
    const journalPath = this.topicJournalPath(topicId);
    const journal = {
      version: 1,
      state: "prepared",
      topicId,
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
        if (previousGraph) {
          await this.saveGraphUnlocked(topicId, previousGraph);
        } else {
          await this.deleteGraphUnlocked(topicId);
        }
        await fs.unlink(journalPath);
      } catch (rollbackError) {
        this.logger.error(`Knowledge graph rollback failed; recovery journal retained at ${journalPath}`, {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          topicId,
        });
      }
      throw error;
    }
  }

  private async recoverTopicUnlocked(topicId: string): Promise<void> {
    const journalPath = this.topicJournalPath(topicId);
    let journal: {
      version: number;
      state: "prepared" | "committed";
      topicId: string;
      previousGraph: KnowledgeGraphData | null;
    };
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw new Error(
        `Knowledge graph recovery journal is corrupt at ${journalPath}; refusing to expose a potentially torn graph`,
      );
    }
    if (journal.version !== 1 || journal.topicId !== topicId) {
      throw new Error(`Knowledge graph recovery journal identity mismatch at ${journalPath}`);
    }
    if (journal.state === "committed") {
      await fs.unlink(journalPath);
      return;
    }
    if (journal.state !== "prepared") {
      throw new Error(`Knowledge graph recovery journal has invalid state at ${journalPath}`);
    }
    if (journal.previousGraph) {
      await this.saveGraphUnlocked(topicId, journal.previousGraph);
    } else {
      await this.deleteGraphUnlocked(topicId);
    }
    await fs.unlink(journalPath);
  }

  private entitySchema(dimension: number): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("name", new Utf8(), false),
      new Field("type", new Utf8(), false),
      new Field("description", new Utf8(), false),
      new Field("vector", new FixedSizeList(dimension, new Field("item", new Float32(), false)), false),
      new Field("sourceChunkIds", new Utf8(), false),
      new Field("confidence", new Float64(), false),
      new Field("strength", new Float64(), false),
      new Field("lastAccessedAt", new Float64(), false),
      new Field("metadata", new Utf8(), false),
    ]);
  }

  private edgeSchema(): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("sourceId", new Utf8(), false),
      new Field("targetId", new Utf8(), false),
      new Field("type", new Utf8(), false),
      new Field("weight", new Float64(), false),
      new Field("description", new Utf8(), false),
      new Field("sourceChunkIds", new Utf8(), false),
      new Field("confidence", new Float64(), false),
      new Field("metadata", new Utf8(), false),
    ]);
  }

  private metadataSchema(): Schema {
    return new Schema([new Field("id", new Utf8(), false), new Field("data", new Utf8(), false)]);
  }
}
