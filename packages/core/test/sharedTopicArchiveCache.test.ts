import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Logger } from "../src/logger";
import { SharedArchiveCache, deriveSharedTopicId } from "../src/sharedTopics/archiveCache";
import { writeTopicArchive } from "./helpers/sharedTopicFixtures";

describe("shared archive cache", function () {
  this.timeout(30_000);

  let root: string;
  let cacheDir: string;
  let folder: string;
  const logger = new Logger("test");

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-archivecache-"));
    cacheDir = path.join(root, "cache");
    folder = path.join(root, "share");
    await fs.mkdir(folder, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("unpacks an archive and remaps every id to the shared id", async function () {
    const archive = path.join(folder, "api.rag");
    const nativeId = await writeTopicArchive(archive);
    const cache = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);

    const [resolved] = await cache.sync([archive]);

    expect(resolved.nativeId).to.equal(nativeId);
    expect(resolved.sharedId).to.equal(deriveSharedTopicId("archiveFolder:test", nativeId));
    expect(resolved.topic.id).to.equal(resolved.sharedId);
    expect(resolved.documents[0].topicId).to.equal(resolved.sharedId);

    const metadata = JSON.parse(
      await fs.readFile(path.join(resolved.storeDir, `vector-${resolved.sharedId}-metadata.json`), "utf8"),
    );
    expect(metadata.topicId).to.equal(resolved.sharedId);
    const table = path.join(resolved.storeDir, "lancedb", `${resolved.sharedId}.lance`);
    expect((await fs.stat(table)).isDirectory()).to.equal(true);
  });

  it("does not reopen an unchanged archive on a second sync", async function () {
    const archive = path.join(folder, "api.rag");
    await writeTopicArchive(archive);
    const cache = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);
    const [first] = await cache.sync([archive]);

    // Replace the bytes with garbage of the SAME length and restore the mtime,
    // so the fingerprint is unchanged but any re-read would fail validation.
    // A warm sync must serve the cached metadata and never open the file.
    const stat = await fs.stat(archive);
    await fs.writeFile(archive, Buffer.alloc(stat.size, 0));
    await fs.utimes(archive, stat.atime, stat.mtime);

    const [second] = await cache.sync([archive]);

    expect(second).to.not.equal(undefined);
    expect(second.storeDir).to.equal(first.storeDir);
    expect(second.topic.name).to.equal("API Docs");
    expect(second.documents).to.have.lengthOf(1);
  });

  it("republishes beside the old unpack and prunes the stale one", async function () {
    const archive = path.join(folder, "api.rag");
    await writeTopicArchive(archive, { name: "API Docs" });
    const cache = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);
    const [first] = await cache.sync([archive]);

    await writeTopicArchive(archive, { name: "API Docs v2" });
    const [second] = await cache.sync([archive]);

    expect(second.storeDir).to.not.equal(first.storeDir);
    expect(second.topic.name).to.equal("API Docs v2");
    await fs.access(second.storeDir);
    let stalePresent = true;
    try {
      await fs.access(first.storeDir);
    } catch {
      stalePresent = false;
    }
    expect(stalePresent).to.equal(false);
  });

  it("skips a corrupt archive and an unsupported version while loading the rest", async function () {
    const good = path.join(folder, "good.rag");
    const tampered = path.join(folder, "tampered.rag");
    const oldVersion = path.join(folder, "old.rag");
    await writeTopicArchive(good, { topicId: "topic-1750000000001-good111", name: "Good" });
    await writeTopicArchive(tampered, { topicId: "topic-1750000000002-bad2222", corruptChecksum: true });
    await writeTopicArchive(oldVersion, { topicId: "topic-1750000000003-old3333", formatVersion: "1.0" });
    const cache = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);

    const resolved = await cache.sync([good, tampered, oldVersion]);

    expect(resolved.map((topic) => topic.topic.name)).to.deep.equal(["Good"]);
  });

  it("stays consistent when two caches materialize the same folder at once", async function () {
    // Two VS Code windows, or a window and an MCP server, sharing one storage
    // root. The cache takes no write lease, so this must be safe by
    // construction: identical content, published under identical names.
    const archive = path.join(folder, "api.rag");
    await writeTopicArchive(archive);
    const first = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);
    const second = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);

    const [left, right] = await Promise.all([first.sync([archive]), second.sync([archive])]);

    expect(left[0].sharedId).to.equal(right[0].sharedId);
    expect(left[0].storeDir).to.equal(right[0].storeDir);
    await fs.access(path.join(left[0].storeDir, "topic.json"));
    const entries = JSON.parse(await fs.readFile(path.join(cacheDir, "entries.json"), "utf8"));
    expect(entries.entries).to.have.lengthOf(1);
  });

  it("removes the unpack of an archive that disappeared", async function () {
    const archive = path.join(folder, "api.rag");
    await writeTopicArchive(archive);
    const cache = new SharedArchiveCache(cacheDir, "archiveFolder:test", logger);
    const [resolved] = await cache.sync([archive]);

    const afterRemoval = await cache.sync([]);

    expect(afterRemoval).to.deep.equal([]);
    let present = true;
    try {
      await fs.access(resolved.storeDir);
    } catch {
      present = false;
    }
    expect(present).to.equal(false);
  });
});
