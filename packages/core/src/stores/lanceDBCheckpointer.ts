/**
 * LanceDB-backed checkpoint saver for LangGraph.
 * Stores checkpoint state and pending writes in two LanceDB tables.
 */

import { connect, type Connection, type Table } from "@lancedb/lancedb";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type ChannelVersions,
  type CheckpointMetadata,
  type PendingWrite,
  type CheckpointPendingWrite,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

const CHECKPOINTS_TABLE = "_lg_checkpoints";
const WRITES_TABLE = "_lg_checkpoint_writes";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string;
  data: string;
  metadata: string;
  created_at: number;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: string;
}

function escapeSQL(s: string): string {
  return s.replace(/'/g, "''");
}

export class LanceDBCheckpointSaver extends BaseCheckpointSaver {
  private lanceDbUri: string;
  private db: Connection | null = null;
  private checkpointTable: Table | null = null;
  private writesTable: Table | null = null;

  constructor(lanceDbUri: string) {
    super();
    this.lanceDbUri = lanceDbUri;
  }

  private async getDb(): Promise<Connection> {
    if (!this.db) {
      this.db = await connect(this.lanceDbUri);
    }
    return this.db;
  }

  private async getCheckpointTable(): Promise<Table | null> {
    if (this.checkpointTable) {
      return this.checkpointTable;
    }
    const db = await this.getDb();
    const tables = await db.tableNames();
    if (!tables.includes(CHECKPOINTS_TABLE)) {
      return null;
    }
    this.checkpointTable = await db.openTable(CHECKPOINTS_TABLE);
    return this.checkpointTable;
  }

  private async getWritesTable(): Promise<Table | null> {
    if (this.writesTable) {
      return this.writesTable;
    }
    const db = await this.getDb();
    const tables = await db.tableNames();
    if (!tables.includes(WRITES_TABLE)) {
      return null;
    }
    this.writesTable = await db.openTable(WRITES_TABLE);
    return this.writesTable;
  }

  private async ensureCheckpointTable(): Promise<Table> {
    const existing = await this.getCheckpointTable();
    if (existing) {
      return existing;
    }
    const db = await this.getDb();
    const seed: CheckpointRow[] = [
      {
        thread_id: "__seed__",
        checkpoint_ns: "",
        checkpoint_id: "",
        parent_checkpoint_id: "",
        data: "{}",
        metadata: "{}",
        created_at: 0,
      },
    ];
    this.checkpointTable = await db.createTable(CHECKPOINTS_TABLE, seed as unknown as Record<string, unknown>[]);
    await this.checkpointTable.delete("thread_id = '__seed__'");
    return this.checkpointTable;
  }

  private async ensureWritesTable(): Promise<Table> {
    const existing = await this.getWritesTable();
    if (existing) {
      return existing;
    }
    const db = await this.getDb();
    const seed: WriteRow[] = [
      {
        thread_id: "__seed__",
        checkpoint_ns: "",
        checkpoint_id: "",
        task_id: "",
        idx: 0,
        channel: "",
        type: "",
        value: "null",
      },
    ];
    this.writesTable = await db.createTable(WRITES_TABLE, seed as unknown as Record<string, unknown>[]);
    await this.writesTable.delete("thread_id = '__seed__'");
    return this.writesTable;
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const table = await this.getWritesTable();
    if (!table) {
      return [];
    }
    const rows = await table
      .query()
      .where(
        `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpointId)}'`,
      )
      .toArray();
    return rows.map((row) => [row.task_id as string, row.channel as string, JSON.parse(row.value as string)]);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
    const checkpointId = getCheckpointId(config);

    const table = await this.getCheckpointTable();
    if (!table) {
      return undefined;
    }

    let rows: Record<string, unknown>[];
    if (checkpointId) {
      rows = await table
        .query()
        .where(
          `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpointId)}'`,
        )
        .limit(1)
        .toArray();
    } else {
      // Get the latest checkpoint for this thread
      rows = await table
        .query()
        .where(`thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}'`)
        .toArray();
      // Sort by created_at desc and take the first
      rows.sort((a, b) => (b.created_at as number) - (a.created_at as number));
      rows = rows.slice(0, 1);
    }

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    const checkpoint: Checkpoint = JSON.parse(row.data as string);
    const metadata: CheckpointMetadata = JSON.parse(row.metadata as string);
    const parentCheckpointId = row.parent_checkpoint_id as string;
    const resolvedId = row.checkpoint_id as string;

    const pendingWrites = await this.loadPendingWrites(threadId, checkpointNs, resolvedId);

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: resolvedId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };

    if (parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: parentCheckpointId,
        },
      };
    }

    return tuple;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;

    const table = await this.getCheckpointTable();
    if (!table) {
      return;
    }

    const rows = await table
      .query()
      .where(`thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}'`)
      .toArray();

    // Sort by created_at desc (newest first)
    rows.sort((a, b) => (b.created_at as number) - (a.created_at as number));

    let yielded = 0;
    for (const row of rows) {
      const cpId = row.checkpoint_id as string;

      // Apply "before" filter
      if (before?.configurable?.checkpoint_id && cpId >= before.configurable.checkpoint_id) {
        continue;
      }

      const metadata: CheckpointMetadata = JSON.parse(row.metadata as string);

      // Apply metadata filter
      if (
        filter &&
        !Object.entries(filter).every(([key, value]) => (metadata as Record<string, unknown>)[key] === value)
      ) {
        continue;
      }

      if (limit !== undefined && yielded >= limit) {
        break;
      }

      const checkpoint: Checkpoint = JSON.parse(row.data as string);
      const parentCheckpointId = row.parent_checkpoint_id as string;
      const pendingWrites = await this.loadPendingWrites(threadId, checkpointNs, cpId);

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: cpId,
          },
        },
        checkpoint,
        metadata,
        pendingWrites,
      };

      if (parentCheckpointId) {
        tuple.parentConfig = {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: parentCheckpointId,
          },
        };
      }

      yield tuple;
      yielded += 1;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
    const parentCheckpointId = (config.configurable?.checkpoint_id ?? "") as string;

    if (!threadId) {
      throw new Error('Failed to put checkpoint. Missing required "thread_id" in configurable.');
    }

    const prepared = copyCheckpoint(checkpoint);
    const table = await this.ensureCheckpointTable();

    // Delete existing row if any (upsert)
    try {
      await table.delete(
        `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpoint.id)}'`,
      );
    } catch {
      // Table may be empty, ignore
    }

    const row: CheckpointRow = {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpoint.id,
      parent_checkpoint_id: parentCheckpointId,
      data: JSON.stringify(prepared),
      metadata: JSON.stringify(metadata),
      created_at: Date.now(),
    };

    await table.add([row] as unknown as Record<string, unknown>[]);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
    const checkpointId = config.configurable?.checkpoint_id as string;

    if (!threadId) {
      throw new Error('Failed to put writes. Missing required "thread_id" in configurable.');
    }
    if (!checkpointId) {
      throw new Error('Failed to put writes. Missing required "checkpoint_id" in configurable.');
    }

    const table = await this.ensureWritesTable();

    // One dedup query for the whole (thread, ns, checkpoint, task) tuple —
    // a query per write meant W round-trips for every superstep.
    const existingIdx = new Set<number>();
    try {
      const existing = await table
        .query()
        .where(
          `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpointId)}' AND task_id = '${escapeSQL(taskId)}'`,
        )
        .toArray();
      for (const row of existing) {
        existingIdx.add(row.idx as number);
      }
    } catch {
      // Table may be empty, proceed with insert
    }

    const newRows: WriteRow[] = [];
    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const idx = WRITES_IDX_MAP[channel as string] ?? i;

      // For non-negative indices, skip writes already persisted
      if (idx >= 0 && existingIdx.has(idx)) {
        continue;
      }

      newRows.push({
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        task_id: taskId,
        idx,
        channel: channel as string,
        type: typeof value,
        value: JSON.stringify(value),
      });
    }

    if (newRows.length > 0) {
      await table.add(newRows as unknown as Record<string, unknown>[]);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const escapedId = escapeSQL(threadId);
    const cpTable = await this.getCheckpointTable();
    if (cpTable) {
      try {
        await cpTable.delete(`thread_id = '${escapedId}'`);
      } catch {
        // Ignore if table is empty or row not found
      }
    }
    const wTable = await this.getWritesTable();
    if (wTable) {
      try {
        await wTable.delete(`thread_id = '${escapedId}'`);
      } catch {
        // Ignore if table is empty or row not found
      }
    }
  }
}
