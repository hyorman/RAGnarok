import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Logger } from "../src/logger";
import { ArchiveFolderSource } from "../src/sharedTopics/archiveFolderSource";
import { writeTopicArchive } from "./helpers/sharedTopicFixtures";

describe("archive folder source", function () {
  this.timeout(30_000);

  let root: string;
  let folder: string;
  let cacheDir: string;
  const logger = new Logger("test");

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-foldersource-"));
    folder = path.join(root, "team-share");
    cacheDir = path.join(root, "cache");
    await fs.mkdir(folder, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("derives a stable id and a label from the folder name", function () {
    const first = new ArchiveFolderSource(folder);
    const second = new ArchiveFolderSource(`${folder}${path.sep}`);

    expect(first.id).to.match(/^archiveFolder:[0-9a-f]{16}$/);
    expect(second.id).to.equal(first.id);
    expect(first.label).to.equal("team-share");
  });

  it("resolves every .rag archive in the folder", async function () {
    await writeTopicArchive(path.join(folder, "a.rag"), { topicId: "topic-1750000000001-aaa1111", name: "Alpha" });
    await writeTopicArchive(path.join(folder, "b.rag"), { topicId: "topic-1750000000002-bbb2222", name: "Beta" });
    const source = new ArchiveFolderSource(folder);

    const resolved = await source.resolve({ cacheDir, logger });

    expect(resolved.map((topic) => topic.topic.name).sort()).to.deep.equal(["Alpha", "Beta"]);
  });

  it("ignores files that are not .rag archives", async function () {
    await writeTopicArchive(path.join(folder, "a.rag"), { name: "Alpha" });
    await fs.writeFile(path.join(folder, "notes.txt"), "hello", "utf8");
    await fs.writeFile(path.join(folder, "storage-format.json"), '{"formatVersion":2}', "utf8");
    const source = new ArchiveFolderSource(folder);

    const resolved = await source.resolve({ cacheDir, logger });

    expect(resolved).to.have.lengthOf(1);
  });

  it("resolves to nothing when the folder does not exist", async function () {
    const source = new ArchiveFolderSource(path.join(root, "absent"));

    expect(await source.resolve({ cacheDir, logger })).to.deep.equal([]);
  });
});
