/**
 * Semantic Chunker - Intelligent text splitting using LangChain splitters
 * Preserves document structure and semantic boundaries
 *
 * Architecture: Strategy pattern with automatic splitter selection
 * - Markdown: Respects heading hierarchy
 * - Code: Preserves syntax structure
 * - General: Smart boundary detection
 */

import * as vscode from 'vscode';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { Logger } from '../utils/logger';
import { CONFIG } from '../utils/constants';

export interface ChunkingOptions {
  /** Target chunk size in characters */
  chunkSize?: number;

  /** Overlap between chunks for context continuity */
  chunkOverlap?: number;

  /** Preserve document structure (headings, sections) */
  preserveStructure?: boolean;

  /** File type hint for optimal chunking */
  fileType?: 'markdown' | 'code' | 'text' | 'html';

  /** Custom separators for splitting */
  customSeparators?: string[];

  /** Add heading metadata to chunks */
  includeHeadingMetadata?: boolean;
}

export interface ChunkingResult {
  /** Chunked documents */
  chunks: LangChainDocument[];

  /** Chunking strategy used */
  strategy: string;

  /** Total chunks created */
  chunkCount: number;

  /** Original document count */
  documentCount: number;

  /** Processing time in milliseconds */
  processingTime: number;

  /** Statistics */
  stats: {
    avgChunkSize: number;
    minChunkSize: number;
    maxChunkSize: number;
    totalCharacters: number;
  };
}

/**
 * Semantic Chunker for intelligent text splitting
 */
export class SemanticChunker {
  private logger: Logger;
  private defaultChunkSize: number;
  private defaultChunkOverlap: number;
  private chunkIdCounter = 0;

  constructor() {
    this.logger = new Logger('SemanticChunker');

    // Load configuration
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    this.defaultChunkSize = config.get<number>(CONFIG.CHUNK_SIZE, 1000);
    this.defaultChunkOverlap = config.get<number>(CONFIG.CHUNK_OVERLAP, 200);

    this.logger.info('SemanticChunker initialized', {
      defaultChunkSize: this.defaultChunkSize,
      defaultChunkOverlap: this.defaultChunkOverlap,
    });
  }

  /**
   * Chunk documents using the appropriate strategy
   */
  public async chunkDocuments(
    documents: LangChainDocument[],
    options: ChunkingOptions = {}
  ): Promise<ChunkingResult> {
    const startTime = Date.now();

    this.logger.info('Chunking documents', {
      documentCount: documents.length,
      options,
    });

    try {
      // Determine chunking strategy
      const strategy = this.determineStrategy(documents, options);

      this.logger.debug('Using chunking strategy', { strategy });

      // Get or create splitter
      const splitter = this.createSplitter(strategy, options);

      // Split documents in batches to avoid stack overflow with large document sets
      const BATCH_SIZE = 200; // Increased for better performance with large repos
      const chunks: LangChainDocument[] = [];

      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, Math.min(i + BATCH_SIZE, documents.length));
        const progressPercent = Math.round((i / documents.length) * 100);

        this.logger.info('Processing document batch', {
          batchStart: i,
          batchEnd: Math.min(i + BATCH_SIZE, documents.length),
          totalDocuments: documents.length,
          chunksCollected: chunks.length,
          progress: `${progressPercent}%`,
        });

        const batchChunks = await splitter.splitDocuments(batch);

        // Use direct assignment for better performance
        for (let j = 0; j < batchChunks.length; j++) {
          chunks.push(batchChunks[j]);
        }

        // Yield to event loop periodically to keep UI responsive
        if (i % 500 === 0 && i > 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      this.logger.info('Splitting complete, enriching chunks...', {
        totalChunks: chunks.length,
      });

      // Add chunk metadata in batches to avoid stack overflow
      const enrichedChunks = this.enrichChunksInBatches(chunks, options);

      // Calculate statistics
      const stats = this.calculateStats(enrichedChunks);

      const processingTime = Date.now() - startTime;

      this.logger.info('Chunking completed', {
        strategy,
        documentCount: documents.length,
        chunkCount: enrichedChunks.length,
        processingTime,
        stats,
      });

      return {
        chunks: enrichedChunks,
        strategy,
        chunkCount: enrichedChunks.length,
        documentCount: documents.length,
        processingTime,
        stats,
      };
    } catch (error) {
      this.logger.error('Failed to chunk documents', {
        error: error instanceof Error ? error.message : String(error),
        documentCount: documents.length,
      });
      throw error;
    }
  }

