/**
 * Document Pipeline - End-to-end document processing orchestrator
 * Coordinates loading, splitting, embedding, and vector storage
 *
 * Architecture: Pipeline pattern with progress tracking
 * Integrates: DocumentLoaderFactory → SemanticChunker → EmbeddingService → VectorStoreFactory
 */

import { IConfigProvider, INotifier } from "../interfaces";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { DocumentLoaderFactory, LoaderOptions } from "../loaders/documentLoaderFactory";
import { SemanticChunker, ChunkingOptions } from "../splitters/semanticChunker";
import { EmbeddingService } from "../embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../embeddings/embeddingServiceRegistry";
import { VectorStoreFactory } from "../stores/vectorStoreFactory";
import { Logger } from "../logger";
import { createHash } from "crypto";
import * as path from "path";

export interface PipelineOptions {
  /** Document loading options */
  loaderOptions?: Partial<LoaderOptions>;

  /** Chunking options */
  chunkingOptions?: ChunkingOptions;

  /** Batch size for embedding generation */
  embeddingBatchSize?: number;

  /** Progress callback */
  onProgress?: (progress: PipelineProgress) => void;
  signal?: AbortSignal;
  /** Internal durable-ingestion transaction identity persisted on every chunk. */
  ingestionTransactionId?: string;
}

export interface PipelineSourceDocument {
  documentId: string;
  canonicalSource: string;
  sourceType: string;
  sourceRevision: string;
  fileName: string;
  filePath: string;
  fileType: string;
  chunkCount: number;
}

export interface PipelineProgress {
  stage: "loading" | "chunking" | "extracting" | "embedding" | "storing" | "complete";
  progress: number; // 0-100
  message: string;
  details?: any;
}

export interface PipelineResult {
  /** Successfully processed documents */
  success: boolean;

  /** Processing stages completed */
  stages: {
    loading: boolean;
    chunking: boolean;
    extracting: boolean;
    embedding: boolean;
    storing: boolean;
  };

  /** Result metadata */
  metadata: {
    originalDocuments: number;
    chunksCreated: number;
    chunksEmbedded: number;
    chunksStored: number;
    entitiesExtracted: number;
    relationshipsExtracted: number;
    totalTime: number;
    stageTimings: {
      loading: number;
      chunking: number;
      extracting: number;
      embedding: number;
      storing: number;
    };
    graphExtracted: boolean;
    partial: boolean;
    documentId?: string;
    sourceDocuments?: PipelineSourceDocument[];
    warnings: Array<{ stage: string; message: string }>;
  };

  /** Generated chunks */
  chunks: LangChainDocument[];

  /** Errors if any */
  errors?: string[];
}

/**
 * Orchestrates document processing pipeline
 */
export class DocumentPipeline {
  private logger: Logger;
  private documentLoader: DocumentLoaderFactory;
  private semanticChunker: SemanticChunker;
  private embeddingService: EmbeddingService;
  private vectorStoreFactory: VectorStoreFactory | null = null;
  private config: IConfigProvider | undefined;

  constructor(
    private notifier: INotifier,
    embeddingService: EmbeddingService,
    private readonly embeddingRegistry: EmbeddingServiceRegistry,
    config?: IConfigProvider,
  ) {
    this.logger = new Logger("DocumentPipeline");
    this.documentLoader = new DocumentLoaderFactory();
    this.semanticChunker = new SemanticChunker(config);
    this.embeddingService = embeddingService;
    this.config = config;

    this.logger.info("DocumentPipeline initialized");
  }

