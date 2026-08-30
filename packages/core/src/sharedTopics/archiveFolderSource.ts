/**
 * A folder of exported `.rag` archives, contributing each as a read-only topic.
 *
 * The folder is only ever read, and only during a refresh: the unpacked cache
 * lives under the host's own storage directory, so the share may be read-only,
 * on a network mount, or shared by several people at once.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { SharedArchiveCache } from "./archiveCache";
import type { ResolvedSharedTopic, SharedTopicSource, SharedTopicSourceContext } from "./types";

const ARCHIVE_EXTENSION = ".rag";

export class ArchiveFolderSource implements SharedTopicSource {
  public readonly id: string;
  public readonly label: string;
  private readonly folderPath: string;

  constructor(folderPath: string) {
    // resolve(), not realpath(): a folder that does not exist yet still gets a
    // stable id, so its cache survives the folder being created later.
    this.folderPath = path.resolve(folderPath);
    this.id = `archiveFolder:${createHash("sha256").update(this.folderPath).digest("hex").slice(0, 16)}`;
    this.label = path.basename(this.folderPath) || this.folderPath;
  }

  public async resolve(context: SharedTopicSourceContext): Promise<ResolvedSharedTopic[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.folderPath);
    } catch (error) {
      context.logger.debug("Shared topic folder is unreadable", { folder: this.folderPath, error });
      return [];
    }

    const archives = names
      .filter((name) => name.toLowerCase().endsWith(ARCHIVE_EXTENSION))
      .map((name) => path.join(this.folderPath, name));

    const cache = new SharedArchiveCache(context.cacheDir, this.id, context.logger);
    return cache.sync(archives);
  }
}
