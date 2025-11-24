/**
 * Document Pipeline - End-to-end document processing orchestrator
 * Coordinates loading, splitting, embedding, and vector storage
 *
 * Architecture: Pipeline pattern with progress tracking
 * Integrates: DocumentLoaderFactory → SemanticChunker → EmbeddingService → VectorStoreFactory
 */

import * as vscode from "vscode";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  DocumentLoaderFactory,
  LoaderOptions,
} from "../loaders/documentLoaderFactory";
import { SemanticChunker, ChunkingOptions } from "../splitters/semanticChunker";
import { EmbeddingService } from "../embeddings/embeddingService";
import { TransformersEmbeddings } from "../embeddings/langchainEmbeddings";
import { VectorStoreFactory } from "../stores/vectorStoreFactory";
import { Logger } from "../utils/logger";

export interface PipelineOptions {
  /** Document loading options */
  loaderOptions?: Partial<LoaderOptions>;

  /** Chunking options */
  chunkingOptions?: ChunkingOptions;

  /** Batch size for embedding generation */
  embeddingBatchSize?: number;

  /** Progress callback */
  onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
  stage: "loading" | "chunking" | "embedding" | "storing" | "complete";
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
    embedding: boolean;
    storing: boolean;
  };

  /** Result metadata */
  metadata: {
    originalDocuments: number;
    chunksCreated: number;
    chunksEmbedded: number;
    chunksStored: number;
    totalTime: number;
    stageTimings: {
      loading: number;
      chunking: number;
      embedding: number;
      storing: number;
    };
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

  constructor() {
    this.logger = new Logger("DocumentPipeline");
    this.documentLoader = new DocumentLoaderFactory();
    this.semanticChunker = new SemanticChunker();
    this.embeddingService = EmbeddingService.getInstance();

    this.logger.info("DocumentPipeline initialized");
  }

  /**
   * Initialize the pipeline with vector store factory using the configured embedding model
   */
  public async initialize(
    storageDir: string
  ): Promise<void> {
    try {
      await this.embeddingService.initialize();

      // Get the actual model name that was initialized
      const actualModelName = this.embeddingService.getCurrentModel();

      this.logger.info("Initializing pipeline", { storageDir, embeddingModel: actualModelName });

      // Create LangChain-compatible embeddings wrapper
      const embeddings = new TransformersEmbeddings();

      // Dispose previous factory before creating a new one
      if (this.vectorStoreFactory) {
        this.vectorStoreFactory.dispose();
      }

      this.vectorStoreFactory = new VectorStoreFactory(
        embeddings,
        storageDir,
        actualModelName
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
    options: PipelineOptions = {}
  ): Promise<PipelineResult> {
    return await this.processDocuments([filePath], topicId, options);
  }

  /**
   * Process multiple documents through the entire pipeline
   */
  public async processDocuments(
    filePaths: string[],
    topicId: string,
    options: PipelineOptions = {}
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const errors: string[] = [];

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
        embedding: false,
        storing: false,
      },
      metadata: {
        originalDocuments: filePaths.length,
        chunksCreated: 0,
        chunksEmbedded: 0,
        chunksStored: 0,
        totalTime: 0,
        stageTimings: {
          loading: 0,
          chunking: 0,
          embedding: 0,
          storing: 0,
        },
      },
      chunks: [],
      errors: [],
    };

    try {
      // Ensure initialized
      if (!this.vectorStoreFactory) {
        throw new Error("Pipeline not initialized. Call initialize() first.");
      }

      // Stage 1: Load documents
      const loadStartTime = Date.now();
      this.reportProgress(options.onProgress, {
        stage: "loading",
        progress: 0,
        message: `Loading ${filePaths.length} document(s)...`,
      });

      const loadedDocs = await this.loadDocuments(filePaths, options);
      result.stages.loading = true;
      result.metadata.stageTimings.loading = Date.now() - loadStartTime;

      this.logger.info("Documents loaded", {
        count: loadedDocs.length,
        time: result.metadata.stageTimings.loading,
        totalContentLength: loadedDocs.reduce(
          (sum, doc) => sum + doc.pageContent.length,
          0
        ),
        sources: loadedDocs.map((doc) => doc.metadata.source || "unknown"),
      });

      // Stop if no documents were loaded - this is a critical failure
      if (loadedDocs.length === 0) {
        const errorMessage = "No documents loaded - document loading failed. Check file paths, loader configuration, or API rate limits.";
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
        message: "Chunking documents...",
      });

      const chunkingResult = await this.semanticChunker.chunkDocuments(
        loadedDocs,
        options.chunkingOptions
      );

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
                chunkingResult.chunks.reduce(
                  (sum, c) => sum + c.pageContent.length,
                  0
                ) / chunkingResult.chunkCount
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

      // Stage 3: Generate embeddings
      this.reportProgress(options.onProgress, {
        stage: "embedding",
        progress: 50,
        message: "Generating embeddings...",
      });

      // Stage 4: Store in vector database
      const storeStartTime = Date.now();
      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 70,
        message: "Storing embeddings in vector database...",
      });

      await this.storeDocuments(result.chunks, topicId, options);
      result.metadata.chunksStored = result.chunks.length;
      result.metadata.chunksEmbedded = result.chunks.length; // Embeddings generated during storage
      result.stages.embedding = true;
      result.stages.storing = true;
      result.metadata.stageTimings.storing = Date.now() - storeStartTime;
      result.metadata.stageTimings.embedding =
        result.metadata.stageTimings.storing; // Same timing

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
        message: `Successfully processed ${filePaths.length} document(s)`,
        details: result.metadata,
      });

      this.logger.info("Pipeline completed successfully", {
        totalTime: result.metadata.totalTime,
        metadata: result.metadata,
      });

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
    }
  }

  // ==================== Private Methods ====================

  /**
   * Load documents using DocumentLoaderFactory
   */
  private async loadDocuments(
    filePaths: string[],
    options: PipelineOptions
  ): Promise<LangChainDocument[]> {
    const loaderOptions = filePaths.map((filePath) => ({
      filePath,
      ...options.loaderOptions,
    }));

    const results = await this.documentLoader.loadDocuments(loaderOptions);

    // Flatten all documents
    const allDocuments = results.flatMap((result) => result.documents);

    return allDocuments;
  }

  /**
   * Store documents in vector store
   * Note: Embeddings are generated automatically during this process
   */
  private async storeDocuments(
    chunks: LangChainDocument[],
    topicId: string,
    options: PipelineOptions
  ): Promise<void> {
    if (!this.vectorStoreFactory) {
      throw new Error("VectorStoreFactory not initialized");
    }

    // Validate embedding model compatibility before proceeding
    try {
      await this.vectorStoreFactory.validateEmbeddingModel(topicId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error validating embedding model";
      vscode.window.showErrorMessage(
        `Embedding validation failed for this topic: ${message}`
      );
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

      await this.vectorStoreFactory.addDocuments(topicId, vectorStore, chunks);
    } else {
      // Create new store (embeddings generated here via our wrapper)
      this.logger.debug("Creating new vector store", { topicId });

      this.reportProgress(options.onProgress, {
        stage: "storing",
        progress: 70,
        message: `Creating vector store and embedding ${chunks.length} chunks...`,
      });

      await this.vectorStoreFactory.createStore(
        { topicId, storageDir: "" },
        chunks
      );
    }

    // Save the store
    this.reportProgress(options.onProgress, {
      stage: "storing",
      progress: 90,
      message: "Saving vector store...",
    });

    const existingMetadata = await this.vectorStoreFactory.getStoreMetadata(topicId);

    await this.vectorStoreFactory.saveStore(topicId, {
      documentCount: (existingMetadata?.documentCount ?? 0) + 1,
      chunkCount: (existingMetadata?.chunkCount ?? 0) + chunks.length,
      createdAt: existingMetadata?.createdAt, // Preserved for existing stores, saveStore() will use Date.now() for new ones
      embeddingModel:
        existingMetadata?.embeddingModel ??
        this.vectorStoreFactory.getEmbeddingModel(),
    });
  }

  /**
   * Report progress to callback
   */
  private reportProgress(
    callback: ((progress: PipelineProgress) => void) | undefined,
    progress: PipelineProgress
  ): void {
    if (callback) {
      callback(progress);
    }
  }

  /**
   * Get current stage name
   */
  private getCurrentStage(stages: PipelineResult["stages"]): string {
    if (!stages.loading) return "loading";
    if (!stages.chunking) return "chunking";
    if (!stages.embedding) return "embedding";
    if (!stages.storing) return "storing";
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
