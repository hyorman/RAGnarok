import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Logger } from "../src/logger";
import { ArchiveFolderSource, createSharedTopicSources } from "../src/sharedTopics/archiveFolderSource";
import { SharedTopicRegistry } from "../src/sharedTopics/registry";
import type { ResolvedSharedTopic, SharedTopicSource } from "../src/sharedTopics/types";
import type { Document as TopicDocument } from "../src/utils/types";
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

  it("builds no source at all for an unconfigured path", function () {
    // The empty case must be zero sources, never a source pointing at "" —
    // which would resolve to the process working directory. The whitespace
    // case is stricter than the four call sites this replaces: a path of
    // spaces was truthy and would have built a source on nonsense.
    expect(createSharedTopicSources("")).to.deep.equal([]);
    expect(createSharedTopicSources(undefined)).to.deep.equal([]);
    expect(createSharedTopicSources(null)).to.deep.equal([]);
    expect(createSharedTopicSources("   ")).to.deep.equal([]);
  });

  it("builds one archive folder source for a configured path", function () {
    const sources = createSharedTopicSources(folder);

    expect(sources).to.have.lengthOf(1);
    expect(sources[0].id).to.equal(new ArchiveFolderSource(folder).id);
  });
});

function stubSource(
  id: string,
  label: string,
  topics: Array<{ nativeId: string; name: string; documents?: TopicDocument[] }>,
): SharedTopicSource {
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
        documents: entry.documents ?? [],
        storeDir: `/cache/${id}/${entry.nativeId}`,
      }));
    },
  };
}

