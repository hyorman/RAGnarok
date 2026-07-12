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
import archiver from "archiver";
import AdmZip from "adm-zip";
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
import { DocumentPipeline, PipelineOptions, PipelineResult } from "./documentPipeline";
import { executeIndexingGraph } from "../agents/indexingGraph";
import { VectorStoreFactory } from "../stores/vectorStoreFactory";
import { KnowledgeGraphStore } from "../stores/knowledgeGraphStore";
import { KnowledgeGraph } from "../stores/knowledgeGraph";
import { EventEmitter } from "events";
import { EmbeddingService } from "../embeddings/embeddingService";
import { Logger } from "../logger";
import { EXTENSION, CONFIG } from "../constants";
import { atomicWriteJson, ensureStorageFormatV2, resetStorageToV2 } from "../utils/storageV2";
import { acquireStorageLock } from "../utils/storageLock";
import type { StorageLockHandle } from "../utils/storageLock";
import { createHash } from "crypto";
import { LanceDBCheckpointSaver } from "../stores/lanceDBCheckpointer";
import { Mutex } from "async-mutex";

/** Current export format version */
const EXPORT_FORMAT_VERSION = "2.0";

export interface TopicManagerOptions {
  storageDir: string;
  config: IConfigProvider;
  notifier: INotifier;
  embeddingService: EmbeddingService;
  /**
   * LLM provider for entity extraction during LangGraph indexing.
   * Optional — without it the graph pipeline skips extraction.
   */
  llmProvider?: ILLMProvider;
  /** Explicitly back up existing managed data and initialize storage format v2. */
  resetStorage?: boolean;
  checkpointer?: LanceDBCheckpointSaver;
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
  topicId: string;
  stage: "started" | "vectorCommitted";
  document: TopicDocument;
  updatedAt: number;
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
  private llmProvider: ILLMProvider | undefined;

  private logger: Logger;
  private topicsIndex: TopicsIndex | null = null;
  private documentPipeline: DocumentPipeline;
  private vectorStoreFactory: VectorStoreFactory | null = null;
  private knowledgeGraphStore: KnowledgeGraphStore | null = null;
  private isInitialized: boolean = false;

  // Cache for loaded vector stores
  private vectorStoreCache: Map<string, VectorStore> = new Map();

  // Cache for topic documents
  private topicDocuments: Map<string, Map<string, TopicDocument>> = new Map();

  // Common database support
  private commonTopicsIndex: TopicsIndex | null = null;
  private commonTopicDocuments: Map<string, Map<string, TopicDocument>> = new Map();
  private commonDatabasePath: string | null = null;
  private commonKnowledgeGraphStore: KnowledgeGraphStore | null = null;
  private journalMutex = new Mutex();
  private storageLock: StorageLockHandle | null = null;

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
    this.llmProvider = options.llmProvider;
    this.documentPipeline = new DocumentPipeline(this.notifier, this.embeddingService, this.config);

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
      // Cross-process single-writer guard: a second OS process on the same
      // storage dir would race whole-table rewrites the in-process
      // serializers cannot see. Fail fast naming the holder instead.
      this.storageLock = await acquireStorageLock(this.storageDir);

