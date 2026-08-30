import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Logger } from "../src/logger";
import { ArchiveFolderSource } from "../src/sharedTopics/archiveFolderSource";
import { SharedTopicRegistry } from "../src/sharedTopics/registry";
import type { ResolvedSharedTopic, SharedTopicSource } from "../src/sharedTopics/types";
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

function stubSource(id: string, label: string, topics: Array<{ nativeId: string; name: string }>): SharedTopicSource {
  return {
    id,
    label,
    async resolve(): Promise<ResolvedSharedTopic[]> {
      return topics.map((entry) => ({
        nativeId: entry.nativeId,
        sharedId: `shared-${entry.nativeId}`,
        topic: {
          id: `shared-${entry.nativeId}`,
          name: entry.name,
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
        documents: [],
        storeDir: `/cache/${id}/${entry.nativeId}`,
      }));
    },
  };
}

describe("shared topic registry", function () {
  let cacheRoot: string;
  const logger = new Logger("test");

  beforeEach(async function () {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-registry-"));
  });

  afterEach(async function () {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  it("keeps a name that collides with nothing", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "team-share", [{ nativeId: "n1", name: "API Docs" }])]);

    await registry.refresh(["Local Notes"]);

    expect(registry.listTopics().map((topic) => topic.name)).to.deep.equal(["API Docs"]);
  });

  it("appends the source label when a local topic already owns the name", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "team-share", [{ nativeId: "n1", name: "API Docs" }])]);

    await registry.refresh(["api docs"]);

    expect(registry.listTopics()[0].name).to.equal("API Docs (team-share)");
  });

  it("numbers a second collision from a second source", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([
      stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs" }]),
      stubSource("src-b", "share", [{ nativeId: "n2", name: "API Docs" }]),
    ]);

    await registry.refresh(["API Docs"]);

    expect(registry.listTopics().map((topic) => topic.name)).to.deep.equal([
      "API Docs (share)",
      "API Docs (share 2)",
    ]);
  });

  it("answers lookups and tags every topic as common", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs" }])]);
    await registry.refresh([]);

    const [topic] = registry.listTopics();

    expect(registry.has(topic.id)).to.equal(true);
    expect(registry.has("topic-local")).to.equal(false);
    expect(topic.source).to.equal("common");
    expect(registry.getStoreDir(topic.id)).to.equal("/cache/src-a/n1");
    expect(registry.getStoreDir("topic-local")).to.equal(undefined);
  });

  it("drops every topic when the sources are cleared", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs" }])]);
    await registry.refresh([]);

    registry.setSources([]);
    await registry.refresh([]);

    expect(registry.listTopics()).to.deep.equal([]);
  });

  it("contributes nothing when a source throws", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs" }])]);
    await registry.refresh([]);

    registry.setSources([
      {
        id: "src-a",
        label: "share",
        resolve: async () => {
          throw new Error("network share vanished");
        },
      },
    ]);
    await registry.refresh([]);

    expect(registry.listTopics()).to.deep.equal([]);
  });
});
