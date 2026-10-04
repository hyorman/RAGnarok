import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  atomicWriteJson,
  ensureStorageFormat,
  inspectStorage,
  resetStorage,
  SHARED_TOPIC_CACHE_DIRNAME,
  STORAGE_FORMAT_FILENAME,
  STORAGE_FORMAT_VERSION,
  STORAGE_CONFIG_FILENAME,
  STORAGE_RESET_JOURNAL_FILENAME,
  UnsupportedStorageError,
} from "../src/utils/storage";
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
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
    const marker = JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"));
    expect(marker.formatVersion).to.equal(2);
  });

  it("refuses non-empty unversioned storage and leaves it untouched", async () => {
    const legacy = path.join(directory, "database");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "topics.json"), '{"topics":{}}');

    const error = await ensureStorageFormat(directory).then(
      () => undefined,
      (caught: Error) => caught,
    );

    expect(error?.name).to.equal("UnsupportedStorageError");
    expect(await fs.readdir(directory)).to.deep.equal(["database"]);
    expect(await fs.readFile(path.join(legacy, "topics.json"), "utf8")).to.equal('{"topics":{}}');
  });

  it("initializes a directory that holds only infrastructure entries", async () => {
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), "{}");
    await fs.writeFile(path.join(directory, STORAGE_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    await fs.mkdir(path.join(directory, SHARED_TOPIC_CACHE_DIRNAME));
    await fs.mkdir(path.join(directory, "backup-v1-2026-01-01T00-00-00-000Z"));

    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(STORAGE_FORMAT_VERSION);
  });

  it("treats OS and filesystem clutter as empty and stamps the directory", async () => {
    // lost+found sits at the root of every fresh ext4 volume (a Docker bind
    // mount); the others are written by file managers. None is RAGnarok data.
    await fs.writeFile(path.join(directory, ".DS_Store"), "");
    await fs.writeFile(path.join(directory, "Thumbs.db"), "");
    await fs.writeFile(path.join(directory, "desktop.ini"), "");
    await fs.mkdir(path.join(directory, "lost+found"));

    expect(await inspectStorage(directory)).to.deep.equal({ status: "empty" });
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(STORAGE_FORMAT_VERSION);
    expect(await inspectStorage(directory)).to.deep.equal({ status: "current" });
  });

  it("still refuses pre-0.4 data beside clutter, naming the entries that triggered it", async () => {
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, "database", "topics.json"), '{"topics":{}}');
    await fs.writeFile(path.join(directory, ".DS_Store"), "");

    const error = await ensureStorageFormat(directory).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).to.be.instanceOf(UnsupportedStorageError);
    const unsupported = error as UnsupportedStorageError;
    expect(unsupported.entries).to.include("database");
    expect(unsupported.entries).to.not.include(".DS_Store");
  });

  it("ignores the storage lock file when judging whether a directory holds data", async () => {
    // The cross-process lock is acquired BEFORE format validation, so a
    // fresh directory containing only .ragnarok.lock must initialize cleanly.
    await fs.writeFile(path.join(directory, STORAGE_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
  });

  it("does not move the active lock file into the reset backup", async () => {
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, STORAGE_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    const backup = await resetStorage(directory);
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
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
  });

  it("still refuses when the config file sits alongside unversioned data, and keeps both", async () => {
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), "{}");
    await fs.mkdir(path.join(directory, "database"));

    const error = await ensureStorageFormat(directory).then(
      () => undefined,
      (caught: Error) => caught,
    );

    expect(error?.name).to.equal("UnsupportedStorageError");
    expect(await fs.readdir(directory)).to.have.members([STORAGE_CONFIG_FILENAME, "database"]);
  });

  it("lets a reset back up refused pre-0.4 content and start a valid store", async () => {
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, "database", "topics.json"), '{"topics":{}}');

    const backupDir = await resetStorage(directory);

    expect(backupDir).to.be.a("string");
    expect(await fs.readFile(path.join(backupDir!, "database", "topics.json"), "utf8")).to.equal('{"topics":{}}');
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(STORAGE_FORMAT_VERSION);
  });

  it("does not move the config file into the reset backup", async () => {
    // Resetting the corpus must not silently discard the operator's settings.
    await fs.mkdir(path.join(directory, "database"));
    await fs.writeFile(path.join(directory, STORAGE_CONFIG_FILENAME), '{"retrieval":{"topK":5}}');
    const backup = await resetStorage(directory);
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
    const backup = await resetStorage(directory);
    expect(backup).to.be.a("string");
    expect(await fs.readFile(path.join(backup!, "database", "topics.json"), "utf8")).to.equal("legacy");
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
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
    // underlying CommonJS module object -- the one storage.ts's own
    // namespace view reads through -- is mutable and shared process-wide.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
        await resetStorage(directory);
        expect.fail("expected resetStorage to throw");
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
    expect(JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"))).to.deep.equal(marker);
    expect(await fs.readFile(path.join(directory, "database", "topics.json"), "utf8")).to.equal("v2 data");
    expect(await fs.readFile(path.join(directory, "extra.txt"), "utf8")).to.equal("more v2 data");

    // And the store opens normally afterward instead of throwing
    // StorageResetInterruptedError -- no lingering fail-closed state.
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
  });

  it("restores the format marker and clears the journal when backup-dir mkdir fails", async () => {
    // A healthy v2 store; resetting it will fail at mkdir, which should
    // trigger a complete rollback (moved is empty).
    await fs.mkdir(path.join(directory, "database"), { recursive: true });
    await fs.writeFile(path.join(directory, "database", "topics.json"), "v2 data");
    const marker = { formatVersion: STORAGE_FORMAT_VERSION, initializedAt: 999 };
    await atomicWriteJson(path.join(directory, STORAGE_FORMAT_FILENAME), marker);

    // Force fs.mkdir to fail. We only want to intercept the backup-dir mkdir,
    // not any other mkdir calls (e.g., mkdtemp in beforeEach).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsModule: typeof fs = require("fs/promises");
    const originalMkdir = fsModule.mkdir;
    let mkdirCalls = 0;
    fsModule.mkdir = (async (dir: unknown, options?: unknown) => {
      const dirStr = String(dir);
      const isBackupDir = path.dirname(dirStr) === directory && path.basename(dirStr).startsWith("backup-v1-");
      if (isBackupDir) {
        mkdirCalls += 1;
        throw new Error("simulated backup-dir mkdir failure");
      }
      return originalMkdir(dir as any, options as any);
    }) as typeof fs.mkdir;

    let caught: any;
    try {
      try {
        await resetStorage(directory);
        expect.fail("expected resetStorage to throw");
      } catch (error) {
        caught = error;
      }
    } finally {
      fsModule.mkdir = originalMkdir;
    }
    expect(caught?.message).to.equal("simulated backup-dir mkdir failure");
    expect(mkdirCalls).to.equal(1);

    // The rollback was provably complete (moved was empty), so the store must
    // be healthy again: marker restored verbatim, journal gone, data untouched.
    expect(await fs.readdir(directory)).to.not.include(STORAGE_RESET_JOURNAL_FILENAME);
    expect(JSON.parse(await fs.readFile(path.join(directory, STORAGE_FORMAT_FILENAME), "utf8"))).to.deep.equal(marker);
    expect(await fs.readFile(path.join(directory, "database", "topics.json"), "utf8")).to.equal("v2 data");

    // And the store opens normally afterward instead of throwing
    // StorageResetInterruptedError -- no lingering fail-closed state.
    expect((await ensureStorageFormat(directory)).formatVersion).to.equal(2);
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

  it("throws UnsupportedStorageError naming the directory for a marker-less dir with managed data", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "database", "topics.json"), "{}");

    const error = await ensureStorageFormat(storageDir).then(
      () => undefined,
      (caught: Error & { storageDir?: string }) => caught,
    );

    expect(error?.name).to.equal("UnsupportedStorageError");
    expect(error?.storageDir).to.equal(storageDir);
  });

  it("throws StorageFormatVersionError for a future formatVersion", async () => {
    const storageDir = path.join(dir, "storage");
    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(path.join(storageDir, "storage-format.json"), JSON.stringify({ formatVersion: 3 }));
    try {
      await ensureStorageFormat(storageDir);
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
      await ensureStorageFormat(storageDir);
      expect.fail("should have thrown");
    } catch (error: any) {
      expect(error.name).to.equal("StorageResetInterruptedError");
      expect(error.storageDir).to.equal(storageDir);
      expect(error.backupDir).to.equal(backupDir);
      expect(error.message).to.include(backupDir);
    }
  });
});

