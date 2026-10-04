/**
 * Merges every configured shared-topic source into one read-only view,
 * renaming shared topics whose names collide with a local topic's: agents
 * address topics by name, so a colliding shared topic would be unreachable.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ILogger } from "../interfaces";
import { ENTRIES_FILENAME, STALE_TRANSIENT_MS } from "./archiveCache";
import type { Document as TopicDocument, Topic } from "../utils/types";
import type { ResolvedSharedTopic, SharedTopicSource } from "./types";

interface RegistryEntry {
  topic: Topic;
  documents: TopicDocument[];
  storeDir: string;
  /** The source's own name, kept apart from `topic.name` so reassignment never suffixes a suffix. */
  preferredName: string;
  /** The contributing source's label, which is what a suffix is built from. */
  sourceLabel: string;
}

export class SharedTopicRegistry {
  private sources: SharedTopicSource[] = [];
  private entries = new Map<string, RegistryEntry>();

  constructor(
    private readonly cacheRoot: string,
    private readonly logger: ILogger,
  ) {}

  public setSources(sources: SharedTopicSource[]): void {
    this.sources = [...sources];
  }

  /** Re-resolve every source and rebuild the view; `reservedNames` (local topic names) match case-insensitively. */
  public async refresh(reservedNames: Iterable<string>): Promise<void> {
    const taken = new Set<string>();
    for (const name of reservedNames) {
      taken.add(name.toLowerCase());
    }

    const rebuilt = new Map<string, RegistryEntry>();
    for (const source of this.sources) {
      const cacheDir = path.join(this.cacheRoot, this.cacheDirName(source));
      let resolved: ResolvedSharedTopic[];
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        resolved = await source.resolve({ cacheDir, logger: this.logger });
      } catch (error) {
        this.logger.debug("Shared topic source failed to resolve", { source: source.id, error });
        continue;
      }

      // Deterministic order so name assignment is reproducible run to run.
      for (const entry of [...resolved].sort((left, right) => left.nativeId.localeCompare(right.nativeId))) {
        if (rebuilt.has(entry.sharedId)) {
          // Two archives exported from one source topic share a sharedId, so only
          // one is served. Keeping the first makes the winner deterministic and
          // stops assignName running twice (the survivor would display as
          // "<name> (share)" with no "<name>" anywhere).
          this.logger.debug("Shared topic id already contributed; keeping the first", {
            source: source.id,
            sharedId: entry.sharedId,
            nativeId: entry.nativeId,
          });
          continue;
        }
        const name = this.assignName(entry.topic.name, source.label, taken);
        taken.add(name.toLowerCase());
        rebuilt.set(entry.sharedId, {
          topic: { ...entry.topic, id: entry.sharedId, name, source: "shared" },
          documents: entry.documents,
          storeDir: entry.storeDir,
          preferredName: entry.topic.name,
          sourceLabel: source.label,
        });
      }
    }

    this.entries = rebuilt;
    await this.pruneUnconfiguredSourceCaches();
  }

  /**
   * Re-run name assignment over already-resolved entries with no source I/O:
   * a local create/rename/delete moves the reserved names but must not re-scan
   * the share (a network-mount readdir can stall or fail). Insertion order is
   * the order refresh() assigned in, so the result matches a refresh.
   */
  public reassignNames(reservedNames: Iterable<string>): void {
    const taken = new Set<string>();
    for (const name of reservedNames) {
      taken.add(name.toLowerCase());
    }
    for (const entry of this.entries.values()) {
      const name = this.assignName(entry.preferredName, entry.sourceLabel, taken);
      taken.add(name.toLowerCase());
      entry.topic = { ...entry.topic, name };
    }
  }

  public has(topicId: string): boolean {
    return this.entries.has(topicId);
  }

  public getTopic(topicId: string): Topic | undefined {
    const entry = this.entries.get(topicId);
    return entry ? { ...entry.topic } : undefined;
  }

  public getStoreDir(topicId: string): string | undefined {
    return this.entries.get(topicId)?.storeDir;
  }

  /** A copy, so a caller cannot corrupt the registry. */
  public getDocuments(topicId: string): TopicDocument[] {
    const entry = this.entries.get(topicId);
    return entry ? [...entry.documents] : [];
  }

  public listTopics(): Topic[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.topic }));
  }

  private assignName(preferred: string, label: string, taken: Set<string>): string {
    if (!taken.has(preferred.toLowerCase())) {
      return preferred;
    }
    const withLabel = `${preferred} (${label})`;
    if (!taken.has(withLabel.toLowerCase())) {
      return withLabel;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${preferred} (${label} ${suffix})`;
      if (!taken.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  /** A source id contains a colon, which is not portable in a path segment. */
  private cacheDirName(source: SharedTopicSource): string {
    return source.id.replace(/[^a-zA-Z0-9._-]+/g, "-");
  }

  /**
   * Reclaim the cache of a source nobody configures any more.
   *
   * Age-gated: the cache root is shared by every process on the storage
   * directory while the configured source set is per-window, so "not
   * configured here" does not mean "not in use", and removing unconditionally
   * would delete another window's live unpacks under its open LanceDB handles.
   * A live process rewrites entries.json on every refresh, so a recent mtime
   * means the cache is in use.
   */
  private async pruneUnconfiguredSourceCaches(): Promise<void> {
    const keep = new Set(this.sources.map((source) => this.cacheDirName(source)));
    let names: string[];
    try {
      names = await fs.readdir(this.cacheRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) {
        continue;
      }
      const sourceDir = path.join(this.cacheRoot, name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(path.join(sourceDir, ENTRIES_FILENAME))).mtimeMs;
      } catch {
        // No entries.json: another process's first sync may still be unpacking
        // (minutes on a big share). Fall back to the directory's mtime rather
        // than delete on a failed probe.
        try {
          mtimeMs = (await fs.stat(sourceDir)).mtimeMs;
        } catch {
          continue;
        }
      }
      if (Date.now() - mtimeMs < STALE_TRANSIENT_MS) {
        continue;
      }
      await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
