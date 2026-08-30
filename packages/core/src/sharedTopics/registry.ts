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
import type { Document as TopicDocument, Topic } from "../utils/types";
import type { ResolvedSharedTopic, SharedTopicSource } from "./types";

interface RegistryEntry {
  topic: Topic;
  documents: TopicDocument[];
  storeDir: string;
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
        });
      }
    }

    this.entries = rebuilt;
    await this.pruneUnconfiguredSourceCaches();
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
      await fs.rm(path.join(this.cacheRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