  /**
   * Chunk a single document
   */
  public async chunkDocument(
    document: LangChainDocument,
    options: ChunkingOptions = {}
  ): Promise<LangChainDocument[]> {
    const result = await this.chunkDocuments([document], options);
    return result.chunks;
  }

  /**
   * Get recommended chunk size based on use case
   */
  public static getRecommendedChunkSize(useCase: 'qa' | 'summarization' | 'search'): number {
    switch (useCase) {
      case 'qa':
        // Smaller chunks for precise Q&A
        return 500;
      case 'summarization':
        // Larger chunks for summarization
        return 2000;
      case 'search':
        // Medium chunks for search
        return 1000;
      default:
        return 1000;
    }
  }

  // ==================== Private Methods ====================

  /**
   * Determine the best chunking strategy based on documents and options
   * Optimized: Only samples first 20 documents instead of scanning all for performance
   */
  private determineStrategy(
    documents: LangChainDocument[],
    options: ChunkingOptions
  ): 'markdown' | 'recursive' | 'code' {
    // Explicit file type
    if (options.fileType === 'markdown') {
      return 'markdown';
    }

    if (options.fileType === 'code') {
      return 'code';
    }

    // Sample from beginning, middle, and end for better diversity
    const sampleSize = Math.min(Math.max(50, Math.ceil(documents.length * 0.1)), 200);
    const indices = new Set<number>();
    for (let i = 0; i < sampleSize && indices.size < documents.length; i++) {
      if (i < sampleSize / 3) {
        indices.add(i); // Beginning
      } else if (i < (2 * sampleSize) / 3) {
        indices.add(Math.floor(documents.length / 2) + i - Math.floor(sampleSize / 3)); // Middle
      } else {
        indices.add(documents.length - 1 - (i - Math.floor(2 * sampleSize / 3))); // End
      }
    }
    const sampleDocs = [...indices].filter(i => i >= 0 && i < documents.length).map(i => documents[i]);

    // Check document metadata
    const hasMarkdown = sampleDocs.some(
      (doc) => doc.metadata.isMarkdown || doc.metadata.fileType === 'markdown'
    );

    if (hasMarkdown && options.preserveStructure !== false) {
      return 'markdown';
    }

    // Check if content looks like code
    const hasCode = sampleDocs.some((doc) => {
      const content = doc.pageContent;
      // Simple heuristic: check for common code patterns
      const codePatterns = [
        /^(function|class|def|import|const|let|var)\s+/m,
        /^\s*(public|private|protected)\s+/m,
        /\{[\s\S]*\}/m, // Curly braces
      ];
      return codePatterns.some((pattern) => pattern.test(content));
    });

    if (hasCode) {
      return 'code';
    }

    // Default to recursive character splitter
    return 'recursive';
  }

  /**
   * Create the appropriate splitter based on strategy
   */
  private createSplitter(
    strategy: 'markdown' | 'recursive' | 'code',
    options: ChunkingOptions
  ) {
    const chunkSize = options.chunkSize ?? this.defaultChunkSize;
    const chunkOverlap = options.chunkOverlap ?? this.defaultChunkOverlap;

    switch (strategy) {
      case 'markdown':
        return this.createMarkdownSplitter(chunkSize, chunkOverlap);

      case 'code':
        return this.createCodeSplitter(chunkSize, chunkOverlap);

      case 'recursive':
      default:
        return this.createRecursiveSplitter(
          chunkSize,
          chunkOverlap,
          options.customSeparators
        );
    }
  }

  /**
   * Create a Markdown text splitter that respects heading hierarchy
   */
  private createMarkdownSplitter(
    chunkSize: number,
    chunkOverlap: number
  ): MarkdownTextSplitter {
    return new MarkdownTextSplitter({
      chunkSize,
      chunkOverlap,
      // Preserve heading hierarchy
      // MarkdownTextSplitter automatically handles heading detection
    });
  }

