import * as fs from "fs/promises";
import * as path from "path";

/**
 * A storage root as the unversioned 0.3 build left it: no storage-format
 * marker, and every file under `database/` named as 0.3 named it. v0.3 and v2
 * share these paths, which is why such a root is refused rather than adopted.
 */
export async function writeV03Layout(root: string): Promise<void> {
  const database = path.join(root, "database");
  const table = path.join(database, "lancedb", "topic-1.lance");
  await fs.mkdir(path.join(table, "data"), { recursive: true });
  await fs.mkdir(path.join(table, "_versions"), { recursive: true });
  await fs.writeFile(
    path.join(database, "topics.json"),
    JSON.stringify({
      topics: { "topic-1": { id: "topic-1", name: "Old", createdAt: 1, updatedAt: 2, documentCount: 1 } },
      modelName: "Xenova/all-MiniLM-L6-v2",
      lastUpdated: 2,
    }),
  );
  await fs.writeFile(
    path.join(database, "topic-topic-1-documents.json"),
    JSON.stringify([
      {
        id: "doc-1",
        topicId: "topic-1",
        name: "a.md",
        filePath: "/old/a.md",
        fileType: "markdown",
        addedAt: 1,
        chunkCount: 3,
      },
    ]),
  );
  await fs.writeFile(
    path.join(database, "vector-topic-1-metadata.json"),
    JSON.stringify({
      topicId: "topic-1",
      documentCount: 1,
      chunkCount: 3,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      createdAt: 1,
      updatedAt: 2,
    }),
  );
  await fs.writeFile(path.join(table, "data", "0.lance"), Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]));
  await fs.writeFile(path.join(table, "_versions", "1.manifest"), Buffer.from([9, 8, 7, 6]));
}

/**
 * Every entry under `root` keyed by its "/"-separated relative path: a file
 * maps to its bytes (base64), a directory to null. Two snapshots are equal
 * exactly when nothing was added, removed, renamed or rewritten.
 */
export async function snapshotTree(root: string): Promise<Record<string, string | null>> {
  const entries: Record<string, string | null> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const key = path.relative(root, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        entries[key] = null;
        await visit(entryPath);
      } else {
        entries[key] = (await fs.readFile(entryPath)).toString("base64");
      }
    }
  };
  await visit(root);
  return entries;
}
