import { expect } from "chai";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import AdmZip from "adm-zip";
import sinon from "sinon";
import { ZipFile } from "yazl";
import { TopicManager, type IConfigProvider, type INotifier } from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { ExportedTopicData, TopicsIndex } from "../src/utils/types";
import {
  TOPIC_ARCHIVE_FORMAT_VERSION,
  validateAndStageTopicArchive,
  validateTopicArchivePath,
} from "../src/utils/topicArchive";

const config: IConfigProvider = {
  get<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  },
};

const notifier: INotifier = {
  showInfo: () => undefined,
  showWarning: () => undefined,
  showError: () => undefined,
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => undefined),
};

function exportedTopic(topicId = "topic-original"): ExportedTopicData {
  return {
    version: TOPIC_ARCHIVE_FORMAT_VERSION,
    topic: {
      id: topicId,
      name: "Archive topic",
      createdAt: 1,
      updatedAt: 2,
      documentCount: 0,
    },
    documents: [],
    embeddingModel: "test-model",
    exportedAt: 3,
  };
}

function manifestFile(entryPath: string, bytes: Buffer): { path: string; size: number; sha256: string } {
  return {
    path: entryPath,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeArchive(
  archivePath: string,
  payloads: Map<string, Buffer>,
  manifestFiles = [...payloads].map(([entryPath, bytes]) => manifestFile(entryPath, bytes)),
): Promise<void> {
  const zip = new AdmZip();
  for (const [entryPath, bytes] of payloads) {
    zip.addFile(entryPath, bytes);
  }
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
        files: manifestFiles,
      }),
    ),
  );
  await new Promise<void>((resolve, reject) =>
    zip.writeZip(archivePath, (error) => (error ? reject(error) : resolve())),
  );
}

async function writeArchiveWithDuplicate(archivePath: string, topicBytes: Buffer): Promise<void> {
  const output = fsSync.createWriteStream(archivePath);
  const zip = new ZipFile();
  const completed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    zip.outputStream.once("error", reject);
  });
  zip.outputStream.pipe(output);
  zip.addBuffer(topicBytes, "topic.json");
  zip.addBuffer(topicBytes, "topic.json");
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
        files: [manifestFile("topic.json", topicBytes)],
      }),
    ),
    "manifest.json",
  );
  zip.end();
  await completed;
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected action to reject");
}

function createManager(storageDir: string): TopicManager {
  const embeddingService = {
    getCurrentModel: () => "test-model",
  } as unknown as EmbeddingService;
  const Manager = TopicManager as unknown as new (options: {
    storageDir: string;
    config: IConfigProvider;
    notifier: INotifier;
    embeddingService: EmbeddingService;
  }) => TopicManager;
  return new Manager({ storageDir, config, notifier, embeddingService });
}

async function listTree(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath).replace(/\\/g, "/");
      result.push(`${entry.isDirectory() ? "d" : "f"}:${relativePath}`);
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(root);
  return result.sort();
}

