/**
 * Vector Store Factory - Creates and manages LanceDB vector stores
 * Embedded vector database with file-based persistence
 *
 * Architecture: LanceDB embedded database
 * - Truly embedded - no external server process needed
 * - File-based persistence (like SQLite)
 * - Cross-platform (Windows, macOS, Linux, ARM)
 * - No dependencies on external processes
 * - Serverless and lightweight
 *
 * LanceDB provides native JavaScript vector storage without
 * requiring any external services or processes
 */

import * as path from "path";
import * as fs from "fs/promises";
import { LanceDB } from "@langchain/community/vectorstores/lancedb";
import { connect } from "@lancedb/lancedb";
import { VectorStore } from "@langchain/core/vectorstores";
import { Embeddings } from "@langchain/core/embeddings";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { TransformersEmbeddings } from "../embeddings/langchainEmbeddings";
import { Logger } from "../utils/logger";

export interface VectorStoreConfig {
  topicId: string;
  storageDir: string;
}

export interface VectorStoreMetadata {
  topicId: string;
  documentCount: number;
  chunkCount: number;
  embeddingModel: string;
  createdAt: number;
  updatedAt: number;
}

export class VectorStoreFactory {
  private logger: Logger;
  private embeddings: Embeddings;
  private storageDir: string;
  private storeCache: Map<string, VectorStore> = new Map();
  private embeddingModel: string;
  private lanceDbUri: string;

  constructor(embeddings: Embeddings, storageDir: string, embeddingModel: string) {
    this.logger = new Logger("VectorStoreFactory");

    if (!embeddingModel) {
      throw new Error("Embedding model is required but was not provided to VectorStoreFactory");
    }

    this.embeddings = embeddings;
    this.storageDir = storageDir;
    this.embeddingModel = embeddingModel;
    this.lanceDbUri = path.join(storageDir, "lancedb");
    this.logger.info("VectorStoreFactory initialized", { storageDir, embeddingModel, lanceDbUri: this.lanceDbUri });
  }

  /**
   * Initialize the factory - creates LanceDB directory if needed
   */
  public async initialize(): Promise<void> {
    this.logger.info("Initializing vector store factory");

    try {
      // Ensure LanceDB directory exists
      await fs.mkdir(this.lanceDbUri, { recursive: true });

      // Test connection to LanceDB
      const db = await connect(this.lanceDbUri);
      const tables = await db.tableNames();

      this.logger.info("LanceDB ready", {
        uri: this.lanceDbUri,
        existingTables: tables.length
      });
    } catch (error) {
      this.logger.error("Failed to initialize LanceDB", error);
      throw new Error("LanceDB initialization failed. Please check disk permissions.");
    }
  }

  public getEmbeddingModel(): string {
    if (!this.embeddingModel) {
      throw new Error("Embedding model is not set in VectorStoreFactory");
    }
    return this.embeddingModel;
  }

  public async createStore(config: VectorStoreConfig, initialDocuments?: LangChainDocument[]): Promise<void> {
    this.logger.info("Creating vector store", { topicId: config.topicId, documentCount: initialDocuments?.length || 0 });

    try {
      // Connect to LanceDB
      const db = await connect(this.lanceDbUri);

      // Check if table exists and drop it to start fresh
      const tableNames = await db.tableNames();
      if (tableNames.includes(config.topicId)) {
        await db.dropTable(config.topicId);
        this.logger.debug("Dropped existing table", { topicId: config.topicId });
      }

      // If we have initial documents, create with them
      // Otherwise create an empty vector store that's ready for documents
      const docs = initialDocuments && initialDocuments.length > 0 ? initialDocuments : [];

      // Normalize metadata to ensure schema consistency
      const normalizedDocs = docs.length > 0 ? this.normalizeDocumentMetadata(docs) : docs;

      const store = await LanceDB.fromDocuments(
        normalizedDocs,
        this.createEmbeddings(this.embeddingModel),
        {
          uri: this.lanceDbUri,
          tableName: config.topicId
        }
      );

      this.storeCache.set(config.topicId, store);
      this.logger.info("Vector store created successfully", { topicId: config.topicId, hasInitialDocs: normalizedDocs.length > 0 });
    } catch (error) {
      this.logger.error("Failed to create vector store", { error: error instanceof Error ? error.message : String(error), config });
      throw error;
    }
  }

