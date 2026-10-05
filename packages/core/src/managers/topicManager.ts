/**
 * Topic Manager - Manages topic lifecycle and vector stores
 * Handles creation, deletion, updates, and document ingestion
 *
 * Architecture: Factory method (create()) with integrated pipeline
 * Replaces manual topic management from vectorDatabase.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { IConfigProvider, ILLMProvider, INotifier } from "../interfaces";
import { Topic, TopicsIndex, Document as TopicDocument, TopicSource, TopicMatch, DocumentSource } from "../utils/types";
import { DocumentPipeline, PipelineOptions, PipelineResult, type PipelineSourceDocument } from "./documentPipeline";
import {
  EmbeddingFingerprintMismatchError,
  VectorStoreFactory,
  VectorStoreMetadataCorruptionError,
} from "../stores/vectorStoreFactory";
import { EventEmitter } from "events";
import { EmbeddingService } from "../embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../embeddings/embeddingServiceRegistry";
import { Logger } from "../logger";
import { EXTENSION } from "../constants";
import {
  atomicWriteJson,
  ensureStorageFormat,
  inspectStorage,
  resetStorage,
  SHARED_TOPIC_CACHE_DIRNAME,
  STORAGE_RESET_JOURNAL_FILENAME,
} from "../utils/storage";
import { SharedTopicRegistry } from "../sharedTopics/registry";
import { SharedTopicReadOnlyError } from "../sharedTopics/types";
import type { SharedTopicSource } from "../sharedTopics/types";
import { acquireOperationLease, STORAGE_LOCK_FILENAME } from "../utils/storageLock";
import type { StorageLockHandle } from "../utils/storageLock";
import { StorageDirectoryWatcher } from "../utils/storageDirectoryWatcher";
import { isFiniteNumber, isRecord } from "../utils/typeGuards";
import {
  StorageTransactionCoordinator,
  type StorageTransactionOperation,
} from "../utils/storageTransactionCoordinator";
import { randomUUID } from "crypto";
import { Mutex } from "async-mutex";
import { errnoCode, pathExists } from "../utils/fsPaths";
import { TopicArchiveTransfer, type TopicArchiveHost } from "./topic/topicArchiveTransfer";
import { documentIdForSource, generateTopicId, mapFileType } from "./topic/topicIds";
import { TopicJournals, type PostCommitCleanupEntry, type TopicJournalHost } from "./topic/topicJournals";
import { TopicStorePaths } from "./topic/topicStorePaths";
import { TopicVectorStores, type TopicVectorStoreHost } from "./topic/topicVectorStores";

export interface TopicManagerOptions {
  storageDir: string;
  config: IConfigProvider;
  notifier: INotifier;
  embeddingService: EmbeddingService;
  /**
   * Owns one embedding service per embedding space. Created at the composition
   * root and shared: a registry per manager would give each its own resident
   * models and defeat the cap.
   */
  embeddingRegistry: EmbeddingServiceRegistry;
  /**
   * LLM provider for entity extraction during indexing.
   * Optional — without it extraction is skipped.
   */
  llmProvider?: ILLMProvider;
  /** Explicitly back up existing managed data and initialize storage format v2. */
  resetStorage?: boolean;
  /**
   * Sources contributing read-only shared topics. Hosts construct these; core
   * owns everything downstream of resolve().
   */
  sharedTopicSources?: SharedTopicSource[];
}

export interface CreateTopicOptions {
  name: string;
  description?: string;
  initialDocuments?: string[];
}

export interface TopicStats {
  documentCount: number;
  chunkCount: number;
  lastUpdated: number;
  embeddingModel: string;
}

export interface AddDocumentResult {
  topic: Topic;
  document: TopicDocument;
  pipelineResult: PipelineResult;
}

/**
 * Notifications about storage state changed by something other than this
 * manager's own write transactions: a foreign process editing topics.json or
 * a topic-documents file, or the storage tree becoming unreachable (a reset in
 * another process, or the folder being moved).
 */
export type StorageExternalChange = { kind: "topics-changed" } | { kind: "storage-unavailable" };

function isDocumentSource(value: unknown): value is DocumentSource {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "file") {
    return typeof value.path === "string";
  }
  if (value.type === "url") {
    return typeof value.url === "string";
  }
  return (
    value.type === "github" &&
    typeof value.url === "string" &&
    (value.branch === undefined || typeof value.branch === "string")
  );
}

function parseTopicsIndex(data: string): TopicsIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Invalid ${EXTENSION.TOPICS_INDEX_FILENAME}: malformed JSON`);
  }

  if (
    !isRecord(parsed) ||
    !isRecord(parsed.topics) ||
    typeof parsed.modelName !== "string" ||
    parsed.modelName.length === 0 ||
    !isFiniteNumber(parsed.lastUpdated)
  ) {
    throw new Error(`Invalid ${EXTENSION.TOPICS_INDEX_FILENAME}: expected a topics map, modelName, and lastUpdated`);
  }

  for (const [topicId, value] of Object.entries(parsed.topics)) {
    if (
      !isRecord(value) ||
      value.id !== topicId ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      !isFiniteNumber(value.createdAt) ||
      !isFiniteNumber(value.updatedAt) ||
      !Number.isInteger(value.documentCount) ||
      (value.documentCount as number) < 0 ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.source !== undefined && value.source !== "local" && value.source !== "shared")
    ) {
      throw new Error(`Invalid ${EXTENSION.TOPICS_INDEX_FILENAME}: invalid topic entry "${topicId}"`);
    }
  }

  return parsed as unknown as TopicsIndex;
}

function parseTopicDocuments(data: string, topicId: string): TopicDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Invalid document metadata for topic "${topicId}": malformed JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid document metadata for topic "${topicId}": expected an array`);
  }

  const validFileTypes = new Set(["pdf", "markdown", "html", "text", "web", "github"]);
  for (const value of parsed) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.topicId !== topicId ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      typeof value.filePath !== "string" ||
      typeof value.fileType !== "string" ||
      !validFileTypes.has(value.fileType) ||
      !isFiniteNumber(value.addedAt) ||
      !Number.isInteger(value.chunkCount) ||
      (value.chunkCount as number) < 0 ||
      (value.source !== undefined && !isDocumentSource(value.source)) ||
      (value.containerId !== undefined && (typeof value.containerId !== "string" || value.containerId.length === 0)) ||
      (value.canonicalSource !== undefined && typeof value.canonicalSource !== "string") ||
      (value.sourceRevision !== undefined && typeof value.sourceRevision !== "string")
    ) {
      throw new Error(`Invalid document metadata for topic "${topicId}": invalid document entry`);
    }
  }

  return parsed as TopicDocument[];
}

/**
 * Manages all topic operations and vector stores
 */
export class TopicManager implements TopicArchiveHost, TopicJournalHost, TopicVectorStoreHost {
  // Event emitter for agent cache cleanup notifications
  // Allows multiple external components (RAGTool, MCP server) to subscribe without overwriting each other
  private static readonly _onAgentCacheCleanup = new EventEmitter();

  public static readonly onAgentCacheCleanup = {
    subscribe(listener: (topicId: string) => void): { unsubscribe(): void } {
      TopicManager._onAgentCacheCleanup.on("cleanup", listener);
      return {
        unsubscribe() {
          TopicManager._onAgentCacheCleanup.off("cleanup", listener);
        },
      };
    },
  };

  /**
   * Check if a topic name/ID indicates a system-internal topic.
   * System topics (e.g. _memory) are hidden from normal listings.
   */
  static isSystemTopic(nameOrId: string): boolean {
    return nameOrId.startsWith("_");
  }

  private storageDir: string;
  /** @internal */
  readonly paths: TopicStorePaths;
  private config: IConfigProvider;
  private notifier: INotifier;
  /** @internal */
  embeddingService: EmbeddingService;
  private embeddingRegistry: EmbeddingServiceRegistry;
  private llmProvider: ILLMProvider | undefined;

  /** @internal */
  logger: Logger;
  /** @internal */
  topicsIndex: TopicsIndex | null = null;
  private documentPipeline: DocumentPipeline;
  /** @internal */
  vectorStoreFactory: VectorStoreFactory | null = null;
  private isInitialized: boolean = false;

  // Cache for topic documents
  /** @internal */
  topicDocuments: Map<string, Map<string, TopicDocument>> = new Map();

  // Memoized topic-name embeddings used by fuzzy topic resolution, valid only
  // for the embedding model recorded alongside them.
  private topicNameVectorCache: Map<string, number[]> = new Map();
  private topicNameVectorModel: string | null = null;

