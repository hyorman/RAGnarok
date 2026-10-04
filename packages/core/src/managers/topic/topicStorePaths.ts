import * as path from "path";
import { EXTENSION } from "../../constants";

/** Where the topic index and per-topic document files live under a fixed storage directory. */
export class TopicStorePaths {
  constructor(private readonly storageDir: string) {}

  /** Get the database directory path */
  databaseDir(): string {
    return path.join(this.storageDir, EXTENSION.DATABASE_DIR);
  }

  /** Get the topics index file path */
  topicsIndexPath(): string {
    return path.join(this.databaseDir(), EXTENSION.TOPICS_INDEX_FILENAME);
  }

  /** Get the file path for storing topic documents metadata */
  topicDocumentsPath(topicId: string): string {
    return path.join(this.databaseDir(), `topic-${topicId}-documents.json`);
  }
}
