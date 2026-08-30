/**
 * Content-addressed unpacks of shared `.rag` archives.
 *
 * The fingerprint is part of each unpack's directory name, so a republished
 * topic is written BESIDE its previous version and never over it: nothing is
 * destructively removed while another process may hold that LanceDB table open.
 * It also means `storeDir` changes on republish, which invalidates
 * TopicManager's vector-store cache key for free.
 *
 * No write lease is taken. The cache is derived, deterministic and lives
 * outside the managed database directory, so two processes materializing it
 * concurrently is safe by construction.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ILogger } from "../interfaces";
import type { Document as TopicDocument, ExportedTopicData } from "../utils/types";
import { atomicWriteJson } from "../utils/storageV2";
import { validateAndStageTopicArchive } from "../utils/topicArchive";
import type { ResolvedSharedTopic } from "./types";

const ENTRIES_FILENAME = "entries.json";
const ENTRIES_VERSION = 1;

interface CacheEntry {
  /** Basename of the archive inside its folder. */
  archive: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
  nativeId: string;
  sharedId: string;
  /** Cached topic metadata, so a warm sync never reopens the archive. */
  topic: ExportedTopicData["topic"];
  documents: TopicDocument[];
}

interface EntriesFile {
  version: number;
  entries: CacheEntry[];
}

/** Collision-free by construction: a local id is always `topic-<ts>-<rand>`. */
export function deriveSharedTopicId(sourceId: string, nativeId: string): string {
  const digest = createHash("sha256").update(`${sourceId}\0${nativeId}`).digest("hex");
  return `shared-${digest.slice(0, 16)}`;
}

function fingerprintOf(archiveName: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${archiveName}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 16);
}

export class SharedArchiveCache {
  constructor(
    private readonly cacheDir: string,
    private readonly sourceId: string,
    private readonly logger: ILogger,
  ) {}

  /**
   * Bring the cache in line with `archivePaths` and return every topic it holds.
   * Archives that fail validation are skipped silently — one bad file must not
   * hide its neighbours.
   */
  public async sync(archivePaths: string[]): Promise<ResolvedSharedTopic[]> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const previous = await this.readEntries();
    const previousByArchive = new Map(previous.map((entry) => [entry.archive, entry]));

    const next: CacheEntry[] = [];
    for (const archivePath of archivePaths.slice().sort()) {
      const archiveName = path.basename(archivePath);
      let size: number;
      let mtimeMs: number;
      try {
        const stat = await fs.stat(archivePath);
        if (!stat.isFile()) {
          continue;
        }
        size = stat.size;
        // fs.utimes() only round-trips whole milliseconds (Date has no
        // sub-millisecond field), so a byte-identical restore after a rewrite
        // can otherwise land on a different mtimeMs than the original write
        // produced. Round to the millisecond the fingerprint is keyed on that.
        mtimeMs = Math.round(stat.mtimeMs);
      } catch (error) {
        this.logger.debug("Shared archive could not be stat'ed; skipping", { archivePath, error });
        continue;
      }

      const fingerprint = fingerprintOf(archiveName, size, mtimeMs);
      const cached = previousByArchive.get(archiveName);
      if (cached && cached.fingerprint === fingerprint && (await this.unpackExists(cached))) {
        next.push(cached);
        continue;
      }

      const entry = await this.unpack(archivePath, archiveName, size, mtimeMs, fingerprint);
      if (entry) {
        next.push(entry);
      }
    }

    await atomicWriteJson(path.join(this.cacheDir, ENTRIES_FILENAME), {
      version: ENTRIES_VERSION,
      entries: next,
    } satisfies EntriesFile);

