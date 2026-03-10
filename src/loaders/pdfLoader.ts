/**
 * PDF Document Loader
 * Uses LangChain PDFLoader for PDF parsing.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";

export class PdfDocumentLoader implements DocumentLoader {
  private logger = new Logger("PdfDocumentLoader");

  async load(
    filePath: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading PDF", { filePath });

    const loader = new PDFLoader(filePath, {
      splitPages: options.splitPages ?? false,
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
}
