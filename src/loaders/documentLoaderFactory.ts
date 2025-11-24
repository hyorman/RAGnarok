/**
 * Document Loader Factory - Unified document loading using LangChain loaders
 * Supports PDF, Markdown, HTML, and plain text files
 *
 * Architecture: Factory pattern with automatic file type detection
 * Uses LangChain's battle-tested document loaders for better parsing
 */

import * as path from "path";
import * as fs from "fs/promises";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { GithubRepoLoader } from "@langchain/community/document_loaders/web/github";
import * as cheerio from "cheerio";
import { Logger } from "../utils/logger";

/**
 * Text file loader - extends LangChain's BaseDocumentLoader
 * Note: TextLoader is not available in @langchain/community v1.0 for Node.js,
 * so we implement it following LangChain's patterns
 */
class TextLoader extends BaseDocumentLoader {
  constructor(private filePath: string) {
    super();
  }

  async load(): Promise<LangChainDocument[]> {
    const text = await fs.readFile(this.filePath, "utf-8");
    return [
      new LangChainDocument({
        pageContent: text,
        metadata: { source: this.filePath }
      })
    ];
  }
}

export type SupportedFileType = "pdf" | "markdown" | "html" | "text" | "github" | "web";

export interface LoaderOptions {
  /** File path to load (or GitHub repo URL for github type) */
  filePath: string;

  /** Override automatic file type detection */
  fileType?: SupportedFileType;

  /** PDF-specific: Split pages into separate documents */
  splitPages?: boolean;

  /** PDF-specific: Separator between parsed items */
  parsedItemSeparator?: string;

  /** HTML-specific: CSS selector to extract content */
  selector?: string;

  /** GitHub-specific: Branch to load from (defaults to 'main') */
  branch?: string;

  /** GitHub-specific: Load files recursively */
  recursive?: boolean;

  /** GitHub-specific: Ignore patterns (.gitignore syntax) */
  ignorePaths?: string[];

  /** GitHub-specific: Access token for private repos (or use GITHUB_ACCESS_TOKEN env var) */
  accessToken?: string;

  /** GitHub-specific: Maximum concurrent requests (defaults to 2) */
  maxConcurrency?: number;

  /** GitHub-specific: Process submodules (requires recursive: true) */
  processSubmodules?: boolean;

  /** Additional metadata to attach to all documents */
  additionalMetadata?: Record<string, any>;
}

export interface LoadedDocument {
  /** LangChain documents */
  documents: LangChainDocument[];

  /** Detected or specified file type */
  fileType: SupportedFileType;

  /** Original file name */
  fileName: string;

  /** File size in bytes */
  fileSize: number;

  /** Load time in milliseconds */
  loadTime: number;
}

/**
 * Factory for loading documents using LangChain loaders
 */
export class DocumentLoaderFactory {
  private logger: Logger;

