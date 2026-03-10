/**
 * Text Document Loader
 * Uses a simple file-read approach following LangChain patterns.
 */

import * as fs from "fs/promises";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";

/**
 * LangChain-compatible text loader (TextLoader is not available in @langchain/community v1.0 for Node.js)
 */
export class LangChainTextLoader extends BaseDocumentLoader {
  constructor(private filePath: string) {
    super();
  }

  async load(): Promise<LangChainDocument[]> {
    const text = await fs.readFile(this.filePath, "utf-8");
    return [
      new LangChainDocument({
        pageContent: text,
        metadata: { source: this.filePath },
      }),
    ];
  }
}

export class TextDocumentLoader implements DocumentLoader {
  private logger = new Logger("TextDocumentLoader");

  async load(
    filePath: string,
    _options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading text", { filePath });

    const loader = new LangChainTextLoader(filePath);

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
}
