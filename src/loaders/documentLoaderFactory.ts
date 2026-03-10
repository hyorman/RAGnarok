/**
 * Document Loader Factory - Unified document loading orchestrator
 * Delegates to specialized loader modules for each file type.
 *
 * Architecture: Factory pattern with automatic file type detection
 */

import * as path from "path";
import * as fs from "fs/promises";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../utils/logger";
import { TextDocumentLoader } from "./textLoader";
import { MarkdownDocumentLoader } from "./markdownLoader";
import { HtmlDocumentLoader } from "./htmlLoader";
import { PdfDocumentLoader } from "./pdfLoader";
import { GithubDocumentLoader } from "./githubLoader";
import { WebDocumentLoader } from "./webLoader";
import type { DocumentLoader, LoaderOptions, LoadedDocument, SupportedFileType } from "./types";

// Re-export types for backward compatibility
export type { SupportedFileType, LoaderOptions, LoadedDocument } from "./types";

/**
 * Factory for loading documents — delegates to specialized loader modules.
 */
export class DocumentLoaderFactory {
  private logger: Logger;
  private loaders: Record<SupportedFileType, DocumentLoader>;

  constructor() {
    this.logger = new Logger("DocumentLoaderFactory");
    this.loaders = {
      text: new TextDocumentLoader(),
      markdown: new MarkdownDocumentLoader(),
      html: new HtmlDocumentLoader(),
      pdf: new PdfDocumentLoader(),
      github: new GithubDocumentLoader(),
      web: new WebDocumentLoader(),
    };
  }

  /**
   * Load a document from file path
   */
  public async loadDocument(options: LoaderOptions): Promise<LoadedDocument> {
    const startTime = Date.now();
    const { filePath, additionalMetadata = {} } = options;

    this.logger.info("Loading document", { filePath });

    try {
      // Detect file type first (before validation, as GitHub URLs don't need file validation)
      const fileType = options.fileType || this.detectFileType(filePath);

      // Validate file exists (skip for GitHub URLs and Web URLs)
      if (fileType !== "github" && fileType !== "web") {
        await this.validateFile(filePath);
      }

      const fileName = path.basename(filePath);

      this.logger.debug("Detected file type", { fileName, fileType });

      // Get file size (skip for GitHub URLs and Web URLs as they're not local files)
      let fileSize = 0;
      if (fileType !== "github" && fileType !== "web") {
        const stats = await fs.stat(filePath);
        fileSize = stats.size;
      }

      // Delegate to the appropriate loader
      const loader = this.loaders[fileType];
      if (!loader) {
        throw new Error(`Unsupported file type: ${fileType}`);
      }
      const documents = await loader.load(filePath, options);

      // Add common metadata to all documents
      const enrichedDocuments = documents.map((doc) => {
        return new LangChainDocument({
          pageContent: doc.pageContent,
          metadata: {
            ...doc.metadata,
            fileName,
            filePath,
            fileType,
            fileSize,
            loadedAt: Date.now(),
            ...additionalMetadata,
          },
        });
      });

      const loadTime = Date.now() - startTime;

      this.logger.info("Document loaded successfully", {
        fileName,
        fileType,
        documentCount: enrichedDocuments.length,
        fileSize,
        loadTime,
      });

      return {
        documents: enrichedDocuments,
        fileType,
        fileName,
        fileSize,
        loadTime,
      };
    } catch (error) {
      this.logger.error("Failed to load document", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw error;
    }
  }

  /**
   * Load multiple documents in batch
   */
  public async loadDocuments(
    filePathsOrOptions: (string | LoaderOptions)[]
  ): Promise<LoadedDocument[]> {
    this.logger.info("Loading multiple documents", {
      count: filePathsOrOptions.length,
    });

    // Expand directories to file paths
    const expandedPaths: LoaderOptions[] = [];
    for (const item of filePathsOrOptions) {
      const options = typeof item === "string" ? { filePath: item } : item;

      // Check if path is a directory (skip for URLs)
      if (!DocumentLoaderFactory.isWebUrl(options.filePath)) {
        const isDir = await this.isDirectory(options.filePath);
        if (isDir) {
          // Collect files from directory
          const files = await this.collectFilesFromDirectory(
            options.filePath,
            options.recursiveDirectory ?? false,
            options.includeExtensions
          );
          this.logger.info("Collected files from directory", {
            directory: options.filePath,
            fileCount: files.length,
            recursive: options.recursiveDirectory ?? false,
          });
          // Add each file with the same options (except filePath)
          for (const file of files) {
            expandedPaths.push({ ...options, filePath: file });
          }
          continue;
        }
      }

      // Not a directory (or is a URL), add as-is
      expandedPaths.push(options);
    }

    if (expandedPaths.length === 0) {
      this.logger.warn("No files to load after directory expansion");
      return [];
    }

    this.logger.info("Loading documents after directory expansion", {
      totalFiles: expandedPaths.length,
    });

    // Process files in batches to avoid "too many open files" error
    const BATCH_SIZE = 50; // Process 50 files at a time
    const successful: LoadedDocument[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (let i = 0; i < expandedPaths.length; i += BATCH_SIZE) {
      const batch = expandedPaths.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(expandedPaths.length / BATCH_SIZE);

      this.logger.info(`Processing batch ${batchNumber}/${totalBatches}`, {
        batchSize: batch.length,
        processedSoFar: i,
        total: expandedPaths.length,
      });

      const results = await Promise.allSettled(
        batch.map((options) => this.loadDocument(options))
      );

      // Separate successful and failed loads for this batch
      results.forEach((result, batchIndex) => {
        const actualIndex = i + batchIndex;
        if (result.status === "fulfilled") {
          successful.push(result.value);
        } else {
          const options = expandedPaths[actualIndex];
          failed.push({
            path: options.filePath,
            error: result.reason.message || String(result.reason),
          });
        }
      });
    }

    if (failed.length > 0) {
      this.logger.warn("Some documents failed to load", {
        successCount: successful.length,
        failedCount: failed.length,
        failures: failed,
      });

      // Check if any failures are critical (rate limits, auth errors, etc.)
      const hasCriticalError = failed.some(f =>
        f.error.includes("rate limit") ||
        f.error.includes("403") ||
        f.error.includes("401") ||
        f.error.includes("API")
      );

      // If all documents failed OR there's a critical error, throw
      if (successful.length === 0 || (hasCriticalError && failed.length === filePathsOrOptions.length)) {
        const errorMessage = failed.map(f => `${f.path}: ${f.error}`).join("; ");
        throw new Error(`Failed to load documents: ${errorMessage}`);
      }
    } else {
      this.logger.info("All documents loaded successfully", {
        count: successful.length,
      });
    }

    return successful;
  }

  /**
   * Get supported file extensions
   */
  public static getSupportedExtensions(): string[] {
    return [".pdf", ".md", ".markdown", ".html", ".htm", ".txt"];
  }

  /**
   * Check if a file is supported (includes URLs)
   */
  public static isSupported(filePath: string): boolean {
    // Check if it's a Web URL (includes GitHub URLs)
    if (this.isWebUrl(filePath)) {
      return true;
    }
    // Check file extension
    const ext = path.extname(filePath).toLowerCase();
    return this.getSupportedExtensions().includes(ext);
  }

  /**
   * Check if a path is a generic Web URL
   */
  public static isWebUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === "http:" || urlObj.protocol === "https:";
    } catch {
      return false;
    }
  }

