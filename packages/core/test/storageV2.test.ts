import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  atomicWriteJson,
  assertNoInterruptedStorageMigration,
  ensureStorageFormatV2,
  resetStorageToV2,
  STORAGE_FORMAT_FILENAME,
  STORAGE_FORMAT_VERSION,
  STORAGE_CONFIG_FILENAME,
  STORAGE_RESET_JOURNAL_FILENAME,
} from "../src/utils/storageV2";
import { STORAGE_LOCK_FILENAME } from "../src/utils/storageLock";

describe("storage format v2", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-storage-v2-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("initializes an empty installation", async () => {
    expect((await ensureStorageFormatV2(directory)).formatVersion).to.equal(2);
    const marker = JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"));
    expect(marker.formatVersion).to.equal(2);
  });

  it("fails closed for non-empty unversioned storage", async () => {
    await fs.mkdir(path.join(directory, "database"));
    try {
      await ensureStorageFormatV2(directory);
      expect.fail("expected format validation to fail");
    } catch (error) {
      expect((error as Error).name).to.equal("UnversionedStorageError");
    }
  });

  it("ignores the storage lock file when judging whether a directory holds data", async () => {
    // The cross-process lock is acquired BEFORE format validation, so a
    // fresh directory containing only .ragnarok.lock must initialize cleanly.
    await fs.writeFile(path.join(directory, STORAGE_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    expect((await ensureStorageFormatV2(directory)).formatVersion).to.equal(2);
  });

  it("does not move the active lock file into the reset backup", async () => {
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, STORAGE_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    const backup = await resetStorageToV2(directory);
    expect(backup).to.be.a("string");
    const backedUp = await fs.readdir(backup!);
    expect(backedUp).to.deep.equal(["database"]);
    // The lock stays in place, still guarding the directory.
    await fs.access(path.join(directory, STORAGE_LOCK_FILENAME));
  });

  it("ignores the generated config file when judging whether a directory holds data", async () => {
    // The MCP server writes config.json during startup, before format
    // validation runs. Treating it as data would make every fresh install look
    // like unversioned v0.3 storage and refuse to start.
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), "{}");
    expect((await ensureStorageFormatV2(directory)).formatVersion).to.equal(2);
  });

  it("still fails closed when the config file sits alongside real unversioned data", async () => {
    // The exemption above is narrow: config.json stops being *evidence* of a
    // legacy install, it does not stop one being detected.
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), "{}");
    await fs.mkdir(path.join(directory, "database"));
    try {
      await ensureStorageFormatV2(directory);
      expect.fail("expected format validation to fail");
    } catch (error) {
      expect((error as Error).name).to.equal("UnversionedStorageError");
    }
  });

  it("does not move the config file into the reset backup", async () => {
    // Resetting the corpus must not silently discard the operator's settings.
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), '{"retrieval":{"topK":5}}');
    const backup = await resetStorageToV2(directory);
    expect(backup).to.be.a("string");
    expect(await fs.readdir(backup!)).to.deep.equal(["database"]);
    expect(await fs.readFile(path.join(directory, STORAGE_CONFIG_FILENAME), "utf8")).to.equal(
      '{"retrieval":{"topK":5}}',
    );
    const marker = JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"));
    expect(marker.formatVersion).to.equal(2);
  });

  it("moves legacy data to a timestamped backup before reset", async () => {
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, "database", "topics.json"), "legacy");
    const backup = await resetStorageToV2(directory);
    expect(backup).to.be.a("string");
    expect(await fs.readFile(path.join(backup!, "database", "topics.json"), "utf8")).to.equal("legacy");
    expect((await ensureStorageFormatV2(directory)).formatVersion).to.equal(2);
  });

  it("restores the format marker and clears the journal when a reset failure fully rolls back", async () => {
    // A healthy v2 store, not a v0.3 layout: resetting it is the "wipe my
    // corpus" path, not a migration. Two top-level entries so the forced
    // failure below lands after at least one has already moved.
    await fs.mkdir(path.join(directory, "database"), { recursive: true });
    await fs.writeFile(path.join(directory, "database", "topics.json"), "v2 data");
    await fs.writeFile(path.join(directory, "extra.txt"), "more v2 data");
    const marker = { formatVersion: STORAGE_FORMAT_VERSION, initializedAt: 999 };
    await atomicWriteJson(path.join(directory, STORAGE_FORMAT_FILENAME), marker);

    // Force the *second* forward move (storageDir entry -> backup-v1-* dir)
    // to fail, simulating a transient error mid-reset after one entry has
    // already been relocated. Restore-direction renames (backup -> storageDir)
    // and unrelated atomic-write renames (journal/marker) are untouched --
    // only a rename landing one level inside a fresh "backup-v1-*" child of
    // this test's storage dir is intercepted.
    //
    // The `import * as fs` binding above is a getter-only ES namespace view
    // (TypeScript's __importStar), so it cannot be assigned to directly; the
    // underlying CommonJS module object -- the one storageV2.ts's own
    // namespace view reads through -- is mutable and shared process-wide.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsModule: typeof fs = require("fs/promises");
    const originalRename = fsModule.rename;
    let forwardMoveCalls = 0;
    fsModule.rename = (async (src: unknown, dest: unknown) => {
      const destParent = path.dirname(String(dest));
      const isForwardMove =
        path.dirname(destParent) === directory && path.basename(destParent).startsWith("backup-v1-");
      if (isForwardMove) {
        forwardMoveCalls += 1;
        if (forwardMoveCalls === 2) {
          throw new Error("simulated transient rename failure");
        }
      }
      return originalRename(src as any, dest as any);
    }) as typeof fs.rename;

    let caught: any;
    try {
      try {
        await resetStorageToV2(directory);
        expect.fail("expected resetStorageToV2 to throw");
      } catch (error) {
        caught = error;
      }
    } finally {
      fsModule.rename = originalRename;
    }
    expect(caught?.message).to.equal("simulated transient rename failure");
    expect(forwardMoveCalls).to.equal(2);

    // The rollback was provably complete, so the store must be genuinely
    // healthy again: marker restored verbatim, journal gone, data untouched.
    expect(await fs.readdir(directory)).to.not.include(STORAGE_RESET_JOURNAL_FILENAME);
    expect(JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"))).to.deep.equal(
      marker,
    );
    expect(await fs.readFile(path.join(directory, "database", "topics.json"), "utf8")).to.equal("v2 data");
    expect(await fs.readFile(path.join(directory, "extra.txt"), "utf8")).to.equal("more v2 data");

    // And the store opens normally afterward instead of throwing
    // StorageResetInterruptedError -- no lingering fail-closed state.
    expect((await ensureStorageFormatV2(directory)).formatVersion).to.equal(2);
  });

  it("atomically replaces JSON without leaving temporary files", async () => {
    const target = path.join(directory, "topics.json");
    await atomicWriteJson(target, { value: 1 });
    await atomicWriteJson(target, { value: 2 });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).to.deep.equal({ value: 2 });
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).to.deep.equal([]);
  });
});

