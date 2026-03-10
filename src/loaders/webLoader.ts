/**
 * Web Page Document Loader
 * Loads public web pages using CheerioWebBaseLoader with security checks.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";

export class WebDocumentLoader implements DocumentLoader {
  private logger = new Logger("WebDocumentLoader");

  async load(
    url: string,
    options: LoaderOptions
  ): Promise<LangChainDocument[]> {
    this.logger.debug("Loading web page", { url });

    try {
      // Security Check: Verify URL is accessible without auth
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "RAGnarok-VSCode-Extension/1.0",
        },
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Authentication required (Status ${response.status})`
        );
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch URL (Status ${response.status})`);
      }

      // Check for login redirects
      const finalUrl = response.url;
      if (
        finalUrl.includes("login") ||
        finalUrl.includes("signin") ||
        finalUrl.includes("auth")
      ) {
        throw new Error("Redirected to potential login page");
      }

      // Check content for password fields
      const html = await response.text();
      if (
        html.includes('type="password"') ||
        html.includes("type='password'")
      ) {
        throw new Error("Page contains password field, likely requires login");
      }

      // Load content using CheerioWebBaseLoader
      const loader = new CheerioWebBaseLoader(url, {
        selector: options.selector as any,
      });

      const documents = await loader.load();

      this.logger.info("Web page loaded successfully", {
        url,
        documentCount: documents.length,
        title: documents[0]?.metadata?.title,
      });

      return documents;
    } catch (error) {
      this.logger.error("Failed to load web page", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
      throw error;
    }
  }
}