  /**
   * Create a code-aware splitter
   */
  private createCodeSplitter(
    chunkSize: number,
    chunkOverlap: number
  ): RecursiveCharacterTextSplitter {
    // Code-specific separators that respect syntax structure
    const codeSeparators = [
      '\n\n',           // Double newline (between functions/classes)
      '\nclass ',       // Class definitions
      '\nfunction ',    // Function definitions
      '\ndef ',         // Python function definitions
      '\n\n',           // Paragraph breaks
      '\n',             // Single newline
      '. ',             // Sentence breaks
      ' ',              // Word breaks
      '',               // Character breaks
    ];

    return new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: codeSeparators,
    });
  }

  /**
   * Create a recursive character splitter with smart boundaries
   */
  private createRecursiveSplitter(
    chunkSize: number,
    chunkOverlap: number,
    customSeparators?: string[]
  ): RecursiveCharacterTextSplitter {
    // Default smart separators that respect semantic boundaries
    const defaultSeparators = [
      '\n\n',     // Paragraph breaks (highest priority)
      '\n',       // Line breaks
      '. ',       // Sentence breaks
      '! ',       // Exclamation breaks
      '? ',       // Question breaks
      '; ',       // Semicolon breaks
      ', ',       // Comma breaks
      ' ',        // Word breaks
      '',         // Character breaks (last resort)
    ];

    const separators = customSeparators || defaultSeparators;

    return new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators,
    });
  }

  /**
   * Enrich chunks with additional metadata (batched to avoid stack overflow)
   */
  private enrichChunksInBatches(
    chunks: LangChainDocument[],
    options: ChunkingOptions
  ): LangChainDocument[] {
    const BATCH_SIZE = 1000;
    const enriched: LangChainDocument[] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
      const batchEnriched = batch.map((chunk, batchIndex) => {
        const globalIndex = i + batchIndex;
        return this.enrichSingleChunk(chunk, globalIndex, options);
      });

      // Use direct assignment instead of spread
      for (const enrichedChunk of batchEnriched) {
        enriched.push(enrichedChunk);
      }
    }

    return enriched;
  }

  /**
   * Enrich a single chunk with metadata
   */
  private enrichSingleChunk(
    chunk: LangChainDocument,
    index: number,
    options: ChunkingOptions
  ): LangChainDocument {
    // Extract heading information if present
    const headingInfo = this.extractHeadingInfo(chunk.pageContent);

    const metadata: Record<string, any> = {
      ...chunk.metadata,
      chunkIndex: index,
      chunkSize: chunk.pageContent.length,
      chunkId: this.generateChunkId(chunk, index),
      chunkedAt: Date.now(),
    };

    // Add heading metadata if requested and available
    if (options.includeHeadingMetadata !== false && headingInfo) {
      metadata.headingPath = headingInfo.headingPath;
      metadata.headingLevel = headingInfo.headingLevel;
      metadata.sectionTitle = headingInfo.sectionTitle;
    }

    return new LangChainDocument({
      pageContent: chunk.pageContent,
      metadata,
    });
  }

  /**
   * Extract heading information from markdown content
   */
  private extractHeadingInfo(content: string): {
    headingPath: string[];
    headingLevel: number;
    sectionTitle: string;
  } | null {
    // Extract the first heading if present
    const headingMatch = content.match(/^(#{1,6})\s+(.+)$/m);

    if (!headingMatch) {
      return null;
    }

    const level = headingMatch[1].length;
    const title = headingMatch[2].trim();

    return {
      headingPath: [title],
      headingLevel: level,
      sectionTitle: title,
    };
  }

  /**
   * Generate a unique ID for a chunk
   */
  private generateChunkId(chunk: LangChainDocument, index: number): string {
    const fileName = chunk.metadata.fileName || 'unknown';
    const counter = ++this.chunkIdCounter;
    return `${fileName}-${index}-${counter}`;
  }

  /**
   * Calculate statistics about the chunks
   */
  private calculateStats(chunks: LangChainDocument[]): {
    avgChunkSize: number;
    minChunkSize: number;
    maxChunkSize: number;
    totalCharacters: number;
  } {
    if (chunks.length === 0) {
      return {
        avgChunkSize: 0,
        minChunkSize: 0,
        maxChunkSize: 0,
        totalCharacters: 0,
      };
    }

    // Avoid stack overflow by calculating stats iteratively instead of using spread
    let totalCharacters = 0;
    let minChunkSize = Number.MAX_SAFE_INTEGER;
    let maxChunkSize = 0;

    for (const chunk of chunks) {
      const size = chunk.pageContent.length;
      totalCharacters += size;
      if (size < minChunkSize) {
        minChunkSize = size;
      }
      if (size > maxChunkSize) {
        maxChunkSize = size;
      }
    }

    return {
      avgChunkSize: Math.round(totalCharacters / chunks.length),
      minChunkSize,
      maxChunkSize,
      totalCharacters,
    };
  }
}
