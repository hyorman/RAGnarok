import type { VectorStore } from "@langchain/core/vectorstores";
import type { Logger } from "../../logger";
import {
  VectorStoreLoadError,
  VectorStoreMetadataCorruptionError,
  type VectorStoreFactory,
} from "../../stores/vectorStoreFactory";
import type { TopicStorePaths } from "./topicStorePaths";

/** What vector-store loading needs from the `TopicManager` that owns it. */
export interface TopicVectorStoreHost {
  vectorStoreFactory: VectorStoreFactory | null;
  logger: Logger;
  paths: Pick<TopicStorePaths, "databaseDir">;
  getTopicStoreDir(topicId: string): string | undefined;
  ensureEmbeddingModelCompatibility(topicId: string): Promise<void>;
}

export class TopicVectorStores {
  // Cache for loaded vector stores
  private vectorStoreCache: Map<string, VectorStore> = new Map();

  constructor(private readonly host: TopicVectorStoreHost) {}

  /**
   * Invalidate cached vector stores
   * @param topicId - If provided, invalidates only that topic's cache. Otherwise clears all.
   */
  public invalidate(topicId?: string): void {
    if (topicId) {
      for (const key of this.vectorStoreCache.keys()) {
        if (key.endsWith(`::${topicId}`)) {
          this.vectorStoreCache.delete(key);
        }
      }
    } else {
      this.vectorStoreCache.clear();
    }
  }

  /**
   * Get vector store for a topic.
   *
   * Reads never take the storage lease, so a concurrent writer's
   * drop-and-recreate (cross-process table swap) can make the table — or its
   * metadata file — vanish mid-read. A first attempt landing on "absent"
   * (table-absent, or a load failure) is ambiguous between a genuinely empty
   * or corrupt topic and that brief window, so it gets exactly one retry
   * after a short wait before either outcome is committed to.
   *
   * Exactly one retry is authorized per call: the two branches below each
   * call `retryVectorStoreLoad` at most once, and neither call sits inside a
   * `catch` that the other could re-enter — a retry that itself throws
   * `VectorStoreLoadError` propagates immediately rather than triggering a
   * second, unauthorized retry that could resolve `null` over a real failure.
   */
  public async get(topicId: string): Promise<VectorStore | null> {
    this.host.logger.debug("Getting vector store", { topicId });

    let store: VectorStore | null;
    try {
      store = await this.loadVectorStoreOnce(topicId);
    } catch (error) {
      if (error instanceof VectorStoreLoadError) {
        return await this.retryVectorStoreLoad(topicId);
      }
      this.host.logger.error("Failed to get vector store", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
    if (store) {
      return store;
    }

    // table-absent on the first attempt. A genuinely empty topic has no
    // vector metadata file either — createStore always writes it at table
    // creation, and a drop-and-recreate's table-absent window still leaves
    // the pre-existing metadata on disk — so skip the retry's wait entirely
    // when there is no metadata to be racing against.
    if (!(await this.topicHasVectorStoreMetadata(topicId))) {
      return null;
    }
    return await this.retryVectorStoreLoad(topicId);
  }

  /** The retry point shared by both "table-absent" and "load failed". Called at most once per `getVectorStore` call. */
  private async retryVectorStoreLoad(topicId: string): Promise<VectorStore | null> {
    this.invalidate(topicId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      // table-absent here is accepted as empty-topic semantics; a second
      // VectorStoreLoadError is a real failure and must surface, never be
      // swallowed into a fabricated "empty topic" result.
      return await this.loadVectorStoreOnce(topicId);
    } catch (error) {
      this.host.logger.error("Failed to get vector store after retry", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Whether a vector-store metadata file exists for this topic, tolerating
   * corruption as "exists" rather than propagating it: a present-but-torn
   * metadata file is itself evidence of an in-flight write, which the caller
   * should retry rather than fast-path to empty-topic semantics for.
   */
  private async topicHasVectorStoreMetadata(topicId: string): Promise<boolean> {
    if (!this.host.vectorStoreFactory) {
      return false;
    }
    const customStorageDir = this.host.getTopicStoreDir(topicId);
    try {
      return (await this.host.vectorStoreFactory.getStoreMetadata(topicId, customStorageDir)) !== null;
    } catch {
      return true;
    }
  }

  /**
   * One disk-touching attempt to resolve a topic's vector store: compat
   * check, cache lookup, then load. A corrupt-metadata refusal from the
   * compat check is classified the same way `loadStore` classifies its own
   * metadata-read failure — as `VectorStoreLoadError` — so `getVectorStore`'s
   * single retry point covers both read paths uniformly.
   */
  private async loadVectorStoreOnce(topicId: string): Promise<VectorStore | null> {
    if (!this.host.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }

    try {
      await this.host.ensureEmbeddingModelCompatibility(topicId);
    } catch (error) {
      if (error instanceof VectorStoreMetadataCorruptionError) {
        // Distinguish this from a table-open failure: no table was touched,
        // the topic's stored embedding metadata itself couldn't be read.
        throw new VectorStoreLoadError(
          topicId,
          new Error(`embedding compatibility check failed before the vector table was opened: ${error.message}`),
        );
      }
      throw error;
    }

    const location = this.host.getTopicStoreDir(topicId) ?? this.host.paths.databaseDir();
    const cacheKey = `${location}::${topicId}`;
    // Check cache first
    const cachedStore = this.vectorStoreCache.get(cacheKey);
    if (cachedStore) {
      this.host.logger.debug("Returning cached vector store", { topicId });
      return cachedStore;
    }

    // Load from disk. `undefined` already means "the managed database directory".
    const store = await this.host.vectorStoreFactory.loadStore(topicId, this.host.getTopicStoreDir(topicId));

    if (store) {
      this.vectorStoreCache.set(cacheKey, store);
      this.host.logger.debug("Vector store loaded and cached", { topicId });
    }

    return store;
  }
}