describe("typed storage errors", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-typed-errors-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("throws StorageMigrationInterruptedError with id, stage, and statePath", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(storageDir, { recursive: true });
    const statePath = path.join(dir, ".storage.migration-mig-abc.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({ sourcePath: storageDir, migrationId: "mig-abc", stage: "cutoverPrepared" }),
    );
    try {
      await assertNoInterruptedStorageMigration(storageDir);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error.name).to.equal("StorageMigrationInterruptedError");
      expect(error.migrationId).to.equal("mig-abc");
      expect(error.stage).to.equal("cutoverPrepared");
      expect(error.statePath).to.equal(statePath);
    }
  });

  it("throws UnversionedStorageError for a marker-less dir with managed data", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "database", "topics.json"), "{}");
    try {
      await ensureStorageFormatV2(storageDir);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error.name).to.equal("UnversionedStorageError");
      expect(error.storageDir).to.equal(storageDir);
    }
  });

  it("throws StorageFormatVersionError for a future formatVersion", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(path.join(storageDir, "storage-format.json"), JSON.stringify({ formatVersion: 3 }));
    try {
      await ensureStorageFormatV2(storageDir);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error.name).to.equal("StorageFormatVersionError");
      expect(error.foundVersion).to.equal(3);
    }
  });

  it("throws StorageResetInterruptedError when a reset journal is present, naming the backup dir", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(storageDir, { recursive: true });
    const backupDir = path.join(storageDir, "backup-v1-fake");
    await atomicWriteJson(path.join(storageDir, STORAGE_RESET_JOURNAL_FILENAME), {
      startedAt: Date.now(),
      backupDir,
    });
    try {
      await ensureStorageFormatV2(storageDir);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error.name).to.equal("StorageResetInterruptedError");
      expect(error.storageDir).to.equal(storageDir);
      expect(error.backupDir).to.equal(backupDir);
      expect(error.message).to.include(backupDir);
    }
  });
});
