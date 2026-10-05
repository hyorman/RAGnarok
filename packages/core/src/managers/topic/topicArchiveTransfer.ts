import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { ZipFile } from "yazl";
import { createHash, randomUUID } from "crypto";
import type { Mutex } from "async-mutex";
import type { EmbeddingService } from "../../embeddings/embeddingService";
import type { Logger } from "../../logger";
import { EXTENSION } from "../../constants";
import { atomicWriteJson } from "../../utils/storage";
import type { StorageLockHandle } from "../../utils/storageLock";
import type {
  StorageTransactionCoordinator,
  StorageTransactionOperation,
} from "../../utils/storageTransactionCoordinator";
import {
  TOPIC_ARCHIVE_ENTRIES,
  TOPIC_ARCHIVE_FORMAT_VERSION,
  TOPIC_ARCHIVE_LIMITS,
  type TopicArchiveManifestFile,
  validateAndStageTopicArchive,
} from "../../utils/topicArchive";
import { errnoCode, listFilesRecursively, pathExists } from "../../utils/fsPaths";
import type { TopicStorePaths } from "./topicStorePaths";
import type { Topic, TopicsIndex, Document as TopicDocument, ExportedTopicData } from "../../utils/types";

/**
 * Revision stand-in for a topics index file that does not exist yet.
 *
 * The index is published by the first storage write transaction, so a store
 * that has never been mutated has no `topics.json` at all — reader paths no
 * longer write one back on load. Not a valid sha256 digest, so it can never
 * collide with a real hash.
 */
const ABSENT_TOPICS_INDEX_HASH = "absent";

interface ArchiveSourceFile {
  sourcePath: string;
  archivePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ExportSnapshotFile {
  stagedPath: string;
  manifest: TopicArchiveManifestFile;
}

interface StagedTopicImportCommit {
  contentDir: string;
  originalTopicId: string;
  newTopicId: string;
  preparedDocumentsPath: string;
  preparedMetadataPath?: string;
  preparedIndexPath: string;
  expectedIndexSha256: string;
}

/** What the archive export/import code needs from the `TopicManager` that owns it. */
export interface TopicArchiveHost {
  topicsIndex: TopicsIndex | null;
  topicDocuments: Map<string, Map<string, TopicDocument>>;
  logger: Logger;
  embeddingService: EmbeddingService;
  archiveMutex: Mutex;
  paths: TopicStorePaths;
  getTopicDocuments(topicId: string): TopicDocument[];
  generateTopicId(): string;
  assertNotSharedTopic(topicId: string, operation: string): void;
  assertStorageOwnership(): Promise<void>;
  runManagedOperation<T>(operation: () => Promise<T>): Promise<T>;
  runStorageWriteTransaction<T>(
    operation: (tx: { coordinator: StorageTransactionCoordinator; lease: StorageLockHandle }) => Promise<T>,
    options?: { waitMs?: number },
  ): Promise<T>;
  reassignSharedTopicNames(): void;
}

export class TopicArchiveTransfer {
  constructor(private readonly host: TopicArchiveHost) {}

  /**
   * Export a topic to a .rag archive file (ZIP format with DEFLATE compression)
   */
  public async exportTopic(topicId: string, exportPath: string): Promise<void> {
    return this.host.runManagedOperation(() =>
      this.host.archiveMutex.runExclusive(() => this.exportTopicUnlocked(topicId, exportPath)),
    );
  }

  /**
   * Import a topic from a .rag archive file
   */
  public async importTopic(archivePath: string): Promise<Topic> {
    return this.host.runManagedOperation(() =>
      this.host.archiveMutex.runExclusive(() => this.importTopicUnlocked(archivePath)),
    );
  }

