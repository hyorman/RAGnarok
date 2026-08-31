/**
 * Merges every configured shared-topic source into one read-only view.
 *
 * Names, not ids, are how agents address topics: rag_query and the VS Code
 * ragQuery tool both take a name, and resolveTopicByName returns the first
 * case-insensitive match with local topics listed first. So a shared topic
 * whose name collides with a local one would be unreachable — hence the
 * disambiguation here.
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
  /**
   * The source's own name for this topic, kept apart from `topic.name` so
   * reassignName() is idempotent: reassigning over an already-suffixed name
   * would otherwise suffix the suffix.
   */
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

  /**
   * Re-resolve every source and rebuild the view.
   *
   * `reservedNames` are the names shared topics must not collide with — the
   * local topic names. Comparison is case-insensitive, matching
   * resolveTopicByName.
   */
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
        const name = this.assignName(entry.topic.name, source.label, taken);
        taken.add(name.toLowerCase());
        rebuilt.set(entry.sharedId, {
          topic: { ...entry.topic, id: entry.sharedId, name, source: "common" },
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
   * Re-run name assignment over the entries already resolved, with no source
   * I/O whatsoever.
   *
   * This is what a local create/rename/delete needs: the reserved names moved,
   * so a shared topic may have to step aside or may be free to step back. What
   * such a mutation must NOT do is re-scan the share -- D5 keeps folder scans
   * out of every hot path, and on the network mount this feature targets a
   * readdir can stall for the OS timeout or fail transiently.
   *
   * Map iteration is insertion order, which is exactly the order refresh()
   * assigned in, so this reproduces what a refresh would have produced.
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

  public getDocuments(topicId: string): TopicDocument[] {
    return this.entries.get(topicId)?.documents ?? [];
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
   * Age-gated, exactly as SharedArchiveCache.prune is for its transients, and
   * for the same reason one level up: the cache root lives under the storage
   * directory, which every process sharing that directory also shares, while
   * the configured source set is per-process (in VS Code, per window — the
   * setting is window-scoped). "Not configured here" therefore does not mean
   * "not in use anywhere", and an unconditional removal would delete another
   * window's live unpacks out from under its open LanceDB handles.
   *
   * A live process rewrites entries.json on every refresh, so a recent mtime
   * is the signal that someone is still using this cache. A genuinely
   * abandoned one is still reclaimed, just a refresh cycle later.
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
        // No entries.json: a source directory another process created but
        // whose first sync has not finished yet — on a big share that is
        // minutes of unpacking. Fall back to the directory's own mtime rather
        // than deleting on a failed probe.
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
