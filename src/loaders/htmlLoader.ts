/**
 * HTML Document Loader
 * Extracts text content from HTML files with tag/entity stripping.
 */

import * as path from "path";
import * as fs from "fs/promises";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";

export class HtmlDocumentLoader implements DocumentLoader {
  private logger = new Logger("HtmlDocumentLoader");

  async load(
    filePath: string,
    _options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading HTML", { filePath });

    try {
      const htmlContent = await fs.readFile(filePath, "utf-8");

      // Extract title
      const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath);

      // Remove script and style tags with their content
      let text = htmlContent
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

      // Remove HTML comments
      text = text.replace(/<!--[\s\S]*?-->/g, " ");

      // Remove all HTML tags
      text = text.replace(/<[^>]+>/g, " ");

      // Decode common HTML entities
      text = text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");

      // Clean up whitespace
      text = text
        .replace(/\s+/g, " ")
        .replace(/\n\s*\n/g, "\n")
        .trim();

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
}
