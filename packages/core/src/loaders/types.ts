/**
 * Shared types for the document loading system.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";

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

  /** Load files recursively from directories (applies when filePath is a directory). For GitHub repos, use 'recursive' option. */
  recursiveDirectory?: boolean;

  /** File extensions to include when loading directories (e.g., ['.html', '.md']). If not specified, all supported extensions are included. */
  includeExtensions?: string[];
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
 * Interface that all document loaders must implement.
 */
export interface DocumentLoader {
  load(filePath: string, options: LoaderOptions): Promise<LangChainDocument[]>;
}
