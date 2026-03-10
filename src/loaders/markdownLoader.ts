/**
 * Markdown Document Loader
 * Loads markdown files as text with structure-preserving metadata.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";
import { LangChainTextLoader } from "./textLoader";

export class MarkdownDocumentLoader implements DocumentLoader {
  private logger = new Logger("MarkdownDocumentLoader");

  async load(
    filePath: string,
    _options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading Markdown", { filePath });

    const loader = new LangChainTextLoader(filePath);

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
}
