/**
 * Topic Manager - Manages topic lifecycle and vector stores
 * Handles creation, deletion, updates, and document ingestion
 *
 * Architecture: Singleton pattern with integrated pipeline
 * Replaces manual topic management from vectorDatabase.ts
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { VectorStore } from "@langchain/core/vectorstores";
import { Topic, TopicsIndex, Document as TopicDocument } from "../utils/types";
import {
  DocumentPipeline,
  PipelineOptions,
  PipelineResult,
} from "./documentPipeline";
import { VectorStoreFactory } from "../stores/vectorStoreFactory";
import { EmbeddingService } from "../embeddings/embeddingService";
import { TransformersEmbeddings } from "../embeddings/langchainEmbeddings";
import { Logger } from "../utils/logger";
import { EXTENSION } from "../utils/constants";

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
 * Manages all topic operations and vector stores
 */
export class TopicManager {
  private static instance: TopicManager;
  private static initPromise: Promise<void> | null = null;

  // Callback registry for external components to register cleanup functions
  // This allows TopicManager to notify other components (like RAGTool) without creating circular dependencies
  private static agentCacheCleanupCallback: ((topicId: string) => void) | null = null;

  private context: vscode.ExtensionContext;
  private logger: Logger;
  private topicsIndex: TopicsIndex | null = null;
  private documentPipeline: DocumentPipeline;
  private vectorStoreFactory: VectorStoreFactory | null = null;
  private embeddingService: EmbeddingService;
  private isInitialized: boolean = false;

  // Cache for loaded vector stores
  private vectorStoreCache: Map<string, VectorStore> = new Map();

  // Cache for topic documents
  private topicDocuments: Map<string, Map<string, TopicDocument>> = new Map();

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.logger = new Logger("TopicManager");
    this.documentPipeline = new DocumentPipeline();
    this.embeddingService = EmbeddingService.getInstance();