  /**
   * Initialize the pipeline with vector store factory using the configured embedding model
   */
  public async initialize(storageDir: string): Promise<void> {
    try {
      await this.embeddingService.initialize();

      // Get the actual model name that was initialized
      const actualModelName = this.embeddingService.getCurrentModel();

      this.logger.info("Initializing pipeline", { storageDir, embeddingModel: actualModelName });

      // Dispose previous factory before creating a new one
      if (this.vectorStoreFactory) {
        this.vectorStoreFactory.dispose();
      }

      this.vectorStoreFactory = new VectorStoreFactory(
        storageDir,
        actualModelName,
        this.embeddingService,
        this.embeddingRegistry,
      );

      this.logger.info("Pipeline initialized successfully");
    } catch (error) {
      this.logger.error("Failed to initialize pipeline", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Process a single document through the entire pipeline
   */
  public async processDocument(
    filePath: string,
    topicId: string,
    options: PipelineOptions = {},
  ): Promise<PipelineResult> {
    return await this.processDocuments([filePath], topicId, options);
  }

  /**
   * Process multiple documents through the entire pipeline
   */
  public async processDocuments(
    filePaths: string[],
    topicId: string,
    options: PipelineOptions = {},
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    this.embeddingService.setProcessing(true);

    this.logger.info("Starting document pipeline", {
      fileCount: filePaths.length,
      topicId,
      options,
    });

    const result: PipelineResult = {
      success: false,
      stages: {
        loading: false,
        chunking: false,
        extracting: false,
        embedding: false,
        storing: false,
      },
      metadata: {
        originalDocuments: filePaths.length,
        chunksCreated: 0,
        chunksEmbedded: 0,
        chunksStored: 0,
        entitiesExtracted: 0,
        relationshipsExtracted: 0,
        totalTime: 0,
        stageTimings: {
          loading: 0,
          chunking: 0,
          extracting: 0,
          embedding: 0,
          storing: 0,
        },
        graphExtracted: false,
        partial: false,
        warnings: [],
      },
      chunks: [],
      errors: [],
    };

    try {
      options.signal?.throwIfAborted();
      // Ensure initialized
      if (!this.vectorStoreFactory) {
        throw new Error("Pipeline not initialized. Call initialize() first.");
      }

      // Stage 1: Load documents
      const loadStartTime = Date.now();
      this.reportProgress(options.onProgress, {
        stage: "loading",
        progress: 0,
        message: `Loading documents...`,
      });

      const loadedDocs = await this.loadDocuments(filePaths, options);
      options.signal?.throwIfAborted();
      result.stages.loading = true;
      result.metadata.stageTimings.loading = Date.now() - loadStartTime;

      // Update metadata with actual loaded document count (after directory expansion)
      result.metadata.originalDocuments = loadedDocs.length;

      this.logger.info("Documents loaded", {
        inputPaths: filePaths.length,
        actualFilesLoaded: loadedDocs.length,
        time: result.metadata.stageTimings.loading,
        totalContentLength: loadedDocs.reduce((sum, doc) => sum + doc.pageContent.length, 0),
        sources: loadedDocs.slice(0, 10).map((doc) => doc.metadata.source || "unknown"),
      });

      // Report the actual number of files loaded
      this.reportProgress(options.onProgress, {
        stage: "loading",
        progress: 10,
        message: `Loaded ${loadedDocs.length} file(s)`,
      });

      // Stop if no documents were loaded - this is a critical failure
      if (loadedDocs.length === 0) {
        const errorMessage =
          "No documents loaded - document loading failed. Check file paths, loader configuration, or API rate limits.";
        this.logger.error(errorMessage, {
          filePaths,
          loaderOptions: options.loaderOptions,
        });
        if (!result.errors) {
          result.errors = [];
        }
        result.errors.push(errorMessage);
        result.metadata.totalTime = Date.now() - startTime;
        throw new Error(errorMessage);
      }

      // Stage 2: Chunk documents
      const chunkStartTime = Date.now();
      this.reportProgress(options.onProgress, {
        stage: "chunking",
        progress: 25,
        message: `Chunking ${loadedDocs.length} document(s)...`,
      });

      const chunkingResult = await this.semanticChunker.chunkDocuments(loadedDocs, options.chunkingOptions);
      options.signal?.throwIfAborted();

      // Replace process-local chunk counters with durable source-derived IDs.
      const perDocumentIndex = new Map<string, number>();
      const perDocumentTotals = new Map<string, number>();
      for (const chunk of chunkingResult.chunks) {
        const documentId = String(chunk.metadata.documentId);
        perDocumentTotals.set(documentId, (perDocumentTotals.get(documentId) ?? 0) + 1);
      }
      for (const chunk of chunkingResult.chunks) {
        const documentId = String(chunk.metadata.documentId);
        const index = perDocumentIndex.get(documentId) ?? 0;
        chunk.metadata.chunkIndex = index;
        chunk.metadata.totalChunks = perDocumentTotals.get(documentId) ?? 1;
        chunk.metadata.chunkId = this.hashId("chunk", `${documentId}\0${index}\0${chunk.pageContent}`);
        perDocumentIndex.set(documentId, index + 1);
      }

      result.chunks = chunkingResult.chunks;
      result.metadata.chunksCreated = chunkingResult.chunkCount;
      result.stages.chunking = true;
      result.metadata.stageTimings.chunking = Date.now() - chunkStartTime;

      this.logger.info("Documents chunked", {
        inputDocuments: loadedDocs.length,
        chunkCount: chunkingResult.chunkCount,
        strategy: chunkingResult.strategy,
        time: result.metadata.stageTimings.chunking,
        avgChunkSize:
          chunkingResult.chunkCount > 0
            ? Math.round(
                chunkingResult.chunks.reduce((sum, c) => sum + c.pageContent.length, 0) / chunkingResult.chunkCount,
              )
            : 0,
      });

      // Log warning if no chunks were created
      if (chunkingResult.chunkCount === 0) {
        this.logger.warn("No chunks created from documents", {
          inputDocuments: loadedDocs.length,
          strategy: chunkingResult.strategy,
          chunkingOptions: options.chunkingOptions,
        });
      }

      // Stage 4: Generate embeddings
      this.reportProgress(options.onProgress, {
        stage: "embedding",
        progress: 50,
        message: `Generating embeddings for ${result.chunks.length} chunk(s)...`,
      });

      // Stage 4: Store in vector database
      const storeStartTime = Date.now();
      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 70,
        message: `Storing ${result.chunks.length} chunk(s) in vector database...`,
      });

      await this.storeDocuments(result.chunks, topicId, options);
      options.signal?.throwIfAborted();
      result.metadata.chunksStored = result.chunks.length;
      result.metadata.documentId = String(result.chunks[0]?.metadata.documentId ?? "") || undefined;
      result.metadata.sourceDocuments = this.summarizeSourceDocuments(result.chunks);
      result.metadata.chunksEmbedded = result.chunks.length; // Embeddings generated during storage
      result.stages.embedding = true;
      result.stages.storing = true;
      result.metadata.stageTimings.storing = Date.now() - storeStartTime;
      result.metadata.stageTimings.embedding = result.metadata.stageTimings.storing; // Same timing

      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 100,
        message: `Completed: ${loadedDocs.length} file(s), ${result.metadata.chunksStored} chunk(s)`,
      });

      this.logger.info("Documents stored with embeddings", {
        chunkCount: result.metadata.chunksStored,
        time: result.metadata.stageTimings.storing,
      });

      // Complete
      result.success = true;
      result.metadata.totalTime = Date.now() - startTime;

      this.reportProgress(options.onProgress, {
        stage: "complete",
        progress: 100,
        message: `Successfully processed ${loadedDocs.length} document(s)`,
        details: result.metadata,
      });

      this.logger.info("Pipeline completed successfully", {
        totalTime: result.metadata.totalTime,
        metadata: result.metadata,
      });

      return result;
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw options.signal?.reason ?? error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);

