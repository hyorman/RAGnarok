/**
 * LanceDB persistence for knowledge graph entity and edge tables.
 * Uses raw @lancedb/lancedb API (same pattern as VectorStoreFactory).
 */

import { connect } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from "apache-arrow";
import { Mutex } from "async-mutex";
import { Logger } from "../logger";
import { GraphEntity, GraphRelationship, KnowledgeGraphData } from "../utils/graphTypes";

export class KnowledgeGraphStore {
  private lanceDbUri: string;
  private logger: Logger;
  private dbPromise: Promise<Connection> | null = null;
  private db: Connection | null = null;
  private tables = new Set<Table>();
  private mutex = new Mutex();

  constructor(lanceDbUri: string) {
    this.lanceDbUri = lanceDbUri;
    this.logger = new Logger("KnowledgeGraphStore");
  }

  async saveGraph(topicId: string, data: KnowledgeGraphData): Promise<void> {
    return this.mutex.runExclusive(() => this.saveGraphUnlocked(topicId, data));
  }

  private async saveGraphUnlocked(topicId: string, data: KnowledgeGraphData): Promise<void> {
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;

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
        this.tables.add(await db.createEmptyTable(entityTableName, this.entitySchema(entityRows[0].vector.length)));
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(entityTableName)) {
        const table = await db.openTable(entityTableName);
        this.tables.add(table);
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
        this.tables.add(await db.createEmptyTable(edgeTableName, this.edgeSchema()));
      }
      tableNames = await db.tableNames();
      if (tableNames.includes(edgeTableName)) {
        const table = await db.openTable(edgeTableName);
        this.tables.add(table);
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
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;

    this.logger.debug("Loading knowledge graph", { topicId });

    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();

      if (!tableNames.includes(entityTableName)) {
        this.logger.debug("No knowledge graph found", { topicId });
        return null;
      }

      // Load entities
      const entityTable = await db.openTable(entityTableName);
      this.tables.add(entityTable);
      const entityRows = await entityTable.query().limit(100000).toArray();

      // Load edges if table exists
      let edgeRows: Record<string, unknown>[] = [];
      if (tableNames.includes(edgeTableName)) {
        const edgeTable = await db.openTable(edgeTableName);
        this.tables.add(edgeTable);
        edgeRows = await edgeTable.query().limit(100000).toArray();
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
          topicId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          entityCount: entities.length,
          edgeCount: relationships.length,
          communityCount: 0,
          embeddingModel: "",
        },
      };
    } catch (error) {
      this.logger.error("Failed to load knowledge graph", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  async deleteGraph(topicId: string): Promise<void> {
    const entityTableName = `kg-entities-${topicId}`;
    const edgeTableName = `kg-edges-${topicId}`;

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
    const entityTableName = `kg-entities-${topicId}`;

    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();
      return tableNames.includes(entityTableName);
    } catch (error) {
      this.logger.error("Failed to check knowledge graph existence", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
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
}