    this.logger.info("TopicManager created");
  }

  public static async getInstance(
    context?: vscode.ExtensionContext
  ): Promise<TopicManager> {
    if (!TopicManager.instance) {
      if (!context) {
        throw new Error(
          "TopicManager not initialized. Context required for first call."
        );
      }
      TopicManager.instance = new TopicManager(context);
      // Automatically initialize on first getInstance call
      TopicManager.initPromise = TopicManager.instance.init();
    }

    // Wait for initialization to complete
    if (TopicManager.initPromise) {
      try {
        await TopicManager.initPromise;
      } catch (error) {
        // Clear instance on failure to allow retry
        TopicManager.instance = null as any;
        TopicManager.initPromise = null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`TopicManager initialization failed: ${errorMessage}`);
      } finally {
        TopicManager.initPromise = null;
      }
    }

    // Verify initialization succeeded
    if (!TopicManager.instance.isInitialized) {
      TopicManager.instance = null as any;
      throw new Error("TopicManager initialization failed - instance is not initialized");
    }

    return TopicManager.instance;
  }

  /**
   * Initialize the manager and load topics index
   */
  private async init(): Promise<void> {
    if (this.isInitialized) {
      this.logger.info("TopicManager already initialized, skipping");
      return;
    }

    this.logger.info("Initializing TopicManager");

    try {
      // Ensure storage directory exists
      await this.ensureStorageDirectory();

      // Ensure embedding service is initialized so we know the active model
      await this.embeddingService.initialize();

      // Load topics index (creates a new one if missing)
      await this.loadTopicsIndex();

      // Initialize document pipeline
      const storageDir = this.getDatabaseDir();
      await this.documentPipeline.initialize(storageDir);

      // Create LangChain-compatible embeddings wrapper
      const embeddings = new TransformersEmbeddings();

      this.vectorStoreFactory = new VectorStoreFactory(
        embeddings,
        storageDir,
        this.topicsIndex!.modelName
      );

      this.isInitialized = true;
      this.logger.info("TopicManager initialized successfully", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
        embeddingModel: this.topicsIndex?.modelName,
      });
    } catch (error) {
      this.logger.error("Failed to initialize TopicManager", {
        error: error instanceof Error ? error.message : String(error),
      });
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
        (t) => t.name.toLowerCase() === options.name.toLowerCase()
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

      // Remove from cache
      this.vectorStoreCache.delete(topicId);
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
   * Notify registered components to clear cached agents for a topic
   */
  private notifyAgentCacheCleanup(topicId: string): void {
    if (!TopicManager.agentCacheCleanupCallback) {
      return;
    }

    try {
      TopicManager.agentCacheCleanupCallback(topicId);
    } catch (error) {
      // Don't fail the caller if cache cleanup fails
      this.logger.debug("Agent cache cleanup callback failed", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update topic metadata
   */
  public async updateTopic(
    topicId: string,
    updates: Partial<Pick<Topic, "name" | "description">>
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
          (t) =>
            t.id !== topicId &&
            t.name.toLowerCase() === updates.name!.toLowerCase()
        );

        if (existingTopic) {
          throw new Error(`Topic with name "${updates.name}" already exists`);
        }
      }

      // Apply updates
      if (updates.name) topic.name = updates.name;
      if (updates.description !== undefined)
        topic.description = updates.description;
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
   * Get a topic by ID
   */
  public getTopic(topicId: string): Topic | null {
    if (!this.topicsIndex) {
      return null;
    }
    return this.topicsIndex.topics[topicId] || null;
  }

  /**
   * Get all topics
   */
  public getAllTopics(): Topic[] {
    if (!this.topicsIndex) {
      return [];
    }
    return Object.values(this.topicsIndex.topics);
  }

  /**
   * Get documents for a specific topic
   */
  public getTopicDocuments(topicId: string): TopicDocument[] {
    const documents = this.topicDocuments.get(topicId);
    if (!documents) {
      return [];
    }
    return Array.from(documents.values());
  }

  /**
   * Add documents to a topic
   */
  public async addDocuments(
    topicId: string,
    filePaths: string[],
    options?: PipelineOptions
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

      // Process each document
      for (const filePath of filePaths) {
        try {
          // Process document through pipeline
          const pipelineResult = await this.documentPipeline.processDocument(
            filePath,
            topicId,
            options
          );

          if (!pipelineResult.success) {
            this.logger.warn("Document processing failed", {
              filePath,
              errors: pipelineResult.errors,
            });
            continue;
          }

          // Create document metadata
          const fileName = path.basename(filePath);
          const fileExt = path.extname(filePath).substring(1);

          const document: TopicDocument = {
            id: this.generateDocumentId(),
            topicId,
            name: fileName,
            filePath,
            fileType: this.mapFileType(fileExt),
            addedAt: Date.now(),
            chunkCount: pipelineResult.metadata.chunksStored,
          };

          // Store document metadata
          if (!this.topicDocuments.has(topicId)) {
            this.topicDocuments.set(topicId, new Map());
          }
          this.topicDocuments.get(topicId)!.set(document.id, document);

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
          // Continue with other documents
        }
      }

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

  /**
   * Get vector store for a topic
   */
  public async getVectorStore(topicId: string): Promise<VectorStore | null> {
    this.logger.debug("Getting vector store", { topicId });

    try {
      if (!this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      const modelSwitched = await this.ensureEmbeddingModelCompatibility(topicId);

      // If model was switched, clear the cached store to force reload with new embeddings
      if (modelSwitched) {
        this.vectorStoreCache.delete(topicId);
        this.logger.debug("Cleared cached vector store after model switch", { topicId });
      }

      // Check cache first
      const cachedStore = this.vectorStoreCache.get(topicId);
      if (cachedStore) {
        this.logger.debug("Returning cached vector store", { topicId });
        return cachedStore;
      }

      // Load from disk
      const store = await this.vectorStoreFactory.loadStore(topicId);

      if (store) {
        this.vectorStoreCache.set(topicId, store);
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
   * Ensure embedding model compatibility by auto-switching to the topic's model if needed
   * Returns true if a model switch occurred, false otherwise
   */
  private async ensureEmbeddingModelCompatibility(topicId: string): Promise<boolean> {
    if (!this.vectorStoreFactory) {
      return false;
    }

    const metadata = await this.vectorStoreFactory.getStoreMetadata(topicId);
    if (!metadata?.embeddingModel) {
      return false;
    }

    const currentModel = this.embeddingService.getCurrentModel();
    if (metadata.embeddingModel === currentModel) {
      return false;
    }

    const topicName = this.topicsIndex?.topics[topicId]?.name ?? topicId;

    this.logger.info("Auto-switching embedding model for topic compatibility", {
      topicId,
      topicName,
      fromModel: currentModel,
      toModel: metadata.embeddingModel,
    });

    try {
      // Auto-switch to the topic's embedding model
      await this.embeddingService.initialize(metadata.embeddingModel);

      this.logger.info("Embedding model switched successfully", {
        topicId,
        topicName,
        model: metadata.embeddingModel,
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error("Failed to auto-switch embedding model", {
        topicId,
        topicName,
        targetModel: metadata.embeddingModel,
        error: errorMessage,
      });

      // Throw a clear error explaining what happened and how to fix it
      throw new Error(
        `Topic "${topicName}" requires embedding model "${metadata.embeddingModel}", ` +
        `but failed to load it: ${errorMessage}. ` +
        `Please ensure the model is available or recreate the topic with a different model.`
      );
    }
  }

  /**
   * Get the embedding model used by a topic's vector store
   * Returns null if topic doesn't exist or has no vector store metadata
   */
  public async getTopicEmbeddingModel(topicId: string): Promise<string | null> {
    this.logger.debug("Getting topic embedding model", { topicId });

    try {
      if (!this.vectorStoreFactory) {
        return null;
      }

      const metadata = await this.vectorStoreFactory.getStoreMetadata(topicId);
      return metadata?.embeddingModel || null;
    } catch (error) {
      this.logger.error("Failed to get topic embedding model", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      return null;
    }
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

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        return null;
      }

      // Get document count
      const documentCount = this.topicDocuments.get(topicId)?.size || 0;

      // Load vector store metadata
      const metadataPath = path.join(
        this.getDatabaseDir(),
        `vector-${topicId}-metadata.json`
      );

      let chunkCount = 0;
      let embeddingModel =
        this.embeddingService.getCurrentModel() ||
        this.topicsIndex?.modelName ||
        "unknown";

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
   * Register a callback function to be called when topics are deleted
   * This allows external components (like RAGTool) to clean up their caches
   * without creating circular dependencies
   */
  public static registerAgentCacheCleanupCallback(callback: (topicId: string) => void): void {
    TopicManager.agentCacheCleanupCallback = callback;
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
      const topicIds = this.topicsIndex
        ? Object.keys(this.topicsIndex.topics)
        : [];

      // 1. Dispose old factory first to release resources
      if (this.vectorStoreFactory) {
        this.vectorStoreFactory.dispose();
      }

      // 2. Clear local caches
      this.vectorStoreCache.clear();

      // 3. Notify external components to clear their caches
      for (const topicId of topicIds) {
        this.notifyAgentCacheCleanup(topicId);
      }

      // Reinitialize document pipeline with new model
      const storageDir = this.getDatabaseDir();
      await this.documentPipeline.initialize(storageDir);

      // Create new LangChain-compatible embeddings wrapper
      const embeddings = new TransformersEmbeddings();

      // Update topics index with new model
      const currentModel = this.embeddingService.getCurrentModel();

      if (this.topicsIndex) {
        this.topicsIndex.modelName = currentModel;
        this.topicsIndex.lastUpdated = Date.now();
        await this.saveTopicsIndex();

        this.vectorStoreFactory = new VectorStoreFactory(
          embeddings,
          storageDir,
          this.topicsIndex.modelName
        );
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

    // Clear references
    this.topicsIndex = null;
    this.isInitialized = false;

    // Clear static callback
    TopicManager.agentCacheCleanupCallback = null;

    this.logger.info("TopicManager disposed");
  }

  // ==================== Private Methods ====================

  /**
   * Get the database directory path
   */
  private getDatabaseDir(): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      EXTENSION.DATABASE_DIR
    );
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
    } catch (error) {
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
    } catch (error) {
      // File doesn't exist, create new index
      this.logger.info("Topics index not found, creating new one");

      // Embedding service is already initialized by init()
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
      await fs.writeFile(
        indexPath,
        JSON.stringify(this.topicsIndex, null, 2),
        "utf-8"
      );

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

  /**
   * Map file extension to document file type
   */
  private mapFileType(extension: string): "pdf" | "markdown" | "html" {
    switch (extension.toLowerCase()) {
      case "pdf":
        return "pdf";
      case "md":
      case "markdown":
        return "markdown";
      case "html":
      case "htm":
        return "html";
      default:
        return "markdown"; // Default fallback
    }
  }

  /**
   * Get the file path for storing topic documents metadata
   */
  private getTopicDocumentsPath(topicId: string): string {
    return path.join(this.getDatabaseDir(), `topic-${topicId}-documents.json`);
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

      await fs.writeFile(
        documentsPath,
        JSON.stringify(documentsArray, null, 2),
        "utf-8"
      );

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
    } catch (error) {
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
}
