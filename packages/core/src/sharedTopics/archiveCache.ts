/**
 * Content-addressed unpacks of shared `.rag` archives.
 *
 * The fingerprint is part of each unpack's directory name, so a republished
 * topic is written BESIDE its previous version, never over it: nothing is
 * removed while another process may hold that LanceDB table open. `storeDir`
 * changes on republish, which invalidates TopicManager's vector-store cache key.
 *
 * No write lease is taken: the cache is derived, deterministic and outside the
 * managed database directory, so concurrent materialization is safe.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ILogger } from "../interfaces";
import type { Document as TopicDocument, ExportedTopicData } from "../utils/types";
import { atomicWriteJson } from "../utils/storage";
import { validateAndStageTopicArchive } from "../utils/topicArchive";
import type { ResolvedSharedTopic } from "./types";

export const ENTRIES_FILENAME = "entries.json";
const ENTRIES_VERSION = 1;
/**
 * How long a dot-prefixed transient (".staging-<uuid>" unpack directory or an
 * atomicWriteJson ".*.tmp") may sit unpublished before `prune()` treats it as
 * orphaned by a crash rather than in flight. SharedTopicRegistry reuses it for
 * cache roots, which every process on one storage directory shares.
 */
export const STALE_TRANSIENT_MS = 60 * 60 * 1000;

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
  /**
   * What the unpack contains, recorded at publish time: an empty topic ships
   * without a table and vector metadata is conditional, so a fixed probe would
   * reject valid unpacks, while no probe serves a half-deleted one forever (the
   * archive's fingerprint never changes). Optional: older entries re-unpack once.
   */
  hasTable?: boolean;
  hasVectorMetadata?: boolean;
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
        // fs.utimes() only round-trips whole milliseconds, so round here: a
        // byte-identical restore after a rewrite could otherwise land on a
        // different mtimeMs than the original write.
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

  /**
   * Does the unpack still hold everything it was published with? Probing only
   * topic.json is not enough: a recursive rm removes children concurrently and
   * an open .lance file can refuse deletion, leaving a partial unpack that would
   * be served forever, since the fingerprint keys the archive, not the unpack.
   */
  private async unpackExists(
    entry: Pick<CacheEntry, "sharedId" | "fingerprint" | "hasTable" | "hasVectorMetadata">,
  ): Promise<boolean> {
    if (entry.hasTable === undefined || entry.hasVectorMetadata === undefined) {
      // Entry predates content tracking: one forced re-unpack beats guessing.
      return false;
    }
    const dir = this.unpackDir(entry);
    const required = [path.join(dir, "topic.json")];
    if (entry.hasTable) {
      required.push(path.join(dir, "lancedb", `${entry.sharedId}.lance`));
    }
    if (entry.hasVectorMetadata) {
      required.push(path.join(dir, `vector-${entry.sharedId}-metadata.json`));
    }
    try {
      for (const target of required) {
        await fs.access(target);
      }
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

  /** Validate, unpack and remap one archive; null when it is unusable (skipped silently). */
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

      // Remap ids: renaming the table directory and rewriting JSON suffices, since
      // rows inside a LanceDB table are never rewritten (as in commitStagedTopicImport).
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
      let hasVectorMetadata = true;
      try {
        const metadata = JSON.parse(await fs.readFile(nativeMetadata, "utf8"));
        metadata.topicId = sharedId;
        await atomicWriteJson(sharedMetadata, metadata);
        await fs.rm(nativeMetadata, { force: true });
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        // The vector metadata file is conditional in a valid archive.
        hasVectorMetadata = false;
      }

      const nativeTable = path.join(content, "lancedb", `${nativeId}.lance`);
      const sharedTable = path.join(content, "lancedb", `${sharedId}.lance`);
      let hasTable = true;
      try {
        await fs.rename(nativeTable, sharedTable);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        // An empty topic legitimately ships without a table.
        hasTable = false;
      }

      const published = { sharedId, fingerprint, hasTable, hasVectorMetadata };
      const destination = this.unpackDir(published);
      try {
        await fs.rename(content, destination);
      } catch (error) {
        // The destination name is deterministic, so a failure here almost always
        // means another process published identical content first: adopt it.
        // Don't dispatch on the error code (Windows raises EPERM for a rename
        // onto ANY existing directory); probe for the destination instead.
        this.logger.debug("Shared unpack could not be renamed into place; probing the destination", {
          destination,
          error,
        });
        if (!(await this.unpackExists(published))) {
          // Missing (a real failure; the retry rethrows) or incomplete (a
          // half-deleted unpack from an interrupted prune): replacing it is the
          // only repair, since the destination name never changes.
          await fs.rm(destination, { recursive: true, force: true });
          await fs.rename(content, destination);
        }
      }

      return {
        archive: archiveName,
        size,
        mtimeMs,
        fingerprint,
        nativeId,
        sharedId,
        topic,
        documents,
        hasTable,
        hasVectorMetadata,
      };
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
      if (name === ENTRIES_FILENAME || keep.has(name)) {
        continue;
      }
      const fullPath = path.join(this.cacheDir, name);
      if (name.startsWith(".")) {
        // A leading dot marks our own ".staging-<uuid>" or an atomicWriteJson
        // ".*.tmp", which may belong to a live process: reclaim only one old
        // enough that a crash is the only explanation.
        let mtimeMs: number;
        try {
          mtimeMs = (await fs.stat(fullPath)).mtimeMs;
        } catch {
          continue;
        }
        if (Date.now() - mtimeMs < STALE_TRANSIENT_MS) {
          continue;
        }
      }
      await fs.rm(fullPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
