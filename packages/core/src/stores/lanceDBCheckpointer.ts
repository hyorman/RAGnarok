/**
 * LanceDB-backed checkpoint saver for LangGraph.
 *
 * Schema v2 stores typed LangGraph serde payloads and uses merge-insert for
 * idempotent writes. Legacy tables are retained as a backup and copied into
 * v2 on startup without overwriting records that already exist in v2.
 */

import { connect, type Connection, type Table } from "@lancedb/lancedb";
import * as path from "path";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type ChannelVersions,
  type CheckpointMetadata,
  type PendingWrite,
  type CheckpointPendingWrite,
  type SerializerProtocol,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Field, Float64, Schema, Utf8 } from "apache-arrow";
import { Mutex } from "async-mutex";

const LEGACY_CHECKPOINTS_TABLE = "_lg_checkpoints";
const LEGACY_WRITES_TABLE = "_lg_checkpoint_writes";
const CHECKPOINTS_TABLE = "_lg_checkpoints_v2";
const WRITES_TABLE = "_lg_checkpoint_writes_v2";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string;
  data_type: string;
  data: string;
  metadata_type: string;
  metadata: string;
  created_at: number;
  sequence: number;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_path: string;
  task_id: string;
  idx: number;
  channel: string;
  value_type: string;
  value: string;
  sequence: number;
}