// The activation path has to know what it is looking at *before* it takes a
// lock or writes anything, so every classification below is reached by reading
// the directory alone.
describe("inspectStorage", () => {
  let dir: string;
  let storageDir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-inspect-"));
    storageDir = path.join(dir, "storage");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports an empty directory as empty", async () => {
    await fs.mkdir(storageDir, { recursive: true });
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "empty" });
  });

  it("reports a v2 marker as current", async () => {
    await fs.mkdir(storageDir, { recursive: true });
    await atomicWriteJson(path.join(storageDir, STORAGE_FORMAT_FILENAME), {
      formatVersion: STORAGE_FORMAT_VERSION,
      initializedAt: Date.now(),
    });
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "current" });
  });

  it("reports a newer marker as future-version, carrying the found version", async () => {
    await fs.mkdir(storageDir, { recursive: true });
    await atomicWriteJson(path.join(storageDir, STORAGE_FORMAT_FILENAME), { formatVersion: 3 });
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "future-version", foundVersion: 3 });
  });

  it("reports marker-less managed data as unsupported", async () => {
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "database", "topics.json"), "{}");
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "unsupported" });
  });

  it("never writes: inspecting an absent directory neither creates it nor marks it", async () => {
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "empty" });
    await fs.access(storageDir).then(
      () => expect.fail("inspectStorage must not create the storage directory"),
      () => undefined,
    );
  });

  it("reports an interrupted reset ahead of the data it left behind", async () => {
    await fs.mkdir(path.join(storageDir, "database"), { recursive: true });
    await atomicWriteJson(path.join(storageDir, STORAGE_RESET_JOURNAL_FILENAME), {
      startedAt: Date.now(),
      backupDir: null,
      marker: null,
    });
    expect(await inspectStorage(storageDir)).to.deep.equal({ status: "reset-interrupted" });
  });
});

describe("shared topic cache and storage v2", function () {
  let storageDir: string;

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-sharedcache-"));
  });

  afterEach(async function () {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("does not classify a store holding only the shared cache as unsupported", async function () {
    await fs.mkdir(path.join(storageDir, SHARED_TOPIC_CACHE_DIRNAME), { recursive: true });

    const inspection = await inspectStorage(storageDir);

    expect(inspection.status).to.equal("empty");
  });

  it("leaves the shared cache in place across a reset", async function () {
    await ensureStorageFormat(storageDir);
    const cacheDir = path.join(storageDir, SHARED_TOPIC_CACHE_DIRNAME);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "entries.json"), "{}", "utf8");

    await resetStorage(storageDir);

    expect(await fs.readFile(path.join(cacheDir, "entries.json"), "utf8")).to.equal("{}");
  });
});
