import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { Mutex } from "async-mutex";

export type StorageTransactionOperation =
  | { type: "replace"; source: string; destination: string }
  | { type: "delete"; destination: string };

interface DurableOperation {
  type: "replace" | "delete";
  destination: string;
  payload?: string;
  backup: string;
  /**
   * Whether the destination existed when the prepare record was built.
   *
   * Rollback must retain this bit durably: once a backup has been restored,
   * both the backup and replacement payload are absent. Without the original
   * existence bit, replay cannot distinguish that state from a replacement
   * that originally targeted an absent destination.
   */
  destinationExisted?: boolean;
}

interface WalPayload {
  version: 1;
  transactionId: string;
  sequence: number;
  state: "prepared" | "committed" | "aborted";
  timestamp: number;
  kind: string;
  ownerId: string;
  operations: DurableOperation[];
  metadata?: Record<string, unknown>;
}

interface WalRecord extends WalPayload {
  checksum: string;
}

export interface StorageTransactionFence {
  readonly ownerId: string;
  assertOwned(): Promise<void>;
}

/**
 * Small filesystem transaction coordinator for publication boundaries.
 *
 * Replacements are copied into same-filesystem transaction staging before a
 * checksummed prepare record is fsynced. Publication uses rename and keeps
 * replaced/deleted destinations as transaction-local backups. A crash before
 * the commit record is rolled back on startup; a crash after it completes by
 * deleting backups. The WAL remains as an audit/recovery record.
 */
export class StorageTransactionCoordinator {
  private readonly root: string;
  private readonly mutex = new Mutex();
  private initialized = false;

  constructor(
    private readonly storageRoot: string,
    private readonly fence: StorageTransactionFence,
  ) {
    this.storageRoot = path.resolve(storageRoot);
    this.root = path.join(this.storageRoot, ".transactions");
  }