interface ScheduledDeletion {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

// LanceDB retries optimistic commit conflicts, but table creation and compound
// upserts still need process-local ordering. Sharing the mutex by URI also
// covers multiple saver instances in this process.
interface MutationState {
  mutex: Mutex;
  lastSequence: number;
}

const mutationStates = new Map<string, MutationState>();

function mutationStateFor(uri: string): MutationState {
  const key = path.resolve(uri);
  let state = mutationStates.get(key);
  if (!state) {
    state = { mutex: new Mutex(), lastSequence: 0 };
    mutationStates.set(key, state);
  }
  return state;
}

function escapeSQL(s: string): string {
  return s.replace(/'/g, "''");
}

function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBytes(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

function compareCheckpointRowsNewestFirst(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const sequenceDifference = Number(b.sequence) - Number(a.sequence);
  if (sequenceDifference !== 0) {
    return sequenceDifference;
  }
  return String(b.checkpoint_id).localeCompare(String(a.checkpoint_id));
}

function compareWriteRows(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (
    String(a.task_path).localeCompare(String(b.task_path)) ||
    String(a.task_id).localeCompare(String(b.task_id)) ||
    Number(a.idx) - Number(b.idx) ||
    Number(a.sequence) - Number(b.sequence)
  );
}

export class LanceDBCheckpointSaver extends BaseCheckpointSaver {
  private readonly lanceDbUri: string;
  private readonly mutationState: MutationState;
  private readonly mutationMutex: Mutex;
  private db: Connection | null = null;
  private dbPromise: Promise<Connection> | null = null;
  private checkpointTable: Table | null = null;
  private writesTable: Table | null = null;
  private initializePromise: Promise<void> | null = null;
  private acceptingOperations = true;
  private activeOperations = 0;
  private drainWaiters: Array<() => void> = [];
  private scheduledDeletions = new Map<string, ScheduledDeletion>();
  private backgroundTasks = new Set<Promise<void>>();
  private threadGenerations = new Map<string, number>();
  private disposePromise: Promise<void> | null = null;

  constructor(lanceDbUri: string, serde?: SerializerProtocol) {
    super(serde);
    this.lanceDbUri = lanceDbUri;
    this.mutationState = mutationStateFor(lanceDbUri);
    this.mutationMutex = this.mutationState.mutex;
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingOperations) {
      throw new Error("Checkpoint saver is disposing or has been disposed.");
    }
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.drainWaiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  private async waitForOperationsToDrain(): Promise<void> {
    if (this.activeOperations === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private async getDb(): Promise<Connection> {
    if (this.db) {
      return this.db;
    }
    if (!this.dbPromise) {
      this.dbPromise = connect(this.lanceDbUri).then((db) => {
        this.db = db;
        return db;
      });
    }
    return this.dbPromise;
  }

  private async createOrOpenTable(name: string, schema: Schema): Promise<Table> {
    const db = await this.getDb();
    const tables = await db.tableNames();
    if (tables.includes(name)) {
      return db.openTable(name);
    }

    try {
      return await db.createEmptyTable(name, schema);
    } catch (error) {
      // A different process may have won the create race. Opening is safe only
      // when the table became visible; otherwise preserve the original error.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const refreshed = await db.tableNames();
        if (refreshed.includes(name)) {
          return db.openTable(name);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw error;
    }
  }

  private checkpointSchema(): Schema {
    return new Schema([
      new Field("thread_id", new Utf8(), false),
      new Field("checkpoint_ns", new Utf8(), false),
      new Field("checkpoint_id", new Utf8(), false),
      new Field("parent_checkpoint_id", new Utf8(), false),
      new Field("data_type", new Utf8(), false),
      new Field("data", new Utf8(), false),
      new Field("metadata_type", new Utf8(), false),
      new Field("metadata", new Utf8(), false),
      new Field("created_at", new Float64(), false),
      new Field("sequence", new Float64(), false),
    ]);
  }

  private writesSchema(): Schema {
    return new Schema([
      new Field("thread_id", new Utf8(), false),
      new Field("checkpoint_ns", new Utf8(), false),
      new Field("checkpoint_id", new Utf8(), false),
      new Field("task_path", new Utf8(), false),
      new Field("task_id", new Utf8(), false),
      new Field("idx", new Float64(), false),
      new Field("channel", new Utf8(), false),
      new Field("value_type", new Utf8(), false),
      new Field("value", new Utf8(), false),
      new Field("sequence", new Float64(), false),
    ]);
  }

  private async migrateLegacyTables(tableNames: string[]): Promise<void> {
    const db = await this.getDb();

    if (tableNames.includes(LEGACY_CHECKPOINTS_TABLE)) {
      const legacy = await db.openTable(LEGACY_CHECKPOINTS_TABLE);
      try {
        const rows = await legacy.query().toArray();
        rows.sort(
          (a, b) =>
            Number(a.created_at) - Number(b.created_at) ||
            String(a.checkpoint_id).localeCompare(String(b.checkpoint_id)),
        );
        const migrated: CheckpointRow[] = [];
        let previousCreatedAt = Number.NaN;
        let sameTimestampOrdinal = 0;
        for (const row of rows) {
          const createdAt = Number(row.created_at);
          if (!Number.isFinite(createdAt)) {
            throw new Error(`Cannot migrate legacy checkpoint "${String(row.checkpoint_id)}": invalid created_at`);
          }
          if (createdAt === previousCreatedAt) {
            sameTimestampOrdinal += 1;
          } else {
            previousCreatedAt = createdAt;
            sameTimestampOrdinal = 0;
          }
          const checkpoint = JSON.parse(String(row.data)) as Checkpoint;
          const metadata = JSON.parse(String(row.metadata)) as CheckpointMetadata;
          const [[dataType, data], [metadataType, metadataData]] = await Promise.all([
            this.serde.dumpsTyped(checkpoint),
            this.serde.dumpsTyped(metadata),
          ]);
          migrated.push({
            thread_id: String(row.thread_id),
            checkpoint_ns: String(row.checkpoint_ns),
            checkpoint_id: String(row.checkpoint_id),
            parent_checkpoint_id: String(row.parent_checkpoint_id ?? ""),
            data_type: dataType,
            data: encodeBytes(data),
            metadata_type: metadataType,
            metadata: encodeBytes(metadataData),
            created_at: createdAt,
            // Preserve the legacy chronology relative to records that already
            // exist in v2. Calling nextSequence() here would assign every
            // migrated legacy row a value newer than the current v2 maximum,
            // causing an old backup checkpoint to become "latest".
            sequence: createdAt * 1000 + sameTimestampOrdinal,
          });
        }
        for (const row of migrated) {
          this.mutationState.lastSequence = Math.max(this.mutationState.lastSequence, row.sequence);
        }
        if (migrated.length > 0) {
          await this.checkpointTable!.mergeInsert(["thread_id", "checkpoint_ns", "checkpoint_id"])
            .whenNotMatchedInsertAll()
            .execute(migrated as unknown as Record<string, unknown>[]);
        }
      } finally {
        legacy.close();
      }
    }

    if (tableNames.includes(LEGACY_WRITES_TABLE)) {
      const legacy = await db.openTable(LEGACY_WRITES_TABLE);
      try {
        const rows = await legacy.query().toArray();
        rows.sort(
          (a, b) =>
            String(a.task_id).localeCompare(String(b.task_id)) ||
            Number(a.idx) - Number(b.idx) ||
            String(a.channel).localeCompare(String(b.channel)),
        );
        const migrated: WriteRow[] = [];
        for (const row of rows) {
          const value = JSON.parse(String(row.value));
          const [valueType, serialized] = await this.serde.dumpsTyped(value);
          migrated.push({
            thread_id: String(row.thread_id),
            checkpoint_ns: String(row.checkpoint_ns),
            checkpoint_id: String(row.checkpoint_id),
            task_path: String(row.checkpoint_ns),
            task_id: String(row.task_id),
            idx: Number(row.idx),
            channel: String(row.channel),
            value_type: valueType,
            value: encodeBytes(serialized),
            sequence: this.nextSequence(),
          });
        }
        if (migrated.length > 0) {
          await this.writesTable!.mergeInsert([
            "thread_id",
            "checkpoint_ns",
            "checkpoint_id",
            "task_path",
            "task_id",
            "idx",
          ])
            .whenNotMatchedInsertAll()
            .execute(migrated as unknown as Record<string, unknown>[]);
        }
      } finally {
        legacy.close();
      }
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.mutationMutex.runExclusive(async () => {
        if (this.checkpointTable && this.writesTable) {
          return;
        }
        const db = await this.getDb();
        const initialTableNames = await db.tableNames();
        this.checkpointTable = await this.createOrOpenTable(CHECKPOINTS_TABLE, this.checkpointSchema());
        this.writesTable = await this.createOrOpenTable(WRITES_TABLE, this.writesSchema());

        const existingRows = await this.checkpointTable.query().select(["sequence"]).toArray();
        for (const row of existingRows) {
          this.mutationState.lastSequence = Math.max(this.mutationState.lastSequence, Number(row.sequence));
        }
        await this.migrateLegacyTables(initialTableNames);
      });
      this.initializePromise.catch(() => {
        this.initializePromise = null;
      });
    }
    await this.initializePromise;
  }

  private nextSequence(now = Date.now()): number {
    // Milliseconds leave three decimal digits for bursts while remaining below
    // Number.MAX_SAFE_INTEGER for contemporary dates.
    this.mutationState.lastSequence = Math.max(this.mutationState.lastSequence + 1, now * 1000);
    return this.mutationState.lastSequence;
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    await this.initialize();
    await this.writesTable!.checkoutLatest();
    const rows = await this.writesTable!.query()
      .where(
        `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpointId)}'`,
      )
      .toArray();
    rows.sort(compareWriteRows);
    return Promise.all(
      rows.map(async (row) => [
        String(row.task_id),
        String(row.channel),
        await this.serde.loadsTyped(String(row.value_type), decodeBytes(String(row.value))),
      ]),
    );
  }

  private async tupleFromRow(row: Record<string, unknown>): Promise<CheckpointTuple> {
    const threadId = String(row.thread_id);
    const checkpointNs = String(row.checkpoint_ns);
    const checkpointId = String(row.checkpoint_id);
    const checkpoint = (await this.serde.loadsTyped(
      String(row.data_type),
      decodeBytes(String(row.data)),
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      String(row.metadata_type),
      decodeBytes(String(row.metadata)),
    )) as CheckpointMetadata;
    const pendingWrites = await this.loadPendingWrites(threadId, checkpointNs, checkpointId);
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    const parentCheckpointId = String(row.parent_checkpoint_id ?? "");
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

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.withOperation(async () => {
      const threadId = config.configurable?.thread_id as string;
      const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
      const checkpointId = getCheckpointId(config);
      await this.initialize();
      await this.checkpointTable!.checkoutLatest();

      let rows: Record<string, unknown>[];
      if (checkpointId) {
        rows = await this.checkpointTable!.query()
          .where(
            `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' AND checkpoint_id = '${escapeSQL(checkpointId)}'`,
          )
          .limit(1)
          .toArray();
      } else {
        rows = await this.checkpointTable!.query()
          .where(`thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}'`)
          .toArray();
        rows.sort(compareCheckpointRowsNewestFirst);
        rows = rows.slice(0, 1);
      }
      return rows.length === 0 ? undefined : this.tupleFromRow(rows[0]);
    });
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const tuples = await this.withOperation(async () => {
      const { limit, before, filter } = options ?? {};
      if (limit !== undefined && limit <= 0) {
        return [];
      }
      const threadId = config.configurable?.thread_id as string | undefined;
      const checkpointNs = config.configurable?.checkpoint_ns as string | undefined;
      const configuredCheckpointId = config.configurable?.checkpoint_id as string | undefined;
      await this.initialize();
      await this.checkpointTable!.checkoutLatest();
      const predicates: string[] = [];
      if (threadId !== undefined) {
        predicates.push(`thread_id = '${escapeSQL(threadId)}'`);
      }
      if (checkpointNs !== undefined) {
        predicates.push(`checkpoint_ns = '${escapeSQL(checkpointNs)}'`);
      }
      const query = this.checkpointTable!.query();
      const rows =
        predicates.length > 0 ? await query.where(predicates.join(" AND ")).toArray() : await query.toArray();
      rows.sort(compareCheckpointRowsNewestFirst);

      let beforeSequence: number | undefined;
      const beforeId = before?.configurable?.checkpoint_id as string | undefined;
      if (beforeId) {
        const beforeRow = rows.find((row) => String(row.checkpoint_id) === beforeId);
        beforeSequence = beforeRow ? Number(beforeRow.sequence) : undefined;
      }

      const result: CheckpointTuple[] = [];
      for (const row of rows) {
        const checkpointId = String(row.checkpoint_id);
        if (configuredCheckpointId && checkpointId !== configuredCheckpointId) {
          continue;
        }
        if (
          beforeId &&
          (beforeSequence !== undefined ? Number(row.sequence) >= beforeSequence : checkpointId >= beforeId)
        ) {
          continue;
        }
        const metadata = (await this.serde.loadsTyped(
          String(row.metadata_type),
          decodeBytes(String(row.metadata)),
        )) as CheckpointMetadata;
        if (
          filter &&
          !Object.entries(filter).every(
            ([key, value]) => (metadata as unknown as Record<string, unknown>)[key] === value,
          )
        ) {
          continue;
        }
        result.push(await this.tupleFromRow(row));
        if (limit !== undefined && result.length >= limit) {
          break;
        }
      }
      return result;
    });

    yield* tuples;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.withOperation(async () => {
      await this.initialize();
      return this.mutationMutex.runExclusive(async () => {
        const threadId = config.configurable?.thread_id as string;
        const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
        const parentCheckpointId = (config.configurable?.checkpoint_id ?? "") as string;
        if (!threadId) {
          throw new Error('Failed to put checkpoint. Missing required "thread_id" in configurable.');
        }
        this.cancelScheduledDeletion(threadId);
        this.threadGenerations.set(threadId, (this.threadGenerations.get(threadId) ?? 0) + 1);

        const prepared = copyCheckpoint(checkpoint);
        const [[dataType, data], [metadataType, metadataData]] = await Promise.all([
          this.serde.dumpsTyped(prepared),
          this.serde.dumpsTyped(metadata),
        ]);
        await this.checkpointTable!.checkoutLatest();
        const existingRows = await this.checkpointTable!.query()
          .where(
            `thread_id = '${escapeSQL(threadId)}' AND checkpoint_ns = '${escapeSQL(checkpointNs)}' ` +
              `AND checkpoint_id = '${escapeSQL(checkpoint.id)}'`,
          )
          .select(["parent_checkpoint_id", "data_type", "data", "metadata_type", "metadata"])
          .limit(1)
          .toArray();
        if (existingRows.length > 0) {
          const existing = existingRows[0];
          if (
            String(existing.parent_checkpoint_id ?? "") !== parentCheckpointId ||
            String(existing.data_type) !== dataType ||
            String(existing.data) !== encodeBytes(data) ||
            String(existing.metadata_type) !== metadataType ||
            String(existing.metadata) !== encodeBytes(metadataData)
          ) {
            throw new Error(
              `Checkpoint identity collision for thread "${threadId}", namespace "${checkpointNs}", ` +
                `checkpoint "${checkpoint.id}"`,
            );
          }
          // Checkpoints are immutable by identity. An at-least-once retry must
          // not refresh created_at/sequence and promote an ancestor above a
          // descendant that committed later.
          return {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: checkpointNs,
              checkpoint_id: checkpoint.id,
            },
          };
        }
        const row: CheckpointRow = {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: parentCheckpointId,
          data_type: dataType,
          data: encodeBytes(data),
          metadata_type: metadataType,
          metadata: encodeBytes(metadataData),
          created_at: Date.now(),
          sequence: this.nextSequence(),
        };
        await this.checkpointTable!.mergeInsert(["thread_id", "checkpoint_ns", "checkpoint_id"])
          .whenNotMatchedInsertAll()
          .execute([row] as unknown as Record<string, unknown>[]);

        return {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpoint.id,
          },
        };
      });
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.withOperation(async () => {
      await this.initialize();
      await this.mutationMutex.runExclusive(async () => {
        const threadId = config.configurable?.thread_id as string;
        const checkpointNs = (config.configurable?.checkpoint_ns ?? "") as string;
        const checkpointId = config.configurable?.checkpoint_id as string;
        if (!threadId) {
          throw new Error('Failed to put writes. Missing required "thread_id" in configurable.');
        }
        if (!checkpointId) {
          throw new Error('Failed to put writes. Missing required "checkpoint_id" in configurable.');
        }
        const positiveRows: WriteRow[] = [];
        const specialRows: WriteRow[] = [];
        for (let index = 0; index < writes.length; index += 1) {
          const [channel, value] = writes[index];
          const idx = WRITES_IDX_MAP[channel as string] ?? index;
          const [valueType, serialized] = await this.serde.dumpsTyped(value);
          const row: WriteRow = {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpointId,
            task_path: checkpointNs,
            task_id: taskId,
            idx,
            channel: channel as string,
            value_type: valueType,
            value: encodeBytes(serialized),
            sequence: this.nextSequence(),
          };
          (idx >= 0 ? positiveRows : specialRows).push(row);
        }
        const key = ["thread_id", "checkpoint_ns", "checkpoint_id", "task_path", "task_id", "idx"];
        await this.writesTable!.checkoutLatest();
        if (positiveRows.length > 0) {
          await this.writesTable!.mergeInsert(key)
            .whenNotMatchedInsertAll()
            .execute(positiveRows as unknown as Record<string, unknown>[]);
        }
        if (specialRows.length > 0) {
          await this.writesTable!.mergeInsert(key)
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(specialRows as unknown as Record<string, unknown>[]);
        }
      });
    });
  }

  private cancelScheduledDeletion(threadId: string): void {
    const scheduled = this.scheduledDeletions.get(threadId);
    if (!scheduled) {
      return;
    }
    clearTimeout(scheduled.timer);
    this.scheduledDeletions.delete(threadId);
  }

  private async deleteThreadUnlocked(threadId: string): Promise<void> {
    const escapedId = escapeSQL(threadId);
    await this.checkpointTable!.checkoutLatest();
    await this.writesTable!.checkoutLatest();
    await this.checkpointTable!.delete(`thread_id = '${escapedId}'`);
    await this.writesTable!.delete(`thread_id = '${escapedId}'`);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.withOperation(async () => {
      await this.initialize();
      await this.mutationMutex.runExclusive(async () => {
        this.cancelScheduledDeletion(threadId);
        this.threadGenerations.set(threadId, (this.threadGenerations.get(threadId) ?? 0) + 1);
        await this.deleteThreadUnlocked(threadId);
      });
    });
  }

  /** Delete a completed thread after an optional debugging-retention window. */
  deleteThreadAfter(threadId: string, delayMs: number): void {
    if (!this.acceptingOperations) {
      return;
    }
    this.cancelScheduledDeletion(threadId);
    const generation = this.threadGenerations.get(threadId) ?? 0;
    const timer = setTimeout(
      () => {
        this.scheduledDeletions.delete(threadId);
        const task = this.withOperation(() =>
          this.mutationMutex.runExclusive(async () => {
            if ((this.threadGenerations.get(threadId) ?? 0) === generation) {
              this.threadGenerations.set(threadId, generation + 1);
              await this.deleteThreadUnlocked(threadId);
            }
          }),
        ).catch(() => {
          // Disposal rejects new operations; the timer is intentionally cancelled.
        });
        this.backgroundTasks.add(task);
        void task.finally(() => this.backgroundTasks.delete(task));
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
    this.scheduledDeletions.set(threadId, { generation, timer });
  }

  /**
   * Delete threads whose latest checkpoint is strictly older than `cutoff`.
   * A checkpoint created exactly at the cutoff is retained. A thread with any
   * checkpoint at or after the cutoff is active and is retained in full.
   */
  async deleteOlderThan(cutoff: number, threadPrefix?: string): Promise<number> {
    return this.withOperation(async () => {
      await this.initialize();
      return this.mutationMutex.runExclusive(async () => {
        await this.checkpointTable!.checkoutLatest();
        const rows = await this.checkpointTable!.query().select(["thread_id", "created_at"]).toArray();
        const latestByThread = new Map<string, number>();
        for (const row of rows) {
          const threadId = String(row.thread_id);
          if (threadPrefix && !threadId.startsWith(threadPrefix)) {
            continue;
          }
          latestByThread.set(
            threadId,
            Math.max(latestByThread.get(threadId) ?? Number.NEGATIVE_INFINITY, Number(row.created_at)),
          );
        }
        const expired = [...latestByThread]
          .filter(([, latest]) => latest < cutoff)
          .map(([threadId]) => threadId)
          .sort();
        for (const threadId of expired) {
          this.cancelScheduledDeletion(threadId);
          this.threadGenerations.set(threadId, (this.threadGenerations.get(threadId) ?? 0) + 1);
          await this.deleteThreadUnlocked(threadId);
        }
        return expired.length;
      });
    });
  }

  /**
   * Stop admission, cancel delayed deletion, drain in-flight work, and close
   * native handles. It is safe to await this more than once.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        this.acceptingOperations = false;
        for (const { timer } of this.scheduledDeletions.values()) {
          clearTimeout(timer);
        }
        this.scheduledDeletions.clear();
        await this.waitForOperationsToDrain();
        await Promise.allSettled([...this.backgroundTasks]);
        this.checkpointTable?.close();
        this.writesTable?.close();
        this.db?.close();
        this.checkpointTable = null;
        this.writesTable = null;
        this.db = null;
        this.dbPromise = null;
        this.initializePromise = null;
      })();
    }
    return this.disposePromise;
  }
}
