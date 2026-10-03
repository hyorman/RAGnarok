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
import { atomicWriteJson } from "../utils/storage";
import { validateAndStageTopicArchive } from "../utils/topicArchive";
import type { ResolvedSharedTopic } from "./types";

export const ENTRIES_FILENAME = "entries.json";
const ENTRIES_VERSION = 1;
/**
 * How long a dot-prefixed transient (our own ".staging-<uuid>" unpack
 * directory, or an atomicWriteJson ".*.tmp") may sit unpublished before
 * `prune()` treats it as orphaned by a crash rather than in-flight from a
 * live concurrent process. Far beyond any real unpack duration, so it cannot
 * race a genuinely live writer.
 *
 * SharedTopicRegistry reuses this threshold for the same reason one level up:
 * a cache root is shared by every process using one storage directory, so an
 * unconfigured source here may be a live source there.
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
   * What the unpack actually contains, recorded at publish time. An empty
   * topic legitimately ships without a table and the vector metadata is
   * conditional too, so an unconditional probe would reject a valid unpack --
   * but without a probe at all a half-deleted one is served forever, because
   * the archive's fingerprint never changes. Optional: an entries.json
   * written before this field existed re-unpacks once, then converges.
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

  /**
   * Does the unpack still hold everything it was published with?
   *
   * Probing only topic.json is not enough: `fs.rm({recursive:true})` removes
   * children concurrently and an open .lance file can refuse deletion, so a
   * partially deleted unpack whose topic.json survived would pass and then be
   * served -- forever, since the fingerprint that keys the warm path is the
   * archive's, not the unpack's.
   */
  private async unpackExists(
    entry: Pick<CacheEntry, "sharedId" | "fingerprint" | "hasTable" | "hasVectorMetadata">,
  ): Promise<boolean> {
    if (entry.hasTable === undefined || entry.hasVectorMetadata === undefined) {
      // Recorded by a version that did not track contents. Treat as a failed
      // probe: one forced re-unpack is cheaper than guessing.
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
        // The destination name is deterministic (sharedId + fingerprint), so
        // a rename failure here almost always means another process
        // published the identical content first — its bytes are ours, so
        // adopt them. Don't dispatch on the error code: POSIX raises
        // EEXIST/ENOTEMPTY for a rename onto a non-empty directory, but
        // Windows raises EPERM for a rename onto ANY existing directory
        // regardless of emptiness. Probe for the destination directly.
        this.logger.debug("Shared unpack could not be renamed into place; probing the destination", {
          destination,
          error,
        });
        if (!(await this.unpackExists(published))) {
          // Either the destination is not there at all (a real failure —
          // the retry below rethrows), or it is there but incomplete: a
          // half-deleted unpack from an interrupted prune. Replacing it is
          // the only repair, because the archive's fingerprint — and so this
          // destination name — never changes.
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
        // A leading dot is our own ".staging-<uuid>" unpack directory, or an
        // atomicWriteJson ".*.tmp" — either may belong to a live concurrent
        // process, so only reclaim one old enough that no real unpack or
        // atomic write could still be using it. A crash is the only way one
        // survives past that age.
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