  /** Read-only topics contributed by configured shared-topic sources. */
  private readonly sharedTopics: SharedTopicRegistry;
  private readonly sharedTopicsMutex = new Mutex();
  /** @internal */
  journalMutex = new Mutex();
  /** @internal */
  archiveMutex = new Mutex();
  private readonly archiveTransfer = new TopicArchiveTransfer(this);
  private readonly journals = new TopicJournals(this);
  private readonly vectorStores = new TopicVectorStores(this);
  private storageMutationMutex = new Mutex();
  private topicMutationMutexes = new Map<string, Mutex>();
  // Set only for the duration of a write transaction. Reads never take a
  // lease, so a null value here means "not currently mutating storage".
  private activeLease: StorageLockHandle | null = null;
  private activeCoordinator: StorageTransactionCoordinator | null = null;
  private acceptingManagedOperations = true;
  private activeManagedOperations = 0;
  private operationDrainWaiters: Array<() => void> = [];
  private managedOperationContext = new AsyncLocalStorage<{ active: boolean }>();
  private disposePromise: Promise<void> | null = null;

  // Cross-process freshness: a directory watch on the database dir (never a
  // file watch -- atomicWriteJson's rename-over-destination orphans an
  // inode-following handle after the first replacement). Instance-scoped,
  // unlike the static onAgentCacheCleanup emitter above, because "another
  // process touched storage" is only meaningful to the manager instance whose
  // caches it might invalidate.
  private readonly externalChangeEmitter = new EventEmitter();
  private externalWatcher: StorageDirectoryWatcher | null = null;
  private watcherStopped = false;

  /**
   * Create and initialize a TopicManager
   */
  public static async create(options: TopicManagerOptions): Promise<TopicManager> {
    const manager = new TopicManager(options);
    await manager.loadTopics();
    return manager;
  }

  private constructor(private options: TopicManagerOptions) {
    this.logger = new Logger("TopicManager");
    this.storageDir = options.storageDir;
    this.paths = new TopicStorePaths(this.storageDir);
    this.sharedTopics = new SharedTopicRegistry(path.join(this.storageDir, SHARED_TOPIC_CACHE_DIRNAME), this.logger);
    this.sharedTopics.setSources(options.sharedTopicSources ?? []);
    this.config = options.config;
    this.notifier = options.notifier;
    this.embeddingService = options.embeddingService;
    this.embeddingRegistry = options.embeddingRegistry;
    this.llmProvider = options.llmProvider;
    this.documentPipeline = new DocumentPipeline(
      this.notifier,
      this.embeddingService,
      this.embeddingRegistry,
      this.config,
    );

    this.logger.info("TopicManager created");
  }