  async initialize(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.initialized) {
        return;
      }
      await this.fence.assertOwned();
      await fs.mkdir(this.root, { recursive: true });
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      const walIds = new Set(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".wal"))
          .map((entry) => entry.name.slice(0, -4)),
      );
      for (const entry of entries) {
        if (entry.isDirectory() && !walIds.has(entry.name)) {
          await fs.rm(path.join(this.root, entry.name), { recursive: true, force: true });
        }
      }
      for (const transactionId of [...walIds].sort()) {
        await this.recoverWal(transactionId);
      }
      this.initialized = true;
    });
  }

  async commit(
    kind: string,
    operations: StorageTransactionOperation[],
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    await this.initialize();
    return this.mutex.runExclusive(async () => {
      await this.fence.assertOwned();
      const transactionId = randomUUID();
      const transactionDir = path.join(this.root, transactionId);
      const payloadDir = path.join(transactionDir, "payload");
      const backupDir = path.join(transactionDir, "backup");
      const walPath = path.join(this.root, `${transactionId}.wal`);
      let preparedPersisted = false;
      let prepared: WalPayload;
      try {
        await fs.mkdir(payloadDir, { recursive: true });
        await fs.mkdir(backupDir, { recursive: true });

        const durable: DurableOperation[] = [];
        for (const [index, operation] of operations.entries()) {
          const destination = this.assertManagedPath(operation.destination);
          const backup = path.join(backupDir, String(index));
          const destinationExisted = await this.exists(destination);
          if (operation.type === "replace") {
            const payload = path.join(payloadDir, String(index));
            await fs.cp(operation.source, payload, { recursive: true, force: false, errorOnExist: true });
            durable.push({ type: "replace", destination, payload, backup, destinationExisted });
          } else {
            durable.push({ type: "delete", destination, backup, destinationExisted });
          }
        }

        prepared = {
          version: 1,
          transactionId,
          sequence: 1,
          state: "prepared",
          timestamp: Date.now(),
          kind,
          ownerId: this.fence.ownerId,
          operations: durable,
          metadata,
        };
        await this.appendWal(prepared);
        preparedPersisted = true;
      } catch (error) {
        // No live destination has changed before prepare. Remove partial
        // payload/WAL artifacts immediately so this process need not restart
        // before retrying after source, quota, or disk failures.
        await fs.rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(walPath, { force: true }).catch(() => undefined);
        throw error;
      }

      let commitPersisted = false;
      try {
        await this.applyPrepared(prepared!);
        await this.fence.assertOwned();
        await this.appendWal({ ...prepared!, sequence: 2, state: "committed", timestamp: Date.now() });
        commitPersisted = true;
        await this.fence.assertOwned();
        await fs.rm(transactionDir, { recursive: true, force: true });
        return transactionId;
      } catch (error) {
        // A durable commit record is the visibility decision. Cleanup is
        // idempotent startup work and must never turn a committed transaction
        // back into an abort.
        if (commitPersisted) {
          return transactionId;
        }
        // A fenced owner must stop touching storage immediately. The current
        // owner will deterministically recover the prepared WAL on startup.
        try {
          await this.fence.assertOwned();
        } catch {
          throw error;
        }
        if (!preparedPersisted) {
          throw error;
        }
        await this.rollback(prepared!);
        await this.fence.assertOwned();
        await this.appendWal({ ...prepared!, sequence: 2, state: "aborted", timestamp: Date.now() });
        await this.fence.assertOwned();
        await fs.rm(transactionDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async applyPrepared(record: WalPayload): Promise<void> {
    for (const operation of record.operations) {
      await this.fence.assertOwned();
      await fs.mkdir(path.dirname(operation.destination), { recursive: true });
      if (await this.exists(operation.destination)) {
        await fs.rename(operation.destination, operation.backup);
      }
      if (operation.type === "replace") {
        await fs.rename(operation.payload!, operation.destination);
      }
    }
  }

  private async rollback(record: WalPayload): Promise<void> {
    for (const operation of [...record.operations].reverse()) {
      await this.fence.assertOwned();
      if (await this.exists(operation.backup)) {
        await this.fence.assertOwned();
        await fs.rm(operation.destination, { recursive: true, force: true });
        await fs.mkdir(path.dirname(operation.destination), { recursive: true });
        await this.fence.assertOwned();
        await fs.rename(operation.backup, operation.destination);
      } else if (operation.type === "replace" && !(await this.exists(operation.payload!))) {
        if (operation.destinationExisted === true) {
          // A previous rollback already restored the original generation and
          // consumed its backup. Replaying rollback must preserve it.
          continue;
        }
        if (operation.destinationExisted === undefined && (await this.exists(operation.destination))) {
          // WALs created before destinationExisted was recorded are ambiguous
          // in this state: the visible destination may be either the new
          // payload or an already-restored original. Fail closed rather than
          // risk deleting user data.
          throw new Error(
            `Storage WAL ${record.transactionId} cannot safely replay legacy rollback for ${operation.destination}`,
          );
        }
        // The destination was absent before publication. Move the new
        // generation out of visibility; repeated removal is idempotent.
        await this.fence.assertOwned();
        await fs.rm(operation.destination, { recursive: true, force: true });
      }
    }
  }

  private async recoverWal(transactionId: string): Promise<void> {
    const records = await this.readWal(transactionId);
    if (records.length === 0) {
      return;
    }
    const prepared = records.find((record) => record.state === "prepared");
    if (!prepared) {
      throw new Error(`Storage WAL ${transactionId} has no prepare record`);
    }
    const { checksum: _preparedChecksum, ...preparedPayload } = prepared;
    const terminal = records.at(-1)!;
    const transactionDir = path.join(this.root, transactionId);
    for (const operation of preparedPayload.operations) {
      this.assertManagedPath(operation.destination);
      this.assertTransactionPath(operation.backup, transactionDir);
      if (operation.payload) {
        this.assertTransactionPath(operation.payload, transactionDir);
      }
    }
    if (terminal.state === "prepared") {
      await this.fence.assertOwned();
      await this.rollback(preparedPayload);
      await this.appendWal({
        ...preparedPayload,
        sequence: terminal.sequence + 1,
        state: "aborted",
        timestamp: Date.now(),
      });
    }
    await fs.rm(transactionDir, { recursive: true, force: true });
  }

  private async appendWal(payload: WalPayload): Promise<void> {
    // Hash the exact JSON-compatible representation that will be persisted;
    // this excludes undefined optional fields and normalizes numeric/string
    // representations before the digest is computed.
    const normalized = JSON.parse(JSON.stringify(payload)) as WalPayload;
    const record: WalRecord = { ...normalized, checksum: this.checksum(normalized) };
    const walPath = path.join(this.root, `${payload.transactionId}.wal`);
    const handle = await fs.open(walPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readWal(transactionId: string): Promise<WalRecord[]> {
    const contents = await fs.readFile(path.join(this.root, `${transactionId}.wal`), "utf8");
    const records: WalRecord[] = [];
    for (const line of contents.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as WalRecord;
      const { checksum, ...payload } = record;
      const expectedChecksum = this.checksum(payload);
      if (checksum !== expectedChecksum) {
        throw new Error(
          `Storage WAL ${transactionId} failed checksum validation (expected ${expectedChecksum}, found ${checksum})`,
        );
      }
      if (payload.version !== 1 || payload.transactionId !== transactionId) {
        throw new Error(`Storage WAL ${transactionId} has an invalid identity or version`);
      }
      records.push(record);
    }
    records.sort((left, right) => left.sequence - right.sequence);
    return records;
  }

  private checksum(payload: WalPayload): string {
    return createHash("sha256").update(this.stableSerialize(payload)).digest("hex");
  }

  private stableSerialize(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableSerialize(entry)).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${this.stableSerialize(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  private assertManagedPath(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (resolved === this.storageRoot || !resolved.startsWith(`${this.storageRoot}${path.sep}`)) {
      throw new Error(`Transaction destination escapes managed storage: ${candidate}`);
    }
    if (resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Transaction destination cannot target the WAL directory: ${candidate}`);
    }
    return resolved;
  }

  private assertTransactionPath(candidate: string, transactionDir: string): void {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${transactionDir}${path.sep}`)) {
      throw new Error(`Storage WAL transaction path escapes staging: ${candidate}`);
    }
  }

  private async exists(candidate: string): Promise<boolean> {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return false;
      }
      throw error;
    }
  }
}
