/**
 * PDF Document Loader
 * Uses pdf-parse v2 directly so the public package does not depend on
 * LangChain's legacy pdf-parse-v1 adapter.
 */

import { readFile } from "node:fs/promises";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../logger";
import { DocumentLoader, LoaderOptions } from "./types";

interface PDFParseInstance {
  getText(): Promise<{ pages: Array<{ num: number; text: string }>; total: number }>;
  destroy(): Promise<void>;
}

type PDFParseConstructor = new (options: { data: Uint8Array }) => PDFParseInstance;

async function loadPdfParser(): Promise<PDFParseConstructor> {
  const runtime = globalThis as typeof globalThis & Record<string, unknown>;
  if (!runtime.DOMMatrix || !runtime.ImageData || !runtime.Path2D) {
    const canvas = await import("@napi-rs/canvas");
    runtime.DOMMatrix ??= canvas.DOMMatrix;
    runtime.ImageData ??= canvas.ImageData;
    runtime.Path2D ??= canvas.Path2D;
  }
  return (await import("pdf-parse")).PDFParse as unknown as PDFParseConstructor;
}

export class PdfDocumentLoader implements DocumentLoader {
  private logger = new Logger("PdfDocumentLoader");

  async load(filePath: string, options: LoaderOptions): Promise<LangChainDocument[]> {
    this.logger.debug("Loading PDF", { filePath });

    let parser: PDFParseInstance | undefined;
    try {
      options.signal?.throwIfAborted();
      const data = await readFile(filePath);
      options.signal?.throwIfAborted();
      const PDFParse = await loadPdfParser();
      parser = new PDFParse({ data });
      const result = await parser.getText();
      options.signal?.throwIfAborted();
      const separator = options.parsedItemSeparator ?? "\n";
      const documents = options.splitPages
        ? result.pages.map(
            (page) =>
              new LangChainDocument({
                pageContent: page.text,
                metadata: { source: filePath, pdf: { totalPages: result.total }, loc: { pageNumber: page.num } },
              }),
          )
        : [
            new LangChainDocument({
              pageContent: result.pages.map((page) => page.text).join(separator),
              metadata: { source: filePath, pdf: { totalPages: result.total } },
            }),
          ];

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
      throw new Error(`Failed to load PDF: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await parser?.destroy();
    }
  }
}
