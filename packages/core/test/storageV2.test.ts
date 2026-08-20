import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  atomicWriteJson,
  ensureStorageFormatV2,
  resetStorageToV2,
  STORAGE_FORMAT_FILENAME,
  STORAGE_CONFIG_FILENAME,
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
      expect((error as Error).message).to.include("unversioned");
      expect((error as Error).message).to.include("ragnarok-migrate");
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
      expect((error as Error).message).to.include("unversioned");
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

  it("atomically replaces JSON without leaving temporary files", async () => {
    const target = path.join(directory, "topics.json");
    await atomicWriteJson(target, { value: 1 });
    await atomicWriteJson(target, { value: 2 });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).to.deep.equal({ value: 2 });
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).to.deep.equal([]);
  });
});