    await this.prune(next);
    return next.map((entry) => this.toResolved(entry));
  }

  private unpackDirName(entry: Pick<CacheEntry, "sharedId" | "fingerprint">): string {
    return `${entry.sharedId}-${entry.fingerprint}`;
  }

  private unpackDir(entry: Pick<CacheEntry, "sharedId" | "fingerprint">): string {
    return path.join(this.cacheDir, this.unpackDirName(entry));
  }

  private toResolved(entry: CacheEntry): ResolvedSharedTopic {
    return {
      nativeId: entry.nativeId,
      sharedId: entry.sharedId,
      topic: entry.topic,
      documents: entry.documents,
      storeDir: this.unpackDir(entry),
    };
  }

  private async unpackExists(entry: CacheEntry): Promise<boolean> {
    try {
      await fs.access(path.join(this.unpackDir(entry), "topic.json"));
      return true;
    } catch {
      return false;
    }
  }

  private async readEntries(): Promise<CacheEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.cacheDir, ENTRIES_FILENAME), "utf8")) as EntriesFile;
      if (parsed?.version !== ENTRIES_VERSION || !Array.isArray(parsed.entries)) {
        return [];
      }
      return parsed.entries;
    } catch {
      // Absent or unreadable: everything re-unpacks. The cache is derived.
      return [];
    }
  }

  /**
   * Validate, unpack and remap one archive. Returns null when the archive is
   * unusable — skipped silently, per the shared-topics contract.
   */
  private async unpack(
    archivePath: string,
    archiveName: string,
    size: number,
    mtimeMs: number,
    fingerprint: string,
  ): Promise<CacheEntry | null> {
    const staging = path.join(this.cacheDir, `.staging-${randomUUID()}`);
    try {
      await fs.mkdir(staging, { recursive: true });
      const staged = await validateAndStageTopicArchive(archivePath, staging);
      const nativeId = staged.exportData.topic.id;
      const sharedId = deriveSharedTopicId(this.sourceId, nativeId);

      // Remap ids. Renaming the table directory and rewriting JSON is
      // sufficient: rows inside a LanceDB table are never rewritten, exactly as
      // commitStagedTopicImport already does for local imports.
      const content = staged.contentDir;
      const topic = { ...staged.exportData.topic, id: sharedId };
      const documents = staged.exportData.documents.map((document) => ({ ...document, topicId: sharedId }));
      await atomicWriteJson(path.join(content, "topic.json"), {
        ...staged.exportData,
        topic,
        documents,
      });

      const nativeMetadata = path.join(content, `vector-${nativeId}-metadata.json`);
      const sharedMetadata = path.join(content, `vector-${sharedId}-metadata.json`);
      try {
        const metadata = JSON.parse(await fs.readFile(nativeMetadata, "utf8"));
        metadata.topicId = sharedId;
        await atomicWriteJson(sharedMetadata, metadata);
        await fs.rm(nativeMetadata, { force: true });
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      const nativeTable = path.join(content, "lancedb", `${nativeId}.lance`);
      const sharedTable = path.join(content, "lancedb", `${sharedId}.lance`);
      try {
        await fs.rename(nativeTable, sharedTable);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      const destination = this.unpackDir({ sharedId, fingerprint });
      try {
        await fs.rename(content, destination);
      } catch (error: any) {
        // EEXIST/ENOTEMPTY means another process published the identical
        // content first. Its bytes are ours, so adopt them.
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
          throw error;
        }
      }

      return { archive: archiveName, size, mtimeMs, fingerprint, nativeId, sharedId, topic, documents };
    } catch (error) {
      this.logger.debug("Shared archive skipped", { archivePath, error });
      return null;
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Best-effort: a directory another process still has open stays put. */
  private async prune(live: CacheEntry[]): Promise<void> {
    const keep = new Set(live.map((entry) => this.unpackDirName(entry)));
    let names: string[];
    try {
      names = await fs.readdir(this.cacheDir);
    } catch {
      return;
    }
    for (const name of names) {
      // A leading dot is always transient — our own ".staging-<uuid>" unpack
      // directories, or an atomicWriteJson ".<file>....tmp" in flight — and
      // may belong to a concurrent process. Never sweep those.
      if (name === ENTRIES_FILENAME || name.startsWith(".") || keep.has(name)) {
        continue;
      }
      await fs.rm(path.join(this.cacheDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
