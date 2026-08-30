import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { ZipFile } from "yazl";
import { createWriteStream } from "fs";
import { TOPIC_ARCHIVE_FORMAT_VERSION } from "../../src/utils/topicArchive";

export interface FixtureOptions {
  topicId?: string;
  name?: string;
  description?: string;
  /** Overrides the manifest's formatVersion, to build an unsupported archive. */
  formatVersion?: string;
  /** Corrupts the recorded sha256 of topic.json, to build a tampered archive. */
  corruptChecksum?: boolean;
}

/**
 * Write a valid .rag archive to `archivePath`. The LanceDB table is a stub
 * file tree: the cache never opens it, so its bytes only have to survive
 * unchanged through unpacking.
 */
export async function writeTopicArchive(archivePath: string, options: FixtureOptions = {}): Promise<string> {
  const topicId = options.topicId ?? "topic-1750000000000-abc1234";
  const now = 1_750_000_000_000;
  const exportData = {
    version: TOPIC_ARCHIVE_FORMAT_VERSION,
    topic: {
      id: topicId,
      name: options.name ?? "API Docs",
      description: options.description ?? "Shared API documentation",
      createdAt: now,
      updatedAt: now,
      documentCount: 1,
    },
    documents: [
      {
        id: "doc-1",
        topicId,
        name: "guide.md",
        filePath: "/tmp/guide.md",
        fileType: "markdown",
        addedAt: now,
        chunkCount: 3,
      },
    ],
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    exportedAt: now,
  };

  const files: Array<{ archivePath: string; contents: Buffer }> = [
    { archivePath: "topic.json", contents: Buffer.from(JSON.stringify(exportData, null, 2), "utf8") },
    {
      archivePath: `vector-${topicId}-metadata.json`,
      contents: Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 2,
            topicId,
            documentCount: 1,
            chunkCount: 3,
            embeddingModel: "Xenova/all-MiniLM-L6-v2",
            createdAt: now,
            updatedAt: now,
          },
          null,
          2,
        ),
        "utf8",
      ),
    },
    {
      archivePath: `lancedb/${topicId}.lance/data/chunk-0.lance`,
      contents: Buffer.from("stub-lance-bytes", "utf8"),
    },
  ];

  const manifest = {
    formatVersion: options.formatVersion ?? TOPIC_ARCHIVE_FORMAT_VERSION,
    files: files.map((file) => ({
      path: file.archivePath,
      size: file.contents.byteLength,
      sha256:
        options.corruptChecksum && file.archivePath === "topic.json"
          ? "0".repeat(64)
          : createHash("sha256").update(file.contents).digest("hex"),
    })),
  };

  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  const zip = new ZipFile();
  const output = createWriteStream(archivePath);
  const done = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
  });
  zip.outputStream.pipe(output);
  for (const file of files) {
    zip.addBuffer(file.contents, file.archivePath);
  }
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "manifest.json");
  zip.end();
  await done;
  return topicId;
}
