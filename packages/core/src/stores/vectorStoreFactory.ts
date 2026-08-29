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
import type { Connection, Table } from "@lancedb/lancedb";
import { Bool, Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from "apache-arrow";
import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { TransformersEmbeddings } from "../embeddings/langchainEmbeddings";
import { EmbeddingService } from "../embeddings/embeddingService";
import { hasRemoteEndpoint, type EmbeddingServiceRegistry } from "../embeddings/embeddingServiceRegistry";
import { Logger } from "../logger";
import {
  adoptLegacyVectorStoreMetadata,
  atomicWriteJson,
  STORAGE_FORMAT_VERSION,
  type LegacyVectorStoreMetadata,
} from "../utils/storageV2";
import type { EmbeddingFingerprint } from "../embeddings/embeddingBackend";

export interface VectorStoreConfig {
  topicId: string;
  storageDir: string;
}

export interface VectorStoreMetadata {
  schemaVersion: typeof STORAGE_FORMAT_VERSION;
  topicId: string;
  documentCount: number;
  chunkCount: number;
  embeddingModel: string;
  /** Backend type used to create these embeddings (may be absent for legacy data). */
  embeddingBackend?: string;
  embeddingFingerprint?: EmbeddingFingerprint;
  /**
   * Legacy vectors whose complete semantic-space identity could not be
   * reconstructed during migration. Reads remain available for recovery, but
   * every vector mutation must be refused until the topic is fully reindexed.
   */
  migrationRequiresFingerprintOnReindex?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class EmbeddingReindexRequiredError extends Error {
  constructor(public readonly topicId: string) {
    super(
      `Topic ${topicId} contains migrated vectors without a verifiable embedding fingerprint. ` +
        "Reindex the complete topic (or delete and recreate it) before adding or replacing documents.",
    );
    this.name = "EmbeddingReindexRequiredError";
  }
}

export class VectorStoreMetadataCorruptionError extends Error {
  constructor(
    public readonly topicId: string,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Vector-store metadata for topic ${topicId} is ${reason}. ` +
        "Refusing to mutate the existing table because its embedding space cannot be verified.",
    );
    this.name = "VectorStoreMetadataCorruptionError";
  }
}

export class EmbeddingFingerprintMismatchError extends Error {
  constructor(
    public readonly topicId: string,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingFingerprintMismatchError";
  }
}

/**
 * A topic was indexed against a different embedding endpoint than the one this
 * deployment is configured with.
 *
 * Unlike the model — which IS resolved per topic — the endpoint is never
 * resolved per topic: it carries credentials and is a deployment-level setting,
 * so a topic must never be able to make the server authenticate somewhere of
 * the topic's choosing. A foreign endpoint is therefore refused rather than
 * honoured, because an endpoint serving a different model under the same name
 * would silently return vectors from another semantic space.
 */
export class EmbeddingEndpointMismatchError extends Error {
  constructor(
    public readonly topicId: string,
    /** endpointHash recorded in the topic's metadata. */
    public readonly expected: string,
    /** endpointHash of the endpoint this deployment is configured with. */
    public readonly actual: string,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingEndpointMismatchError";
  }
}

export class VectorStoreFactory {
  private logger: Logger;
  private storageDir: string;
  private storeCache: Map<string, VectorStore> = new Map();
  private static readonly MAX_CACHE_SIZE = 50;
  private embeddingModel: string;
  private lanceDbUri: string;
  private metadataDropWarningShown = false;
  private endpointHashCache?: Promise<string>;
  private embeddingService: EmbeddingService;
  private connections = new Map<string, Connection>();
  private tables = new Set<Table>();

  constructor(
    storageDir: string,
    embeddingModel: string,
    embeddingService: EmbeddingService,
    private readonly registry: EmbeddingServiceRegistry,
  ) {
    this.logger = new Logger("VectorStoreFactory");

    if (!embeddingModel) {
      throw new Error("Embedding model is required but was not provided to VectorStoreFactory");
    }

    this.storageDir = storageDir;
    this.embeddingModel = embeddingModel;
    this.embeddingService = embeddingService;
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
      const db = await this.getConnection(this.lanceDbUri);
      const tables = await db.tableNames();

      this.logger.info("LanceDB ready", {
        uri: this.lanceDbUri,
        existingTables: tables.length,
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

  public async createStore(
    config: VectorStoreConfig,
    initialDocuments?: LangChainDocument[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.logger.info("Creating vector store", {
      topicId: config.topicId,
      documentCount: initialDocuments?.length || 0,
    });

    try {
      // Connect to LanceDB
      const db = await this.getConnection(this.lanceDbUri);
      signal?.throwIfAborted();

      // Check if table exists and drop it to start fresh
      const tableNames = await db.tableNames();
      signal?.throwIfAborted();
      if (tableNames.includes(config.topicId)) {
        await db.dropTable(config.topicId);
        signal?.throwIfAborted();
        this.logger.debug("Dropped existing table", { topicId: config.topicId });
      }

      const docs = initialDocuments && initialDocuments.length > 0 ? initialDocuments : [];
      const normalizedDocs = docs.length > 0 ? this.normalizeDocumentMetadata(docs) : docs;
      signal?.throwIfAborted();
      const fingerprint = await this.embeddingService.getFingerprint(signal);
      const table = await db.createEmptyTable(config.topicId, this.createDocumentSchema(fingerprint.dimension));
      signal?.throwIfAborted();
      this.tables.add(table);
      // The backend must come from the same fingerprint that is about to be
      // stamped into metadata, not be defaulted: `embeddingModel` may carry a
      // backend prefix ("vscodeLM:<id>"), which only the backend that produced
      // it knows how to strip. Pairing it with a defaulted "huggingface" would
      // hand HuggingFace a model it cannot load, and this is also what makes
      // createStore and loadStore resolve the same registry entry.
      const store = new LanceDB(await this.createEmbeddings(this.embeddingModel, fingerprint.backendKind), { table });
      // A freshly-created table is the only case where missing metadata is
      // expected. Establish its semantic-space identity before the first
      // vector write so every public mutation path can fail closed.
      await this.writeStoreMetadata(config.topicId, {
        schemaVersion: STORAGE_FORMAT_VERSION,
        topicId: config.topicId,
        documentCount: 0,
        chunkCount: 0,
        embeddingModel: this.embeddingModel,
        embeddingBackend: fingerprint.backendKind,
        embeddingFingerprint: fingerprint,
        migrationRequiresFingerprintOnReindex: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (normalizedDocs.length > 0) {
        await this.reconcileDocuments(config.topicId, normalizedDocs, signal);
      }
      signal?.throwIfAborted();

      if (this.storeCache.size >= VectorStoreFactory.MAX_CACHE_SIZE) {
        const firstKey = this.storeCache.keys().next().value;
        if (firstKey) {
          this.storeCache.delete(firstKey);
        }
      }
      this.storeCache.set(`${this.lanceDbUri}::${config.topicId}`, store);
      this.logger.info("Vector store created successfully", {
        topicId: config.topicId,
        hasInitialDocs: normalizedDocs.length > 0,
      });
    } catch (error) {
      this.logger.error("Failed to create vector store", {
        error: error instanceof Error ? error.message : String(error),
        config,
      });
      throw error;
    }
  }

  public async loadStore(topicId: string, customStorageDir?: string): Promise<VectorStore | null> {
    this.logger.info("Loading vector store", { topicId, customStorageDir: customStorageDir || "default" });

    const targetLanceDbUri = customStorageDir ? path.join(customStorageDir, "lancedb") : this.lanceDbUri;
    const cacheKey = `${targetLanceDbUri}::${topicId}`;
    const cachedStore = this.storeCache.get(cacheKey);
    if (cachedStore) {
      this.logger.debug("Returning cached store", { topicId });
      return cachedStore;
    }

    try {
      // Connect to LanceDB database
      const db = await this.getConnection(targetLanceDbUri);
      const tableNames = await db.tableNames();

      if (!tableNames.includes(topicId)) {
        this.logger.debug("Table not found", { topicId, uri: targetLanceDbUri });
        return null;
      }

      // Read metadata to know which model was used
      const metadata = await this.getStoreMetadata(topicId, customStorageDir);

      if (!metadata) {
        this.logger.warn("Vector store metadata missing — cannot verify embedding model compatibility", {
          topicId,
          usingModel: this.embeddingModel,
        });
      }

      // If we have metadata with a model, use it. Otherwise fall back to factory default.
      const modelToUse = metadata?.embeddingModel || this.embeddingModel;
      const backendToUse = metadata?.embeddingBackend || "";

      this.logger.debug("Loading vector store", {
        topicId,
        model: modelToUse,
        backend: backendToUse,
      });

      if (metadata && metadata.embeddingModel && metadata.embeddingModel !== this.embeddingModel) {
        this.logger.warn("Embedding model mismatch detected", {
          topicId,
          storedModel: metadata.embeddingModel,
          storedBackend: backendToUse,
          currentModel: this.embeddingModel,
        });
      }

      // The model is resolved per topic; the ENDPOINT never is. Refuse before
      // createEmbeddings so a doomed topic cannot first register a registry
      // service — and open a connection — against an endpoint it may not use.
      if (hasRemoteEndpoint(backendToUse)) {
        const recorded = metadata?.embeddingFingerprint?.endpointHash;
        const configured = await this.configuredEndpointHash();
        if (recorded && recorded !== configured) {
          throw new EmbeddingEndpointMismatchError(
            topicId,
            recorded,
            configured,
            `Topic ${topicId} was indexed against a different embedding endpoint ` +
              `(recorded ${recorded}, configured ${configured}). An endpoint carries credentials and ` +
              `is never chosen by a topic, so this topic cannot be served here. Configure the ` +
              `endpoint it was built against, or rebuild the topic.`,
          );
        }
      }

      // Initialize with specific model and backend for this topic
      const embeddings = await this.createEmbeddings(modelToUse, backendToUse);

      // Open existing table
      const table = await db.openTable(topicId);
      this.tables.add(table);

      // Create vector store from existing table (per LangChain docs)
      const store = new LanceDB(embeddings, { table });

      if (this.storeCache.size >= VectorStoreFactory.MAX_CACHE_SIZE) {
        const firstKey = this.storeCache.keys().next().value;
        if (firstKey) {
          this.storeCache.delete(firstKey);
        }
      }
      this.storeCache.set(cacheKey, store);
      this.logger.info("Vector store loaded successfully", { topicId });
      return store;
    } catch (error) {
      // A refusal must ESCAPE this catch-all. Swallowed, it returns null, which
      // is indistinguishable from an empty topic on the read path — and on the
      // ingestion path documentPipeline treats null as "no store yet" and calls
      // createStore, which DROPS the existing table and re-embeds it against
      // this deployment's endpoint. The silent loss this check exists to
      // prevent would then be caused by the check itself.
      if (error instanceof EmbeddingEndpointMismatchError) {
        throw error;
      }
      this.logger.error("Failed to load vector store", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  public async getStoreMetadata(topicId: string, customStorageDir?: string): Promise<VectorStoreMetadata | null> {
    const metadataPath = this.getMetadataPath(topicId, customStorageDir);
    try {
      const metadataJson = await fs.readFile(metadataPath, "utf-8");
      const metadata = JSON.parse(metadataJson) as unknown;
      if (this.isVectorStoreMetadata(metadata, topicId)) {
        return metadata;
      }
      // A pre-v2 file is old, not damaged. Adopting it in memory recovers the
      // topic for reading without re-embedding anything; the adoption marks the
      // embedding space unverifiable, so extension still fails closed below.
      const adopted = this.adoptIfLegacyMetadata(metadata, topicId);
      if (adopted) {
        this.logger.info("Adopted pre-v2 vector store metadata", { topicId, embeddingModel: adopted.embeddingModel });
        return adopted;
      }
      throw new VectorStoreMetadataCorruptionError(topicId, "malformed or incomplete");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      const integrityError =
        error instanceof VectorStoreMetadataCorruptionError
          ? error
          : new VectorStoreMetadataCorruptionError(topicId, "unreadable or malformed", error);
      this.logger.error("Failed to read store metadata", {
        error: integrityError.message,
        topicId,
      });
      throw integrityError;
    }
  }

  /**
   * Refuses a mutation whose target vectors cannot be safely extended.
   *
   * A differing model NAME is no longer a refusal. The topic is now read AND
   * written with the model its own metadata records, so "the configured model
   * is called something else" is ordinary configuration drift rather than
   * corruption — refusing it would forbid a perfectly consistent topic.
   *
   * What survives are the two conditions no per-topic routing can reconcile:
   *  - the topic's own model no longer produces the DIMENSION its table holds,
   *    which no amount of correct routing can make compatible;
   *  - migrated vectors carrying no verifiable fingerprint, whose embedding
   *    space is simply unknown.
   */
  public async validateEmbeddingModel(topicId: string): Promise<void> {
    const metadata = await this.getStoreMetadata(topicId);
    if (!metadata) {
      return;
    }
    let verified = metadata;
    if (metadata.migrationRequiresFingerprintOnReindex || !metadata.embeddingFingerprint) {
      const migrationBackend = metadata.embeddingBackend ?? "";
      if (hasRemoteEndpoint(migrationBackend)) {
        const recordedHash = metadata.embeddingFingerprint?.endpointHash;
        if (recordedHash && recordedHash !== (await this.configuredEndpointHash())) {
          return; // foreign endpoint: loadStore's refusal handles it; never resolve here
        }
      }
      verified = await this.adoptFingerprintForMigratedTopic(topicId, metadata);
    }
    const recorded = verified.embeddingFingerprint;
    if (!recorded) {
      // Unreachable — adoptFingerprintForMigratedTopic always returns
      // metadata carrying a fingerprint, or throws — but the space stays
      // unverifiable either way.
      throw new EmbeddingReindexRequiredError(topicId);
    }

    const backend = verified.embeddingBackend ?? "";
    if (hasRemoteEndpoint(backend) && recorded.endpointHash !== (await this.configuredEndpointHash())) {
      // A foreign endpoint is loadStore's refusal to raise, one step later.
      // Resolving the topic's service here would first register it — and open a
      // connection — against an endpoint this topic may not be served from.
      return;
    }

    const model = verified.embeddingModel || this.embeddingModel;
    const current = await (await this.resolveEmbeddingService(model, backend)).getFingerprint();
    if (recorded.dimension !== current.dimension) {
      this.logger.error("Embedding dimension mismatch detected", {
        topicId,
        model,
        existingDimension: recorded.dimension,
        currentDimension: current.dimension,
      });
      throw new EmbeddingFingerprintMismatchError(
        topicId,
        `Embedding dimension mismatch for topic ${topicId}.\n` +
          `Existing vectors have ${recorded.dimension} dimensions, but "${model}" now produces ` +
          `${current.dimension}.\n\n` +
          `Vectors of different dimensions cannot share a table, so this is not a setting that can be ` +
          `changed back — the model itself no longer matches the data.\n` +
          `Delete and recreate this topic to reindex it.`,
      );
    }
  }

  public async saveStore(topicId: string, metadata: Partial<VectorStoreMetadata>): Promise<void> {
    this.logger.info("Saving vector store metadata", { topicId });
    try {
      const metadataPath = this.getMetadataPath(topicId);
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      const previousMetadata = await this.getStoreMetadata(topicId);
      if (!previousMetadata && (await this.hasTable(topicId))) {
        throw new VectorStoreMetadataCorruptionError(topicId, "missing");
      }
      const migrationRequiresFingerprintOnReindex =
        metadata.migrationRequiresFingerprintOnReindex ??
        previousMetadata?.migrationRequiresFingerprintOnReindex ??
        false;
      const embeddingFingerprint = migrationRequiresFingerprintOnReindex
        ? metadata.embeddingFingerprint
        : (metadata.embeddingFingerprint ?? (await this.embeddingService.getFingerprint()));
      const fullMetadata: VectorStoreMetadata = {
        schemaVersion: STORAGE_FORMAT_VERSION,
        topicId,
        documentCount: metadata.documentCount || 0,
        chunkCount: metadata.chunkCount || 0,
        // The topic's own recorded model outranks this factory's default: a
        // caller that omits the field is refreshing counts, not re-labelling
        // the embedding space. Falling straight through to the default would
        // silently re-attribute adopted and migrated vectors.
        embeddingModel: metadata.embeddingModel || previousMetadata?.embeddingModel || this.embeddingModel,
        embeddingBackend: metadata.embeddingBackend || "",
        embeddingFingerprint,
        migrationRequiresFingerprintOnReindex,
        createdAt: metadata.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await this.writeStoreMetadata(topicId, fullMetadata);
      this.logger.info("Vector store metadata saved successfully", { topicId });
    } catch (error) {
      this.logger.error("Failed to save vector store metadata", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  public async deleteStore(topicId: string): Promise<void> {
    this.logger.info("Deleting vector store", { topicId });
    try {
      for (const key of this.storeCache.keys()) {
        if (key.endsWith(`::${topicId}`)) {
          this.storeCache.delete(key);
        }
      }

      // Drop the LanceDB table if it exists
      const db = await this.getConnection(this.lanceDbUri);

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
      this.logger.error("Failed to delete vector store", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  public async addDocuments(topicId: string, store: VectorStore, documents: LangChainDocument[]): Promise<void> {
    this.logger.info("Adding documents to vector store", { topicId, documentCount: documents.length });
    void store; // Compatibility parameter; writes use the native durable reconciliation path.
    try {
      await this.reconcileDocuments(topicId, documents);
      this.logger.info("Documents reconciled successfully", { topicId, documentCount: documents.length });
    } catch (error) {
      this.logger.error("Failed to add documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
        documentCount: documents.length,
      });
      throw error;
    }
  }

  /** Upsert stable chunks and remove obsolete chunks for each affected source. */
  public async reconcileDocuments(
    topicId: string,
    documents: LangChainDocument[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    const metadata = await this.assertMutationAllowed(topicId);
    const normalized = this.normalizeDocumentMetadata(documents);
    const db = await this.getConnection(this.lanceDbUri);
    const table = await db.openTable(topicId);
    this.tables.add(table);
    signal?.throwIfAborted();
    const vectors = await this.embedForTopic(
      metadata,
      normalized.map((document) => document.pageContent),
      signal,
    );
    signal?.throwIfAborted();
    const rows: Array<Record<string, unknown>> = normalized.map((document, index) => ({
      vector: vectors[index],
      text: document.pageContent,
      document_id: String(document.metadata.documentId),
      chunk_id: String(document.metadata.chunkId),
      ...document.metadata,
    }));
    const byDocument = new Map<string, typeof rows>();
    for (const row of rows) {
      const documentId = String(row.documentId);
      const sourceRows = byDocument.get(documentId) ?? [];
      sourceRows.push(row);
      byDocument.set(documentId, sourceRows);
    }
    for (const [documentId, sourceRows] of byDocument) {
      signal?.throwIfAborted();
      const escaped = documentId.replace(/'/g, "''");
      await table
        .mergeInsert("chunk_id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where: `document_id = '${escaped}'` })
        .execute(sourceRows);
      signal?.throwIfAborted();
    }
  }

  public async getStoredStats(topicId: string): Promise<{ documentCount: number; chunkCount: number }> {
    const db = await this.getConnection(this.lanceDbUri);
    if (!(await db.tableNames()).includes(topicId)) {
      return { documentCount: 0, chunkCount: 0 };
    }
    const table = await db.openTable(topicId);
    this.tables.add(table);
    // The chunk count is a pushdown count — never materialize rows for it.
    const chunkCount = await table.countRows();
    if (chunkCount === 0) {
      return { documentCount: 0, chunkCount: 0 };
    }
    // LanceDB (0.19) exposes no distinct/aggregate pushdown, so the distinct
    // document count still needs a scan. Stream the single id column in Arrow
    // record batches instead of materializing one JS object per chunk.
    const documentIds = new Set<string>();
    for await (const batch of table.query().select(["document_id"])) {
      const column = batch.getChild("document_id");
      if (!column) {
        continue;
      }
      for (const value of column) {
        if (value !== null && value !== undefined) {
          documentIds.add(String(value));
        }
      }
    }
    return { documentCount: documentIds.size, chunkCount };
  }

  public async getDocumentChunkCount(topicId: string, documentId: string): Promise<number> {
    const db = await this.getConnection(this.lanceDbUri);
    if (!(await db.tableNames()).includes(topicId)) {
      return 0;
    }
    const table = await db.openTable(topicId);
    this.tables.add(table);
    const escaped = documentId.replace(/'/g, "''");
    return (await table.query().where(`document_id = '${escaped}'`).select(["chunk_id"]).toArray()).length;
  }

  public async removeDocument(topicId: string, documentId: string): Promise<string[]> {
    const db = await this.getConnection(this.lanceDbUri);
    if (!(await db.tableNames()).includes(topicId)) {
      return [];
    }
    const table = await db.openTable(topicId);
    this.tables.add(table);
    const escaped = documentId.replace(/'/g, "''");
    const rows = await table.query().where(`document_id = '${escaped}'`).select(["chunkId"]).toArray();
    if (rows.length > 0) {
      await table.delete(`document_id = '${escaped}'`);
    }
    return rows.map((row) => String(row.chunkId));
  }

  /**
   * Defense-in-depth for every in-place vector write/upsert entry point.
   *
   * Returns the metadata it verified, because the caller needs the very same
   * record to resolve the topic's embedder: re-reading it would open a window
   * in which the space that was checked is not the space that is written.
   */
  private async assertMutationAllowed(topicId: string): Promise<VectorStoreMetadata> {
    const metadata = await this.getStoreMetadata(topicId);
    if (!metadata) {
      if (await this.hasTable(topicId)) {
        throw new VectorStoreMetadataCorruptionError(topicId, "missing");
      }
      throw new Error(`Vector store table not found for topic ${topicId}`);
    }
    if (metadata.migrationRequiresFingerprintOnReindex || !metadata.embeddingFingerprint) {
      return this.adoptFingerprintForMigratedTopic(topicId, metadata);
    }
    return metadata;
  }

  /**
   * A migrated or adopted topic reaches its first write here. The topic's own
   * recorded model is resolved and its produced dimension checked against the
   * live table; only a verified match may stamp the fingerprint the migrator
   * refused to invent. A mismatch is the genuine reindex case.
   */
  private async adoptFingerprintForMigratedTopic(
    topicId: string,
    metadata: VectorStoreMetadata,
  ): Promise<VectorStoreMetadata> {
    let fingerprint: EmbeddingFingerprint;
    try {
      const service = await this.resolveEmbeddingService(
        metadata.embeddingModel || this.embeddingModel,
        metadata.embeddingBackend ?? "",
      );
      fingerprint = await service.getFingerprint();
    } catch (error) {
      this.logger.error("Cannot resolve recorded model for migrated topic", {
        topicId,
        model: metadata.embeddingModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EmbeddingReindexRequiredError(topicId);
    }
    const tableDimension = await this.getTableDimension(topicId);
    if (tableDimension !== null && tableDimension !== fingerprint.dimension) {
      throw new EmbeddingReindexRequiredError(topicId);
    }
    await this.saveStore(topicId, {
      ...metadata,
      embeddingFingerprint: fingerprint,
      embeddingBackend: fingerprint.backendKind,
      migrationRequiresFingerprintOnReindex: false,
    });
    const healed = await this.getStoreMetadata(topicId);
    if (!healed || healed.migrationRequiresFingerprintOnReindex || !healed.embeddingFingerprint) {
      throw new EmbeddingReindexRequiredError(topicId);
    }
    return healed;
  }

  /** Vector dimension of the live table, or null when the table is empty/absent. */
  private async getTableDimension(topicId: string): Promise<number | null> {
    const db = await this.getConnection(this.lanceDbUri);
    if (!(await db.tableNames()).includes(topicId)) {
      return null;
    }
    const table = await db.openTable(topicId);
    const schema = await table.schema();
    const vectorField = schema.fields.find((field: { name: string }) => field.name === "vector");
    const listSize = (vectorField?.type as { listSize?: number } | undefined)?.listSize;
    if (typeof listSize === "number" && listSize > 0) {
      return listSize;
    }
    const rows = await table.query().limit(1).toArray();
    const vector = rows[0]?.vector;
    return vector ? Array.from(vector as ArrayLike<number>).length : null;
  }

  private async hasTable(topicId: string): Promise<boolean> {
    const db = await this.getConnection(this.lanceDbUri);
    return (await db.tableNames()).includes(topicId);
  }

  private async writeStoreMetadata(topicId: string, metadata: VectorStoreMetadata): Promise<void> {
    const metadataPath = this.getMetadataPath(topicId);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await atomicWriteJson(metadataPath, metadata);
  }

  /**
   * Recognizes metadata written before the schema was versioned, and only that.
   *
   * `schemaVersion` must be absent rather than merely unequal: a file claiming a
   * version this build does not know is a forward-compatibility problem, not a
   * legacy one, and guessing at it would be exactly the silent reinterpretation
   * the corruption refusal exists to prevent.
   */
  private adoptIfLegacyMetadata(value: unknown, topicId: string): VectorStoreMetadata | null {
    if (!value || typeof value !== "object" || "schemaVersion" in value) {
      return null;
    }
    const legacy = value as Partial<LegacyVectorStoreMetadata>;
    if (
      legacy.topicId !== topicId ||
      !Number.isFinite(legacy.documentCount) ||
      !Number.isFinite(legacy.chunkCount) ||
      typeof legacy.embeddingModel !== "string" ||
      !Number.isFinite(legacy.createdAt) ||
      !Number.isFinite(legacy.updatedAt)
    ) {
      return null;
    }
    return adoptLegacyVectorStoreMetadata({
      topicId,
      documentCount: legacy.documentCount as number,
      chunkCount: legacy.chunkCount as number,
      embeddingModel: legacy.embeddingModel,
      createdAt: legacy.createdAt as number,
      updatedAt: legacy.updatedAt as number,
    });
  }

  private isVectorStoreMetadata(value: unknown, topicId: string): value is VectorStoreMetadata {
    if (!value || typeof value !== "object") {
      return false;
    }
    const metadata = value as Partial<VectorStoreMetadata>;
    const fingerprint = metadata.embeddingFingerprint;
    const fingerprintValid =
      fingerprint === undefined ||
      (typeof fingerprint.backendKind === "string" &&
        typeof fingerprint.providerFormat === "string" &&
        typeof fingerprint.model === "string" &&
        typeof fingerprint.revision === "string" &&
        Number.isInteger(fingerprint.dimension) &&
        fingerprint.dimension > 0 &&
        typeof fingerprint.endpointHash === "string");
    return (
      metadata.schemaVersion === STORAGE_FORMAT_VERSION &&
      metadata.topicId === topicId &&
      Number.isFinite(metadata.documentCount) &&
      Number.isFinite(metadata.chunkCount) &&
      typeof metadata.embeddingModel === "string" &&
      (metadata.embeddingBackend === undefined || typeof metadata.embeddingBackend === "string") &&
      (metadata.migrationRequiresFingerprintOnReindex === undefined ||
        typeof metadata.migrationRequiresFingerprintOnReindex === "boolean") &&
      Number.isFinite(metadata.createdAt) &&
      Number.isFinite(metadata.updatedAt) &&
      fingerprintValid
    );
  }

  /**
   * Fetch all documents from a topic via LanceDB table scan.
   * Unlike similaritySearch, this does NOT require embedding a query vector,
   * so it works regardless of the current embedding model's dimension.
   */
  public async getAllDocuments(
    topicId: string,
    limit: number,
    customStorageDir?: string,
  ): Promise<LangChainDocument[]> {
    this.logger.info("Fetching all documents via table scan", { topicId, limit });

    try {
      const targetUri = customStorageDir ? path.join(customStorageDir, "lancedb") : this.lanceDbUri;

      const db = await this.getConnection(targetUri);
      const tableNames = await db.tableNames();
      if (!tableNames.includes(topicId)) {
        this.logger.warn("Table not found for getAllDocuments", { topicId });
        return [];
      }

      const table = await db.openTable(topicId);
      this.tables.add(table);
      const rows = await table.query().limit(limit).toArray();

      // Debug: log first row's column keys and text preview
      if (rows.length > 0) {
        const firstRow = rows[0];
        const keys = Object.keys(firstRow);
        const textPreview =
          typeof firstRow["text"] === "string" ? firstRow["text"].substring(0, 100) : `[${typeof firstRow["text"]}]`;
        this.logger.debug("Table scan first row", { columns: keys, textPreview });
      }

      const documents = rows.map((row: Record<string, unknown>) => {
        const metadata: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key !== "text" && key !== "vector" && key !== "document_id" && key !== "chunk_id") {
            metadata[key] = value;
          }
        }
        return new LangChainDocument({
          pageContent: (row["text"] as string) || "",
          metadata,
        });
      });

      this.logger.info("Table scan complete", {
        topicId,
        documentCount: documents.length,
        nonEmptyCount: documents.filter((d) => d.pageContent.length > 0).length,
      });
      return documents;
    } catch (error) {
      this.logger.error("Failed to fetch all documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
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
    for (const table of this.tables) {
      table.close();
    }
    this.tables.clear();
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();

    this.logger.info("VectorStoreFactory disposed");
  }

  /**
   * Normalize document metadata to ensure schema consistency across all documents
   * This prevents LanceDB schema mismatch errors when adding documents with different metadata
   */
  private normalizeDocumentMetadata(documents: LangChainDocument[]): LangChainDocument[] {
    return documents.map((doc) => {
      // Keep only essential, consistent metadata fields.
      // chunkId is required for graph retrieval to hydrate chunks (entities
      // reference chunks by chunkId), and the position/heading fields drive
      // source attribution in query results.
      const allowedFields = [
        "source",
        "sourceType",
        "sourceDescriptor",
        "sourceRevision",
        "ingestionTransactionId",
        "documentId",
        "fileName",
        "filePath",
        "fileType",
        "fileSize",
        "loadedAt",
        "chunkIndex",
        "totalChunks",
        "loc",
        "loc_lines_from",
        "loc_lines_to",
        "isMarkdown",
        "preserveStructure",
        "chunkId",
        "startPosition",
        "endPosition",
        "headingPath",
        "sectionTitle",
        "headingLevel",
      ];

      const normalizedMetadata: Record<string, any> = {
        source: "",
        sourceType: "file",
        sourceDescriptor: "{}",
        sourceRevision: "",
        ingestionTransactionId: "",
        documentId: "",
        chunkId: "",
        fileName: "",
        filePath: "",
        fileType: "text",
        fileSize: 0,
        loadedAt: 0,
        chunkIndex: 0,
        totalChunks: 0,
        loc_lines_from: 0,
        loc_lines_to: 0,
        isMarkdown: false,
        preserveStructure: false,
        startPosition: 0,
        endPosition: 0,
        headingPath: "[]",
        headingLevel: 0,
        sectionTitle: "",
      };

      // Copy only allowed fields
      for (const field of allowedFields) {
        if (field in doc.metadata) {
          normalizedMetadata[field] = doc.metadata[field];
        }
      }

      // Convert loc object to simple fields if present (for compatibility)
      if (doc.metadata.loc && typeof doc.metadata.loc === "object") {
        normalizedMetadata.loc_lines_from = doc.metadata.loc.lines?.from ?? 0;
        normalizedMetadata.loc_lines_to = doc.metadata.loc.lines?.to ?? 0;
        delete normalizedMetadata.loc; // Remove complex object
      }

      // Serialize array-valued headingPath to a scalar JSON string — LanceDB
      // columns must be scalar (same treatment as tags/entityIds elsewhere).
      if (Array.isArray(normalizedMetadata.headingPath)) {
        normalizedMetadata.headingPath = JSON.stringify(normalizedMetadata.headingPath);
      }

      // Warn about dropped fields (once)
      const droppedFields = Object.keys(doc.metadata).filter((f) => !allowedFields.includes(f));
      if (droppedFields.length > 0 && !this.metadataDropWarningShown) {
        this.logger.warn("Some metadata fields were dropped during normalization", {
          droppedFields: droppedFields.slice(0, 5),
        });
        this.metadataDropWarningShown = true;
      }

      return new LangChainDocument({
        pageContent: doc.pageContent,
        metadata: normalizedMetadata,
      });
    });
  }

  private getMetadataPath(topicId: string, customStorageDir?: string): string {
    return path.join(customStorageDir ?? this.storageDir, `vector-${topicId}-metadata.json`);
  }

  private async getConnection(uri: string): Promise<Connection> {
    let connection = this.connections.get(uri);
    if (!connection || !connection.isOpen()) {
      connection = await connect(uri);
      this.connections.set(uri, connection);
    }
    return connection;
  }

  private createDocumentSchema(dimension: number): Schema {
    const stringFields = [
      "text",
      "source",
      "sourceType",
      "sourceDescriptor",
      "sourceRevision",
      "ingestionTransactionId",
      "documentId",
      "document_id",
      "chunkId",
      "chunk_id",
      "fileName",
      "filePath",
      "fileType",
      "headingPath",
      "sectionTitle",
    ].map((name) => new Field(name, new Utf8(), false));
    const numberFields = [
      "fileSize",
      "loadedAt",
      "chunkIndex",
      "totalChunks",
      "loc_lines_from",
      "loc_lines_to",
      "startPosition",
      "endPosition",
      "headingLevel",
    ].map((name) => new Field(name, new Float64(), false));
    return new Schema([
      new Field("vector", new FixedSizeList(dimension, new Field("item", new Float32(), false)), false),
      ...stringFields,
      ...numberFields,
      new Field("isMarkdown", new Bool(), false),
      new Field("preserveStructure", new Bool(), false),
    ]);
  }

  /**
   * Resolves the embedding service for one topic's embedding space.
   *
   * Every store used to share this factory's single EmbeddingService, which the
   * most recently loaded topic re-pointed via initialize(model). The registry
   * hands out one immutable service per (backend, endpoint, model) instead, so
   * a topic keeps embedding with the model its vectors were built from.
   */
  private async createEmbeddings(modelName: string, backendType?: string): Promise<TransformersEmbeddings> {
    const service = await this.resolveEmbeddingService(modelName, backendType);
    return new TransformersEmbeddings({ modelName, backendType, embeddingService: service });
  }

  /**
   * The registry entry for one embedding space.
   *
   * Sole owner of the registry key, so reads (`createEmbeddings`) and writes
   * (`embedForTopic`) provably resolve the same service for the same topic —
   * two independent key computations would be free to drift apart, and the
   * drift would only show up as vectors from two spaces in one table.
   */
  private async resolveEmbeddingService(modelName: string, backendType?: string): Promise<EmbeddingService> {
    // "auto" is a configuration request, not a resolved backend: keying on it
    // would occupy a cap slot under a name no store can be identified by.
    const backend = backendType && backendType !== "auto" ? backendType : "huggingface";
    return this.registry.get({
      model: modelName,
      backend,
      endpointHash: hasRemoteEndpoint(backend) ? await this.configuredEndpointHash() : "local",
    });
  }

  /**
   * Embeds text into one topic's existing embedding space.
   *
   * The model comes from the topic's own metadata, never from the configured
   * one: a table holds vectors from exactly one space, so extending a topic
   * built with another model has to re-enter THAT model. Routing mirrors
   * `TransformersEmbeddings` — scoped to the recorded backend when there is
   * one — so a topic is written through the same service that reads it.
   */
  private async embedForTopic(
    metadata: VectorStoreMetadata,
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const backendType = metadata.embeddingBackend;
    const service = await this.resolveEmbeddingService(metadata.embeddingModel || this.embeddingModel, backendType);
    return backendType
      ? service.embedBatchWithBackend(backendType, texts, undefined, signal)
      : service.embedBatch(texts, undefined, signal);
  }

  /**
   * endpointHash of the currently configured backend.
   *
   * Cached because getFingerprint() may perform a live embed probe, which must
   * not run once per store load. A rejection clears the cache rather than
   * poisoning every later load with the same failure.
   */
  private configuredEndpointHash(): Promise<string> {
    if (!this.endpointHashCache) {
      this.endpointHashCache = this.embeddingService.getFingerprint().then(
        (fingerprint) => fingerprint.endpointHash ?? "local",
        (error) => {
          this.endpointHashCache = undefined;
          throw error;
        },
      );
    }
    return this.endpointHashCache;
  }
}
