/**
 * GitHub Repository Document Loader
 * Uses LangChain GithubRepoLoader with Enterprise support.
 */

import { Document as LangChainDocument } from "@langchain/core/documents";
import { GithubRepoLoader } from "@langchain/community/document_loaders/web/github";
import { Logger } from "../utils/logger";
import { DocumentLoader, LoaderOptions } from "./types";

export class GithubDocumentLoader implements DocumentLoader {
  private logger = new Logger("GithubDocumentLoader");

  async load(
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
      const urlObj = new URL(repoUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      const apiUrl =
        urlObj.host === "github.com"
          ? "https://api.github.com"
          : `${baseUrl}/api/v3`;

      this.logger.debug("GitHub configuration", {
        baseUrl,
        apiUrl,
        host: urlObj.host,
      });

      this.logger.info(
        "Starting GitHub repository load - this may take a while for large repositories...",
        { repoUrl, branch: options.branch || "main" }
      );

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
        verbose: true,
      });

      const progressInterval = setInterval(() => {
        this.logger.info("Still loading GitHub repository...", {
          repoUrl,
          elapsed: `${Math.floor((Date.now() - startTime) / 1000)}s`,
        });
      }, 10000);

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
          fileSources: documents
            .slice(0, 5)
            .map((doc) => doc.metadata.source),
        });

        if (documents.length === 0) {
          this.logger.warn(
            "GitHub repository loaded but no documents found",
            {
              repoUrl,
              branch: options.branch || "main",
              recursive: options.recursive,
              ignorePaths: options.ignorePaths,
              suggestion:
                "Check if repository is empty, branch exists, or ignorePaths is too restrictive",
            }
          );
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
}