      if (this.options.resetStorage) {
        const backupPath = await resetStorageToV2(this.storageDir);
        this.logger.warn("Storage reset completed", { backupPath: backupPath ?? "empty storage" });
      } else {
        await ensureStorageFormatV2(this.storageDir);
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

      this.vectorStoreFactory = new VectorStoreFactory(storageDir, this.topicsIndex!.modelName, this.embeddingService);
      this.knowledgeGraphStore = new KnowledgeGraphStore(path.join(storageDir, "lancedb"));
      await this.recoverIngestionJournal();

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
      // Don't hold the lock hostage after a failed init (e.g., unversioned
      // storage rejected) — the user will retry with --reset-storage.
      if (this.storageLock) {
        const lock = this.storageLock;
        this.storageLock = null;
        await lock.release().catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Create a new topic
   */
  public async createTopic(options: CreateTopicOptions): Promise<Topic> {
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
      const topic: Topic = {
        id: this.generateTopicId(),
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

        await this.addDocuments(topic.id, options.initialDocuments);
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

      // Delete vector store
      await this.vectorStoreFactory.deleteStore(topicId);

      // Delete knowledge graph tables if they exist
      if (this.knowledgeGraphStore) {
        await this.knowledgeGraphStore.deleteGraph(topicId);
      }

      // Remove from cache
      this.invalidateVectorStoreCache(topicId);
      this.topicDocuments.delete(topicId);

      // Delete document metadata file
      try {
        const documentsPath = this.getTopicDocumentsPath(topicId);
        await fs.unlink(documentsPath);
      } catch {
        // File might not exist
      }

      // Remove from index
      delete this.topicsIndex.topics[topicId];
      this.topicsIndex.lastUpdated = Date.now();

      // Save index
      await this.saveTopicsIndex();

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
   * Get the knowledge graph store for persisting entity/edge tables
   */
  public getKnowledgeGraphStore(): KnowledgeGraphStore | null {
    return this.knowledgeGraphStore;
  }

  /**
   * Load the knowledge graph for a topic (returns null if none exists)
   */
  public async getKnowledgeGraph(topicId: string): Promise<KnowledgeGraph | null> {
    const graphStore = this.isCommonTopic(topicId) ? this.commonKnowledgeGraphStore : this.knowledgeGraphStore;
    if (!graphStore) {
      return null;
    }
    try {
      const hasGraph = await graphStore.hasGraph(topicId);
      if (!hasGraph) {
        return null;
      }
      const data = await graphStore.loadGraph(topicId);
      if (!data) {
        return null;
      }
      return KnowledgeGraph.fromJSON(data);
    } catch (error) {
      this.logger.warn("Failed to load knowledge graph", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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

    const topicSimilarities = await Promise.all(
      allTopics.map(async (topic) => {
        const topicEmbedding = await this.embeddingService.embed(topic.name);
        const similarity = this.embeddingService.cosineSimilarity(requestedEmbedding, topicEmbedding);
        return { topic, similarity };
      }),
    );

    topicSimilarities.sort((a, b) => b.similarity - a.similarity);
    const bestMatch = topicSimilarities[0];

    this.logger.debug(`Best matching topic: ${bestMatch.topic.name} (similarity: ${bestMatch.similarity.toFixed(3)})`);
    return { topic: bestMatch.topic, matchType: "similar", availableTopics: topicNames };
  }

  /**
   * Check if a topic is from the common database (read-only)
   */
  public isCommonTopic(topicId: string): boolean {
    return this.commonTopicsIndex?.topics[topicId] !== undefined;
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
    if (this.isCommonTopic(topicId)) {
      throw new Error("Common database topics are read-only");
    }
    if (!this.topicsIndex || !this.vectorStoreFactory) {
      throw new Error("TopicManager not initialized");
    }
    const documents = this.topicDocuments.get(topicId);
    const document = documents?.get(documentId);
    if (!document) {
      throw new Error(`Document not found: ${documentId}`);
    }
    const removedChunkIds = await this.vectorStoreFactory.removeDocument(topicId, documentId);
    if (this.knowledgeGraphStore && removedChunkIds.length > 0) {
      const graph = await this.getKnowledgeGraph(topicId);
      if (graph) {
        const removed = new Set(removedChunkIds);
        for (const relationship of graph.getAllRelationships()) {
          const sourceChunkIds = relationship.sourceChunkIds.filter((id) => !removed.has(id));
          if (sourceChunkIds.length === 0) {
            graph.removeRelationship(relationship.id);
          } else {
            graph.updateRelationship(relationship.id, { sourceChunkIds });
          }
        }
        for (const entity of graph.getAllEntities()) {
          const sourceChunkIds = entity.sourceChunkIds.filter((id) => !removed.has(id));
          if (sourceChunkIds.length === 0) {
            graph.removeEntity(entity.id);
          } else {
            graph.updateEntity(entity.id, { sourceChunkIds });
          }
        }
        await this.knowledgeGraphStore.saveGraph(topicId, graph.toJSON());
      }
    }
    documents!.delete(documentId);
    const topic = this.topicsIndex.topics[topicId];
    topic.documentCount = documents!.size;
    topic.updatedAt = Date.now();
    this.topicsIndex.lastUpdated = Date.now();
    await this.saveTopicDocuments(topicId);
    await this.saveTopicsIndex();
    const stats = await this.vectorStoreFactory.getStoredStats(topicId);
    const existing = await this.vectorStoreFactory.getStoreMetadata(topicId);
    await this.vectorStoreFactory.saveStore(topicId, {
      ...existing,
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount,
    });
    this.invalidateVectorStoreCache(topicId);
    this.notifyAgentCacheCleanup(topicId);
    return { document, chunksRemoved: removedChunkIds.length };
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
    this.logger.info("Adding documents to topic", {
      topicId,
      documentCount: filePaths.length,
    });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const results: AddDocumentResult[] = [];
      const useLangGraph = this.config.get<boolean>(CONFIG.LANGGRAPH_ENABLED, false);

      // Process each document
      for (const filePath of filePaths) {
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).substring(1);
        const source: DocumentSource =
          options?.loaderOptions?.fileType === "github"
            ? { type: "github", url: filePath, branch: options.loaderOptions.branch }
            : /^https?:\/\//i.test(filePath)
              ? { type: "url", url: filePath }
              : { type: "file", path: path.resolve(filePath) };
        const stableDocumentId = this.documentIdForSource(filePath, source.type === "url" ? "web" : source.type);
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
        };
        const journalId = `${topicId}:${stableDocumentId}`;
        await this.upsertIngestionJournal({
          id: journalId,
          topicId,
          stage: "started",
          document: plannedDocument,
          updatedAt: Date.now(),
        });
        try {
          // Process document through the LangGraph pipeline (single-pass
          // load/chunk/store with topic-graph extraction) or the legacy
          // pipeline, depending on the langGraphEnabled flag.
          const pipelineResult = useLangGraph
            ? await this.processDocumentViaGraph(filePath, topicId, options)
            : await this.documentPipeline.processDocument(filePath, topicId, options);

          if (!pipelineResult.success) {
            this.logger.warn("Document processing failed", {
              filePath,
              errors: pipelineResult.errors,
            });
            continue;
          }
          await this.reconcileKnowledgeGraphProvenance(topicId);

          const document: TopicDocument = {
            ...plannedDocument,
            id: String(pipelineResult.chunks[0]?.metadata.documentId ?? "") || stableDocumentId,
            chunkCount: pipelineResult.metadata.chunksStored,
          };
          await this.upsertIngestionJournal({
            id: journalId,
            topicId,
            stage: "vectorCommitted",
            document,
            updatedAt: Date.now(),
          });

          // Store document metadata
          if (!this.topicDocuments.has(topicId)) {
            this.topicDocuments.set(topicId, new Map());
          }
          this.topicDocuments.get(topicId)!.set(document.id, document);
          topic.documentCount = this.topicDocuments.get(topicId)!.size;
          topic.updatedAt = Date.now();
          this.topicsIndex.lastUpdated = Date.now();
          await this.saveTopicDocuments(topicId);
          await this.saveTopicsIndex();
          await this.removeIngestionJournal(journalId);

          results.push({
            topic,
            document,
            pipelineResult,
          });

          this.logger.info("Document added successfully", {
            topicId,
            documentId: document.id,
            fileName,
            chunkCount: document.chunkCount,
          });
        } catch (error) {
          this.logger.error("Failed to add document", {
            error: error instanceof Error ? error.message : String(error),
            filePath,
          });
          await this.removeIngestionJournal(journalId).catch(() => undefined);
          // Continue with other documents
        }
      }

      // Invalidate cached vector store so next read picks up new documents
      this.invalidateVectorStoreCache(topicId);
      this.notifyAgentCacheCleanup(topicId);

      // Update topic document count
      topic.documentCount = this.topicDocuments.get(topicId)?.size || 0;
      topic.updatedAt = Date.now();
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      // Persist document metadata to disk
      await this.saveTopicDocuments(topicId);

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

  public async addSources(
    topicId: string,
    sources: DocumentSource[],
    options?: PipelineOptions,
  ): Promise<AddDocumentResult[]> {
    const outcomes: AddDocumentResult[] = [];
    for (const source of sources) {
      const input = source.type === "file" ? source.path : source.url;
      const loaderOptions =
        source.type === "github"
          ? { fileType: "github" as const, branch: source.branch }
          : source.type === "url"
            ? { fileType: "web" as const }
            : options?.loaderOptions;
      outcomes.push(
        ...(await this.addDocuments(topicId, [input], {
          ...options,
          loaderOptions: { ...options?.loaderOptions, ...loaderOptions },
        })),
      );
    }
    return outcomes;
  }

  /**
   * Embed and persist already-chunked documents (store-only path).
   * Used by the LangGraph indexing pipeline, which owns loading/chunking.
   */
  public async storeProcessedChunks(topicId: string, chunks: LangChainDocument[]): Promise<void> {
    await this.documentPipeline.storeProcessedChunks(chunks, topicId);
    await this.reconcileKnowledgeGraphProvenance(topicId);
  }

  private async reconcileKnowledgeGraphProvenance(topicId: string): Promise<void> {
    if (!this.knowledgeGraphStore || !(await this.knowledgeGraphStore.hasGraph(topicId))) {
      return;
    }
    const graph = await this.getKnowledgeGraph(topicId);
    if (!graph) {
      return;
    }
    const liveChunks = new Set(
      (await this.getAllDocuments(topicId, 1_000_000)).map((document) => String(document.metadata.chunkId)),
    );
    let changed = false;
    for (const relationship of graph.getAllRelationships()) {
      const sourceChunkIds = relationship.sourceChunkIds.filter((id) => liveChunks.has(id));
      if (sourceChunkIds.length === 0) {
        graph.removeRelationship(relationship.id);
      } else if (sourceChunkIds.length !== relationship.sourceChunkIds.length) {
        graph.updateRelationship(relationship.id, { sourceChunkIds });
      }
      changed ||= sourceChunkIds.length !== relationship.sourceChunkIds.length;
    }
    for (const entity of graph.getAllEntities()) {
      const sourceChunkIds = entity.sourceChunkIds.filter((id) => liveChunks.has(id));
      if (sourceChunkIds.length === 0) {
        graph.removeEntity(entity.id);
      } else if (sourceChunkIds.length !== entity.sourceChunkIds.length) {
        graph.updateEntity(entity.id, { sourceChunkIds });
      }
      changed ||= sourceChunkIds.length !== entity.sourceChunkIds.length;
    }
    if (changed) {
      await this.knowledgeGraphStore.saveGraph(topicId, graph.toJSON());
    }
  }

  /**
   * Run one document through the LangGraph indexing pipeline and adapt the
   * graph result to the PipelineResult shape addDocuments() bookkeeping uses.
   */
  private async processDocumentViaGraph(
    filePath: string,
    topicId: string,
    options?: PipelineOptions,
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const checkpointRetentionMs = this.config.get<number>(CONFIG.CHECKPOINT_RETENTION_MS, 0);
    if (checkpointRetentionMs > 0) {
      await this.options.checkpointer?.deleteOlderThan(Date.now() - checkpointRetentionMs, "ingest:");
    }
    const threadId = `ingest:${topicId}:${createHash("sha256").update(this.documentIdForSource(filePath)).digest("hex")}`;
    const graphResult = await executeIndexingGraph(
      {
        topicManager: this,
        llmProvider: this.llmProvider,
        config: this.config,
        checkpointer: this.options.checkpointer,
        loaderOptions: { ...options?.loaderOptions, signal: options?.signal },
        signal: options?.signal,
      },
      [filePath],
      topicId,
      threadId,
    );

    const success = graphResult.success === true;
    if (success) {
      if (checkpointRetentionMs > 0) {
        this.options.checkpointer?.deleteThreadAfter(threadId, checkpointRetentionMs);
      } else {
        await this.options.checkpointer?.deleteThread(threadId);
      }
    }
    const documentCount = (graphResult.documentCount as number) ?? 0;
    const chunkCount = (graphResult.chunkCount as number) ?? 0;
    const entityCount = (graphResult.entityCount as number) ?? 0;
    const relationshipCount = (graphResult.relationshipCount as number) ?? 0;
    const errors = (graphResult.errors as string[] | undefined) ?? [];
    const warnings = (graphResult.warnings as Array<{ stage: string; message: string }> | undefined) ?? [];
    const completedStage = (graphResult.completedStage as string) ?? "";

    const stageReached = (stage: string): boolean => {
      const order = ["loaded", "chunked", "stored", "extracted", "entities_stored"];
      return order.indexOf(completedStage) >= order.indexOf(stage);
    };

    const totalTime = Date.now() - startTime;
    return {
      success,
      stages: {
        loading: stageReached("loaded"),
        chunking: stageReached("chunked"),
        extracting: stageReached("extracted"),
        embedding: stageReached("stored"),
        storing: stageReached("stored"),
      },
      metadata: {
        originalDocuments: documentCount,
        chunksCreated: chunkCount,
        chunksEmbedded: success ? chunkCount : 0,
        chunksStored: success ? chunkCount : 0,
        entitiesExtracted: entityCount,
        relationshipsExtracted: relationshipCount,
        totalTime,
        stageTimings: { loading: 0, chunking: 0, extracting: 0, embedding: 0, storing: 0 },
        graphExtracted: graphResult.graphExtracted === true,
        partial: graphResult.partial === true,
        documentId: this.documentIdForSource(filePath),
        warnings,
      },
      chunks: [],
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Get vector store for a topic
   */
  public async getVectorStore(topicId: string): Promise<VectorStore | null> {
    this.logger.debug("Getting vector store", { topicId });

    try {
      if (!this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      await this.ensureEmbeddingModelCompatibility(topicId);

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
    } catch (error) {
      this.logger.error("Failed to get vector store", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
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
    this.logger.info("Refreshing topics");
    await this.loadTopicsIndex();
  }

  /**
   * Reinitialize with the currently configured embedding model
   * Called when the embedding model configuration changes
   */
  public async reinitializeWithNewModel(): Promise<void> {
    this.logger.info("Reinitializing TopicManager with new embedding model");

    try {
      const topicIds = this.topicsIndex ? Object.keys(this.topicsIndex.topics) : [];
      const storageDir = this.getDatabaseDir();
      const currentModel = this.embeddingService.getCurrentModel();
      const replacementPipeline = new DocumentPipeline(this.notifier, this.embeddingService, this.config);
      await replacementPipeline.initialize(storageDir);
      const replacementFactory = new VectorStoreFactory(storageDir, currentModel, this.embeddingService);
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
  public dispose(): void {
    this.logger.info("Disposing TopicManager");

    // Clear all caches
    this.vectorStoreCache.clear();
    this.topicDocuments.clear();

    // Dispose of document pipeline
    if (this.documentPipeline) {
      this.documentPipeline.dispose();
    }

    // Dispose of vector store factory if it exists
    if (this.vectorStoreFactory) {
      this.vectorStoreFactory.dispose();
      this.vectorStoreFactory = null;
    }
    this.knowledgeGraphStore?.dispose();
    this.knowledgeGraphStore = null;
    this.commonKnowledgeGraphStore?.dispose();
    this.commonKnowledgeGraphStore = null;

    // Clear references
    this.topicsIndex = null;
    this.isInitialized = false;

    // Clear all agent cache cleanup listeners
    TopicManager._onAgentCacheCleanup.removeAllListeners();

    // dispose() is sync; the exit hook and heartbeat staleness back this up
    // if the async release never completes.
    if (this.storageLock) {
      const lock = this.storageLock;
      this.storageLock = null;
      void lock.release().catch(() => undefined);
    }

    this.logger.info("TopicManager disposed");
  }

  // ==================== Export/Import Methods ====================

  /**
   * Export a topic to a .rag archive file (ZIP format with DEFLATE compression)
   */
  public async exportTopic(topicId: string, exportPath: string): Promise<void> {
    this.logger.info("Exporting topic", { topicId, exportPath });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Only allow exporting local topics
      if (this.isCommonTopic(topicId)) {
        throw new Error("Cannot export topics from common database");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const documents = this.getTopicDocuments(topicId);
      const databaseDir = this.getDatabaseDir();

      // Create export metadata
      const exportData: ExportedTopicData = {
        version: EXPORT_FORMAT_VERSION,
        topic: { ...topic },
        documents,
        embeddingModel: this.topicsIndex.modelName,
        exportedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(exportPath), { recursive: true });

      // Create ZIP archive
      const output = fsSync.createWriteStream(exportPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      const archivePromise = new Promise<void>((resolve, reject) => {
        output.on("close", resolve);
        archive.on("error", reject);
      });

      archive.pipe(output);

      // Add topic metadata
      const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];
      const topicJson = Buffer.from(JSON.stringify(exportData, null, 2));
      archive.append(topicJson, { name: "topic.json" });
      manifestFiles.push({
        path: "topic.json",
        size: topicJson.byteLength,
        sha256: createHash("sha256").update(topicJson).digest("hex"),
      });

      // Add vector store files (LanceDB tables are directories with .lance extension)
      for (const tableName of [topicId, `kg-entities-${topicId}`, `kg-edges-${topicId}`]) {
        const lanceDbDir = path.join(databaseDir, "lancedb", `${tableName}.lance`);
        try {
          await fs.access(lanceDbDir);
          for (const filePath of await this.listFilesRecursively(lanceDbDir)) {
            const relative = path.relative(lanceDbDir, filePath).replace(/\\/g, "/");
            const archiveEntryPath = `lancedb/${tableName}.lance/${relative}`;
            const bytes = await fs.readFile(filePath);
            archive.append(bytes, { name: archiveEntryPath });
            manifestFiles.push({
              path: archiveEntryPath,
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
        } catch {
          this.logger.debug("No LanceDB directory found", { tableName, path: lanceDbDir });
        }
      }

      // Add vector metadata file
      const vectorMetadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);
      try {
        await fs.access(vectorMetadataPath);
        const bytes = await fs.readFile(vectorMetadataPath);
        const metadataName = `vector-${topicId}-metadata.json`;
        archive.append(bytes, { name: metadataName });
        manifestFiles.push({
          path: metadataName,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch {
        this.logger.debug("No vector metadata file found for topic", { topicId });
      }

      archive.append(JSON.stringify({ formatVersion: EXPORT_FORMAT_VERSION, files: manifestFiles }, null, 2), {
        name: "manifest.json",
      });

      await archive.finalize();
      await archivePromise;

      this.logger.info("Topic exported successfully", { topicId, exportPath });
    } catch (error) {
      this.logger.error("Failed to export topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Import a topic from a .rag archive file
   */
  public async importTopic(archivePath: string): Promise<Topic> {
    this.logger.info("Importing topic", { archivePath });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Use adm-zip for extraction
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();
      if (entries.length > 100_000) {
        throw new Error("Invalid archive: too many entries");
      }
      const uncompressedSize = entries.reduce((sum, entry) => sum + Number(entry.header.size || 0), 0);
      if (uncompressedSize > 2 * 1024 * 1024 * 1024) {
        throw new Error("Invalid archive: decompressed size exceeds 2 GiB");
      }
      for (const entry of entries) {
        const normalized = entry.entryName.replace(/\\/g, "/");
        if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
          throw new Error(`Invalid archive path: ${entry.entryName}`);
        }
      }
      const manifestEntry = entries.find((entry) => entry.entryName === "manifest.json");
      if (!manifestEntry) {
        throw new Error("Invalid archive: manifest.json not found");
      }
      const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
      if (manifest.formatVersion !== EXPORT_FORMAT_VERSION || !Array.isArray(manifest.files)) {
        throw new Error("Invalid archive manifest");
      }
      const entriesByName = new Map(entries.map((entry) => [entry.entryName, entry]));
      for (const expected of manifest.files) {
        const entry = entriesByName.get(expected.path);
        if (!entry || entry.isDirectory) {
          throw new Error(`Archive checksum entry missing: ${expected.path}`);
        }
        const bytes = entry.getData();
        if (
          bytes.byteLength !== expected.size ||
          createHash("sha256").update(bytes).digest("hex") !== expected.sha256
        ) {
          throw new Error(`Archive checksum mismatch: ${expected.path}`);
        }
      }

      // Find and parse topic.json
      const topicEntry = entries.find((e: AdmZip.IZipEntry) => e.entryName === "topic.json");
      if (!topicEntry) {
        throw new Error("Invalid archive: topic.json not found");
      }

      const exportData: ExportedTopicData = JSON.parse(topicEntry.getData().toString("utf8"));
      if (exportData.version !== EXPORT_FORMAT_VERSION) {
        throw new Error(`Unsupported .rag format ${exportData.version}; expected ${EXPORT_FORMAT_VERSION}`);
      }

      // Log if embedding model differs - actual compatibility check happens at query time
      const currentModel = this.embeddingService.getCurrentModel();
      if (exportData.embeddingModel !== currentModel) {
        this.logger.warn("Imported topic uses different embedding model", {
          importedModel: exportData.embeddingModel,
          currentModel,
          note: "Switch to the imported model before querying this topic",
        });
      }

      // Generate new topic ID to avoid conflicts
      const newTopicId = this.generateTopicId();
      const originalTopicId = exportData.topic.id;

      // Create new topic with imported data
      const newTopic: Topic = {
        ...exportData.topic,
        id: newTopicId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: "local",
      };

      // Check for name conflicts
      const existingTopic = Object.values(this.topicsIndex.topics).find(
        (t) => t.name.toLowerCase() === newTopic.name.toLowerCase(),
      );
      if (existingTopic) {
        newTopic.name = `${newTopic.name} (imported)`;
      }

      // Extract LanceDB files with new topic ID
      const databaseDir = this.getDatabaseDir();

      const tableMappings = [
        { oldName: originalTopicId, newName: newTopicId },
        { oldName: `kg-entities-${originalTopicId}`, newName: `kg-entities-${newTopicId}` },
        { oldName: `kg-edges-${originalTopicId}`, newName: `kg-edges-${newTopicId}` },
      ];
      for (const mapping of tableMappings) {
        const prefix = `lancedb/${mapping.oldName}.lance/`;
        const matching = entries.filter((entry) => !entry.isDirectory && entry.entryName.startsWith(prefix));
        if (matching.length === 0) {
          continue;
        }
        const targetDir = path.join(databaseDir, "lancedb", `${mapping.newName}.lance`);
        await fs.mkdir(targetDir, { recursive: true });
        for (const entry of matching) {
          const relativePath = entry.entryName.slice(prefix.length);
          const targetPath = path.resolve(targetDir, relativePath);
          if (!targetPath.startsWith(path.resolve(targetDir) + path.sep)) {
            throw new Error("Archive path traversal");
          }
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, entry.getData());
        }
      }

      // Extract and update vector metadata
      const vectorMetadataEntry = entries.find(
        (e: AdmZip.IZipEntry) => e.entryName === `vector-${originalTopicId}-metadata.json`,
      );
      if (vectorMetadataEntry) {
        const metadata = JSON.parse(vectorMetadataEntry.getData().toString("utf8"));
        metadata.topicId = newTopicId;
        const newMetadataPath = path.join(databaseDir, `vector-${newTopicId}-metadata.json`);
        await atomicWriteJson(newMetadataPath, metadata);
      }

      // Update document IDs and topic references
      const newDocuments = exportData.documents.map((doc) => ({
        ...doc,
        topicId: newTopicId,
      }));

      // Save to index
      this.topicsIndex.topics[newTopicId] = newTopic;
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      // Save documents
      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of newDocuments) {
        documentsMap.set(doc.id, doc);
      }
      this.topicDocuments.set(newTopicId, documentsMap);
      await this.saveTopicDocuments(newTopicId);

      this.logger.info("Topic imported successfully", {
        originalId: originalTopicId,
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
    }
  }

  /**
   * Load topics from common database path (read-only)
   */
  public async loadCommonDatabase(): Promise<void> {
    const commonPath = this.config.get<string>(CONFIG.COMMON_DATABASE_PATH, "");

    if (!commonPath) {
      this.logger.debug("No common database path configured");
      this.commonTopicsIndex = null;
      this.commonTopicDocuments.clear();
      this.commonDatabasePath = null;
      this.commonKnowledgeGraphStore?.dispose();
      this.commonKnowledgeGraphStore = null;
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
      this.commonKnowledgeGraphStore?.dispose();
      this.commonKnowledgeGraphStore = new KnowledgeGraphStore(path.join(commonDatabaseDir, "lancedb"));

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
      this.commonTopicsIndex = JSON.parse(data);

      this.logger.info("Common database loaded", {
        path: commonPath,
        topicCount: Object.keys(this.commonTopicsIndex?.topics || {}).length,
      });

      // Load document metadata for each common topic
      if (this.commonTopicsIndex) {
        // Check for name conflicts with local topics BEFORE fully loading
        const localTopicNames = new Set(Object.values(this.topicsIndex?.topics || {}).map((t) => t.name.toLowerCase()));

        const conflicts: string[] = [];

        for (const topic of Object.values(this.commonTopicsIndex.topics)) {
          if (localTopicNames.has(topic.name.toLowerCase())) {
            conflicts.push(topic.name);
          }
        }

        if (conflicts.length > 0) {
          const conflictList = conflicts.slice(0, 3).join(", ") + (conflicts.length > 3 ? "..." : "");
          const message = `Cannot load common database due to name conflicts. Local topics [${conflictList}] already exist. Please rename your local topics first.`;

          this.logger.warn("Common database load aborted due to name conflicts", { conflicts });
          this.notifier.showError(message);

          // Abort loading
          this.commonTopicsIndex = null;
          this.commonTopicDocuments.clear();
          this.commonDatabasePath = null;
          this.commonKnowledgeGraphStore?.dispose();
          this.commonKnowledgeGraphStore = null;
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
      this.commonKnowledgeGraphStore?.dispose();
      this.commonKnowledgeGraphStore = null;
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
    try {
      const indexPath = this.getTopicsIndexPath();
      const data = await fs.readFile(indexPath, "utf-8");
      this.topicsIndex = JSON.parse(data);

      this.logger.info("Topics index loaded", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
      });

      // Load document metadata for each topic
      await this.loadAllTopicDocuments();
    } catch (_error) {
      // File doesn't exist, create new index
      this.logger.info("Topics index not found, creating new one");

      // Embedding service is already initialized by loadTopics()
      this.topicsIndex = {
        topics: {},
        modelName: this.embeddingService.getCurrentModel(),
        lastUpdated: Date.now(),
      };

      await this.saveTopicsIndex();
    }
  }

  /**
   * Save topics index to file
   */
  private async saveTopicsIndex(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    try {
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

  private async removeIngestionJournal(id: string): Promise<void> {
    await this.journalMutex.runExclusive(async () => {
      const entries = (await this.readIngestionJournal()).filter((entry) => entry.id !== id);
      await atomicWriteJson(this.getIngestionJournalPath(), entries);
    });
  }

  private async recoverIngestionJournal(): Promise<void> {
    if (!this.vectorStoreFactory || !this.topicsIndex) {
      return;
    }
    await this.journalMutex.runExclusive(async () => {
      const pending = await this.readIngestionJournal();
      const remaining: IngestionJournalEntry[] = [];
      const touched = new Set<string>();
      for (const entry of pending) {
        const topic = this.topicsIndex!.topics[entry.topicId];
        if (!topic) {
          continue;
        }
        const chunkCount = await this.vectorStoreFactory!.getDocumentChunkCount(entry.topicId, entry.document.id);
        if (chunkCount === 0) {
          // No vector commit occurred; the started operation is safe to discard.
          continue;
        }
        const documents = this.topicDocuments.get(entry.topicId) ?? new Map<string, TopicDocument>();
        documents.set(entry.document.id, { ...entry.document, chunkCount });
        this.topicDocuments.set(entry.topicId, documents);
        topic.documentCount = documents.size;
        topic.updatedAt = Math.max(topic.updatedAt, entry.updatedAt);
        touched.add(entry.topicId);
      }
      for (const topicId of touched) {
        await this.saveTopicDocuments(topicId);
      }
      if (touched.size > 0) {
        this.topicsIndex!.lastUpdated = Date.now();
        await this.saveTopicsIndex();
      }
      await atomicWriteJson(this.getIngestionJournalPath(), remaining);
    });
  }

  /**
   * Save document metadata for a topic to disk
   */
  private async saveTopicDocuments(topicId: string): Promise<void> {
    try {
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
  private async loadTopicDocuments(topicId: string): Promise<void> {
    try {
      const documentsPath = this.getTopicDocumentsPath(topicId);
      const data = await fs.readFile(documentsPath, "utf-8");
      const documentsArray: TopicDocument[] = JSON.parse(data);

      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of documentsArray) {
        documentsMap.set(doc.id, doc);
      }

      this.topicDocuments.set(topicId, documentsMap);

      this.logger.debug("Topic documents loaded", {
        topicId,
        documentCount: documentsArray.length,
      });
    } catch (_error) {
      // File might not exist for older topics
      this.logger.debug("No document metadata found for topic", { topicId });
      this.topicDocuments.set(topicId, new Map());
    }
  }

  /**
   * Load document metadata for all topics
   */
  private async loadAllTopicDocuments(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    const topicIds = Object.keys(this.topicsIndex.topics);
    this.logger.debug("Loading documents for all topics", {
      topicCount: topicIds.length,
    });

    for (const topicId of topicIds) {
      await this.loadTopicDocuments(topicId);
    }
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
}