  public async loadStore(topicId: string, customStorageDir?: string): Promise<VectorStore | null> {
    this.logger.info("Loading vector store", { topicId, customStorageDir: customStorageDir || "default" });

    // Note: Verify cache key handling if same topic ID exists in both (though getVectorStore handles this)
    const cachedStore = this.storeCache.get(topicId);
    if (cachedStore) {
      this.logger.debug("Returning cached store", { topicId });
      return cachedStore;
    }

    try {
      // Determine URI
      const targetLanceDbUri = customStorageDir
        ? path.join(customStorageDir, "lancedb")
        : this.lanceDbUri;

      // Connect to LanceDB database
      const db = await connect(targetLanceDbUri);
      const tableNames = await db.tableNames();

      if (!tableNames.includes(topicId)) {
        this.logger.debug("Table not found", { topicId, uri: targetLanceDbUri });
        return null;
      }

      // Read metadata to know which model was used
      const metadata = await this.getStoreMetadata(topicId);
      // If we have metadata with a model, use it. Otherwise fall back to factory default.
      const modelToUse = metadata?.embeddingModel || this.embeddingModel;

      this.logger.debug("Loading vector store", {
        topicId,
        model: modelToUse
      });

      if (modelToUse !== this.embeddingModel) {
        this.logger.info("Switching embedding model for topic load", {
          topicId,
          configuredModel: this.embeddingModel,
          topicModel: modelToUse
        });
      }

      // Initialize with specific model for this topic
      const embeddings = this.createEmbeddings(modelToUse);

      // Open existing table
      const table = await db.openTable(topicId);

      // Create vector store from existing table (per LangChain docs)
      const store = new LanceDB(embeddings, { table });

      this.storeCache.set(topicId, store);
      this.logger.info("Vector store loaded successfully", { topicId });
      return store;
    } catch (error) {
      this.logger.error("Failed to load vector store", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
    }
  }

  public async getStoreMetadata(topicId: string): Promise<VectorStoreMetadata | null> {
    try {
      const metadataPath = this.getMetadataPath(topicId);
      try {
        await fs.access(metadataPath);
      } catch {
        return null;
      }
      const metadataJson = await fs.readFile(metadataPath, "utf-8");
      const metadata: VectorStoreMetadata = JSON.parse(metadataJson);
      return metadata;
    } catch (error) {
      this.logger.error("Failed to read store metadata", { error: error instanceof Error ? error.message : String(error), topicId });
      return null;
    }
  }

  public async validateEmbeddingModel(topicId: string): Promise<void> {
    const metadata = await this.getStoreMetadata(topicId);
    if (!metadata) {
      return;
    }
    if (metadata.embeddingModel && metadata.embeddingModel !== this.embeddingModel) {
      const error = new Error(
        `Embedding model mismatch for topic ${topicId}.\n` +
          `Existing embeddings use: "${metadata.embeddingModel}"\n` +
          `Current model is: "${this.embeddingModel}"\n\n` +
          `Cannot add documents with a different embedding model as this would corrupt the vector store.\n` +
          `Please either:\n` +
          `1. Change the embedding model back to "${metadata.embeddingModel}" in settings, or\n` +
          `2. Create a new topic with the current model, or\n` +
          `3. Delete and recreate this topic with the new model`
      );
      this.logger.error("Embedding model mismatch detected", { topicId, existingModel: metadata.embeddingModel, currentModel: this.embeddingModel });
      throw error;
    }
  }

  public async saveStore(topicId: string, metadata: Partial<VectorStoreMetadata>): Promise<void> {
    this.logger.info("Saving vector store metadata", { topicId });
    try {
      const metadataPath = this.getMetadataPath(topicId);
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      const fullMetadata: VectorStoreMetadata = {
        topicId,
        documentCount: metadata.documentCount || 0,
        chunkCount: metadata.chunkCount || 0,
        embeddingModel: metadata.embeddingModel || this.embeddingModel,
        createdAt: metadata.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await fs.writeFile(metadataPath, JSON.stringify(fullMetadata, null, 2), "utf-8");
      this.logger.info("Vector store metadata saved successfully", { topicId });
    } catch (error) {
      this.logger.error("Failed to save vector store metadata", { error: error instanceof Error ? error.message : String(error), topicId });
      throw error;
    }
  }

  public async deleteStore(topicId: string): Promise<void> {
    this.logger.info("Deleting vector store", { topicId });
    try {
      this.storeCache.delete(topicId);

      // Drop the LanceDB table if it exists
      const db = await connect(this.lanceDbUri);

      const tableNames = await db.tableNames();
      if (tableNames.includes(topicId)) {
        await db.dropTable(topicId);
        this.logger.info("LanceDB table dropped", { topicId });
      } else {
        this.logger.warn("LanceDB table not found (already deleted or missing)", { topicId });
      }

      // Delete metadata file
      const metadataPath = this.getMetadataPath(topicId);
      try {
        await fs.unlink(metadataPath);
        this.logger.debug("Metadata file deleted", { topicId });
      } catch {
        // Metadata file might not exist
        this.logger.debug("Metadata file not found (already deleted or missing)", { topicId });
      }
      this.logger.info("Vector store deleted successfully", { topicId });
    } catch (error) {
      this.logger.error("Failed to delete vector store", { error: error instanceof Error ? error.message : String(error), topicId });
      throw error;
    }
  }

  public async addDocuments(topicId: string, store: VectorStore, documents: LangChainDocument[]): Promise<void> {
    this.logger.info("Adding documents to vector store", { topicId, documentCount: documents.length });
    try {
      // Normalize metadata to prevent schema mismatches
      const normalizedDocuments = this.normalizeDocumentMetadata(documents);

      const BATCH_SIZE = 500;
      for (let i = 0; i < normalizedDocuments.length; i += BATCH_SIZE) {
        const batch = normalizedDocuments.slice(i, Math.min(i + BATCH_SIZE, normalizedDocuments.length));
        const progressPercent = Math.round(((i + batch.length) / normalizedDocuments.length) * 100);
        this.logger.info(`Adding document batch to vector store`, { topicId, batchStart: i, batchEnd: i + batch.length, totalDocuments: normalizedDocuments.length, progress: `${progressPercent}%` });
        await store.addDocuments(batch);
      }
      this.logger.info("Documents added successfully", { topicId, documentCount: normalizedDocuments.length });
    } catch (error) {
      this.logger.error("Failed to add documents", { error: error instanceof Error ? error.message : String(error), topicId, documentCount: documents.length });
      throw error;
    }
  }

  /**
   * Dispose of all resources and clean up
   * Clears cache and releases references
   * Note: LanceDB connections are stateless and don't need explicit closing
   */
  public dispose(): void {
    this.logger.info("Disposing VectorStoreFactory");

    // Clear all cached stores
    this.storeCache.clear();

    // Clear references
    this.embeddings = null as any;

    this.logger.info("VectorStoreFactory disposed");
  }

  /**
   * Normalize document metadata to ensure schema consistency across all documents
   * This prevents LanceDB schema mismatch errors when adding documents with different metadata
   */
  private normalizeDocumentMetadata(documents: LangChainDocument[]): LangChainDocument[] {
    return documents.map((doc) => {
      // Keep only essential, consistent metadata fields
      const allowedFields = [
        'source',
        'fileName',
        'filePath',
        'fileType',
        'fileSize',
        'loadedAt',
        'chunkIndex',
        'totalChunks',
        'loc',
        'isMarkdown',
        'preserveStructure'
      ];

      const normalizedMetadata: Record<string, any> = {};

      // Copy only allowed fields
      for (const field of allowedFields) {
        if (field in doc.metadata) {
          normalizedMetadata[field] = doc.metadata[field];
        }
      }

      // Convert loc object to simple fields if present (for compatibility)
      if (doc.metadata.loc && typeof doc.metadata.loc === 'object') {
        normalizedMetadata.loc_lines_from = doc.metadata.loc.lines?.from;
        normalizedMetadata.loc_lines_to = doc.metadata.loc.lines?.to;
        delete normalizedMetadata.loc; // Remove complex object
      }

      return new LangChainDocument({
        pageContent: doc.pageContent,
        metadata: normalizedMetadata,
      });
    });
  }

  private getMetadataPath(topicId: string): string {
    return path.join(this.storageDir, `vector-${topicId}-metadata.json`);
  }

  private createEmbeddings(modelName: string): TransformersEmbeddings {
    return new TransformersEmbeddings({ modelName });
  }
}