      this.logger.error("Pipeline failed", {
        error: errorMessage,
        stage: this.getCurrentStage(result.stages),
        metadata: result.metadata,
      });

      result.success = false;
      result.errors = errors;
      result.metadata.totalTime = Date.now() - startTime;

      return result;
    } finally {
      this.embeddingService.setProcessing(false);
    }
  }

  /**
   * Embed and persist already-chunked documents, skipping the load/chunk
   * stages. Storage path (validation, store creation, metadata save) is
   * identical to processDocuments(). The caller loads and chunks exactly once
   * in its own stages.
   */
  public async storeProcessedChunks(
    chunks: LangChainDocument[],
    topicId: string,
    options: PipelineOptions = {},
  ): Promise<void> {
    if (!this.vectorStoreFactory) {
      throw new Error("Pipeline not initialized. Call initialize() first.");
    }

    this.embeddingService.setProcessing(true);
    try {
      await this.storeDocuments(chunks, topicId, options);
    } finally {
      this.embeddingService.setProcessing(false);
    }
  }

  // ==================== Private Methods ====================

  /**
   * Load documents using DocumentLoaderFactory
   */
  private async loadDocuments(filePaths: string[], options: PipelineOptions): Promise<LangChainDocument[]> {
    const loaderOptions = filePaths.map((filePath) => ({
      filePath,
      ...options.loaderOptions,
      signal: options.signal,
    }));

    const results = await this.documentLoader.loadDocuments(loaderOptions);

    // Flatten all documents
    const allDocuments = results.flatMap((result) => result.documents);
    const grouped = new Map<string, LangChainDocument[]>();
    for (const document of allDocuments) {
      const source = this.normalizeSource(String(document.metadata.source ?? document.metadata.filePath ?? "unknown"));
      const group = grouped.get(source) ?? [];
      group.push(document);
      grouped.set(source, group);
    }
    for (const [source, documents] of grouped) {
      const first = documents[0];
      const sourceType = ["web", "github"].includes(String(first.metadata.fileType))
        ? String(first.metadata.fileType)
        : "file";
      const descriptor = { type: sourceType, source };
      const documentId = this.hashId("doc", JSON.stringify(descriptor));
      const revision = createHash("sha256")
        .update(documents.map((document) => document.pageContent).join("\0"))
        .digest("hex");
      for (const document of documents) {
        document.metadata.source = source;
        document.metadata.sourceType = sourceType;
        document.metadata.sourceDescriptor = JSON.stringify(descriptor);
        document.metadata.sourceRevision = revision;
        document.metadata.documentId = documentId;
        if (options.ingestionTransactionId) {
          document.metadata.ingestionTransactionId = options.ingestionTransactionId;
        }
      }
    }

    return allDocuments;
  }

  private normalizeSource(source: string): string {
    try {
      const url = new URL(source);
      url.hash = "";
      url.hostname = url.hostname.toLowerCase();
      if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
        url.port = "";
      }
      return url.toString();
    } catch {
      return path.resolve(source).replace(/\\/g, "/");
    }
  }

  private hashId(prefix: string, value: string): string {
    return `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
  }

  /**
   * Store documents in vector store
   * Note: Embeddings are generated automatically during this process
   */
  private async storeDocuments(chunks: LangChainDocument[], topicId: string, options: PipelineOptions): Promise<void> {
    if (!this.vectorStoreFactory) {
      throw new Error("VectorStoreFactory not initialized");
    }

    // Validate embedding model compatibility before proceeding
    try {
      await this.vectorStoreFactory.validateEmbeddingModel(topicId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error validating embedding model";
      this.notifier.showError(`Embedding validation failed for this topic: ${message}`);
      throw error;
    }

    // Try to load existing store or create new one
    const vectorStore = await this.vectorStoreFactory.loadStore(topicId);

    if (vectorStore) {
      // Add to existing store (embeddings generated here via our wrapper)
      this.logger.debug("Adding to existing vector store", { topicId });

      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 70,
        message: `Adding ${chunks.length} chunks with embeddings...`,
      });

      await this.vectorStoreFactory.reconcileDocuments(topicId, chunks, options.signal);
    } else {
      // Create new store (embeddings generated here via our wrapper)
      this.logger.debug("Creating new vector store", { topicId });

      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 70,
        message: `Creating vector store and embedding ${chunks.length} chunks...`,
      });

      await this.vectorStoreFactory.createStore({ topicId, storageDir: "" }, chunks, options.signal);
    }

    // Save the store
    this.reportProgress(options.onProgress, {
      stage: "storing",
      progress: 90,
      message: "Saving vector store...",
    });

    const existingMetadata = await this.vectorStoreFactory.getStoreMetadata(topicId);
    const storedStats = await this.vectorStoreFactory.getStoredStats(topicId);

    options.signal?.throwIfAborted();
    await this.vectorStoreFactory.saveStore(topicId, {
      documentCount: storedStats.documentCount,
      chunkCount: storedStats.chunkCount,
      createdAt: existingMetadata?.createdAt, // Preserved for existing stores, saveStore() will use Date.now() for new ones
      embeddingModel: existingMetadata?.embeddingModel ?? this.vectorStoreFactory.getEmbeddingModel(),
      embeddingBackend: existingMetadata?.embeddingBackend ?? this.embeddingService.getActiveBackendType(),
      embeddingFingerprint:
        existingMetadata?.embeddingFingerprint ?? (await this.embeddingService.getFingerprint(options.signal)),
    });
    options.signal?.throwIfAborted();
  }

  private summarizeSourceDocuments(chunks: LangChainDocument[]): PipelineSourceDocument[] {
    const summaries = new Map<string, PipelineSourceDocument>();
    for (const chunk of chunks) {
      const documentId = String(chunk.metadata.documentId ?? "");
      if (!documentId) {
        continue;
      }
      const current = summaries.get(documentId);
      if (current) {
        current.chunkCount += 1;
        continue;
      }
      summaries.set(documentId, {
        documentId,
        canonicalSource: String(chunk.metadata.source ?? chunk.metadata.filePath ?? ""),
        sourceType: String(chunk.metadata.sourceType ?? "file"),
        sourceRevision: String(chunk.metadata.sourceRevision ?? ""),
        fileName: String(chunk.metadata.fileName ?? path.basename(String(chunk.metadata.source ?? ""))),
        filePath: String(chunk.metadata.filePath ?? chunk.metadata.source ?? ""),
        fileType: String(chunk.metadata.fileType ?? "text"),
        chunkCount: 1,
      });
    }
    return [...summaries.values()];
  }

  /**
   * Report progress to callback
   */
  private reportProgress(
    callback: ((progress: PipelineProgress) => void) | undefined,
    progress: PipelineProgress,
  ): void {
    if (callback) {
      callback(progress);
    }
  }

  /**
   * Get current stage name
   */
  private getCurrentStage(stages: PipelineResult["stages"]): string {
    if (!stages.loading) {
      return "loading";
    }
    if (!stages.chunking) {
      return "chunking";
    }
    if (!stages.embedding) {
      return "embedding";
    }
    if (!stages.storing) {
      return "storing";
    }
    return "complete";
  }

  /**
   * Dispose of all resources and clean up
   * Should be called when DocumentPipeline is no longer needed
   */
  public dispose(): void {
    this.logger.info("Disposing DocumentPipeline");

    // Dispose of vector store factory if it exists
    if (this.vectorStoreFactory) {
      this.vectorStoreFactory.dispose();
      this.vectorStoreFactory = null;
    }

    // Clear references
    this.documentLoader = null as any;
    this.semanticChunker = null as any;
    this.embeddingService = null as any;

    this.logger.info("DocumentPipeline disposed");
  }
}