  private async exportTopicUnlocked(topicId: string, exportPath: string): Promise<void> {
    this.host.logger.info("Exporting topic", { topicId, exportPath });
    const databaseDir = this.host.paths.databaseDir();
    let stagingDir: string | undefined;
    let temporaryArchivePath: string | undefined;

    try {
      if (!this.host.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }
      this.host.assertNotSharedTopic(topicId, "export");
      if (!this.host.topicsIndex.topics[topicId]) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Export takes no lease: it is a read. Capture the topics index
      // revision now and re-check it once the archive is written, so a
      // mutation that lands mid-export is caught instead of silently
      // shipping a torn archive.
      const indexHashBeforeExport = await this.hashFile(this.host.paths.topicsIndexPath());

      await fs.mkdir(databaseDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(databaseDir, ".rag-export-"));
      const snapshot = await this.createStableExportSnapshot(topicId, stagingDir);
      const manifestContents = JSON.stringify(
        {
          formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
          files: snapshot.files.map((file) => file.manifest),
        },
        null,
        2,
      );
      if (Buffer.byteLength(manifestContents) > TOPIC_ARCHIVE_LIMITS.maxManifestBytes) {
        throw new Error("Topic is too large to export: archive manifest exceeds size limit");
      }

      await fs.mkdir(path.dirname(exportPath), { recursive: true });
      const realDatabaseDir = await fs.realpath(databaseDir);
      const realExportParent = await fs.realpath(path.dirname(exportPath));
      if (this.isSameOrNestedPath(realDatabaseDir, realExportParent)) {
        throw new Error("Export destination cannot be inside the managed database directory");
      }
      temporaryArchivePath = path.join(path.dirname(exportPath), `.${path.basename(exportPath)}.${randomUUID()}.tmp`);
      const output = fsSync.createWriteStream(temporaryArchivePath, { flags: "wx", mode: 0o600 });
      const zip = new ZipFile();
      const archivePromise = new Promise<void>((resolve, reject) => {
        let archiveError: unknown;
        const closeWithError = (error: unknown) => {
          archiveError = error;
          if (!output.destroyed) {
            output.destroy();
          }
        };
        output.once("close", () => (archiveError === undefined ? resolve() : reject(archiveError)));
        output.once("error", closeWithError);
        zip.outputStream.once("error", closeWithError);
      });
      zip.outputStream.pipe(output);

      for (const file of snapshot.files) {
        zip.addFile(file.stagedPath, file.manifest.path);
      }
      zip.addBuffer(Buffer.from(manifestContents, "utf8"), TOPIC_ARCHIVE_ENTRIES.MANIFEST);
      zip.end();

      await archivePromise;

      if ((await this.hashFile(this.host.paths.topicsIndexPath())) !== indexHashBeforeExport) {
        throw new Error("Topic storage changed during export; retry the export");
      }

      await fs.rename(temporaryArchivePath, exportPath);
      temporaryArchivePath = undefined;

      this.host.logger.info("Topic exported successfully", { topicId, exportPath });
    } catch (error) {
      this.host.logger.error("Failed to export topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    } finally {
      if (temporaryArchivePath) {
        await fs.rm(temporaryArchivePath, { force: true }).catch(() => undefined);
      }
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async importTopicUnlocked(archivePath: string): Promise<Topic> {
    this.host.logger.info("Importing topic", { archivePath });
    const databaseDir = this.host.paths.databaseDir();
    let stagingDir: string | undefined;

    try {
      if (!this.host.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }
      await fs.mkdir(databaseDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(databaseDir, ".rag-import-"));
      const stagedArchive = await validateAndStageTopicArchive(archivePath, stagingDir);
      const exportData = stagedArchive.exportData;

      const currentModel = this.host.embeddingService.getCurrentModel();
      if (exportData.embeddingModel !== currentModel) {
        this.host.logger.warn("Imported topic uses different embedding model", {
          importedModel: exportData.embeddingModel,
          currentModel,
          note: "Switch to the imported model before querying this topic",
        });
      }

      let newTopicId = this.host.generateTopicId();
      while (this.host.topicsIndex.topics[newTopicId]) {
        newTopicId = this.host.generateTopicId();
      }
      const now = Date.now();
      const newTopic: Topic = {
        ...exportData.topic,
        id: newTopicId,
        createdAt: now,
        updatedAt: now,
        source: "local",
      };
      const occupiedNames = new Set(
        Object.values(this.host.topicsIndex.topics).map((topic) => topic.name.toLowerCase()),
      );
      const baseName = newTopic.name;
      let suffix = 0;
      while (occupiedNames.has(newTopic.name.toLowerCase())) {
        suffix += 1;
        newTopic.name = `${baseName} (imported${suffix === 1 ? "" : ` ${suffix}`})`;
      }

      const newDocuments = exportData.documents.map((document) => ({
        ...document,
        topicId: newTopicId,
      }));
      const preparedDocumentsPath = path.join(stagingDir, "prepared-documents.json");
      await atomicWriteJson(preparedDocumentsPath, newDocuments);

      const originalMetadataPath = path.join(stagedArchive.contentDir, `vector-${exportData.topic.id}-metadata.json`);
      const preparedMetadataPath = path.join(stagingDir, "prepared-vector-metadata.json");
      if (await pathExists(originalMetadataPath)) {
        const metadata = JSON.parse(await fs.readFile(originalMetadataPath, "utf8"));
        metadata.topicId = newTopicId;
        await atomicWriteJson(preparedMetadataPath, metadata);
      }

      const nextTopicsIndex: TopicsIndex = {
        ...this.host.topicsIndex,
        topics: { ...this.host.topicsIndex.topics, [newTopicId]: newTopic },
        lastUpdated: now,
      };
      const preparedIndexPath = path.join(stagingDir, "prepared-topics.json");
      await atomicWriteJson(preparedIndexPath, nextTopicsIndex);
      // Captured before the lease is taken: this guards the staging window
      // above, not live cross-process races (the lease already excludes
      // those once we hold it).
      const expectedIndexSha256 = await this.hashTopicsIndexOrAbsent();
      const preparedMetadataFinalPath = (await pathExists(preparedMetadataPath)) ? preparedMetadataPath : undefined;

      // Only the commit is a storage mutation: staging above needed no lease.
      await this.host.runStorageWriteTransaction(async (tx) => {
        await this.commitStagedTopicImport(
          {
            contentDir: stagedArchive.contentDir,
            originalTopicId: exportData.topic.id,
            newTopicId,
            preparedDocumentsPath,
            preparedMetadataPath: preparedMetadataFinalPath,
            preparedIndexPath,
            expectedIndexSha256,
          },
          tx.coordinator,
        );

        const documentsMap = new Map<string, TopicDocument>();
        for (const document of newDocuments) {
          documentsMap.set(document.id, document);
        }
        this.host.topicsIndex = nextTopicsIndex;
        this.host.topicDocuments.set(newTopicId, documentsMap);
      });

      // A shared topic whose name the newly imported one now occupies must be
      // renamed, or it becomes unreachable by name.
      this.host.reassignSharedTopicNames();

      this.host.logger.info("Topic imported successfully", {
        originalId: exportData.topic.id,
        newId: newTopicId,
        name: newTopic.name,
        documentCount: newDocuments.length,
      });
      return newTopic;
    } catch (error) {
      this.host.logger.error("Failed to import topic", {
        error: error instanceof Error ? error.message : String(error),
        archivePath,
      });
      throw error;
    } finally {
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Copy a point-in-time candidate into same-filesystem staging. LanceDB does
   * not currently expose a transaction snapshot for its directory, so compare
   * the complete file inventory and identity before/after the streamed copies.
   * A concurrent mutation causes a bounded retry instead of a mixed archive.
   */
  private async createStableExportSnapshot(
    topicId: string,
    stagingRoot: string,
  ): Promise<{ files: ExportSnapshotFile[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptDir = path.join(stagingRoot, `snapshot-${attempt}`);
      await fs.mkdir(attemptDir, { recursive: true });

      const topicBefore = this.host.topicsIndex?.topics[topicId];
      if (!topicBefore) {
        throw new Error(`Topic not found: ${topicId}`);
      }
      const topicSnapshot = { ...topicBefore };
      const documentsSnapshot = this.host.getTopicDocuments(topicId).map((document) => ({
        ...document,
        source: document.source ? { ...document.source } : undefined,
      }));
      const exportData: ExportedTopicData = {
        version: TOPIC_ARCHIVE_FORMAT_VERSION,
        topic: topicSnapshot,
        documents: documentsSnapshot,
        embeddingModel: this.host.topicsIndex!.modelName,
        exportedAt: Date.now(),
      };
      const metadataIdentity = JSON.stringify({
        topic: topicSnapshot,
        documents: documentsSnapshot,
        modelName: this.host.topicsIndex!.modelName,
      });
      let sourcesBefore: ArchiveSourceFile[];
      try {
        sourcesBefore = await this.collectArchiveSourceFiles(topicId);
      } catch (error) {
        if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ESTALE") {
          await fs.rm(attemptDir, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
      const files: ExportSnapshotFile[] = [];

      const topicBytes = Buffer.from(JSON.stringify(exportData, null, 2));
      if (topicBytes.byteLength > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) {
        throw new Error("Topic is too large to export: topic metadata exceeds entry size limit");
      }
      if (sourcesBefore.length + 2 > TOPIC_ARCHIVE_LIMITS.maxEntries) {
        throw new Error("Topic is too large to export: archive entry count exceeds limit");
      }
      const snapshotSize = sourcesBefore.reduce((total, source) => total + source.size, topicBytes.byteLength);
      if (
        sourcesBefore.some((source) => source.size > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) ||
        snapshotSize > TOPIC_ARCHIVE_LIMITS.maxTotalBytes
      ) {
        throw new Error("Topic is too large to export: archive payload exceeds size limit");
      }
      const stagedTopicPath = path.join(attemptDir, TOPIC_ARCHIVE_ENTRIES.TOPIC);
      await fs.writeFile(stagedTopicPath, topicBytes, { flag: "wx", mode: 0o600 });
      files.push({
        stagedPath: stagedTopicPath,
        manifest: {
          path: TOPIC_ARCHIVE_ENTRIES.TOPIC,
          size: topicBytes.byteLength,
          sha256: createHash("sha256").update(topicBytes).digest("hex"),
        },
      });

      let copyFailed = false;
      for (const source of sourcesBefore) {
        const stagedPath = path.join(attemptDir, ...source.archivePath.split("/"));
        try {
          await fs.mkdir(path.dirname(stagedPath), { recursive: true });
          await fs.copyFile(source.sourcePath, stagedPath, fsSync.constants.COPYFILE_EXCL);
          const stagedStat = await fs.stat(stagedPath);
          files.push({
            stagedPath,
            manifest: {
              path: source.archivePath,
              size: stagedStat.size,
              sha256: await this.hashFile(stagedPath),
            },
          });
        } catch (error) {
          if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ESTALE") {
            copyFailed = true;
            break;
          }
          throw error;
        }
      }

      const topicAfter = this.host.topicsIndex?.topics[topicId];
      const metadataAfter = topicAfter
        ? JSON.stringify({
            topic: topicAfter,
            documents: this.host.getTopicDocuments(topicId),
            modelName: this.host.topicsIndex!.modelName,
          })
        : "";
      let sourcesAfter: ArchiveSourceFile[] = [];
      if (!copyFailed) {
        try {
          sourcesAfter = await this.collectArchiveSourceFiles(topicId);
        } catch (error) {
          if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ESTALE") {
            copyFailed = true;
          } else {
            throw error;
          }
        }
      }
      if (
        !copyFailed &&
        metadataIdentity === metadataAfter &&
        this.archiveSourceInventoriesEqual(sourcesBefore, sourcesAfter) &&
        files.every((file) => {
          if (file.manifest.path === TOPIC_ARCHIVE_ENTRIES.TOPIC) {
            return true;
          }
          const source = sourcesAfter.find((candidate) => candidate.archivePath === file.manifest.path);
          return source !== undefined && source.size === file.manifest.size;
        })
      ) {
        files.sort((left, right) => left.manifest.path.localeCompare(right.manifest.path));
        return { files };
      }
      await fs.rm(attemptDir, { recursive: true, force: true });
    }
    throw new Error("Topic changed during export; retry after active writes finish");
  }

  private async collectArchiveSourceFiles(topicId: string): Promise<ArchiveSourceFile[]> {
    const databaseDir = this.host.paths.databaseDir();
    const sources: ArchiveSourceFile[] = [];
    for (const tableName of [topicId]) {
      const tableDir = path.join(databaseDir, EXTENSION.LANCEDB_DIR, `${tableName}.lance`);
      let tableStat: fsSync.Stats;
      try {
        tableStat = await fs.lstat(tableDir);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (tableStat.isSymbolicLink() || !tableStat.isDirectory()) {
        throw new Error(`Refusing to export unsafe LanceDB path: ${tableDir}`);
      }
      for (const filePath of await listFilesRecursively(tableDir)) {
        const stat = await fs.lstat(filePath);
        const relativePath = path.relative(tableDir, filePath).replace(/\\/g, "/");
        sources.push({
          sourcePath: filePath,
          archivePath: `${EXTENSION.LANCEDB_DIR}/${tableName}.lance/${relativePath}`,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      }
    }

    const vectorMetadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);
    try {
      const stat = await fs.lstat(vectorMetadataPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing to export unsafe vector metadata path: ${vectorMetadataPath}`);
      }
      sources.push({
        sourcePath: vectorMetadataPath,
        archivePath: `vector-${topicId}-metadata.json`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }
    }
    return sources.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  }

  private archiveSourceInventoriesEqual(left: ArchiveSourceFile[], right: ArchiveSourceFile[]): boolean {
    return (
      left.length === right.length &&
      left.every((source, index) => {
        const candidate = right[index];
        return (
          source.archivePath === candidate.archivePath &&
          source.size === candidate.size &&
          source.mtimeMs === candidate.mtimeMs &&
          source.ctimeMs === candidate.ctimeMs
        );
      })
    );
  }

  /**
   * Revision hash of the topics index, or {@link ABSENT_TOPICS_INDEX_HASH}
   * when the file has not been written yet.
   *
   * Import captures this before staging and re-checks it under the write
   * lease, so both sides must agree on how "no index yet" is spelled:
   * absent-then-still-absent compares equal and the import proceeds, while
   * absent-then-present compares unequal — a foreign writer published an
   * index during the staging window, which is a genuine concurrent change.
   */
  private async hashTopicsIndexOrAbsent(): Promise<string> {
    try {
      return await this.hashFile(this.host.paths.topicsIndexPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return ABSENT_TOPICS_INDEX_HASH;
      }
      throw error;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const input = fsSync.createReadStream(filePath);
      input.on("data", (chunk) => hash.update(chunk));
      input.once("error", reject);
      input.once("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Publish a validated import under a fresh topic ID. Every payload is moved
   * before the topics index; the index rename is the visibility point. Runtime
   * failures before that point move all payloads back into staging.
   */
  private async commitStagedTopicImport(
    commit: StagedTopicImportCommit,
    coordinator: StorageTransactionCoordinator,
  ): Promise<void> {
    const databaseDir = this.host.paths.databaseDir();
    const operations: StorageTransactionOperation[] = [];
    const tableMappings = [{ oldName: commit.originalTopicId, newName: commit.newTopicId }];
    for (const mapping of tableMappings) {
      const source = path.join(commit.contentDir, EXTENSION.LANCEDB_DIR, `${mapping.oldName}.lance`);
      if (await pathExists(source)) {
        operations.push({
          type: "replace",
          source,
          destination: path.join(databaseDir, EXTENSION.LANCEDB_DIR, `${mapping.newName}.lance`),
        });
      }
    }
    if (commit.preparedMetadataPath) {
      operations.push({
        type: "replace",
        source: commit.preparedMetadataPath,
        destination: path.join(databaseDir, `vector-${commit.newTopicId}-metadata.json`),
      });
    }
    operations.push({
      type: "replace",
      source: commit.preparedDocumentsPath,
      destination: this.host.paths.topicDocumentsPath(commit.newTopicId),
    });
    // Topics index publication is last and is the visibility point.
    operations.push({
      type: "replace",
      source: commit.preparedIndexPath,
      destination: this.host.paths.topicsIndexPath(),
    });

    for (const operation of operations.slice(0, -1)) {
      if (await pathExists(operation.destination)) {
        throw new Error(`Import destination already exists: ${operation.destination}`);
      }
    }
    if ((await this.hashTopicsIndexOrAbsent()) !== commit.expectedIndexSha256) {
      throw new Error("Topics index changed during import; retry after active writes finish");
    }
    // Retained as a deterministic failure-injection seam for archive tests.
    await this.publishPreparedTopicsIndex(commit.preparedIndexPath);
    await this.host.assertStorageOwnership();
    await coordinator.commit("import-topic", operations, {
      originalTopicId: commit.originalTopicId,
      newTopicId: commit.newTopicId,
      expectedIndexSha256: commit.expectedIndexSha256,
    });
  }

  /** Testable pre-publication seam. Durable publication is owned by the coordinator. */
  private async publishPreparedTopicsIndex(_preparedIndexPath: string): Promise<void> {
    // Intentionally empty.
  }

  private isSameOrNestedPath(parentPath: string, candidatePath: string): boolean {
    const normalize = (value: string): string =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const normalizedParent = normalize(parentPath);
    const normalizedCandidate = normalize(candidatePath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  }
}