describe("topic archive safety", function () {
  let temporaryDir: string;
  let archivePath: string;
  let stagingDir: string;

  beforeEach(async function () {
    temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-archive-test-"));
    archivePath = path.join(temporaryDir, "topic.rag");
    stagingDir = path.join(temporaryDir, "staging");
    await fs.mkdir(stagingDir);
  });

  afterEach(async function () {
    sinon.restore();
    await fs.rm(temporaryDir, { recursive: true, force: true });
  });

  it("accepts a valid current v2 archive and stages every declared payload", async function () {
    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));
    const tableBytes = Buffer.from("lance payload");
    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["lancedb/topic-original.lance/data.bin", tableBytes],
      ]),
    );

    const staged = await validateAndStageTopicArchive(archivePath, stagingDir);
    expect(staged.exportData.topic.id).to.equal("topic-original");
    expect(await fs.readFile(path.join(staged.contentDir, "lancedb/topic-original.lance/data.bin"), "utf8")).to.equal(
      "lance payload",
    );
  });

  it("rejects the reproduced topic.json-removed-from-manifest bypass before staging payloads", async function () {
    const topicBytes = Buffer.from(
      JSON.stringify({ ...exportedTopic(), topic: { ...exportedTopic().topic, name: "Tampered" } }),
    );
    const metadataBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        topicId: "topic-original",
        documentCount: 0,
        chunkCount: 0,
        embeddingModel: "test-model",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["vector-topic-original-metadata.json", metadataBytes],
      ]),
      [manifestFile("vector-topic-original-metadata.json", metadataBytes)],
    );

    const error = await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir));
    expect(error.message).to.include("unlisted entry (topic.json)");
    expect(await fs.readdir(stagingDir)).to.deep.equal([]);
  });

  it("rejects missing, duplicate, and case-colliding manifest/archive entries", async function () {
    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));

    await writeArchive(archivePath, new Map([["topic.json", topicBytes]]), [
      manifestFile("topic.json", topicBytes),
      manifestFile("missing.bin", Buffer.from("missing")),
    ]);
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "manifest entry missing",
    );

    await writeArchive(archivePath, new Map([["topic.json", topicBytes]]), [
      manifestFile("topic.json", topicBytes),
      manifestFile("topic.json", topicBytes),
    ]);
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "duplicate or reserved path",
    );

    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["TOPIC.JSON", topicBytes],
      ]),
    );
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "case-fold path collision",
    );

    await writeArchiveWithDuplicate(archivePath, topicBytes);
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "duplicate entry",
    );
  });

  it("rejects cross-platform absolute, traversal, backslash, and ambiguous paths", function () {
    for (const unsafePath of [
      "/topic.json",
      "C:/topic.json",
      "../topic.json",
      "a/../topic.json",
      "a\\topic.json",
      "a//b",
    ]) {
      expect(() => validateTopicArchivePath(unsafePath), unsafePath).to.throw("Invalid archive path");
    }
  });

  it("rejects encrypted archive entries before materializing data", async function () {
    const zip = new AdmZip();
    const entry = zip.addFile("topic.json", Buffer.from("{}"));
    entry.header.flags |= 1;
    zip.writeZip(archivePath);

    const error = await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir));
    expect(error.message).to.include("Archive entry is encrypted: topic.json");
  });

  it("rejects symlinks and excessive compression ratios from central-directory metadata", async function () {
    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));
    const symlinkZip = new AdmZip();
    const topicEntry = symlinkZip.addFile("topic.json", topicBytes);
    topicEntry.attr = ((0xa000 | 0o777) << 16) >>> 0;
    symlinkZip.addFile(
      "manifest.json",
      Buffer.from(
        JSON.stringify({
          formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
          files: [manifestFile("topic.json", topicBytes)],
        }),
      ),
    );
    symlinkZip.writeZip(archivePath);
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "unsafe entry type",
    );

    const highlyCompressible = Buffer.alloc(2 * 1024 * 1024);
    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["lancedb/topic-original.lance/data.bin", highlyCompressible],
      ]),
    );
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "excessive compression ratio",
    );
  });

  it("schema-validates topic and vector metadata", async function () {
    const invalidTopic = Buffer.from(JSON.stringify({ ...exportedTopic(), documents: [{ id: "bad" }] }));
    await writeArchive(archivePath, new Map([["topic.json", invalidTopic]]));
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "invalid document metadata",
    );

    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));
    const invalidMetadata = Buffer.from(JSON.stringify({ topicId: "../wrong" }));
    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["vector-topic-original-metadata.json", invalidMetadata],
      ]),
    );
    expect((await captureError(() => validateAndStageTopicArchive(archivePath, stagingDir))).message).to.include(
      "vector metadata does not match",
    );
  });

  it("rolls back staged live paths when index publication fails", async function () {
    const storageDir = path.join(temporaryDir, "storage");
    const databaseDir = path.join(storageDir, "database");
    await fs.mkdir(databaseDir, { recursive: true });
    const index: TopicsIndex = { topics: {}, modelName: "test-model", lastUpdated: 1 };
    const originalIndexBytes = `${JSON.stringify(index, null, 2)}\n`;
    await fs.writeFile(path.join(databaseDir, "topics.json"), originalIndexBytes);

    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));
    await writeArchive(
      archivePath,
      new Map([
        ["topic.json", topicBytes],
        ["lancedb/topic-original.lance/data.bin", Buffer.from("payload")],
      ]),
    );

    const manager = createManager(storageDir);
    (manager as any).topicsIndex = index;
    (manager as any).topicDocuments = new Map();
    (manager as any).generateTopicId = () => "topic-imported";
    (manager as any).publishPreparedTopicsIndex = async () => {
      throw new Error("injected publication failure");
    };
    const treeBefore = await listTree(databaseDir);

    const error = await captureError(() => manager.importTopic(archivePath));
    expect(error.message).to.equal("injected publication failure");
    expect(await listTree(databaseDir)).to.deep.equal(treeBefore);
    expect(await fs.readFile(path.join(databaseDir, "topics.json"), "utf8")).to.equal(originalIndexBytes);
    expect(manager.getTopic("topic-imported")).to.equal(null);
  });

  it("closes the destination and removes the temporary archive after a Yazl output error", async function () {
    const storageDir = path.join(temporaryDir, "storage");
    const databaseDir = path.join(storageDir, "database");
    await fs.mkdir(databaseDir, { recursive: true });
    const index: TopicsIndex = {
      topics: {
        "topic-local": {
          id: "topic-local",
          name: "Local",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
      },
      modelName: "test-model",
      lastUpdated: 1,
    };
    await fs.writeFile(path.join(databaseDir, "topics.json"), `${JSON.stringify(index, null, 2)}\n`);
    const manager = createManager(storageDir);
    (manager as any).topicsIndex = index;
    (manager as any).topicDocuments = new Map([["topic-local", new Map()]]);

    const injectedError = new Error("injected Yazl output error");
    let destination: fsSync.WriteStream | undefined;
    sinon.stub(ZipFile.prototype, "end").callsFake(function (this: ZipFile) {
      const pipes = (this.outputStream as any)._readableState.pipes;
      destination = (Array.isArray(pipes) ? pipes[0] : pipes) as fsSync.WriteStream;
      this.outputStream.emit("error", injectedError);
    });
    const exportPath = path.join(temporaryDir, "failed.rag");

    const error = await captureError(() => manager.exportTopic("topic-local", exportPath));

    expect(error).to.equal(injectedError);
    expect(destination?.destroyed).to.equal(true);
    expect(
      (await fs.readdir(temporaryDir)).filter((entry) => entry.startsWith(".failed.rag.") && entry.endsWith(".tmp")),
    ).to.deep.equal([]);
    expect((await captureError(() => fs.stat(exportPath))).message).to.include("ENOENT");
  });

  it("publishes valid imports and creates valid concurrent exports", async function () {
    const storageDir = path.join(temporaryDir, "storage");
    const databaseDir = path.join(storageDir, "database");
    await fs.mkdir(databaseDir, { recursive: true });
    const index: TopicsIndex = {
      topics: {
        "topic-local": {
          id: "topic-local",
          name: "Local",
          createdAt: 1,
          updatedAt: 1,
          documentCount: 0,
        },
      },
      modelName: "test-model",
      lastUpdated: 1,
    };
    await fs.writeFile(path.join(databaseDir, "topics.json"), `${JSON.stringify(index, null, 2)}\n`);
    const manager = createManager(storageDir);
    (manager as any).topicsIndex = index;
    (manager as any).topicDocuments = new Map([["topic-local", new Map()]]);

    const topicBytes = Buffer.from(JSON.stringify(exportedTopic()));
    await writeArchive(archivePath, new Map([["topic.json", topicBytes]]));
    (manager as any).generateTopicId = () => "topic-imported";
    const imported = await manager.importTopic(archivePath);
    expect(imported.id).to.equal("topic-imported");
    expect(JSON.parse(await fs.readFile(path.join(databaseDir, "topics.json"), "utf8")).topics).to.have.property(
      "topic-imported",
    );

    const indexBeforeUnsafeExport = await fs.readFile(path.join(databaseDir, "topics.json"), "utf8");
    const unsafeExportError = await captureError(() =>
      manager.exportTopic("topic-local", path.join(databaseDir, "topics.json")),
    );
    expect(unsafeExportError.message).to.include("inside the managed database");
    expect(await fs.readFile(path.join(databaseDir, "topics.json"), "utf8")).to.equal(indexBeforeUnsafeExport);

    const firstExport = path.join(temporaryDir, "first.rag");
    const secondExport = path.join(temporaryDir, "second.rag");
    await Promise.all([
      manager.exportTopic("topic-local", firstExport),
      manager.exportTopic("topic-local", secondExport),
    ]);
    for (const [index, exportedPath] of [firstExport, secondExport].entries()) {
      const validationDir = path.join(temporaryDir, `validation-${index}`);
      await fs.mkdir(validationDir);
      const validated = await validateAndStageTopicArchive(exportedPath, validationDir);
      expect(validated.exportData.topic.id).to.equal("topic-local");
    }
    expect((await fs.readdir(databaseDir)).some((entry) => entry.startsWith(".rag-"))).to.equal(false);
  });
});
