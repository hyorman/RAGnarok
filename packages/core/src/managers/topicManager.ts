/**
 * Topic Manager - Manages topic lifecycle and vector stores
 * Handles creation, deletion, updates, and document ingestion
 *
 * Architecture: Factory method (create()) with integrated pipeline
 * Replaces manual topic management from vectorDatabase.ts
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { ZipFile } from "yazl";
import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { IConfigProvider, ILLMProvider, INotifier } from "../interfaces";
import {
  Topic,
  TopicsIndex,
  Document as TopicDocument,
  ExportedTopicData,
  TopicSource,
  TopicMatch,
  DocumentSource,
} from "../utils/types";
import { DocumentPipeline, PipelineOptions, PipelineResult, type PipelineSourceDocument } from "./documentPipeline";
import {
  EmbeddingFingerprintMismatchError,
  EmbeddingReindexRequiredError,
  VectorStoreFactory,
  VectorStoreLoadError,
  VectorStoreMetadataCorruptionError,
} from "../stores/vectorStoreFactory";
import { EventEmitter } from "events";
import { EmbeddingService } from "../embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../embeddings/embeddingServiceRegistry";
import { Logger } from "../logger";
import { EXTENSION, CONFIG } from "../constants";
import {
  assertNoInterruptedStorageMigration,
  atomicWriteJson,
  ensureStorageFormatV2,
  inspectStorage,
  resetStorageToV2,
} from "../utils/storageV2";
import { acquireOperationLease } from "../utils/storageLock";
import type { StorageLockHandle } from "../utils/storageLock";
import {
  StorageTransactionCoordinator,
  type StorageTransactionOperation,
} from "../utils/storageTransactionCoordinator";
import { createHash, randomUUID } from "crypto";
import { Mutex } from "async-mutex";
import {
  TOPIC_ARCHIVE_FORMAT_VERSION,
  TOPIC_ARCHIVE_LIMITS,
  type TopicArchiveManifestFile,
  validateAndStageTopicArchive,
} from "../utils/topicArchive";

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

interface IngestionJournalEntry {
  id: string;
  transactionId?: string;
  containerId?: string;
  topicId: string;
  stage: "started" | "vectorCommitted" | "graphCommitted" | "metadataCommitted";
  document: TopicDocument;
  containerLeafIds?: string[];
  warnings?: Array<{ stage: string; message: string }>;
  updatedAt: number;
}

interface PostCommitCleanupEntry {
  version: 1;
  id: string;
  kind: "document";
  topicId: string;
  documents: TopicDocument[];
  legacyContainer: boolean;
  updatedAt: number;
}

interface ArchiveSourceFile {
  sourcePath: string;
  archivePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ExportSnapshotFile {
  stagedPath: string;
  manifest: TopicArchiveManifestFile;
}

interface StagedTopicImportCommit {
  contentDir: string;
  originalTopicId: string;
  newTopicId: string;
  preparedDocumentsPath: string;
  preparedMetadataPath?: string;
  preparedIndexPath: string;
  expectedIndexSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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
      (value.source !== undefined && value.source !== "local" && value.source !== "common")
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
export class TopicManager {
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
  private config: IConfigProvider;
  private notifier: INotifier;
  private embeddingService: EmbeddingService;
  private embeddingRegistry: EmbeddingServiceRegistry;
  private llmProvider: ILLMProvider | undefined;

  private logger: Logger;
  private topicsIndex: TopicsIndex | null = null;
  private documentPipeline: DocumentPipeline;
  private vectorStoreFactory: VectorStoreFactory | null = null;
  private isInitialized: boolean = false;

  // Cache for loaded vector stores
  private vectorStoreCache: Map<string, VectorStore> = new Map();

  // Cache for topic documents
  private topicDocuments: Map<string, Map<string, TopicDocument>> = new Map();

  // Memoized topic-name embeddings used by fuzzy topic resolution, valid only
  // for the embedding model recorded alongside them.
  private topicNameVectorCache: Map<string, number[]> = new Map();
  private topicNameVectorModel: string | null = null;

  // Common database support
  private commonTopicsIndex: TopicsIndex | null = null;
  private commonTopicDocuments: Map<string, Map<string, TopicDocument>> = new Map();
  private commonDatabasePath: string | null = null;
  private journalMutex = new Mutex();
  private archiveMutex = new Mutex();
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
      await assertNoInterruptedStorageMigration(this.storageDir);

      if (this.options.resetStorage) {
        const backupPath = await this.withOperationLease(() => resetStorageToV2(this.storageDir));
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
      const storageDir = this.getDatabaseDir();
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

      // Load common database if configured
      await this.loadCommonDatabase();

      this.isInitialized = true;
      this.logger.info("TopicManager initialized successfully", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
        commonTopicCount: Object.keys(this.commonTopicsIndex?.topics || {}).length,
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
    return this.runManagedOperation(() => this.runStorageWriteTransaction(() => this.createTopicUnlocked(options)));
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
      const commonNameConflict = Object.values(this.commonTopicsIndex?.topics ?? {}).find(
        (topic) => topic.name.toLowerCase() === options.name.toLowerCase(),
      );

      if (existingTopic || commonNameConflict) {
        throw new Error(`Topic with name "${options.name}" already exists`);
      }

      // Create topic object
      let topicId = this.generateTopicId();
      while (this.topicsIndex.topics[topicId] || this.commonTopicsIndex?.topics[topicId]) {
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
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction((tx) =>
        this.getTopicMutationMutex(topicId).runExclusive(() => this.deleteTopicUnlocked(topicId, tx.coordinator)),
      ),
    );
  }

  private async deleteTopicUnlocked(topicId: string, coordinator: StorageTransactionCoordinator): Promise<void> {
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
      // Once it no longer advertises the topic, remaining table directories
      // are unreachable cleanup. A pre-commit crash restores every backup.
      const nextTopicsIndex: TopicsIndex = {
        ...this.topicsIndex,
        topics: { ...this.topicsIndex.topics },
        lastUpdated: Date.now(),
      };
      delete nextTopicsIndex.topics[topicId];
      const preparedIndex = path.join(this.getDatabaseDir(), `.delete-${topicId}-${randomUUID()}.json`);
      await atomicWriteJson(preparedIndex, nextTopicsIndex);
      const lancedbDir = path.join(this.getDatabaseDir(), "lancedb");
      const operations: StorageTransactionOperation[] = [
        { type: "replace", source: preparedIndex, destination: this.getTopicsIndexPath() },
        { type: "delete", destination: this.getTopicDocumentsPath(topicId) },
        { type: "delete", destination: path.join(this.getDatabaseDir(), `vector-${topicId}-metadata.json`) },
        { type: "delete", destination: path.join(lancedbDir, `${topicId}.lance`) },
      ];

      // Closing the shared factory invalidates handles for every local/common
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
          this.getDatabaseDir(),
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
    return this.runManagedOperation(() =>
      this.runStorageWriteTransaction(() => this.updateTopicUnlocked(topicId, updates)),
    );
  }

  private async updateTopicUnlocked(
    topicId: string,
    updates: Partial<Pick<Topic, "name" | "description">>,
  ): Promise<Topic> {
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
        const commonTopic = Object.values(this.commonTopicsIndex?.topics ?? {}).find(
          (candidate) => candidate.name.toLowerCase() === updates.name!.toLowerCase(),
        );

        if (existingTopic || commonTopic) {
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
   * Get a topic by ID (from local or common database)
   */
  public getTopic(topicId: string): Topic | null {
    // Check local topics first
    if (this.topicsIndex?.topics[topicId]) {
      return { ...this.topicsIndex.topics[topicId], source: "local" as TopicSource };
    }
    // Check common topics
    if (this.commonTopicsIndex?.topics[topicId]) {
      return { ...this.commonTopicsIndex.topics[topicId], source: "common" as TopicSource };
    }
    return null;
  }

  /**
   * Get all topics (local + common merged)
   */
  public getAllTopics(): Topic[] {
    const localTopics = this.topicsIndex
      ? Object.values(this.topicsIndex.topics).map((t) => ({ ...t, source: "local" as TopicSource }))
      : [];

    const commonTopics = this.commonTopicsIndex
      ? Object.values(this.commonTopicsIndex.topics).map((t) => ({ ...t, source: "common" as TopicSource }))
      : [];

    return [...localTopics, ...commonTopics].filter((t) => !TopicManager.isSystemTopic(t.name));
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

  /**
   * Check if a topic is from the common database (read-only)
   */
  public isCommonTopic(topicId: string): boolean {
    return this.topicsIndex?.topics[topicId] === undefined && this.commonTopicsIndex?.topics[topicId] !== undefined;
  }

  /**
   * Get documents for a specific topic (local or common)
   */
  public getTopicDocuments(topicId: string): TopicDocument[] {
    // Check local documents first
    const localDocs = this.topicDocuments.get(topicId);
    if (localDocs) {
      return Array.from(localDocs.values());
    }
    // Check common documents
    const commonDocs = this.commonTopicDocuments.get(topicId);
    if (commonDocs) {
      return Array.from(commonDocs.values());
    }
    return [];
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
    if (this.isCommonTopic(topicId)) {
      throw new Error("Common database topics are read-only");
    }
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
      legacyContainer: Boolean(exactDocument && !exactDocument.containerId),
      updatedAt: Date.now(),
    };
    await this.upsertPostCommitCleanup(cleanupEntry);

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
    const preparedDocuments = path.join(this.getDatabaseDir(), `.remove-documents-${randomUUID()}.json`);
    const preparedIndex = path.join(this.getDatabaseDir(), `.remove-index-${randomUUID()}.json`);
    await atomicWriteJson(preparedDocuments, [...nextDocuments.values()]);
    await atomicWriteJson(preparedIndex, nextIndex);
    try {
      await coordinator.commit(
        "remove-document-metadata",
        [
          { type: "replace", source: preparedDocuments, destination: this.getTopicDocumentsPath(topicId) },
          { type: "replace", source: preparedIndex, destination: this.getTopicsIndexPath() },
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
      removedChunkIds = await this.completePostCommitCleanup(cleanupEntry);
      await this.removePostCommitCleanup(cleanupEntry.id);
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
    commonTopicCount: number;
  }> {
    return {
      formatVersion: 2,
      storageDir: this.storageDir,
      databaseDir: this.getDatabaseDir(),
      topicCount: Object.keys(this.topicsIndex?.topics ?? {}).length,
      commonTopicCount: Object.keys(this.commonTopicsIndex?.topics ?? {}).length,
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
        const stableDocumentId = this.documentIdForSource(filePath, source.type === "url" ? "web" : source.type);
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
                : this.mapFileType(fileExt),
          source,
          addedAt: Date.now(),
          chunkCount: 0,
          containerId: stableDocumentId,
          canonicalSource: source.type === "file" ? source.path : source.url,
        };
        const journalId = `${transactionId}:container`;
        await this.upsertIngestionJournal({
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
          await this.replaceIngestionTransaction(
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
          await this.markAndRemoveCommittedIngestion(transactionId);

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
    return (
      error instanceof EmbeddingReindexRequiredError ||
      error instanceof VectorStoreMetadataCorruptionError ||
      error instanceof EmbeddingFingerprintMismatchError
    );
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

  private createLeafTopicDocuments(
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

  private summarizePipelineChunks(chunks: LangChainDocument[]): PipelineSourceDocument[] {
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

  private async removeDocumentStorage(topicId: string, documentId: string, signal?: AbortSignal): Promise<string[]> {
    if (!this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }
    signal?.throwIfAborted();
    const removedChunkIds = await this.vectorStoreFactory.removeDocument(topicId, documentId);
    signal?.throwIfAborted();
    return removedChunkIds;
  }

  private async legacyLeafIdsForContainer(topicId: string, container: TopicDocument): Promise<string[]> {
    if (!this.vectorStoreFactory) {
      return [];
    }
    const rows = await this.vectorStoreFactory.getAllDocuments(topicId, 1_000_000);
    const containerSource =
      container.source?.type === "file"
        ? container.source.path
        : container.source?.type === "url" || container.source?.type === "github"
          ? container.source.url
          : (container.canonicalSource ?? container.filePath);
    let containerUrl: URL | undefined;
    try {
      containerUrl = new URL(containerSource);
      containerUrl.hash = "";
    } catch {
      // Local path comparison below.
    }
    const containerPath = containerUrl ? undefined : path.resolve(containerSource);
    const matchesContainer = (candidate: string): boolean => {
      if (!candidate) {
        return false;
      }
      if (containerUrl) {
        try {
          const candidateUrl = new URL(candidate);
          const basePath = containerUrl.pathname.replace(/\/$/, "");
          return (
            candidateUrl.origin === containerUrl.origin &&
            (candidateUrl.pathname === basePath || candidateUrl.pathname.startsWith(`${basePath}/`))
          );
        } catch {
          return false;
        }
      }
      const relative = path.relative(containerPath!, path.resolve(candidate));
      return (
        relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    };
    const leafIds = new Set<string>();
    for (const row of rows) {
      const leafId = String(row.metadata.documentId ?? "");
      if (!leafId || leafId === container.id) {
        continue;
      }
      const source = String(row.metadata.source ?? row.metadata.filePath ?? "");
      let descriptorSource = "";
      try {
        const descriptor = JSON.parse(String(row.metadata.sourceDescriptor ?? "{}")) as unknown;
        if (isRecord(descriptor) && typeof descriptor.source === "string") {
          descriptorSource = descriptor.source;
        }
      } catch {
        // A malformed legacy descriptor is not evidence for deletion.
      }
      if (matchesContainer(source) || matchesContainer(descriptorSource)) {
        leafIds.add(leafId);
      }
    }
    return [...leafIds];
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
  public async getVectorStore(topicId: string): Promise<VectorStore | null> {
    this.logger.debug("Getting vector store", { topicId });

    let store: VectorStore | null;
    try {
      store = await this.loadVectorStoreOnce(topicId);
    } catch (error) {
      if (error instanceof VectorStoreLoadError) {
        return await this.retryVectorStoreLoad(topicId);
      }
      this.logger.error("Failed to get vector store", {
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
    this.invalidateVectorStoreCache(topicId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      // table-absent here is accepted as empty-topic semantics; a second
      // VectorStoreLoadError is a real failure and must surface, never be
      // swallowed into a fabricated "empty topic" result.
      return await this.loadVectorStoreOnce(topicId);
    } catch (error) {
      this.logger.error("Failed to get vector store after retry", {
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
    if (!this.vectorStoreFactory) {
      return false;
    }
    const customStorageDir = this.isCommonTopic(topicId) ? (this.commonDatabasePath ?? undefined) : undefined;
    try {
      return (await this.vectorStoreFactory.getStoreMetadata(topicId, customStorageDir)) !== null;
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
    if (!this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }

    try {
      await this.ensureEmbeddingModelCompatibility(topicId);
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

    const location = this.isCommonTopic(topicId) ? (this.commonDatabasePath ?? "common") : this.getDatabaseDir();
    const cacheKey = `${location}::${topicId}`;
    // Check cache first
    const cachedStore = this.vectorStoreCache.get(cacheKey);
    if (cachedStore) {
      this.logger.debug("Returning cached vector store", { topicId });
      return cachedStore;
    }

    // Load from disk
    let store;
    if (this.isCommonTopic(topicId) && this.commonDatabasePath) {
      this.logger.debug("Loading vector store from common database", { topicId });
      store = await this.vectorStoreFactory.loadStore(topicId, this.commonDatabasePath);
    } else {
      store = await this.vectorStoreFactory.loadStore(topicId);
    }

    if (store) {
      this.vectorStoreCache.set(cacheKey, store);
      this.logger.debug("Vector store loaded and cached", { topicId });
    }

    return store;
  }

  /**
   * Fetch all documents from a topic via table scan (no embedding needed).
   */
  public async getAllDocuments(topicId: string, limit: number): Promise<LangChainDocument[]> {
    if (!this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }

    const customDir = this.isCommonTopic(topicId) ? this.commonDatabasePath : undefined;
    return this.vectorStoreFactory.getAllDocuments(topicId, limit, customDir ?? undefined);
  }

  /**
   * Verify that the stored embedding backend/model is available for querying.
   * Does NOT block queries when the backend is available but differs from the
   * current global setting — loadStore() handles routing via scoped embeddings.
   * Throws only when the required backend is truly unavailable.
   */
  private async ensureEmbeddingModelCompatibility(topicId: string): Promise<void> {
    if (!this.vectorStoreFactory) {
      return;
    }

    const metadata = await this.vectorStoreFactory.getStoreMetadata(
      topicId,
      this.isCommonTopic(topicId) ? (this.commonDatabasePath ?? undefined) : undefined,
    );
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

      let topic = this.topicsIndex.topics[topicId];
      let databaseDir = this.getDatabaseDir();
      let isCommon = false;

      // If not in local, check common
      if (!topic && this.commonTopicsIndex && this.commonTopicsIndex.topics[topicId]) {
        topic = this.commonTopicsIndex.topics[topicId];
        if (this.commonDatabasePath) {
          databaseDir = this.commonDatabasePath;
          isCommon = true;
        }
      }

      if (!topic) {
        return null;
      }

      // Get document count
      const documents = isCommon ? this.commonTopicDocuments.get(topicId) : this.topicDocuments.get(topicId);

      const documentCount = documents?.size || 0;

      // Load vector store metadata
      const metadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);

      let chunkCount = 0;
      let embeddingModel = this.embeddingService.getCurrentModel() || this.topicsIndex?.modelName || "unknown";

      try {
        const metadataJson = await fs.readFile(metadataPath, "utf-8");
        const metadata = JSON.parse(metadataJson);
        chunkCount = metadata.chunkCount || 0;
        if (metadata.embeddingModel) {
          embeddingModel = metadata.embeddingModel;
        }
      } catch {
        // Metadata not available
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
    return this.runManagedOperation(() =>
      // A refresh is a read: it republishes what is on disk and writes
      // nothing, so it takes no lease. It still serializes against local
      // mutations, because republishing the caches between a mutation's
      // in-memory apply and its flush would silently drop that mutation.
      this.storageMutationMutex.runExclusive(async () => {
        this.logger.info("Refreshing topics");
        await this.reloadCanonicalState();
      }),
    );
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
      const storageDir = this.getDatabaseDir();
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
      this.vectorStoreCache.clear();
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
   * Should be called when TopicManager is no longer needed
   */
  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.logger.info("Disposing TopicManager");
    this.acceptingManagedOperations = false;
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

    this.vectorStoreCache.clear();
    this.topicDocuments.clear();
    this.topicNameVectorCache.clear();
    this.topicNameVectorModel = null;
    this.topicMutationMutexes.clear();
    this.topicsIndex = null;
    this.isInitialized = false;
    TopicManager._onAgentCacheCleanup.removeAllListeners();

    // No session lease exists to release: every lease is released by the
    // transaction that took it, and the drain above waited for those.

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
  public async exportTopic(topicId: string, exportPath: string): Promise<void> {
    return this.runManagedOperation(() =>
      this.archiveMutex.runExclusive(() => this.exportTopicUnlocked(topicId, exportPath)),
    );
  }

  /**
   * Import a topic from a .rag archive file
   */
  public async importTopic(archivePath: string): Promise<Topic> {
    return this.runManagedOperation(() =>
      this.archiveMutex.runExclusive(() => this.importTopicUnlocked(archivePath)),
    );
  }

  private async exportTopicUnlocked(topicId: string, exportPath: string): Promise<void> {
    this.logger.info("Exporting topic", { topicId, exportPath });
    const databaseDir = this.getDatabaseDir();
    let stagingDir: string | undefined;
    let temporaryArchivePath: string | undefined;

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }
      if (this.isCommonTopic(topicId)) {
        throw new Error("Cannot export topics from common database");
      }
      if (!this.topicsIndex.topics[topicId]) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Export takes no lease: it is a read. Capture the topics index
      // revision now and re-check it once the archive is written, so a
      // mutation that lands mid-export is caught instead of silently
      // shipping a torn archive.
      const indexHashBeforeExport = await this.hashFile(this.getTopicsIndexPath());

      await fs.mkdir(databaseDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(databaseDir, ".rag-export-"));
      const snapshot = await this.createStableExportSnapshot(topicId, stagingDir);
      const manifestContents = JSON.stringify(
        {
          formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
          files: snapshot.files.map((file) => file.manifest),
        },
        null,
        2,
      );
      if (Buffer.byteLength(manifestContents) > TOPIC_ARCHIVE_LIMITS.maxManifestBytes) {
        throw new Error("Topic is too large to export: archive manifest exceeds size limit");
      }

      await fs.mkdir(path.dirname(exportPath), { recursive: true });
      const realDatabaseDir = await fs.realpath(databaseDir);
      const realExportParent = await fs.realpath(path.dirname(exportPath));
      if (this.isSameOrNestedPath(realDatabaseDir, realExportParent)) {
        throw new Error("Export destination cannot be inside the managed database directory");
      }
      temporaryArchivePath = path.join(path.dirname(exportPath), `.${path.basename(exportPath)}.${randomUUID()}.tmp`);
      const output = fsSync.createWriteStream(temporaryArchivePath, { flags: "wx", mode: 0o600 });
      const zip = new ZipFile();
      const archivePromise = new Promise<void>((resolve, reject) => {
        let archiveError: unknown;
        const closeWithError = (error: unknown) => {
          archiveError = error;
          if (!output.destroyed) {
            output.destroy();
          }
        };
        output.once("close", () => (archiveError === undefined ? resolve() : reject(archiveError)));
        output.once("error", closeWithError);
        zip.outputStream.once("error", closeWithError);
      });
      zip.outputStream.pipe(output);

      for (const file of snapshot.files) {
        zip.addFile(file.stagedPath, file.manifest.path);
      }
      zip.addBuffer(Buffer.from(manifestContents, "utf8"), "manifest.json");
      zip.end();

      await archivePromise;

      if ((await this.hashFile(this.getTopicsIndexPath())) !== indexHashBeforeExport) {
        throw new Error("Topic storage changed during export; retry the export");
      }

      await fs.rename(temporaryArchivePath, exportPath);
      temporaryArchivePath = undefined;

      this.logger.info("Topic exported successfully", { topicId, exportPath });
    } catch (error) {
      this.logger.error("Failed to export topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    } finally {
      if (temporaryArchivePath) {
        await fs.rm(temporaryArchivePath, { force: true }).catch(() => undefined);
      }
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async importTopicUnlocked(archivePath: string): Promise<Topic> {
    this.logger.info("Importing topic", { archivePath });
    const databaseDir = this.getDatabaseDir();
    let stagingDir: string | undefined;

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }
      await fs.mkdir(databaseDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(databaseDir, ".rag-import-"));
      const stagedArchive = await validateAndStageTopicArchive(archivePath, stagingDir);
      const exportData = stagedArchive.exportData;

      const currentModel = this.embeddingService.getCurrentModel();
      if (exportData.embeddingModel !== currentModel) {
        this.logger.warn("Imported topic uses different embedding model", {
          importedModel: exportData.embeddingModel,
          currentModel,
          note: "Switch to the imported model before querying this topic",
        });
      }

      let newTopicId = this.generateTopicId();
      while (this.topicsIndex.topics[newTopicId] || this.commonTopicsIndex?.topics[newTopicId]) {
        newTopicId = this.generateTopicId();
      }
      const now = Date.now();
      const newTopic: Topic = {
        ...exportData.topic,
        id: newTopicId,
        createdAt: now,
        updatedAt: now,
        source: "local",
      };
      const occupiedNames = new Set(
        [...Object.values(this.topicsIndex.topics), ...Object.values(this.commonTopicsIndex?.topics ?? {})].map(
          (topic) => topic.name.toLowerCase(),
        ),
      );
      const baseName = newTopic.name;
      let suffix = 0;
      while (occupiedNames.has(newTopic.name.toLowerCase())) {
        suffix += 1;
        newTopic.name = `${baseName} (imported${suffix === 1 ? "" : ` ${suffix}`})`;
      }

      const newDocuments = exportData.documents.map((document) => ({
        ...document,
        topicId: newTopicId,
      }));
      const preparedDocumentsPath = path.join(stagingDir, "prepared-documents.json");
      await atomicWriteJson(preparedDocumentsPath, newDocuments);

      const originalMetadataPath = path.join(stagedArchive.contentDir, `vector-${exportData.topic.id}-metadata.json`);
      const preparedMetadataPath = path.join(stagingDir, "prepared-vector-metadata.json");
      if (await this.pathExists(originalMetadataPath)) {
        const metadata = JSON.parse(await fs.readFile(originalMetadataPath, "utf8"));
        metadata.topicId = newTopicId;
        await atomicWriteJson(preparedMetadataPath, metadata);
      }

      const nextTopicsIndex: TopicsIndex = {
        ...this.topicsIndex,
        topics: { ...this.topicsIndex.topics, [newTopicId]: newTopic },
        lastUpdated: now,
      };
      const preparedIndexPath = path.join(stagingDir, "prepared-topics.json");
      await atomicWriteJson(preparedIndexPath, nextTopicsIndex);
      // Captured before the lease is taken: this guards the staging window
      // above, not live cross-process races (the lease already excludes
      // those once we hold it).
      const expectedIndexSha256 = await this.hashFile(this.getTopicsIndexPath());
      const preparedMetadataFinalPath = (await this.pathExists(preparedMetadataPath))
        ? preparedMetadataPath
        : undefined;

      // Only the commit is a storage mutation: staging above needed no lease.
      await this.runStorageWriteTransaction(async (tx) => {
        await this.commitStagedTopicImport(
          {
            contentDir: stagedArchive.contentDir,
            originalTopicId: exportData.topic.id,
            newTopicId,
            preparedDocumentsPath,
            preparedMetadataPath: preparedMetadataFinalPath,
            preparedIndexPath,
            expectedIndexSha256,
          },
          tx.coordinator,
        );

        const documentsMap = new Map<string, TopicDocument>();
        for (const document of newDocuments) {
          documentsMap.set(document.id, document);
        }
        this.topicsIndex = nextTopicsIndex;
        this.topicDocuments.set(newTopicId, documentsMap);
      });

      this.logger.info("Topic imported successfully", {
        originalId: exportData.topic.id,
        newId: newTopicId,
        name: newTopic.name,
        documentCount: newDocuments.length,
      });
      return newTopic;
    } catch (error) {
      this.logger.error("Failed to import topic", {
        error: error instanceof Error ? error.message : String(error),
        archivePath,
      });
      throw error;
    } finally {
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Copy a point-in-time candidate into same-filesystem staging. LanceDB does
   * not currently expose a transaction snapshot for its directory, so compare
   * the complete file inventory and identity before/after the streamed copies.
   * A concurrent mutation causes a bounded retry instead of a mixed archive.
   */
  private async createStableExportSnapshot(
    topicId: string,
    stagingRoot: string,
  ): Promise<{ files: ExportSnapshotFile[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptDir = path.join(stagingRoot, `snapshot-${attempt}`);
      await fs.mkdir(attemptDir, { recursive: true });

      const topicBefore = this.topicsIndex?.topics[topicId];
      if (!topicBefore) {
        throw new Error(`Topic not found: ${topicId}`);
      }
      const topicSnapshot = { ...topicBefore };
      const documentsSnapshot = this.getTopicDocuments(topicId).map((document) => ({
        ...document,
        source: document.source ? { ...document.source } : undefined,
      }));
      const exportData: ExportedTopicData = {
        version: TOPIC_ARCHIVE_FORMAT_VERSION,
        topic: topicSnapshot,
        documents: documentsSnapshot,
        embeddingModel: this.topicsIndex!.modelName,
        exportedAt: Date.now(),
      };
      const metadataIdentity = JSON.stringify({
        topic: topicSnapshot,
        documents: documentsSnapshot,
        modelName: this.topicsIndex!.modelName,
      });
      let sourcesBefore: ArchiveSourceFile[];
      try {
        sourcesBefore = await this.collectArchiveSourceFiles(topicId);
      } catch (error: any) {
        if (error?.code === "ENOENT" || error?.code === "ESTALE") {
          await fs.rm(attemptDir, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
      const files: ExportSnapshotFile[] = [];

      const topicBytes = Buffer.from(JSON.stringify(exportData, null, 2));
      if (topicBytes.byteLength > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) {
        throw new Error("Topic is too large to export: topic metadata exceeds entry size limit");
      }
      if (sourcesBefore.length + 2 > TOPIC_ARCHIVE_LIMITS.maxEntries) {
        throw new Error("Topic is too large to export: archive entry count exceeds limit");
      }
      const snapshotSize = sourcesBefore.reduce((total, source) => total + source.size, topicBytes.byteLength);
      if (
        sourcesBefore.some((source) => source.size > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) ||
        snapshotSize > TOPIC_ARCHIVE_LIMITS.maxTotalBytes
      ) {
        throw new Error("Topic is too large to export: archive payload exceeds size limit");
      }
      const stagedTopicPath = path.join(attemptDir, "topic.json");
      await fs.writeFile(stagedTopicPath, topicBytes, { flag: "wx", mode: 0o600 });
      files.push({
        stagedPath: stagedTopicPath,
        manifest: {
          path: "topic.json",
          size: topicBytes.byteLength,
          sha256: createHash("sha256").update(topicBytes).digest("hex"),
        },
      });

      let copyFailed = false;
      for (const source of sourcesBefore) {
        const stagedPath = path.join(attemptDir, ...source.archivePath.split("/"));
        try {
          await fs.mkdir(path.dirname(stagedPath), { recursive: true });
          await fs.copyFile(source.sourcePath, stagedPath, fsSync.constants.COPYFILE_EXCL);
          const stagedStat = await fs.stat(stagedPath);
          files.push({
            stagedPath,
            manifest: {
              path: source.archivePath,
              size: stagedStat.size,
              sha256: await this.hashFile(stagedPath),
            },
          });
        } catch (error: any) {
          if (error?.code === "ENOENT" || error?.code === "ESTALE") {
            copyFailed = true;
            break;
          }
          throw error;
        }
      }

      const topicAfter = this.topicsIndex?.topics[topicId];
      const metadataAfter = topicAfter
        ? JSON.stringify({
            topic: topicAfter,
            documents: this.getTopicDocuments(topicId),
            modelName: this.topicsIndex!.modelName,
          })
        : "";
      let sourcesAfter: ArchiveSourceFile[] = [];
      if (!copyFailed) {
        try {
          sourcesAfter = await this.collectArchiveSourceFiles(topicId);
        } catch (error: any) {
          if (error?.code === "ENOENT" || error?.code === "ESTALE") {
            copyFailed = true;
          } else {
            throw error;
          }
        }
      }
      if (
        !copyFailed &&
        metadataIdentity === metadataAfter &&
        this.archiveSourceInventoriesEqual(sourcesBefore, sourcesAfter) &&
        files.every((file) => {
          if (file.manifest.path === "topic.json") {
            return true;
          }
          const source = sourcesAfter.find((candidate) => candidate.archivePath === file.manifest.path);
          return source !== undefined && source.size === file.manifest.size;
        })
      ) {
        files.sort((left, right) => left.manifest.path.localeCompare(right.manifest.path));
        return { files };
      }
      await fs.rm(attemptDir, { recursive: true, force: true });
    }
    throw new Error("Topic changed during export; retry after active writes finish");
  }

  private async collectArchiveSourceFiles(topicId: string): Promise<ArchiveSourceFile[]> {
    const databaseDir = this.getDatabaseDir();
    const sources: ArchiveSourceFile[] = [];
    for (const tableName of [topicId]) {
      const tableDir = path.join(databaseDir, "lancedb", `${tableName}.lance`);
      let tableStat: fsSync.Stats;
      try {
        tableStat = await fs.lstat(tableDir);
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (tableStat.isSymbolicLink() || !tableStat.isDirectory()) {
        throw new Error(`Refusing to export unsafe LanceDB path: ${tableDir}`);
      }
      for (const filePath of await this.listFilesRecursively(tableDir)) {
        const stat = await fs.lstat(filePath);
        const relativePath = path.relative(tableDir, filePath).replace(/\\/g, "/");
        sources.push({
          sourcePath: filePath,
          archivePath: `lancedb/${tableName}.lance/${relativePath}`,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      }
    }

    const vectorMetadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);
    try {
      const stat = await fs.lstat(vectorMetadataPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing to export unsafe vector metadata path: ${vectorMetadataPath}`);
      }
      sources.push({
        sourcePath: vectorMetadataPath,
        archivePath: `vector-${topicId}-metadata.json`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    return sources.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  }

  private archiveSourceInventoriesEqual(left: ArchiveSourceFile[], right: ArchiveSourceFile[]): boolean {
    return (
      left.length === right.length &&
      left.every((source, index) => {
        const candidate = right[index];
        return (
          source.archivePath === candidate.archivePath &&
          source.size === candidate.size &&
          source.mtimeMs === candidate.mtimeMs &&
          source.ctimeMs === candidate.ctimeMs
        );
      })
    );
  }

  private async hashFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const input = fsSync.createReadStream(filePath);
      input.on("data", (chunk) => hash.update(chunk));
      input.once("error", reject);
      input.once("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Publish a validated import under a fresh topic ID. Every payload is moved
   * before the topics index; the index rename is the visibility point. Runtime
   * failures before that point move all payloads back into staging.
   */
  private async commitStagedTopicImport(
    commit: StagedTopicImportCommit,
    coordinator: StorageTransactionCoordinator,
  ): Promise<void> {
    const databaseDir = this.getDatabaseDir();
    const operations: StorageTransactionOperation[] = [];
    const tableMappings = [{ oldName: commit.originalTopicId, newName: commit.newTopicId }];
    for (const mapping of tableMappings) {
      const source = path.join(commit.contentDir, "lancedb", `${mapping.oldName}.lance`);
      if (await this.pathExists(source)) {
        operations.push({
          type: "replace",
          source,
          destination: path.join(databaseDir, "lancedb", `${mapping.newName}.lance`),
        });
      }
    }
    if (commit.preparedMetadataPath) {
      operations.push({
        type: "replace",
        source: commit.preparedMetadataPath,
        destination: path.join(databaseDir, `vector-${commit.newTopicId}-metadata.json`),
      });
    }
    operations.push({
      type: "replace",
      source: commit.preparedDocumentsPath,
      destination: this.getTopicDocumentsPath(commit.newTopicId),
    });
    // Topics index publication is last and is the visibility point.
    operations.push({
      type: "replace",
      source: commit.preparedIndexPath,
      destination: this.getTopicsIndexPath(),
    });

    for (const operation of operations.slice(0, -1)) {
      if (await this.pathExists(operation.destination)) {
        throw new Error(`Import destination already exists: ${operation.destination}`);
      }
    }
    if ((await this.hashFile(this.getTopicsIndexPath())) !== commit.expectedIndexSha256) {
      throw new Error("Topics index changed during import; retry after active writes finish");
    }
    // Retained as a deterministic failure-injection seam for archive tests.
    await this.publishPreparedTopicsIndex(commit.preparedIndexPath);
    await this.assertStorageOwnership();
    await coordinator.commit("import-topic", operations, {
      originalTopicId: commit.originalTopicId,
      newTopicId: commit.newTopicId,
      expectedIndexSha256: commit.expectedIndexSha256,
    });
  }

  /** Testable pre-publication seam. Durable publication is owned by the coordinator. */
  private async publishPreparedTopicsIndex(_preparedIndexPath: string): Promise<void> {
    // Intentionally empty.
  }

  private async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await fs.lstat(candidatePath);
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private isSameOrNestedPath(parentPath: string, candidatePath: string): boolean {
    const normalize = (value: string): string =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const normalizedParent = normalize(parentPath);
    const normalizedCandidate = normalize(candidatePath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  }

  /**
   * Load topics from common database path (read-only)
   */
  public async loadCommonDatabase(): Promise<void> {
    return this.runManagedOperation(() => this.loadCommonDatabaseUnlocked());
  }

  private async loadCommonDatabaseUnlocked(): Promise<void> {
    const commonPath = this.config.get<string>(CONFIG.COMMON_DATABASE_PATH, "");

    if (!commonPath) {
      this.logger.debug("No common database path configured");
      this.commonTopicsIndex = null;
      this.commonTopicDocuments.clear();
      this.commonDatabasePath = null;
      return;
    }

    try {
      // Verify path exists
      await fs.access(commonPath);
      const commonFormat = JSON.parse(await fs.readFile(path.join(commonPath, "storage-format.json"), "utf8"));
      if (commonFormat.formatVersion !== 2) {
        throw new Error("Common database must use storage format v2");
      }
      const commonDatabaseDir = path.join(commonPath, EXTENSION.DATABASE_DIR);
      this.commonDatabasePath = commonDatabaseDir;

      // Check for topics.json
      const indexPath = path.join(commonDatabaseDir, EXTENSION.TOPICS_INDEX_FILENAME);
      try {
        await fs.access(indexPath);
      } catch {
        this.logger.warn("Common database path exists but missing topics.json", { path: commonPath });
        this.notifier.showWarning(
          `Common database path found, but missing "${EXTENSION.TOPICS_INDEX_FILENAME}". Is the path correct?`,
        );
        this.commonTopicsIndex = null;
        this.commonTopicDocuments.clear();
        return;
      }

      // Load topics index from common path
      const data = await fs.readFile(indexPath, "utf-8");
      this.commonTopicsIndex = parseTopicsIndex(data);
      this.commonTopicDocuments.clear();

      this.logger.info("Common database loaded", {
        path: commonPath,
        topicCount: Object.keys(this.commonTopicsIndex?.topics || {}).length,
      });

      // Load document metadata for each common topic
      if (this.commonTopicsIndex) {
        // Check for name conflicts with local topics BEFORE fully loading
        const localTopicNames = new Set(Object.values(this.topicsIndex?.topics || {}).map((t) => t.name.toLowerCase()));
        const localTopicIds = new Set(Object.keys(this.topicsIndex?.topics || {}));

        const conflicts: string[] = [];

        for (const topic of Object.values(this.commonTopicsIndex.topics)) {
          if (localTopicNames.has(topic.name.toLowerCase()) || localTopicIds.has(topic.id)) {
            conflicts.push(`${topic.name} (${topic.id})`);
          }
        }

        if (conflicts.length > 0) {
          const conflictList = conflicts.slice(0, 3).join(", ") + (conflicts.length > 3 ? "..." : "");
          const message = `Cannot load common database due to topic ID/name conflicts. Local topics [${conflictList}] already exist. Please rename or re-ID the conflicting topics first.`;

          this.logger.warn("Common database load aborted due to name conflicts", { conflicts });
          this.notifier.showError(message);

          // Abort loading
          this.commonTopicsIndex = null;
          this.commonTopicDocuments.clear();
          this.commonDatabasePath = null;
          return;
        }

        // No conflicts, proceed to load documents
        for (const topicId of Object.keys(this.commonTopicsIndex.topics)) {
          await this.loadCommonTopicDocuments(topicId);
        }
      }
    } catch (error) {
      this.logger.warn("Failed to load common database", {
        path: commonPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.notifier.showError(
        `Failed to load common database: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.commonTopicsIndex = null;
      this.commonTopicDocuments.clear();
      this.commonDatabasePath = null;
    }
  }

  /**
   * Load document metadata for a common topic
   */
  private async loadCommonTopicDocuments(topicId: string): Promise<void> {
    if (!this.commonDatabasePath) {
      return;
    }

    try {
      const documentsPath = path.join(this.commonDatabasePath, `topic-${topicId}-documents.json`);
      const data = await fs.readFile(documentsPath, "utf-8");
      const documentsArray: TopicDocument[] = JSON.parse(data);

      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of documentsArray) {
        documentsMap.set(doc.id, doc);
      }

      this.commonTopicDocuments.set(topicId, documentsMap);
    } catch (error) {
      if ((error as any).code === "ENOENT") {
        this.logger.warn("Document file missing for common topic", { topicId, error: "File not found" });
      } else {
        this.logger.error("Failed to load documents for common topic", { topicId, error });
      }
      this.commonTopicDocuments.set(topicId, new Map());
    }
  }

  /**
   * Get common database path if configured
   */
  public getCommonDatabasePath(): string | null {
    return this.commonDatabasePath;
  }

  // ==================== Private Methods ====================

  /**
   * Get the database directory path
   */
  private getDatabaseDir(): string {
    return path.join(this.storageDir, EXTENSION.DATABASE_DIR);
  }

  /**
   * Get the topics index file path
   */
  private getTopicsIndexPath(): string {
    return path.join(this.getDatabaseDir(), EXTENSION.TOPICS_INDEX_FILENAME);
  }

  /**
   * Ensure storage directory exists
   */
  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.getDatabaseDir(), { recursive: true });
    } catch (_error) {
      // Directory might already exist
    }
  }

  /**
   * Load topics index from file
   */
  private async loadTopicsIndex(): Promise<void> {
    const indexPath = this.getTopicsIndexPath();
    let data: string;
    try {
      data = await fs.readFile(indexPath, "utf-8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
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
    // partially replace a manager's previously loaded state during refresh.
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

  /**
   * Save topics index to file
   */
  private async saveTopicsIndex(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    try {
      await this.assertStorageOwnership();
      const indexPath = this.getTopicsIndexPath();
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
   */
  private generateTopicId(): string {
    return `topic-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Generate a unique document ID
   */
  private generateDocumentId(): string {
    return `doc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private documentIdForSource(source: string, sourceType: "file" | "web" | "github" = "file"): string {
    let normalized: string;
    try {
      const url = new URL(source);
      url.hash = "";
      normalized = url.toString();
    } catch {
      normalized = path.resolve(source).replace(/\\/g, "/");
    }
    return `doc-${createHash("sha256")
      .update(JSON.stringify({ type: sourceType, source: normalized }))
      .digest("hex")}`;
  }

  /**
   * Map file extension to document file type
   */
  private mapFileType(extension: string): "pdf" | "markdown" | "html" | "text" | "web" | "github" {
    switch (extension.toLowerCase()) {
      case "pdf":
        return "pdf";
      case "md":
      case "markdown":
        return "markdown";
      case "html":
      case "htm":
        return "html";
      case "txt":
        return "text";
      default:
        return "text";
    }
  }

  /**
   * Get the file path for storing topic documents metadata
   */
  private getTopicDocumentsPath(topicId: string): string {
    return path.join(this.getDatabaseDir(), `topic-${topicId}-documents.json`);
  }

  private getIngestionJournalPath(): string {
    return path.join(this.getDatabaseDir(), "ingestion-journal.json");
  }

  private getPostCommitCleanupJournalPath(): string {
    return path.join(this.getDatabaseDir(), "post-commit-cleanup-journal.json");
  }

  private async readPostCommitCleanupJournal(): Promise<PostCommitCleanupEntry[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.getPostCommitCleanupJournalPath(), "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw new Error("Post-commit cleanup journal is corrupt; refusing to expose potentially orphaned storage");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Post-commit cleanup journal is invalid; expected an array");
    }
    for (const entry of parsed) {
      if (
        !isRecord(entry) ||
        entry.version !== 1 ||
        typeof entry.id !== "string" ||
        typeof entry.topicId !== "string" ||
        !isFiniteNumber(entry.updatedAt) ||
        entry.kind !== "document"
      ) {
        throw new Error("Post-commit cleanup journal contains an invalid entry");
      }
      if (!Array.isArray(entry.documents) || typeof entry.legacyContainer !== "boolean") {
        throw new Error("Post-commit cleanup journal contains invalid cleanup details");
      }
    }
    return parsed as PostCommitCleanupEntry[];
  }

  private async upsertPostCommitCleanup(entry: PostCommitCleanupEntry): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = await this.readPostCommitCleanupJournal();
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      await atomicWriteJson(this.getPostCommitCleanupJournalPath(), entries);
    });
  }

  private async removePostCommitCleanup(id: string): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = (await this.readPostCommitCleanupJournal()).filter((entry) => entry.id !== id);
      await atomicWriteJson(this.getPostCommitCleanupJournalPath(), entries);
    });
  }

  private async completePostCommitCleanup(entry: PostCommitCleanupEntry): Promise<string[]> {
    if (!this.vectorStoreFactory) {
      throw new Error("Vector store is not initialized");
    }
    const removedChunkIds: string[] = [];
    for (const document of entry.documents) {
      removedChunkIds.push(...(await this.removeDocumentStorage(entry.topicId, document.id)));
    }
    if (entry.legacyContainer && entry.documents.length === 1 && removedChunkIds.length === 0) {
      for (const legacyLeafId of await this.legacyLeafIdsForContainer(entry.topicId, entry.documents[0])) {
        removedChunkIds.push(...(await this.removeDocumentStorage(entry.topicId, legacyLeafId)));
      }
    }
    const stats = await this.vectorStoreFactory.getStoredStats(entry.topicId);
    const existing = await this.vectorStoreFactory.getStoreMetadata(entry.topicId);
    await this.vectorStoreFactory.saveStore(entry.topicId, {
      ...existing,
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount,
    });
    return removedChunkIds;
  }

  private async recoverPostCommitCleanupJournal(): Promise<void> {
    const entries = await this.readPostCommitCleanupJournal();
    for (const entry of entries) {
      const documents = this.topicDocuments.get(entry.topicId);
      if (!this.topicsIndex?.topics[entry.topicId]) {
        await this.removePostCommitCleanup(entry.id);
        continue;
      }
      // If any selected document is still advertised, coordinator recovery
      // rolled metadata publication back. Physical rows remain live.
      if (entry.documents.some((document) => documents?.has(document.id))) {
        await this.removePostCommitCleanup(entry.id);
        continue;
      }
      await this.completePostCommitCleanup(entry);
      await this.removePostCommitCleanup(entry.id);
    }
  }

  private async readIngestionJournal(): Promise<IngestionJournalEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.getIngestionJournalPath(), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async upsertIngestionJournal(entry: IngestionJournalEntry): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = await this.readIngestionJournal();
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      await atomicWriteJson(this.getIngestionJournalPath(), entries);
    });
  }

  private async replaceIngestionTransaction(
    transactionId: string,
    replacement: IngestionJournalEntry[],
  ): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = (await this.readIngestionJournal()).filter(
        (entry) => (entry.transactionId ?? entry.id) !== transactionId,
      );
      entries.push(...replacement);
      await atomicWriteJson(this.getIngestionJournalPath(), entries);
    });
  }

  private async markAndRemoveCommittedIngestion(transactionId: string): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = await this.readIngestionJournal();
      const committedAt = Date.now();
      const marked = entries.map((entry) =>
        (entry.transactionId ?? entry.id) === transactionId
          ? { ...entry, stage: "metadataCommitted" as const, updatedAt: committedAt }
          : entry,
      );
      await atomicWriteJson(this.getIngestionJournalPath(), marked);
      await atomicWriteJson(
        this.getIngestionJournalPath(),
        marked.filter((entry) => (entry.transactionId ?? entry.id) !== transactionId),
      );
    });
  }

  private async recoverIngestionJournal(): Promise<void> {
    if (!this.vectorStoreFactory || !this.topicsIndex) {
      return;
    }
    await this.journalMutex.runExclusive(async () => {
      const pending = await this.readIngestionJournal();
      if (pending.length === 0) {
        return;
      }
      const touched = new Set<string>();
      const rowsByTopic = new Map<string, LangChainDocument[]>();
      const transactions = new Map<string, IngestionJournalEntry[]>();
      for (const entry of pending) {
        const transactionId = entry.transactionId ?? entry.id;
        const group = transactions.get(transactionId) ?? [];
        group.push(entry);
        transactions.set(transactionId, group);
      }

      for (const [transactionId, originalEntries] of transactions) {
        const starter = originalEntries.find((entry) => entry.stage === "started") ?? originalEntries[0];
        const topic = this.topicsIndex!.topics[starter.topicId];
        if (!topic) {
          continue;
        }

        let durableEntries = originalEntries.filter((entry) => entry.stage !== "started");
        if (durableEntries.length === 0) {
          let rows = rowsByTopic.get(starter.topicId);
          if (!rows) {
            rows = await this.vectorStoreFactory!.getAllDocuments(starter.topicId, 1_000_000);
            rowsByTopic.set(starter.topicId, rows);
          }
          const transactionRows = rows.filter(
            (row) => String(row.metadata.ingestionTransactionId ?? "") === transactionId,
          );
          let sourceDocuments = this.summarizePipelineChunks(transactionRows);
          if (sourceDocuments.length === 0) {
            // Backward compatibility for the pre-transaction journal.
            const legacyCount = await this.vectorStoreFactory!.getDocumentChunkCount(
              starter.topicId,
              starter.document.id,
            );
            if (legacyCount > 0) {
              sourceDocuments = [
                {
                  documentId: starter.document.id,
                  canonicalSource: starter.document.filePath,
                  sourceType: starter.document.fileType === "web" ? "web" : starter.document.fileType,
                  sourceRevision: starter.document.sourceRevision ?? "",
                  fileName: starter.document.name,
                  filePath: starter.document.filePath,
                  fileType: starter.document.fileType,
                  chunkCount: legacyCount,
                },
              ];
            }
          }
          if (sourceDocuments.length === 0) {
            // No durable vector row exists for this starter. Recovery rolls it
            // back by removing the journal record without publishing metadata.
            continue;
          }
          const leaves = this.createLeafTopicDocuments(starter.topicId, starter.document, sourceDocuments);
          const leafIds = leaves.map((document) => document.id);
          durableEntries = leaves.map((document) => ({
            id: `${transactionId}:${document.id}`,
            transactionId,
            containerId: starter.containerId ?? starter.document.id,
            topicId: starter.topicId,
            stage: "vectorCommitted",
            document,
            containerLeafIds: leafIds,
            updatedAt: Date.now(),
          }));
        }

        const documents = this.topicDocuments.get(starter.topicId) ?? new Map<string, TopicDocument>();
        const durableLeafIds = new Set<string>();
        for (const entry of durableEntries) {
          const chunkCount = await this.vectorStoreFactory!.getDocumentChunkCount(entry.topicId, entry.document.id);
          if (chunkCount === 0) {
            continue;
          }
          durableLeafIds.add(entry.document.id);
          documents.set(entry.document.id, { ...entry.document, chunkCount });
        }
        if (durableLeafIds.size === 0) {
          continue;
        }
        const containerId = starter.containerId ?? starter.document.containerId ?? starter.document.id;
        const declaredLeafIds = new Set(durableEntries.flatMap((entry) => entry.containerLeafIds ?? []));
        const desiredLeafIds = declaredLeafIds.size > 0 ? declaredLeafIds : durableLeafIds;
        const staleDocuments = [...documents.values()].filter(
          (document) =>
            (document.containerId === containerId || document.id === containerId) && !desiredLeafIds.has(document.id),
        );
        for (const staleDocument of staleDocuments) {
          await this.removeDocumentStorage(starter.topicId, staleDocument.id);
          documents.delete(staleDocument.id);
        }

        this.topicDocuments.set(starter.topicId, documents);
        topic.documentCount = documents.size;
        topic.updatedAt = Math.max(topic.updatedAt, ...durableEntries.map((entry) => entry.updatedAt));
        touched.add(starter.topicId);
      }
      for (const topicId of touched) {
        await this.saveTopicDocuments(topicId);
      }
      if (touched.size > 0) {
        this.topicsIndex!.lastUpdated = Date.now();
        await this.saveTopicsIndex();
      }
      // Every transaction was either completed from proven rows or rolled back
      // because no durable row existed. The metadata writes above must all
      // succeed before the journal is cleared.
      await atomicWriteJson(this.getIngestionJournalPath(), []);
    });
  }

  /**
   * Save document metadata for a topic to disk
   */
  private async saveTopicDocuments(topicId: string): Promise<void> {
    try {
      await this.assertStorageOwnership();
      const documents = this.topicDocuments.get(topicId);
      if (!documents) {
        return;
      }

      const documentsPath = this.getTopicDocumentsPath(topicId);
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
    const documentsPath = this.getTopicDocumentsPath(topicId);
    let data: string;
    try {
      data = await fs.readFile(documentsPath, "utf-8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
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

  private async listFilesRecursively(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to export symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursively(entryPath)));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
    return files;
  }

  private getTopicMutationMutex(topicId: string): Mutex {
    let mutex = this.topicMutationMutexes.get(topicId);
    if (!mutex) {
      mutex = new Mutex();
      this.topicMutationMutexes.set(topicId, mutex);
    }
    return mutex;
  }

  private async assertStorageOwnership(): Promise<void> {
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
   */
  private async runStorageWriteTransaction<T>(
    operation: (tx: { coordinator: StorageTransactionCoordinator; lease: StorageLockHandle }) => Promise<T>,
    options?: { waitMs?: number },
  ): Promise<T> {
    return this.storageMutationMutex.runExclusive(async () => {
      const lease = await acquireOperationLease(this.storageDir, { waitMs: options?.waitMs ?? 5_000 });
      const previousLease = this.activeLease;
      const previousCoordinator = this.activeCoordinator;
      this.activeLease = lease;
      try {
        const coordinator = new StorageTransactionCoordinator(this.getDatabaseDir(), lease);
        await coordinator.initialize();
        this.activeCoordinator = coordinator;
        // Write-side safety: another process may have written since our caches
        // were loaded, and the recovery above may just have rolled a torn
        // generation back. Reload the canonical files before deriving
        // next-state from them.
        await this.reloadCanonicalState();
        await this.recoverPostCommitCleanupJournal();
        await this.recoverIngestionJournal();
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
   * `ensureStorageFormatV2` unleased purely so it raises its own typed error —
   * it cannot write on those paths, and taking a lease first would let a
   * StorageBusyError mask the real diagnosis.
   */
  private async ensureStorageFormatMarker(): Promise<void> {
    const inspection = await inspectStorage(this.storageDir);
    if (inspection.status === "current") {
      return;
    }
    if (inspection.status !== "empty") {
      await ensureStorageFormatV2(this.storageDir);
      return;
    }
    await this.withOperationLease(async () => {
      // Re-check under the lease: another process may have stamped it while
      // we waited.
      await ensureStorageFormatV2(this.storageDir);
    });
  }

  /**
   * Read-only probe: has a previous run left anything to recover?
   *
   * Startup used to roll interrupted work back unconditionally, because it
   * held a session lock and a session coordinator anyway. Recovery writes, so
   * it now needs a lease — and a clean open must not take one. Probing keeps
   * the old guarantee (an interrupted write is repaired when the store is
   * opened, not deferred to whenever someone happens to write next) while a
   * healthy store still opens without touching the lock file.
   */
  private async hasPendingStorageRecovery(): Promise<boolean> {
    for (const journalPath of [this.getPostCommitCleanupJournalPath(), this.getIngestionJournalPath()]) {
      if (await this.pathExists(journalPath)) {
        return true;
      }
    }
    // A crashed transaction leaves its WAL, or an orphaned staging directory,
    // under the coordinator root.
    try {
      const staged = await fs.readdir(path.join(this.getDatabaseDir(), ".transactions"));
      return staged.length > 0;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async runManagedOperation<T>(operation: () => Promise<T>): Promise<T> {
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