describe("shared topic registry", function () {
  this.timeout(30_000);

  let cacheRoot: string;
  let shareFolder: string;
  const logger = new Logger("test");

  beforeEach(async function () {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-registry-"));
    shareFolder = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-registry-share-"));
  });

  afterEach(async function () {
    await fs.rm(cacheRoot, { recursive: true, force: true });
    await fs.rm(shareFolder, { recursive: true, force: true });
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

    expect(registry.listTopics().map((topic) => topic.name)).to.deep.equal(["API Docs (share)", "API Docs (share 2)"]);
  });

  it("answers lookups and tags every topic as common", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    const document: TopicDocument = {
      id: "doc-1",
      topicId: "shared-n1",
      name: "readme.md",
      filePath: "readme.md",
      fileType: "markdown",
      addedAt: 1,
      chunkCount: 1,
    };
    registry.setSources([stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs", documents: [document] }])]);
    await registry.refresh([]);

    const [topic] = registry.listTopics();

    expect(registry.has(topic.id)).to.equal(true);
    expect(registry.has("topic-local")).to.equal(false);
    expect(topic.source).to.equal("shared");
    expect(registry.getStoreDir(topic.id)).to.equal("/cache/src-a/n1");
    expect(registry.getStoreDir("topic-local")).to.equal(undefined);
    expect(registry.getTopic(topic.id)?.name).to.equal("API Docs");
    expect(registry.getTopic("topic-local")).to.equal(undefined);
    expect(registry.getDocuments(topic.id)).to.deep.equal([document]);
    expect(registry.getDocuments("topic-local")).to.deep.equal([]);
  });

  it("keeps the first of two archives that derive the same shared id", async function () {
    // api-docs.rag and api-docs-v2.rag exported from one source topic derive
    // one sharedId. Only one can be served; the survivor must be stable, and
    // it must not display as "API Docs (share)" with no "API Docs" anywhere
    // because the loser reserved the plain name on its way past.
    const duplicating: SharedTopicSource = {
      id: "src-a",
      label: "share",
      async resolve(): Promise<ResolvedSharedTopic[]> {
        return ["v1", "v2"].map((native) => ({
          nativeId: native,
          sharedId: "shared-same",
          topic: { id: "shared-same", name: "API Docs", createdAt: 1, updatedAt: 1, documentCount: 0 },
          documents: [],
          storeDir: `/cache/src-a/${native}`,
        }));
      },
    };
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([duplicating]);

    await registry.refresh([]);

    const topics = registry.listTopics();
    expect(topics.map((topic) => topic.name)).to.deep.equal(["API Docs"]);
    expect(registry.getStoreDir(topics[0].id)).to.equal("/cache/src-a/v1");
  });

  it("reassigns names with no source I/O, idempotently and reversibly", async function () {
    let scans = 0;
    const counting: SharedTopicSource = {
      id: "src-a",
      label: "share",
      async resolve(): Promise<ResolvedSharedTopic[]> {
        scans += 1;
        return [
          {
            nativeId: "n1",
            sharedId: "shared-n1",
            topic: { id: "shared-n1", name: "API Docs", createdAt: 1, updatedAt: 1, documentCount: 0 },
            documents: [],
            storeDir: "/cache/src-a/n1",
          },
        ];
      },
    };
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([counting]);
    await registry.refresh([]);
    expect(scans).to.equal(1);

    registry.reassignNames(["API Docs"]);
    expect(registry.listTopics()[0].name).to.equal("API Docs (share)");

    // Idempotent: a second pass must not suffix the suffix.
    registry.reassignNames(["API Docs"]);
    expect(registry.listTopics()[0].name).to.equal("API Docs (share)");

    // Reversible: the local topic went away, so the plain name is free again.
    registry.reassignNames([]);
    expect(registry.listTopics()[0].name).to.equal("API Docs");

    expect(scans, "reassignNames must never touch a source").to.equal(1);
  });

  it("hands out a copy of a topic's documents, not the stored array", async function () {
    const document: TopicDocument = {
      id: "doc-1",
      topicId: "shared-n1",
      name: "readme.md",
      filePath: "readme.md",
      fileType: "markdown",
      addedAt: 1,
      chunkCount: 1,
    };
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([stubSource("src-a", "share", [{ nativeId: "n1", name: "API Docs", documents: [document] }])]);
    await registry.refresh([]);
    const topicId = registry.listTopics()[0].id;

    registry.getDocuments(topicId).length = 0;

    expect(registry.getDocuments(topicId)).to.deep.equal([document]);
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

  it("leaves a concurrent process's cache alone when this process has no sources", async function () {
    // One storage directory, two windows. globalStorageUri is shared by every
    // VS Code window while ragnarok.commonDatabasePath is window-scoped, so a
    // window with no share configured routinely refreshes over a cache root
    // another window is actively serving from. Deleting it there pulls the
    // LanceDB directories out from under that window's open handles.
    await writeTopicArchive(path.join(shareFolder, "api.rag"), { name: "API Docs" });
    const configured = new SharedTopicRegistry(cacheRoot, logger);
    configured.setSources([new ArchiveFolderSource(shareFolder)]);
    await configured.refresh([]);
    const storeDir = configured.getStoreDir(configured.listTopics()[0].id)!;
    await fs.access(path.join(storeDir, "topic.json"));

    const unconfigured = new SharedTopicRegistry(cacheRoot, logger);
    await unconfigured.refresh([]);

    await fs.access(path.join(storeDir, "topic.json"));
  });

  it("prunes an unconfigured source's cache once it is old enough to be abandoned", async function () {
    await writeTopicArchive(path.join(shareFolder, "api.rag"), { name: "API Docs" });
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([new ArchiveFolderSource(shareFolder)]);
    await registry.refresh([]);
    const storeDir = registry.getStoreDir(registry.listTopics()[0].id)!;
    const sourceDir = path.dirname(storeDir);

    // Age the cache past the point where any live process could still be
    // refreshing it, which is the only signal that says "genuinely abandoned".
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(path.join(sourceDir, "entries.json"), old, old);
    await fs.utimes(sourceDir, old, old);

    registry.setSources([]);
    await registry.refresh([]);

    let present = true;
    try {
      await fs.access(sourceDir);
    } catch {
      present = false;
    }
    expect(present).to.equal(false);
  });

  it("isolates a failing source so the other source's topics still load", async function () {
    const registry = new SharedTopicRegistry(cacheRoot, logger);
    registry.setSources([
      {
        id: "src-a",
        label: "share",
        resolve: async () => {
          throw new Error("network share vanished");
        },
      },
      stubSource("src-b", "backup", [{ nativeId: "n1", name: "Runbook" }]),
    ]);

    await registry.refresh([]);

    expect(registry.listTopics().map((topic) => topic.name)).to.deep.equal(["Runbook"]);
  });
});