  constructor() {
    this.logger = new Logger("DocumentLoaderFactory");
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

      // Load documents based on type
      let documents: LangChainDocument[];

      switch (fileType) {
        case "pdf":
          documents = await this.loadPDF(filePath, options);
          break;
        case "markdown":
          documents = await this.loadMarkdown(filePath, options);
          break;
        case "html":
          documents = await this.loadHTML(filePath, options);
          break;
        case "text":
          documents = await this.loadText(filePath, options);
          break;
        case "github":
          documents = await this.loadGitHub(filePath, options);
          break;
        case "web":
          documents = await this.loadWebPage(filePath, options);
          break;
        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }

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

    const results = await Promise.allSettled(
      filePathsOrOptions.map((item) => {
        const options = typeof item === "string" ? { filePath: item } : item;
        return this.loadDocument(options);
      })
    );

    // Separate successful and failed loads
    const successful: LoadedDocument[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successful.push(result.value);
      } else {
        const item = filePathsOrOptions[index];
        const filePath = typeof item === "string" ? item : item.filePath;
        failed.push({
          path: filePath,
          error: result.reason.message || String(result.reason),
        });
      }
    });

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
   * Check if a file is supported (includes GitHub URLs)
   */
  public static isSupported(filePath: string): boolean {
    // Check if it's a GitHub URL
    if (this.isGitHubUrl(filePath)) {
      return true;
    }
    // Check if it's a generic Web URL
    if (this.isWebUrl(filePath)) {
      return true;
    }
    // Check file extension
    const ext = path.extname(filePath).toLowerCase();
    return this.getSupportedExtensions().includes(ext);
  }

  /**
   * Check if a path is a GitHub repository URL (GitHub.com or Enterprise)
   */
  public static isGitHubUrl(url: string): boolean {
    // Match repository URLs with pattern: https://domain/owner/repo
    // Works for:
    // - github.com/owner/repo
    // - github.company.com/owner/repo (GitHub Enterprise)
    // - any custom GitHub Enterprise domain
    return /^https?:\/\/[a-zA-Z0-9.-]+\/[\w-]+\/[\w.-]+/.test(url);
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
   * Detect file type from extension or URL pattern
   */
  private detectFileType(filePath: string): SupportedFileType {
    // Check if it's a GitHub URL
    if (DocumentLoaderFactory.isGitHubUrl(filePath)) {
      return "github";
    }

    // Check if it's a generic Web URL
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
   * Load PDF document using LangChain PDFLoader
   */
  private async loadPDF(
    filePath: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading PDF", { filePath });

    const loader = new PDFLoader(filePath, {
      // Don't split pages by default - we'll handle chunking separately
      splitPages: options.splitPages ?? false,
      // Use newline separator for better text extraction
      parsedItemSeparator: options.parsedItemSeparator ?? "\n",
    });

    try {
      const documents = await loader.load();

      this.logger.debug("PDF loaded", {
        filePath,
        pageCount: documents.length,
      });

      return documents;
    } catch (error) {
      this.logger.error("Failed to load PDF", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw new Error(
        `Failed to load PDF: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Load Markdown document using TextLoader
   * Markdown is treated as text, structure will be preserved for semantic chunking
   */
  private async loadMarkdown(
    filePath: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading Markdown", { filePath });

    const loader = new TextLoader(filePath);

    try {
      const documents = await loader.load();

      // Add markdown-specific metadata
      documents.forEach((doc: LangChainDocument) => {
        doc.metadata.isMarkdown = true;
        doc.metadata.preserveStructure = true;
      });

      this.logger.debug("Markdown loaded", {
        filePath,
        documentCount: documents.length,
      });

      return documents;
    } catch (error) {
      this.logger.error("Failed to load Markdown", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw new Error(
        `Failed to load Markdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Load HTML document using Cheerio loader for clean text extraction
   */
  private async loadHTML(
    filePath: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading HTML", { filePath });

    try {
      // Read file as text first
      const htmlContent = await fs.readFile(filePath, "utf-8");

      // Create a file:// URL for the loader
      const fileUrl = `file://${path.resolve(filePath)}`;

      // Use CheerioWebBaseLoader with custom HTML content
      // Note: We need to use a workaround since CheerioWebBaseLoader expects URLs
      // We'll create a simple document directly
      const $ = cheerio.load(htmlContent);

      // Extract text content, removing script and style tags
      $("script, style").remove();

      // Use selector if provided, otherwise get all text
      const selector = options.selector || "body";
      const text = $(selector).text().trim();

      // Extract title if available
      const title = $("title").text().trim() || path.basename(filePath);

      const document = new LangChainDocument({
        pageContent: text,
        metadata: {
          source: filePath,
          title,
          isHTML: true,
        },
      });

      this.logger.debug("HTML loaded", {
        filePath,
        textLength: text.length,
        title,
      });

      return [document];
    } catch (error) {
      this.logger.error("Failed to load HTML", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw new Error(
        `Failed to load HTML: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Load plain text document using TextLoader
   */
  private async loadText(
    filePath: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading text", { filePath });

    const loader = new TextLoader(filePath);

    try {
      const documents = await loader.load();

      this.logger.debug("Text loaded", {
        filePath,
        documentCount: documents.length,
      });

      return documents;
    } catch (error) {
      this.logger.error("Failed to load text", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw new Error(
        `Failed to load text: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Load GitHub repository using LangChain GithubRepoLoader
   * Supports loading entire repos or specific branches with filtering
   *
   * @param repoUrl - GitHub repository URL (e.g., https://github.com/owner/repo)
   * @param options - Loader options including branch, recursive, ignorePaths, etc.
   */
  private async loadGitHub(
    repoUrl: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading GitHub repository", {
      repoUrl,
      branch: options.branch || "main",
      recursive: options.recursive,
      ignorePaths: options.ignorePaths,
      hasAccessToken: !!options.accessToken,
    });

    try {
      // Extract base URL and API URL for GitHub Enterprise support
      const urlObj = new URL(repoUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      // Determine API URL based on host
      // For GitHub.com, use api.github.com
      // For GitHub Enterprise, use the same host with /api/v3
      const apiUrl = urlObj.host === "github.com"
        ? "https://api.github.com"
        : `${baseUrl}/api/v3`;

      this.logger.debug("GitHub configuration", {
        baseUrl,
        apiUrl,
        host: urlObj.host,
      });

      this.logger.info("Starting GitHub repository load - this may take a while for large repositories...", {
        repoUrl,
        branch: options.branch || "main",
      });

      const startTime = Date.now();

      const loader = new GithubRepoLoader(repoUrl, {
        baseUrl,
        apiUrl,
        branch: options.branch || "main",
        recursive: options.recursive ?? true,
        unknown: "warn" as const,
        ignorePaths: options.ignorePaths,
        accessToken: options.accessToken || process.env.GITHUB_ACCESS_TOKEN,
        maxConcurrency: options.maxConcurrency || 10,
        processSubmodules: options.processSubmodules ?? false,
        verbose: true, // Enable verbose logging to see progress
      });

      // Add periodic progress logging
      const progressInterval = setInterval(() => {
        this.logger.info("Still loading GitHub repository...", {
          repoUrl,
          elapsed: `${Math.floor((Date.now() - startTime) / 1000)}s`,
        });
      }, 10000); // Log every 10 seconds

      try {
        const documents = await loader.load();
        clearInterval(progressInterval);

        this.logger.info("GitHub repository loaded successfully", {
          repoUrl,
          documentCount: documents.length,
          branch: options.branch || "main",
          totalContentLength: documents.reduce(
            (sum, doc) => sum + doc.pageContent.length,
            0
          ),
          fileSources: documents.slice(0, 5).map((doc) => doc.metadata.source),
        });

        // Log warning if no documents loaded
        if (documents.length === 0) {
          this.logger.warn("GitHub repository loaded but no documents found", {
            repoUrl,
            branch: options.branch || "main",
            recursive: options.recursive,
            ignorePaths: options.ignorePaths,
            suggestion:
              "Check if repository is empty, branch exists, or ignorePaths is too restrictive",
          });
        }

        return documents;
      } finally {
        clearInterval(progressInterval);
      }
    } catch (error) {
      this.logger.error("Failed to load GitHub repository", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        repoUrl,
        branch: options.branch,
      });
      throw error;
    }
  }

  /**
   * Load a public web page
   * Includes security checks to reject pages requiring authentication
   */
  private async loadWebPage(
    url: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading web page", { url });

    try {
      // 1. Security Check: Verify URL is accessible without auth
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'RAGnarok-VSCode-Extension/1.0'
        }
      });

      // Check status code
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication required (Status ${response.status})`);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch URL (Status ${response.status})`);
      }

      // Check for login redirects
      const finalUrl = response.url;
      if (finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth')) {
        throw new Error('Redirected to potential login page');
      }

      // Check content for password fields
      const html = await response.text();
      if (html.includes('type="password"') || html.includes('type=\'password\'')) {
        throw new Error('Page contains password field, likely requires login');
      }

      // 2. Load content using CheerioWebBaseLoader
      const loader = new CheerioWebBaseLoader(url, {
        selector: options.selector as any
      });

      const documents = await loader.load();

      this.logger.info("Web page loaded successfully", {
        url,
        documentCount: documents.length,
        title: documents[0]?.metadata?.title
      });

      return documents;

    } catch (error) {
      this.logger.error("Failed to load web page", {
        error: error instanceof Error ? error.message : String(error),
        url
      });
      throw error;
    }
  }
}