  /**
   * Initialize the manager and load topics index
   */
  private async loadTopics(): Promise<void> {
    if (this.isInitialized) {
      this.logger.info("TopicManager already initialized, skipping");
      return;
    }

    this.logger.info("Initializing TopicManager");

    try {
      // Opening a store is a read. Cross-process exclusion is now per write
      // operation (see runStorageWriteTransaction), so initialization takes a
      // lease only for the two startup steps that genuinely write: stamping
      // the format marker of an empty directory, and an explicit reset.
      if (this.options.resetStorage) {
        const backupPath = await this.withOperationLease(() => resetStorage(this.storageDir));
        this.logger.warn("Storage reset completed", { backupPath: backupPath ?? "empty storage" });
      } else {
        await this.ensureStorageFormatMarker();
      }

      // Ensure storage directory exists
      await this.ensureStorageDirectory();

      // Ensure embedding service is initialized so we know the active model
      await this.embeddingService.initialize();

      // Load topics index (creates a new one if missing)
      await this.loadTopicsIndex();

      // Initialize document pipeline
      const storageDir = this.paths.databaseDir();
      await this.documentPipeline.initialize(storageDir);

      this.vectorStoreFactory = new VectorStoreFactory(
        storageDir,
        this.topicsIndex!.modelName,
        this.embeddingService,
        this.embeddingRegistry,
      );
      // Recovery writes. Probe read-only first so the overwhelmingly common
      // clean start never touches the lock file; only a store with something
      // to repair pays for a transaction (whose prologue is the recovery
      // itself, so the body has nothing left to do).
      if (await this.hasPendingStorageRecovery()) {
        await this.runStorageWriteTransaction(async () => undefined);
      }

      await this.refreshSharedTopics();

      this.isInitialized = true;
      this.startExternalChangeWatcher();
      this.logger.info("TopicManager initialized successfully", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
        sharedTopicCount: this.sharedTopics.listTopics().length,
        embeddingModel: this.topicsIndex?.modelName,
      });
    } catch (error) {
      this.logger.error("Failed to initialize TopicManager", {
        error: error instanceof Error ? error.message : String(error),
      });
      // A rejected factory call gives the caller no manager instance to
      // dispose. Close every resource opened before the failure here so a
      // long-lived extension host can retry without leaked native handles.
      this.acceptingManagedOperations = false;
      const cleanupFailures: unknown[] = [];
      const close = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      };
      await close(() => this.documentPipeline.dispose());
      if (this.vectorStoreFactory) {
        const factory = this.vectorStoreFactory;
        this.vectorStoreFactory = null;
        await close(() => factory.dispose());
      }
      if (cleanupFailures.length > 0) {
        this.logger.warn("TopicManager initialization cleanup encountered failures", {
          failures: cleanupFailures.map((cleanupError) =>
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          ),
        });
      }
      throw error;
    }
  }

  /**
   * Create a new topic
   */
  public async createTopic(options: CreateTopicOptions): Promise<Topic> {
    return this.runManagedOperation(async () => {
      const topic = await this.runStorageWriteTransaction(() => this.createTopicUnlocked(options));
      // After the transaction resolves -- runStorageWriteTransaction releases
      // both storageMutationMutex and the exclusive lease in its own finally.
      // Names only: reconciling them is pure in-memory work, where a full
      // re-resolve would readdir the share on a path D5 keeps scan-free.
      // Success path only: a throw above propagates before this runs.
      this.reassignSharedTopicNames();
      return topic;
    });
  }

  private async createTopicUnlocked(options: CreateTopicOptions): Promise<Topic> {
    this.logger.info("Creating topic", { name: options.name });

    try {
      // Ensure initialized
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Check for duplicate names
      const existingTopic = Object.values(this.topicsIndex.topics).find(
        (t) => t.name.toLowerCase() === options.name.toLowerCase(),
      );

      if (existingTopic) {
        throw new Error(`Topic with name "${options.name}" already exists`);
      }

      // Create topic object
      let topicId = this.generateTopicId();
      while (this.topicsIndex.topics[topicId]) {
        topicId = this.generateTopicId();
      }
      const topic: Topic = {
        id: topicId,
        name: options.name,
        description: options.description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        documentCount: 0,
      };

      // Add to index
      this.topicsIndex.topics[topic.id] = topic;
      this.topicsIndex.lastUpdated = Date.now();

      // Save index
      await this.saveTopicsIndex();

      // Initialize document map for this topic
      this.topicDocuments.set(topic.id, new Map());

      // Add initial documents if provided
      if (options.initialDocuments && options.initialDocuments.length > 0) {
        this.logger.info("Adding initial documents to topic", {
          topicId: topic.id,
          documentCount: options.initialDocuments.length,
        });

        await this.getTopicMutationMutex(topic.id).runExclusive(() =>
          this.addDocumentsUnlocked(topic.id, options.initialDocuments!, undefined),
        );
      }

      this.logger.info("Topic created successfully", {
        topicId: topic.id,
        name: topic.name,
      });

      return topic;
    } catch (error) {
      this.logger.error("Failed to create topic", {
        error: error instanceof Error ? error.message : String(error),
        name: options.name,
      });
      throw error;
    }
  }

  /**
   * Delete a topic and its vector store
   */
  public async deleteTopic(topicId: string): Promise<void> {
    return this.runManagedOperation(async () => {
      await this.runStorageWriteTransaction((tx) =>
        this.getTopicMutationMutex(topicId).runExclusive(() => this.deleteTopicUnlocked(topicId, tx.coordinator)),
      );
      // The deleted name is free again, so a shared topic that was suffixed out
      // of its way can take it back. Placement: see createTopic.
      this.reassignSharedTopicNames();
    });
  }

  private async deleteTopicUnlocked(topicId: string, coordinator: StorageTransactionCoordinator): Promise<void> {
    this.assertNotSharedTopic(topicId, "delete");
    this.logger.info("Deleting topic", { topicId });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      // Check if topic exists
      if (!this.topicsIndex.topics[topicId]) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const topicName = this.topicsIndex.topics[topicId].name;
      await this.assertStorageOwnership();

      // The topics index is the visibility boundary and is published first.
      // After it stops advertising the topic, remaining table directories
      // are unreachable cleanup. A pre-commit crash restores every backup.
      const nextTopicsIndex: TopicsIndex = {
        ...this.topicsIndex,
        topics: { ...this.topicsIndex.topics },
        lastUpdated: Date.now(),
      };
      delete nextTopicsIndex.topics[topicId];
      const preparedIndex = path.join(this.paths.databaseDir(), `.delete-${topicId}-${randomUUID()}.json`);
      await atomicWriteJson(preparedIndex, nextTopicsIndex);
      const lancedbDir = path.join(this.paths.databaseDir(), "lancedb");
      const operations: StorageTransactionOperation[] = [
        { type: "replace", source: preparedIndex, destination: this.paths.topicsIndexPath() },
        { type: "delete", destination: this.paths.topicDocumentsPath(topicId) },
        { type: "delete", destination: path.join(this.paths.databaseDir(), `vector-${topicId}-metadata.json`) },
        { type: "delete", destination: path.join(lancedbDir, `${topicId}.lance`) },
      ];

      // Closing the shared factory invalidates handles for every local/shared
      // topic, so clear the complete cache before reopening it.
      this.invalidateVectorStoreCache();
      this.vectorStoreFactory.dispose();
      try {
        await coordinator.commit("delete-topic", operations, { topicId });
        // Publish only what the commit made durable. Deriving next-state from
        // the reloaded index and applying it after the commit removes the
        // window in which the cache advertised a deletion that never landed.
        this.topicsIndex = nextTopicsIndex;
      } finally {
        await fs.rm(preparedIndex, { force: true }).catch(() => undefined);
        this.vectorStoreFactory = new VectorStoreFactory(
          this.paths.databaseDir(),
          nextTopicsIndex.modelName,
          this.embeddingService,
          this.embeddingRegistry,
        );
      }

      this.topicDocuments.delete(topicId);
      this.topicMutationMutexes.delete(topicId);

      this.notifyAgentCacheCleanup(topicId);

      this.logger.info("Topic deleted successfully", { topicId, topicName });
    } catch (error) {
      this.logger.error("Failed to delete topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Invalidate cached vector stores
   * @param topicId - If provided, invalidates only that topic's cache. Otherwise clears all.
   */
  public invalidateVectorStoreCache(topicId?: string): void {
    this.vectorStores.invalidate(topicId);
  }

  /**
   * Get the embedding service instance
   */
  public getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  /**
   * Notify registered components to clear cached agents for a topic
   */
  private notifyAgentCacheCleanup(topicId: string): void {
    try {
      TopicManager._onAgentCacheCleanup.emit("cleanup", topicId);
    } catch (error) {
      // Don't fail the caller if cache cleanup fails
      this.logger.debug("Agent cache cleanup notification failed", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update topic metadata
   */
  public async updateTopic(topicId: string, updates: Partial<Pick<Topic, "name" | "description">>): Promise<Topic> {
    return this.runManagedOperation(async () => {
      const topic = await this.runStorageWriteTransaction(() => this.updateTopicUnlocked(topicId, updates));
      // A shared topic whose name this rename now occupies must be renamed, or
      // it becomes unreachable by name. Placement: see createTopic.
      this.reassignSharedTopicNames();
      return topic;
    });
  }

  private async updateTopicUnlocked(
    topicId: string,
    updates: Partial<Pick<Topic, "name" | "description">>,
  ): Promise<Topic> {
    this.assertNotSharedTopic(topicId, "rename");
    this.logger.info("Updating topic", { topicId, updates });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Check for name conflicts if renaming
      if (updates.name && updates.name !== topic.name) {
        const existingTopic = Object.values(this.topicsIndex.topics).find(
          (t) => t.id !== topicId && t.name.toLowerCase() === updates.name!.toLowerCase(),
        );

        if (existingTopic) {
          throw new Error(`Topic with name "${updates.name}" already exists`);
        }
      }

      // Apply updates
      if (updates.name) {
        topic.name = updates.name;
      }
      if (updates.description !== undefined) {
        topic.description = updates.description;
      }
      topic.updatedAt = Date.now();

      // Save index
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      this.logger.info("Topic updated successfully", { topicId });

      return topic;
    } catch (error) {
      this.logger.error("Failed to update topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Get a topic by ID (local, or contributed by a shared source)
   */
  public getTopic(topicId: string): Topic | null {
    const local = this.topicsIndex?.topics[topicId];
    if (local) {
      return { ...local, source: "local" as TopicSource };
    }
    return this.sharedTopics.getTopic(topicId) ?? null;
  }

  /**
   * Get all topics (local + shared merged)
   */
  public getAllTopics(): Topic[] {
    const localTopics = this.topicsIndex
      ? Object.values(this.topicsIndex.topics).map((topic) => ({ ...topic, source: "local" as TopicSource }))
      : [];

    return [...localTopics, ...this.sharedTopics.listTopics()].filter(
      (topic) => !TopicManager.isSystemTopic(topic.name),
    );
  }

  /**
   * Find the best matching topic for a user-supplied name.
   * Tries exact match first, then single-topic fallback, then semantic similarity.
   * Throws if no topics exist at all.
   */
  public async resolveTopicByName(requestedTopic: string): Promise<TopicMatch> {
    if (!requestedTopic.trim()) {
      throw new Error("Topic name is required.");
    }
    const allTopics = this.getAllTopics();

    if (allTopics.length === 0) {
      throw new Error("No topics found in the RAG database. Create a topic first.");
    }

    // Try exact match (case-insensitive)
    const exactMatch = allTopics.find((t) => t.name.toLowerCase() === requestedTopic.toLowerCase());
    if (exactMatch) {
      this.logger.debug(`Exact topic match found: ${exactMatch.name}`);
      return { topic: exactMatch, matchType: "exact" };
    }

    const topicNames = allTopics.map((t) => t.name);

    // Single-topic fallback
    if (allTopics.length === 1) {
      this.logger.debug(`Single topic fallback: ${allTopics[0].name}`);
      return { topic: allTopics[0], matchType: "fallback", availableTopics: topicNames };
    }

    // Semantic similarity across all topics
    this.logger.debug(`Computing semantic similarity for topic: ${requestedTopic}`);
    const requestedEmbedding = await this.embeddingService.embed(requestedTopic);
    const topicEmbeddings = await this.embedTopicNames(topicNames);

    const topicSimilarities = allTopics.map((topic, index) => ({
      topic,
      similarity: this.embeddingService.cosineSimilarity(requestedEmbedding, topicEmbeddings[index]),
    }));

    topicSimilarities.sort((a, b) => b.similarity - a.similarity);
    const bestMatch = topicSimilarities[0];

    this.logger.debug(`Best matching topic: ${bestMatch.topic.name} (similarity: ${bestMatch.similarity.toFixed(3)})`);
    return { topic: bestMatch.topic, matchType: "similar", availableTopics: topicNames };
  }

  /**
   * Embed topic names for fuzzy resolution, memoized per name and per embedding
   * model.
   *
   * Topic names are stable, so recomputing every vector on every lookup costs
   * one embedding round trip per topic per query for nothing.
   *
   * Keying the cache on the name is what makes create/rename/delete safe
   * without a dedicated invalidation hook: a lookup only ever reads entries for
   * names present in the freshly read topic list, so a renamed or deleted
   * topic's vector can never be matched. Entries whose name is gone are pruned
   * so the map stays bounded by the topic count. A model switch does need an
   * explicit guard, because the same name embeds to a different vector.
   */
  private async embedTopicNames(names: string[]): Promise<number[][]> {
    const currentModel = this.embeddingService.getCurrentModel();
    if (currentModel !== this.topicNameVectorModel) {
      this.topicNameVectorCache.clear();
      this.topicNameVectorModel = currentModel;
    }
    const liveNames = new Set(names);
    for (const cachedName of this.topicNameVectorCache.keys()) {
      if (!liveNames.has(cachedName)) {
        this.topicNameVectorCache.delete(cachedName);
      }
    }
    return Promise.all(
      names.map(async (name) => {
        const cached = this.topicNameVectorCache.get(name);
        if (cached) {
          return cached;
        }
        const vector = await this.embeddingService.embed(name);
        this.topicNameVectorCache.set(name, vector);
        return vector;
      }),
    );
  }

  /** True when this topic comes from a shared source and is therefore read-only. */
  public isSharedTopic(topicId: string): boolean {
    return this.sharedTopics.has(topicId);
  }

  /**
   * Refuse a mutation aimed at a shared topic. Without this, deleteTopic and
   * addDocuments fail with "Topic not found" — technically true (a shared topic
   * is not in the local index) and actively misleading.
   *
   * @internal
   */
  assertNotSharedTopic(topicId: string, operation: string): void {
    if (!this.sharedTopics.has(topicId)) {
      return;
    }
    throw new SharedTopicReadOnlyError(topicId, this.sharedTopics.getTopic(topicId)?.name ?? topicId, operation);
  }

  /**
   * Get documents for a specific topic (local or shared)
   */
  public getTopicDocuments(topicId: string): TopicDocument[] {
    const localDocuments = this.topicDocuments.get(topicId);
    if (localDocuments) {
      return Array.from(localDocuments.values());
    }
    return this.sharedTopics.getDocuments(topicId);
  }

  public listDocuments(topicId: string): TopicDocument[] {
    if (!this.getTopic(topicId)) {
      throw new Error(`Topic not found: ${topicId}`);
    }
    return this.getTopicDocuments(topicId);
  }

  public async removeDocument(
    topicId: string,
    documentId: string,
  ): Promise<{ document: TopicDocument; chunksRemoved: number }> {
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction((tx) =>
        this.getTopicMutationMutex(topicId).runExclusive(() =>
          this.removeDocumentUnlocked(topicId, documentId, tx.coordinator),
        ),
      ),
    );
  }

  private async removeDocumentUnlocked(
    topicId: string,
    documentId: string,
    coordinator: StorageTransactionCoordinator,
  ): Promise<{ document: TopicDocument; chunksRemoved: number }> {
    this.assertNotSharedTopic(topicId, "remove document");
    if (!this.topicsIndex || !this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }
    const documents = this.topicDocuments.get(topicId);
    const exactDocument = documents?.get(documentId);
    const selectedDocuments = exactDocument
      ? [exactDocument]
      : [...(documents?.values() ?? [])].filter((candidate) => candidate.containerId === documentId);
    if (selectedDocuments.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }
    const cleanupEntry: PostCommitCleanupEntry = {
      version: 1,
      id: `document:${topicId}:${randomUUID()}`,
      kind: "document",
      topicId,
      documents: selectedDocuments.map((document) => ({
        ...document,
        source: document.source ? { ...document.source } : undefined,
      })),
      updatedAt: Date.now(),
    };
    await this.journals.upsertPostCommitCleanup(cleanupEntry);

    // Publish metadata removal before destructive row deletion. A crash after
    // this transaction can leave unreachable rows for cleanup, but can never
    // advertise a document whose vectors were already destroyed.
    const nextDocuments = new Map(documents);
    for (const selectedDocument of selectedDocuments) {
      nextDocuments.delete(selectedDocument.id);
    }
    const nextIndex: TopicsIndex = {
      ...this.topicsIndex,
      topics: { ...this.topicsIndex.topics },
      lastUpdated: Date.now(),
    };
    nextIndex.topics[topicId] = {
      ...nextIndex.topics[topicId],
      documentCount: nextDocuments.size,
      updatedAt: Date.now(),
    };
    const preparedDocuments = path.join(this.paths.databaseDir(), `.remove-documents-${randomUUID()}.json`);
    const preparedIndex = path.join(this.paths.databaseDir(), `.remove-index-${randomUUID()}.json`);
    await atomicWriteJson(preparedDocuments, [...nextDocuments.values()]);
    await atomicWriteJson(preparedIndex, nextIndex);
    try {
      await coordinator.commit(
        "remove-document-metadata",
        [
          { type: "replace", source: preparedDocuments, destination: this.paths.topicDocumentsPath(topicId) },
          { type: "replace", source: preparedIndex, destination: this.paths.topicsIndexPath() },
        ],
        { topicId, documentIds: selectedDocuments.map((document) => document.id) },
      );
    } finally {
      await fs.rm(preparedDocuments, { force: true }).catch(() => undefined);
      await fs.rm(preparedIndex, { force: true }).catch(() => undefined);
    }
    this.topicDocuments.set(topicId, nextDocuments);
    this.topicsIndex = nextIndex;

    let removedChunkIds: string[] = [];
    try {
      removedChunkIds = await this.journals.completePostCommitCleanup(cleanupEntry);
      await this.journals.removePostCommitCleanup(cleanupEntry.id);
    } catch (cleanupError) {
      // Metadata publication is the logical delete commit. Returning success is
      // unambiguous; the retained journal makes physical cleanup durable and
      // retryable instead of turning a committed delete into a false failure.
      this.logger.warn("Document removal committed; storage cleanup is deferred and will retry on startup", {
        topicId,
        documentIds: selectedDocuments.map((document) => document.id),
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    this.invalidateVectorStoreCache(topicId);
    this.notifyAgentCacheCleanup(topicId);
    return { document: exactDocument ?? selectedDocuments[0], chunksRemoved: removedChunkIds.length };
  }

  public async getStorageStatus(): Promise<{
    formatVersion: number;
    storageDir: string;
    databaseDir: string;
    topicCount: number;
    sharedTopicCount: number;
  }> {
    return {
      formatVersion: 2,
      storageDir: this.storageDir,
      databaseDir: this.paths.databaseDir(),
      topicCount: Object.keys(this.topicsIndex?.topics ?? {}).length,
      sharedTopicCount: this.sharedTopics.listTopics().length,
    };
  }

  /**
   * Add documents to a topic
   */
  public async addDocuments(
    topicId: string,
    filePaths: string[],
    options?: PipelineOptions,
  ): Promise<AddDocumentResult[]> {
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction(() =>
        this.getTopicMutationMutex(topicId).runExclusive(() => this.addDocumentsUnlocked(topicId, filePaths, options)),
      ),
    );
  }

  private async addDocumentsUnlocked(
    topicId: string,
    filePaths: string[],
    options?: PipelineOptions,
  ): Promise<AddDocumentResult[]> {
    this.assertNotSharedTopic(topicId, "ingest");
    this.logger.info("Adding documents to topic", {
      topicId,
      documentCount: filePaths.length,
    });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // The write transaction's prologue has already reloaded this.topicsIndex
      // from disk before invoking this operation, so this lookup is live: a
      // foreign process that deleted the topic since our caches were last
      // populated is reflected here, not a stale in-memory reference.
      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const results: AddDocumentResult[] = [];

      for (const filePath of filePaths) {
        options?.signal?.throwIfAborted();
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).substring(1);
        const source: DocumentSource =
          options?.loaderOptions?.fileType === "github"
            ? { type: "github", url: filePath, branch: options.loaderOptions.branch }
            : /^https?:\/\//i.test(filePath)
              ? { type: "url", url: filePath }
              : { type: "file", path: path.resolve(filePath) };
        const stableDocumentId = documentIdForSource(filePath, source.type === "url" ? "web" : source.type);
        const transactionId = `ingest-${randomUUID()}`;
        const plannedDocument: TopicDocument = {
          id: stableDocumentId,
          topicId,
          name: fileName,
          filePath,
          fileType:
            options?.loaderOptions?.fileType === "github"
              ? "github"
              : options?.loaderOptions?.fileType === "web"
                ? "web"
                : mapFileType(fileExt),
          source,
          addedAt: Date.now(),
          chunkCount: 0,
          containerId: stableDocumentId,
          canonicalSource: source.type === "file" ? source.path : source.url,
        };
        const journalId = `${transactionId}:container`;
        await this.journals.upsertIngestion({
          id: journalId,
          transactionId,
          containerId: stableDocumentId,
          topicId,
          stage: "started",
          document: plannedDocument,
          updatedAt: Date.now(),
        });
        try {
          const pipelineOptions: PipelineOptions = {
            ...options,
            ingestionTransactionId: transactionId,
          };
          const pipelineResult = await this.documentPipeline.processDocument(filePath, topicId, pipelineOptions);

          options?.signal?.throwIfAborted();
          if (!pipelineResult.success) {
            this.logger.warn("Document processing failed", {
              filePath,
              errors: pipelineResult.errors,
            });
            continue;
          }
          options?.signal?.throwIfAborted();

          const leafDocuments = this.createLeafTopicDocuments(
            topicId,
            plannedDocument,
            pipelineResult.metadata.sourceDocuments ?? this.summarizePipelineChunks(pipelineResult.chunks),
          );
          if (leafDocuments.length === 0) {
            throw new Error("Ingestion stored vectors but produced no leaf document metadata");
          }
          const leafIds = leafDocuments.map((document) => document.id);
          const durableStage = pipelineResult.metadata.graphExtracted ? "graphCommitted" : "vectorCommitted";
          await this.journals.replaceIngestionTransaction(
            transactionId,
            leafDocuments.map((document) => ({
              id: `${transactionId}:${document.id}`,
              transactionId,
              containerId: stableDocumentId,
              topicId,
              stage: durableStage,
              document,
              containerLeafIds: leafIds,
              warnings: pipelineResult.metadata.warnings,
              updatedAt: Date.now(),
            })),
          );

          if (!this.topicDocuments.has(topicId)) {
            this.topicDocuments.set(topicId, new Map());
          }
          const documents = this.topicDocuments.get(topicId)!;
          const staleDocuments = [...documents.values()].filter(
            (document) =>
              (document.containerId === stableDocumentId || document.id === stableDocumentId) &&
              !leafIds.includes(document.id),
          );
          for (const staleDocument of staleDocuments) {
            await this.removeDocumentStorage(topicId, staleDocument.id, options?.signal);
            documents.delete(staleDocument.id);
          }
          for (const document of leafDocuments) {
            documents.set(document.id, document);
          }
          topic.documentCount = documents.size;
          topic.updatedAt = Date.now();
          this.topicsIndex.lastUpdated = Date.now();
          await this.saveTopicDocuments(topicId);
          await this.saveTopicsIndex();
          await this.journals.markAndRemoveCommittedIngestion(transactionId);

          for (const document of leafDocuments) {
            results.push({ topic, document, pipelineResult });
            this.logger.info("Document leaf added successfully", {
              topicId,
              documentId: document.id,
              containerId: stableDocumentId,
              fileName: document.name,
              chunkCount: document.chunkCount,
            });
          }
        } catch (error) {
          this.logger.error("Failed to add document", {
            error: error instanceof Error ? error.message : String(error),
            filePath,
          });
          // The journal intentionally survives all ordinary failures. Recovery
          // decides from durable transaction-tagged rows whether to complete
          // committed leaves or roll back an uncommitted starter.
          if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw options?.signal?.reason ?? error;
          }
          if (this.isIngestionIntegrityFailure(error)) {
            throw error;
          }
        }
      }

      this.invalidateVectorStoreCache(topicId);
      this.notifyAgentCacheCleanup(topicId);

      this.logger.info("Documents added to topic", {
        topicId,
        successCount: results.length,
        totalCount: filePaths.length,
      });

      return results;
    } catch (error) {
      this.logger.error("Failed to add documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  private isIngestionIntegrityFailure(error: unknown): error is Error {
    return error instanceof VectorStoreMetadataCorruptionError || error instanceof EmbeddingFingerprintMismatchError;
  }

  public async addSources(
    topicId: string,
    sources: DocumentSource[],
    options?: PipelineOptions,
  ): Promise<AddDocumentResult[]> {
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction(() =>
        this.getTopicMutationMutex(topicId).runExclusive(() => this.addSourcesUnlocked(topicId, sources, options)),
      ),
    );
  }

  private async addSourcesUnlocked(
    topicId: string,
    sources: DocumentSource[],
    options?: PipelineOptions,
  ): Promise<AddDocumentResult[]> {
    const outcomes: AddDocumentResult[] = [];
    for (const source of sources) {
      options?.signal?.throwIfAborted();
      const input = source.type === "file" ? source.path : source.url;
      const loaderOptions =
        source.type === "github"
          ? { fileType: "github" as const, branch: source.branch }
          : source.type === "url"
            ? { fileType: "web" as const }
            : options?.loaderOptions;
      outcomes.push(
        ...(await this.addDocumentsUnlocked(topicId, [input], {
          ...options,
          loaderOptions: { ...options?.loaderOptions, ...loaderOptions },
        })),
      );
    }
    return outcomes;
  }

  /** @internal */
  createLeafTopicDocuments(
    topicId: string,
    container: TopicDocument,
    sources: PipelineSourceDocument[],
  ): TopicDocument[] {
    const fileTypes = new Set<TopicDocument["fileType"]>(["pdf", "markdown", "html", "text", "web", "github"]);
    return sources.map((source) => {
      const leafSource: DocumentSource =
        container.source?.type === "github"
          ? container.source
          : source.sourceType === "web"
            ? { type: "url", url: source.canonicalSource }
            : { type: "file", path: source.canonicalSource };
      const candidateType = source.fileType as TopicDocument["fileType"];
      return {
        id: source.documentId,
        topicId,
        name: this.displayNameForSource(source.canonicalSource, source.fileName),
        filePath: source.canonicalSource || source.filePath,
        fileType: fileTypes.has(candidateType) ? candidateType : container.fileType,
        source: leafSource,
        addedAt: Date.now(),
        chunkCount: source.chunkCount,
        containerId: container.id,
        canonicalSource: source.canonicalSource,
        sourceRevision: source.sourceRevision,
      };
    });
  }

  /** @internal */
  summarizePipelineChunks(chunks: LangChainDocument[]): PipelineSourceDocument[] {
    const summaries = new Map<string, PipelineSourceDocument>();
    for (const chunk of chunks) {
      const documentId = String(chunk.metadata.documentId ?? "");
      if (!documentId) {
        continue;
      }
      const existing = summaries.get(documentId);
      if (existing) {
        existing.chunkCount += 1;
        continue;
      }
      summaries.set(documentId, {
        documentId,
        canonicalSource: String(chunk.metadata.source ?? chunk.metadata.filePath ?? ""),
        sourceType: String(chunk.metadata.sourceType ?? "file"),
        sourceRevision: String(chunk.metadata.sourceRevision ?? ""),
        fileName: String(chunk.metadata.fileName ?? ""),
        filePath: String(chunk.metadata.filePath ?? ""),
        fileType: String(chunk.metadata.fileType ?? "text"),
        chunkCount: 1,
      });
    }
    return [...summaries.values()];
  }

  private displayNameForSource(canonicalSource: string, fallback: string): string {
    try {
      const url = new URL(canonicalSource);
      return path.posix.basename(url.pathname) || fallback || url.hostname;
    } catch {
      return path.basename(canonicalSource) || fallback;
    }
  }

  /** @internal */
  async removeDocumentStorage(topicId: string, documentId: string, signal?: AbortSignal): Promise<string[]> {
    if (!this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }
    signal?.throwIfAborted();
    const removedChunkIds = await this.vectorStoreFactory.removeDocument(topicId, documentId);
    signal?.throwIfAborted();
    return removedChunkIds;
  }

  /**
   * Embed and persist already-chunked documents (store-only path).
   * The caller owns loading/chunking.
   */
  public async storeProcessedChunks(topicId: string, chunks: LangChainDocument[], signal?: AbortSignal): Promise<void> {
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction(() => this.storeProcessedChunksUnlocked(topicId, chunks, signal)),
    );
  }

  private async storeProcessedChunksUnlocked(
    topicId: string,
    chunks: LangChainDocument[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.documentPipeline.storeProcessedChunks(chunks, topicId, { signal });
    signal?.throwIfAborted();
  }

  /**
   * Get vector store for a topic. Loading, the one-shot retry and the cache
   * live in `TopicVectorStores`.
   */
  public async getVectorStore(topicId: string): Promise<VectorStore | null> {
    return this.vectorStores.get(topicId);
  }

  /**
   * Fetch all documents from a topic via table scan (no embedding needed).
   */
  public async getAllDocuments(topicId: string, limit: number): Promise<LangChainDocument[]> {
    if (!this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }

    return this.vectorStoreFactory.getAllDocuments(topicId, limit, this.getTopicStoreDir(topicId));
  }

  /**
   * Verify that the stored embedding backend/model is available for querying.
   * Does NOT block queries when the backend is available but differs from the
   * current global setting — loadStore() handles routing via scoped embeddings.
   * Throws only when the required backend is truly unavailable.
   * @internal
   */
  async ensureEmbeddingModelCompatibility(topicId: string): Promise<void> {
    if (!this.vectorStoreFactory) {
      return;
    }

    const metadata = await this.vectorStoreFactory.getStoreMetadata(topicId, this.getTopicStoreDir(topicId));
    if (!metadata?.embeddingModel) {
      return;
    }

    const storedBackend = metadata.embeddingBackend || "";
    const storedModel = metadata.embeddingModel;

    // Legacy stores without embeddingBackend — skip compatibility check,
    // let loadStore() use whatever the current active backend is.
    if (!storedBackend) {
      this.logger.info("Legacy topic without embeddingBackend metadata — skipping compatibility check", {
        topicId,
        storedModel,
      });
      return;
    }

    // Check if the required backend is available
    const backendAvailable = await this.embeddingService.isBackendAvailable(
      storedBackend,
      storedBackend === "huggingface" ? storedModel : undefined,
    );

    if (backendAvailable) {
      // Backend is available — loadStore() will route queries to the correct backend
      const currentModel = this.embeddingService.getCurrentModel();
      if (storedModel !== currentModel) {
        this.logger.info("Topic uses different embedding — will query with stored backend", {
          topicId,
          storedModel,
          storedBackend,
          currentModel,
        });
      }
      return;
    }

    // Backend NOT available — throw descriptive error
    const topicName = this.topicsIndex?.topics[topicId]?.name ?? topicId;

    if (storedBackend !== "huggingface") {
      throw new Error(
        `Topic "${topicName}" was indexed with "${storedBackend}" embeddings (${storedModel}), ` +
          `but that embedding backend is not currently available. ` +
          `Please ensure the backend is enabled and properly configured.`,
      );
    }

    throw new Error(
      `Topic "${topicName}" was indexed with embedding model "${storedModel}", ` +
        `which is not currently available/downloaded. ` +
        `Please switch to "${storedModel}" in settings to download it, or recreate the topic with the current model.`,
    );
  }

  /**
   * Get statistics for a topic
   */
  public async getTopicStats(topicId: string): Promise<TopicStats | null> {
    this.logger.debug("Getting topic stats", { topicId });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        return null;
      }

      const topic = this.getTopic(topicId);
      if (!topic) {
        return null;
      }

      const documentCount = this.getTopicDocuments(topicId).length;
      const databaseDir = this.getTopicStoreDir(topicId) ?? this.paths.databaseDir();
      const metadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);

      let chunkCount = 0;
      let embeddingModel = this.embeddingService.getCurrentModel() || this.topicsIndex.modelName || "unknown";

      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
        chunkCount = metadata.chunkCount || 0;
        if (metadata.embeddingModel) {
          embeddingModel = metadata.embeddingModel;
        }
      } catch {
        // Metadata not available: an empty topic reports zero chunks.
      }

      return {
        documentCount,
        chunkCount,
        lastUpdated: topic.updatedAt,
        embeddingModel,
      };
    } catch (error) {
      this.logger.error("Failed to get topic stats", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      return null;
    }
  }

  /**
   * Refresh topics from disk
   */
  public async refresh(): Promise<void> {
    return this.runManagedOperation(async () => {
      // A refresh is a read: it republishes what is on disk and writes
      // nothing, so it takes no lease. It still serializes against local
      // mutations, because republishing the caches between a mutation's
      // in-memory apply and its flush would silently drop that mutation.
      await this.storageMutationMutex.runExclusive(async () => {
        this.logger.info("Refreshing topics");
        await this.reloadCanonicalState();
      });
      // The local names just changed, so a shared topic may now collide with
      // one. Outside the mutex, for the same reason the mutation wrappers put
      // it outside their transaction. This command reloads local state; the
      // share is re-scanned only by RAG: Refresh Shared Topics.
      this.reassignSharedTopicNames();
    });
  }

  /**
   * Subscribe to storage changes this manager did not itself make: a foreign
   * process editing topics.json/a topic-documents file (`topics-changed`), or
   * the storage tree becoming unreachable (`storage-unavailable`).
   */
  public onExternalChange(listener: (change: StorageExternalChange) => void): { dispose(): void } {
    this.externalChangeEmitter.on("change", listener);
    return {
      dispose: () => {
        this.externalChangeEmitter.off("change", listener);
      },
    };
  }

  private emitExternalChange(change: StorageExternalChange): void {
    try {
      this.externalChangeEmitter.emit("change", change);
    } catch (error) {
      this.logger.warn("onExternalChange listener threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reinitialize with the currently configured embedding model
   * Called when the embedding model configuration changes
   */
  public async reinitializeWithNewModel(): Promise<void> {
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction(() => this.reinitializeWithNewModelUnlocked()),
    );
  }

  private async reinitializeWithNewModelUnlocked(): Promise<void> {
    this.logger.info("Reinitializing TopicManager with new embedding model");

    try {
      const topicIds = this.topicsIndex ? Object.keys(this.topicsIndex.topics) : [];
      const storageDir = this.paths.databaseDir();
      const currentModel = this.embeddingService.getCurrentModel();
      const replacementPipeline = new DocumentPipeline(
        this.notifier,
        this.embeddingService,
        this.embeddingRegistry,
        this.config,
      );
      await replacementPipeline.initialize(storageDir);
      const replacementFactory = new VectorStoreFactory(
        storageDir,
        currentModel,
        this.embeddingService,
        this.embeddingRegistry,
      );
      const previousIndexModel = this.topicsIndex?.modelName;
      try {
        if (this.topicsIndex) {
          this.topicsIndex.modelName = currentModel;
          this.topicsIndex.lastUpdated = Date.now();
          await this.saveTopicsIndex();
        }
      } catch (error) {
        if (this.topicsIndex && previousIndexModel) {
          this.topicsIndex.modelName = previousIndexModel;
        }
        replacementPipeline.dispose();
        replacementFactory.dispose();
        throw error;
      }

      const previousPipeline = this.documentPipeline;
      const previousFactory = this.vectorStoreFactory;
      this.documentPipeline = replacementPipeline;
      this.vectorStoreFactory = replacementFactory;
      this.vectorStores.invalidate();
      previousPipeline.dispose();
      previousFactory?.dispose();
      for (const topicId of topicIds) {
        this.notifyAgentCacheCleanup(topicId);
      }

      this.logger.info("TopicManager reinitialized successfully with new model", {
        embeddingModel: this.topicsIndex?.modelName,
      });
    } catch (error) {
      this.logger.error("Failed to reinitialize TopicManager with new model", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Dispose of all resources and clean up
   * Should be called once the TopicManager is finished with
   */
  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.logger.info("Disposing TopicManager");
    this.acceptingManagedOperations = false;
    this.stopExternalChangeWatcher();
    await this.waitForManagedOperationsToDrain();

    const failures: unknown[] = [];
    const close = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };

    await close(() => this.documentPipeline.dispose());
    if (this.vectorStoreFactory) {
      const factory = this.vectorStoreFactory;
      this.vectorStoreFactory = null;
      await close(() => factory.dispose());
    }

    this.vectorStores.invalidate();
    this.topicDocuments.clear();
    this.topicNameVectorCache.clear();
    this.topicNameVectorModel = null;
    this.topicMutationMutexes.clear();
    this.topicsIndex = null;
    this.isInitialized = false;
    TopicManager._onAgentCacheCleanup.removeAllListeners();
    this.externalChangeEmitter.removeAllListeners();

    this.logger.info("TopicManager disposed");
    if (failures.length > 0) {
      const error = new Error(`TopicManager disposal encountered ${failures.length} cleanup failure(s)`) as Error & {
        failures: unknown[];
      };
      error.failures = failures;
      throw error;
    }
  }

  // ==================== Export/Import Methods ====================

  /**
   * Export a topic to a .rag archive file (ZIP format with DEFLATE compression)
   */
  public exportTopic(...args: Parameters<TopicArchiveTransfer["exportTopic"]>): Promise<void> {
    return this.archiveTransfer.exportTopic(...args);
  }

  /**
   * Import a topic from a .rag archive file
   */
  public importTopic(...args: Parameters<TopicArchiveTransfer["importTopic"]>): Promise<Topic> {
    return this.archiveTransfer.importTopic(...args);
  }

  /**
   * Re-resolve shared topic sources: the only path that reads a share.
   *
   * Per D5 this runs at initialize, on configuration change, and from the
   * RAG: Refresh Shared Topics command -- nowhere else. Local topic changes
   * reconcile names through reassignSharedTopicNames() instead, so no
   * mutation ever waits on a folder scan.
   *
   * Inside runManagedOperation so dispose() cannot drain past an in-flight
   * scan. Never throws: neither an unreadable share nor a shutdown that
   * refuses the operation may stop a store from opening or fail a caller.
   */
  public async refreshSharedTopics(sources?: SharedTopicSource[]): Promise<void> {
    try {
      await this.runManagedOperation(() => this.refreshSharedTopicsUnlocked(sources));
    } catch (error) {
      this.logger.debug("Shared topic refresh skipped", { error });
    }
  }

  private async refreshSharedTopicsUnlocked(sources?: SharedTopicSource[]): Promise<void> {
    await this.sharedTopicsMutex.runExclusive(async () => {
      if (sources) {
        this.sharedTopics.setSources(sources);
      }
      const previous = this.sharedTopics
        .listTopics()
        .map((topic) => ({ id: topic.id, storeDir: this.sharedTopics.getStoreDir(topic.id) }));
      const localNames = Object.values(this.topicsIndex?.topics ?? {}).map((topic) => topic.name);
      try {
        await this.sharedTopics.refresh(localNames);
      } catch (error) {
        this.logger.debug("Shared topic refresh failed", { error });
        return;
      }
      // The scan above is real I/O and takes no lease, so a local mutation may
      // have landed while it ran and the names it just assigned would be built
      // from a stale reserved set. Reconciling again is pure in-memory work.
      this.reassignSharedTopicNames();
      // A topic that is gone, or whose unpack moved, must not keep being served
      // from a directory that has been pruned.
      for (const entry of previous) {
        this.invalidateVectorStoreCache(entry.id);
      }
      // Retirement is best-effort: it is real I/O against handles the resolve
      // step above does not own, and this method is awaited on the success
      // path of createTopic/updateTopic/deleteTopic/refresh(). A rejection
      // here must never surface a successful mutation as a failure.
      try {
        // The manager's cache is not the only thing holding the old directory:
        // VectorStoreFactory keeps a LanceDB connection per lancedb URI and the
        // tables opened through it, neither of which the per-topic invalidation
        // above can reach. A shared unpack is content-addressed, so a republished
        // archive retires its predecessor's directory -- which the cache then
        // prunes from disk, out from under those handles.
        const liveStoreDirs = new Set(
          this.sharedTopics
            .listTopics()
            .map((topic) => this.sharedTopics.getStoreDir(topic.id))
            .filter((storeDir): storeDir is string => storeDir !== undefined),
        );
        const retiredStoreDirs = new Set<string>();
        for (const entry of previous) {
          if (entry.storeDir === undefined || entry.storeDir === this.sharedTopics.getStoreDir(entry.id)) {
            continue;
          }
          // Two topics from one archive share a directory; only retire one no
          // surviving topic is still served from.
          if (!liveStoreDirs.has(entry.storeDir)) {
            retiredStoreDirs.add(entry.storeDir);
          }
        }
        for (const storeDir of retiredStoreDirs) {
          await this.vectorStoreFactory?.closeConnection(storeDir);
        }
      } catch (error) {
        this.logger.debug("Shared topic connection retirement failed", { error });
      }
    });
  }

  // ==================== Private Methods ====================

  /**
   * Reconcile shared topic names against the local names, touching no share.
   *
   * Synchronous and lock-free on purpose. A shared topic whose name a local
   * topic takes becomes unreachable -- resolveTopicByName returns the first
   * case-insensitive match and local topics are listed first -- so every local
   * create/rename/delete has to push it aside, and every delete has to let it
   * step back. What none of them may do is wait on the share: awaiting the
   * shared-topics mutex here would queue a committed mutation behind a stalled
   * network readdir, which is the hazard D5 exists to prevent.
   *
   * @internal
   */
  reassignSharedTopicNames(): void {
    const localNames = Object.values(this.topicsIndex?.topics ?? {}).map((topic) => topic.name);
    this.sharedTopics.reassignNames(localNames);
  }

  /**
   * Where this topic's vector data lives, or undefined for the managed database
   * directory. Shared topics keep their data in their own store directory.
   * @internal
   */
  getTopicStoreDir(topicId: string): string | undefined {
    return this.sharedTopics.getStoreDir(topicId);
  }

  /**
   * Ensure storage directory exists
   */
  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.paths.databaseDir(), { recursive: true });
    } catch (_error) {
      // Directory might already exist
    }
  }

  /**
   * Load topics index from file
   */
  private async loadTopicsIndex(): Promise<void> {
    const indexPath = this.paths.topicsIndexPath();
    let data: string;
    try {
      data = await fs.readFile(indexPath, "utf-8");
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }

      // Only a genuinely missing index may initialize empty storage. Parse,
      // schema, permission, and other I/O errors must leave the source intact
      // and abort initialization.
      //
      // This is a reader path and must not write: persisting the empty index
      // here would be an unleased mutation. The first real mutation's
      // transaction saves it. An index already in memory is kept as-is — on
      // reload it is the pending canonical state, not something to discard.
      if (!this.topicsIndex) {
        this.logger.info("Topics index not found, starting from an empty in-memory index");
        this.topicsIndex = {
          topics: {},
          modelName: this.embeddingService.getCurrentModel(),
          lastUpdated: Date.now(),
        };
        this.topicDocuments = new Map();
      }
      return;
    }

    const parsedIndex = parseTopicsIndex(data);
    // Load every document file into a temporary map before publishing either
    // the index or documents. A single corrupt topic file therefore cannot
    // partially replace a manager's loaded state during refresh.
    await this.loadAllTopicDocuments(parsedIndex);
    this.topicsIndex = parsedIndex;

    this.logger.info("Topics index loaded", {
      topicCount: Object.keys(parsedIndex.topics).length,
    });
  }

  /**
   * Read-only reload of topics.json and every topic-<id>-documents.json into
   * the caches. Reads take no lease, so this is also what a write transaction
   * runs before deriving next-state from cached values.
   */
  private async reloadCanonicalState(): Promise<void> {
    await this.loadTopicsIndex();
  }

  // ==================== External-change watcher ====================
  //
  // External changes: a foreign process editing topics.json or a
  // topic-documents file reloads the caches and emits `topics-changed`; the
  // directory disappearing emits `storage-unavailable` and is retried until it
  // returns. Mechanics live in StorageDirectoryWatcher.

  /**
   * Start the directory watch. Failure to construct it degrades to no watcher;
   * freshness then comes only from refresh().
   */
  private startExternalChangeWatcher(): void {
    if (this.watcherStopped) {
      return;
    }
    this.externalWatcher ??= new StorageDirectoryWatcher({
      directory: this.paths.databaseDir(),
      accepts: (name) => name === EXTENSION.TOPICS_INDEX_FILENAME || /^topic-.*-documents\.json$/.test(name),
      debounceMs: 250,
      onChange: () => this.handleDebouncedChange(),
      onError: (error, phase) =>
        this.logger.warn(
          phase === "start"
            ? "Unable to watch the storage directory for external changes; freshness relies on refresh() until a watch is established"
            : "The storage directory watch failed; external-change tracking will retry until the directory is back",
          { error: error instanceof Error ? error.message : String(error) },
        ),
      outage: {
        pollMs: 2_000,
        retryMs: 2_000,
        exists: () => this.databaseDirExists(),
        onUnavailable: () => void this.announceUnavailability(),
        onRecovered: () => this.recoverFromOutage(),
      },
    });
    // A construction failure is reported (once) through onError above.
    this.externalWatcher.start();
  }

  private stopExternalChangeWatcher(): void {
    this.watcherStopped = true;
    this.externalWatcher?.stop();
  }

  private async databaseDirExists(): Promise<boolean> {
    try {
      return await pathExists(this.paths.databaseDir());
    } catch {
      return false;
    }
  }

  /**
   * Every await below is a point where dispose() may have run to completion
   * (cleared caches, removed listeners) while this call was suspended. Each
   * one is followed by a fresh `watcherStopped` check that bails silently --
   * a disposed manager must never have its caches repopulated by, or emit an
   * event from, a reload that was already in flight when dispose() ran.
   */
  private async handleDebouncedChange(): Promise<void> {
    if (this.watcherStopped || this.activeLease !== null) {
      return;
    }
    const dirExists = await this.databaseDirExists();
    if (this.watcherStopped) {
      return;
    }
    if (!dirExists) {
      this.externalWatcher?.reportOutage();
      return;
    }
    try {
      await this.reloadAfterExternalChange();
    } catch (error) {
      if (this.watcherStopped) {
        return;
      }
      if (errnoCode(error) === "ENOENT") {
        this.externalWatcher?.reportOutage();
        return;
      }
      this.logger.warn("Failed to reload storage state after an external change notification", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Reload the caches, then announce the change. Bails silently once the watcher is stopped; callers own error handling. */
  private async reloadAfterExternalChange(): Promise<void> {
    await this.storageMutationMutex.runExclusive(async () => {
      // Checked again inside the mutex: dispose() may have run while this
      // call was queued waiting for a concurrent transaction/refresh.
      if (this.watcherStopped) {
        return;
      }
      await this.reloadCanonicalState();
    });
    if (this.watcherStopped) {
      return;
    }
    // The local names just changed underneath us, so a shared topic may now
    // collide with one -- the very hole this feature closes for local
    // mutations, reopened from outside. Names only: a watcher callback is a
    // hot path, and D5 keeps folder scans out of those.
    this.reassignSharedTopicNames();
    this.emitExternalChange({ kind: "topics-changed" });
  }

  /** The directory is back and the watch re-established; a throw re-enters the outage and retries. */
  private async recoverFromOutage(): Promise<void> {
    if (this.watcherStopped) {
      return;
    }
    try {
      await this.reloadAfterExternalChange();
    } catch (error) {
      if (this.watcherStopped) {
        return;
      }
      this.logger.warn("Storage directory returned but reload failed; retrying", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Diagnostic only: which marker file is present does not change the retry
   * behaviour (either way storage is unavailable and gets retried), it only
   * names the likely cause in the log line. A reset journal means a reset is
   * running in another window; a lock file alone means another process holds
   * an ordinary write lease; neither means storage is genuinely gone.
   */
  private async announceUnavailability(): Promise<void> {
    let reason = "the storage directory is unreachable";
    try {
      if (await pathExists(path.join(this.storageDir, STORAGE_RESET_JOURNAL_FILENAME))) {
        reason = "a reset appears to be in progress in another window";
      } else if (await pathExists(path.join(this.storageDir, STORAGE_LOCK_FILENAME))) {
        reason = "another process holds the storage write lease";
      }
    } catch {
      // Best-effort diagnostic only; never let this block the notification.
    }
    this.logger.warn("Storage became unavailable; external-change tracking will retry until it returns", { reason });
    this.emitExternalChange({ kind: "storage-unavailable" });
  }

  /**
   * Save topics index to file
   */
  /** @internal */
  async saveTopicsIndex(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    try {
      await this.assertStorageOwnership();
      const indexPath = this.paths.topicsIndexPath();
      await atomicWriteJson(indexPath, this.topicsIndex);

      this.logger.debug("Topics index saved");
    } catch (error) {
      this.logger.error("Failed to save topics index", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate a unique topic ID
   *
   * @internal
   */
  generateTopicId(): string {
    return generateTopicId();
  }

  /**
   * Save document metadata for a topic to disk
   */
  /** @internal */
  async saveTopicDocuments(topicId: string): Promise<void> {
    try {
      await this.assertStorageOwnership();
      const documents = this.topicDocuments.get(topicId);
      if (!documents) {
        return;
      }

      const documentsPath = this.paths.topicDocumentsPath(topicId);
      const documentsArray = Array.from(documents.values());

      await atomicWriteJson(documentsPath, documentsArray);

      this.logger.debug("Topic documents saved", {
        topicId,
        documentCount: documentsArray.length,
      });
    } catch (error) {
      this.logger.error("Failed to save topic documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Load document metadata for a topic from disk
   */
  private async loadTopicDocuments(topicId: string): Promise<Map<string, TopicDocument>> {
    const documentsPath = this.paths.topicDocumentsPath(topicId);
    let data: string;
    try {
      data = await fs.readFile(documentsPath, "utf-8");
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }

      // Missing metadata is valid for topics created by older releases.
      this.logger.debug("No document metadata found for topic", { topicId });
      return new Map();
    }

    const documentsArray = parseTopicDocuments(data, topicId);
    const documentsMap = new Map<string, TopicDocument>();
    for (const doc of documentsArray) {
      if (documentsMap.has(doc.id)) {
        throw new Error(`Invalid document metadata for topic "${topicId}": duplicate document id "${doc.id}"`);
      }
      documentsMap.set(doc.id, doc);
    }

    this.logger.debug("Topic documents loaded", {
      topicId,
      documentCount: documentsArray.length,
    });
    return documentsMap;
  }

  /**
   * Load document metadata for all topics
   */
  private async loadAllTopicDocuments(index: TopicsIndex | null = this.topicsIndex): Promise<void> {
    if (!index) {
      return;
    }

    const topicIds = Object.keys(index.topics);
    this.logger.debug("Loading documents for all topics", {
      topicCount: topicIds.length,
    });

    // Each topic's metadata lives in its own file, so read them concurrently.
    // Failure semantics are unchanged: any topic that fails to load rejects the
    // whole load and leaves `topicDocuments` untouched.
    const documentsByTopic = await Promise.all(topicIds.map((topicId) => this.loadTopicDocuments(topicId)));
    const loadedDocuments = new Map<string, Map<string, TopicDocument>>();
    topicIds.forEach((topicId, index) => loadedDocuments.set(topicId, documentsByTopic[index]));
    this.topicDocuments = loadedDocuments;
  }

  private getTopicMutationMutex(topicId: string): Mutex {
    let mutex = this.topicMutationMutexes.get(topicId);
    if (!mutex) {
      mutex = new Mutex();
      this.topicMutationMutexes.set(topicId, mutex);
    }
    return mutex;
  }

  /** @internal */
  async assertStorageOwnership(): Promise<void> {
    if (this.activeLease) {
      await this.activeLease.assertOwned();
      return;
    }
    // Direct unit fixtures construct the private manager without running
    // initialization. A live initialized manager must never commit outside a
    // write transaction: without a lease nothing excludes another process.
    if (this.isInitialized) {
      throw new Error("Storage lease is unavailable; refusing to commit");
    }
  }

  /**
   * Run `operation` under an exclusive, operation-scoped write lease.
   *
   * Every storage mutation goes through here. The transaction coordinator is
   * per operation on purpose: its `initialize()` is WAL recovery, which under
   * this design must run while we hold the lease rather than once at startup.
   *
   * Prologue order is load-bearing. WAL recovery *mutates the canonical
   * files* — it rolls a prepared-but-uncommitted transaction back by restoring
   * destinations from their backups. Reloading before that would fill the
   * caches from the torn, pre-rollback generation, and the operation would
   * then derive next-state from it and commit that durably, resurrecting a
   * transaction the recovery had just aborted. So: recover first, then read.
   *
   * @internal
   */
  async runStorageWriteTransaction<T>(
    operation: (tx: { coordinator: StorageTransactionCoordinator; lease: StorageLockHandle }) => Promise<T>,
    options?: { waitMs?: number },
  ): Promise<T> {
    return this.storageMutationMutex.runExclusive(async () => {
      const lease = await acquireOperationLease(this.storageDir, { waitMs: options?.waitMs ?? 5_000 });
      const previousLease = this.activeLease;
      const previousCoordinator = this.activeCoordinator;
      this.activeLease = lease;
      try {
        const coordinator = new StorageTransactionCoordinator(this.paths.databaseDir(), lease);
        await coordinator.initialize();
        this.activeCoordinator = coordinator;
        // Write-side safety: another process may have written since our caches
        // were loaded, and the recovery above may just have rolled a torn
        // generation back. Reload the canonical files before deriving
        // next-state from them.
        await this.reloadCanonicalState();
        await this.journals.recoverPostCommitCleanup();
        await this.journals.recoverIngestion();
        return await operation({ coordinator, lease });
      } finally {
        // Restore rather than clear: a nested acquisition must never drop an
        // outer transaction's fence on the way out.
        this.activeCoordinator = previousCoordinator;
        this.activeLease = previousLease;
        await lease.release();
      }
    });
  }

  /** Take an operation lease for a single startup write, then give it back. */
  private async withOperationLease<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await acquireOperationLease(this.storageDir, { waitMs: 5_000 });
    const previousLease = this.activeLease;
    this.activeLease = lease;
    try {
      return await operation();
    } finally {
      this.activeLease = previousLease;
      await lease.release();
    }
  }

  /**
   * Validate the storage format marker, stamping it only for a genuinely
   * empty directory.
   *
   * Classification is read-only, so two windows opening the same healthy store
   * never contend. Only the fresh-install case writes, and it waits for the
   * lease rather than try-locking: a first run that silently skipped the stamp
   * would leave the store unversioned. Any other classification is handed to
   * `ensureStorageFormat` unleased purely so it raises its own typed error
   * (a newer format version, an unreadable marker, an interrupted reset, or unsupported pre-0.4 data) — it
   * cannot write on those paths, and taking a lease first would let a
   * StorageBusyError mask the real diagnosis.
   */
  private async ensureStorageFormatMarker(): Promise<void> {
    const inspection = await inspectStorage(this.storageDir);
    if (inspection.status === "current") {
      return;
    }
    if (inspection.status !== "empty") {
      await ensureStorageFormat(this.storageDir);
      return;
    }
    await this.withOperationLease(async () => {
      // Re-check under the lease: another process may have stamped it while
      // we waited.
      await ensureStorageFormat(this.storageDir);
    });
  }

  /**
   * Read-only probe: has a previous run left anything to recover?
   *
   * Recovery writes, so it needs a lease — and a clean open must not take one.
   * Probing means an interrupted write is repaired when the store is opened,
   * not deferred to whenever someone happens to write next, while a healthy
   * store still opens without touching the lock file.
   */
  private async hasPendingStorageRecovery(): Promise<boolean> {
    for (const journalPath of [
      this.journals.getPostCommitCleanupJournalPath(),
      this.journals.getIngestionJournalPath(),
    ]) {
      if (await pathExists(journalPath)) {
        return true;
      }
    }
    // A crashed transaction leaves its WAL, or an orphaned staging directory,
    // under the coordinator root.
    try {
      const staged = await fs.readdir(path.join(this.paths.databaseDir(), ".transactions"));
      return staged.length > 0;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  /** @internal */
  async runManagedOperation<T>(operation: () => Promise<T>): Promise<T> {
    const parentContext = this.managedOperationContext.getStore();
    if (parentContext?.active) {
      return operation();
    }
    if (!this.acceptingManagedOperations) {
      throw new Error("TopicManager is shutting down and is not accepting new storage operations");
    }
    this.activeManagedOperations += 1;
    const context = { active: true };
    try {
      return await this.managedOperationContext.run(context, operation);
    } finally {
      context.active = false;
      this.activeManagedOperations -= 1;
      if (this.activeManagedOperations === 0) {
        for (const resolve of this.operationDrainWaiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  private async waitForManagedOperationsToDrain(): Promise<void> {
    if (this.activeManagedOperations === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.operationDrainWaiters.push(resolve));
  }
}
