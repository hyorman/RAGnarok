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

async function initPdfParser(): Promise<PDFParseConstructor> {
  const runtime = globalThis as typeof globalThis & Record<string, unknown>;

  // pdfjs polyfills navigator itself, but by plain assignment, which throws in the
  // extension host because navigator there is an accessor with no setter. Define it
  // first - pdfjs leaves navigator alone once it reports a language. These are the
  // values pdfjs would have used; nothing here reads them.
  if (!(runtime.navigator as { language?: string } | undefined)?.language) {
    try {
      Object.defineProperty(runtime, "navigator", {
        value: { language: "en-US", platform: "", userAgent: "" },
        writable: true,
        configurable: true,
      });
    } catch {
      // Not configurable: leave it to pdfjs, which reports its own failure.
    }
  }

  // pdfjs picks its Node or browser code path once, while its modules evaluate, by
  // reading process.type: under Electron it counts anything but "browser" as a
  // renderer. The extension host has no DOM but does carry an Electron process.type,
  // so pdfjs takes the browser path and demands a worker it cannot spawn. Hide the
  // marker across the import so it sees the Node process it is actually in.
  // Removing the property is the cleanest signal, but this module is strict mode, so
  // deleting a non-configurable one would throw; "browser" (the main process) reads as
  // not-a-renderer and satisfies the same check. If it is neither, leave it alone.
  const processType = Object.getOwnPropertyDescriptor(process, "type");
  if (processType?.configurable) {
    delete (process as { type?: string }).type;
  } else if (processType?.writable) {
    (process as { type?: string }).type = "browser";
  }
  try {
    return (await import("pdf-parse")).PDFParse as unknown as PDFParseConstructor;
  } finally {
    if (processType?.configurable || processType?.writable) {
      Object.defineProperty(process, "type", processType);
    }
  }
}

let pdfParserPromise: Promise<PDFParseConstructor> | null = null;

/** Memoized so a folder index, which loads 50 PDFs at once, hides process.type once. */
function loadPdfParser(): Promise<PDFParseConstructor> {
  pdfParserPromise ??= initPdfParser().catch((error: unknown) => {
    pdfParserPromise = null; // let the next load retry a transient failure
    throw error;
  });
  return pdfParserPromise;
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
      // Callers recognise cancellation by identity against signal.reason.
      if (options.signal?.aborted === true && error === options.signal.reason) {
        throw error;
      }
      this.logger.error("Failed to load PDF", {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw Object.assign(new Error(`Failed to load PDF: ${error instanceof Error ? error.message : String(error)}`), {
        cause: error,
      });
    } finally {
      try {
        await parser?.destroy();
      } catch (destroyError) {
        // Never let teardown replace the real outcome of the load.
        this.logger.warn("Failed to release PDF parser", {
          error: destroyError instanceof Error ? destroyError.message : String(destroyError),
          filePath,
        });
      }
    }
  }
}
