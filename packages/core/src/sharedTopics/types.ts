/**
 * Shared topics: read-only topics contributed by a source outside the user's
 * own store. One source kind exists today (a folder of exported `.rag`
 * archives); a git-repository marketplace is planned and will implement the
 * same interface.
 */

import type { ILogger } from "../interfaces";
import type { Document as TopicDocument, Topic } from "../utils/types";

export interface SharedTopicSourceContext {
  /** Directory this source may cache under. Created by the registry before resolve(). */
  readonly cacheDir: string;
  readonly logger: ILogger;
}

export interface ResolvedSharedTopic {
  /** The topic's id inside its archive, before remapping. */
  readonly nativeId: string;
  /** Collision-free id assigned by the source: "shared-<16 hex>". */
  readonly sharedId: string;
  /** Topic metadata carrying sharedId as its id. `name` may still be renamed by the registry. */
  readonly topic: Omit<Topic, "source">;
  readonly documents: TopicDocument[];
  /** Directory holding lancedb/<sharedId>.lance and vector-<sharedId>-metadata.json. */
  readonly storeDir: string;
}

export interface SharedTopicSource {
  /** Stable across runs. Used to namespace the cache and to derive shared ids. */
  readonly id: string;
  /** Human-facing. Used to disambiguate topic names that collide. */
  readonly label: string;
  resolve(context: SharedTopicSourceContext): Promise<ResolvedSharedTopic[]>;
}

/**
 * A mutation was attempted against a topic contributed by a shared source.
 *
 * Routed on `error.name`, never by message substring — the same convention as
 * StorageBusyError. The message names the topic, not the id: whoever hit this
 * addressed the topic by name and would not recognise "shared-3f9a1c0b7e2d4856".
 */
export class SharedTopicReadOnlyError extends Error {
  readonly name = "SharedTopicReadOnlyError";

  constructor(
    public readonly topicId: string,
    public readonly topicName: string,
    public readonly operation: string,
  ) {
    super(`Topic "${topicName}" is a shared topic and cannot be modified (${operation})`);
  }
}