  // ==================== Private Methods ====================

  /**
   * Validate that file exists and is readable
   */
  private async validateFile(filePath: string): Promise<void> {
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (error) {
      throw new Error(`File not found or not readable: ${filePath}`);
    }
  }

  /**
   * Detect file type from extension or URL pattern.
   * Note: GitHub repos are detected via explicit fileType option from addGithubRepo.
   */
  private detectFileType(filePath: string): SupportedFileType {
    // Check if it's a Web URL
    if (DocumentLoaderFactory.isWebUrl(filePath)) {
      return "web";
    }

    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case ".pdf":
        return "pdf";
      case ".md":
      case ".markdown":
        return "markdown";
      case ".html":
      case ".htm":
        return "html";
      case ".txt":
        return "text";
      default:
        // Default to text for unknown extensions
        this.logger.warn("Unknown file extension, treating as text", { ext });
        return "text";
    }
  }

  /**
   * Check if a path is a directory
   */
  private async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Recursively collect files from a directory
   * @param dirPath - Directory path to scan
   * @param recursive - Whether to scan subdirectories
   * @param includeExtensions - File extensions to include (e.g., ['.html', '.md']). If not specified, all supported extensions are included.
   * @returns Array of file paths
   */
  private async collectFilesFromDirectory(
    dirPath: string,
    recursive: boolean,
    includeExtensions?: string[],
    depth: number = 0
  ): Promise<string[]> {
    if (depth > 20) { return []; }
    const files: string[] = [];
    const extensionsToInclude = includeExtensions || DocumentLoaderFactory.getSupportedExtensions();

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (recursive) {
            const stats = await fs.lstat(fullPath);
            if (stats.isSymbolicLink()) { continue; }
            // Recursively collect files from subdirectory
            const subFiles = await this.collectFilesFromDirectory(
              fullPath,
              recursive,
              includeExtensions,
              depth + 1
            );
            files.push(...subFiles);
          }
        } else if (entry.isFile()) {
          // Check if file extension is supported
          const ext = path.extname(entry.name).toLowerCase();
          if (extensionsToInclude.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      this.logger.error("Failed to read directory", {
        error: error instanceof Error ? error.message : String(error),
        dirPath,
      });
      throw new Error(
        `Failed to read directory ${dirPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return files;
  }
}
