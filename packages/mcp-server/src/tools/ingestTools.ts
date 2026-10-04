import fs from "node:fs/promises";
import path from "node:path";
import { type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpConfig } from "../config";
import { MCP_LIMITS, type ToolContext } from "./shared";

const ingestInput = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("files"),
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to add documents to"),
      filePaths: z
        .array(z.string().trim().min(1).max(MCP_LIMITS.path))
        .min(1)
        .max(100)
        .describe("Array of file paths to add"),
    })
    .strict(),
  z
    .object({
      source: z.literal("url"),
      topic: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to add the page to"),
      url: z.string().url().max(MCP_LIMITS.url).describe("Public HTTP(S) page URL"),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      topic: z
        .string()
        .trim()
        .min(1)
        .max(MCP_LIMITS.topicName)
        .describe("The name of the topic to add the repository to"),
      url: z.string().url().max(MCP_LIMITS.url).describe("HTTPS URL of an allowlisted GitHub or GHES repository"),
      branch: z.string().min(1).max(255).optional().describe("Branch to index (default branch if omitted)"),
    })
    .strict(),
]);

/**
 * Builds the path guard shared by rag_ingest (files) and rag_topic (import).
 *
 * Paths are restricted to the configured allowlist roots
 * (security.allowedPaths, defaulting to the working directory), so an agent
 * steered by injected content cannot index — and so read back — arbitrary
 * files. Symlinks are resolved before the containment check so a link inside
 * an allowed root cannot escape it.
 */
export function createPathGuard(config: McpConfig | undefined): (filePath: string) => Promise<string> {
  let allowedRootsPromise: Promise<string[]> | undefined;
  const getAllowedRoots = (): Promise<string[]> => {
    allowedRootsPromise ??= (async () => {
      const configured = config?.allowedPaths?.length
        ? [...config.allowedPaths]
        : [config?.workingDir || process.cwd()];
      if (config?.exportDir) {
        configured.push(config.exportDir);
      }
      const roots: string[] = [];
      for (const root of configured) {
        try {
          roots.push(await fs.realpath(path.resolve(root)));
        } catch {
          // Nonexistent roots can't contain anything — skip.
        }
      }
      return roots;
    })();
    return allowedRootsPromise;
  };

  return async function assertPathAllowed(filePath: string): Promise<string> {
    let real: string;
    try {
      real = await fs.realpath(path.resolve(filePath));
    } catch {
      throw new Error(`File not found or unreadable: ${filePath}`);
    }
    const roots = await getAllowedRoots();
    const contained = roots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!contained) {
      throw new Error(
        `Path not allowed: ${filePath}. Allowed roots: ${roots.join(", ") || "(none)"} — set "security.allowedPaths" in config.json to widen access.`,
      );
    }
    return real;
  };
}

export function registerIngestTools(ctx: ToolContext): void {
  type IngestInput = z.infer<typeof ingestInput>;

  async function ingestFiles(
    input: Extract<IngestInput, { source: "files" }>,
    context: ServerContext,
  ): Promise<CallToolResult> {
    const topicMatch = await ctx.topicManager.resolveTopicByName(input.topic);
    const matchedTopic = topicMatch.topic;

    // Per-file processing so the response reports the actual outcome of
    // every file instead of claiming blanket success.
    const files: Array<{ path: string; status: "added" | "failed"; chunkCount?: number; error?: string }> = [];
    for (const filePath of input.filePaths) {
      try {
        const realPath = await ctx.assertPathAllowed(filePath);
        const results = await ctx.runMutation(() =>
          ctx.topicManager.addDocuments(matchedTopic.id, [realPath], {
            signal: context.mcpReq.signal,
          }),
        );
        if (results.length > 0) {
          files.push({
            path: filePath,
            status: "added",
            chunkCount: results.reduce((sum, r) => sum + r.pipelineResult.metadata.chunksStored, 0),
          });
        } else {
          files.push({ path: filePath, status: "failed", error: "document processing failed (see server logs)" });
        }
      } catch (error) {
        files.push({
          path: filePath,
          status: "failed",
          error: ctx.toolErrorMessage(error),
        });
      }
    }

    const added = files.filter((f) => f.status === "added");
    return {
      ...ctx.toolJson({
        success: added.length > 0,
        partial: added.length > 0 && added.length < files.length,
        topic: matchedTopic.name,
        documentsAdded: added.length,
        documentsFailed: files.length - added.length,
        files,
      }),
      isError: added.length === 0,
    };
  }

  async function ingestUrl(
    input: Extract<IngestInput, { source: "url" }>,
    context: ServerContext,
  ): Promise<CallToolResult> {
    const parsed = new URL(input.url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP(S) URLs are supported");
    }
    if (parsed.username || parsed.password) {
      throw new Error("URLs containing credentials are not allowed");
    }
    const match = await ctx.topicManager.resolveTopicByName(input.topic);
    const results = await ctx.runMutation(() =>
      ctx.topicManager.addDocuments(match.topic.id, [input.url], {
        loaderOptions: { fileType: "web" },
        signal: context.mcpReq.signal,
      }),
    );
    return ctx.toolJson({ success: results.length > 0, outcomes: results });
  }

  async function ingestGithub(
    input: Extract<IngestInput, { source: "github" }>,
    context: ServerContext,
  ): Promise<CallToolResult> {
    const parsed = new URL(input.url);
    if (parsed.username || parsed.password || parsed.protocol !== "https:") {
      throw new Error("GitHub repositories require an HTTPS URL without embedded credentials");
    }
    if (!ctx.config?.githubHosts.includes(parsed.hostname.toLowerCase())) {
      throw new Error("GitHub host is not allowlisted");
    }
    const match = await ctx.topicManager.resolveTopicByName(input.topic);
    const results = await ctx.runMutation(() =>
      ctx.topicManager.addDocuments(match.topic.id, [input.url], {
        loaderOptions: {
          fileType: "github",
          branch: input.branch,
          accessToken: ctx.config?.githubToken || undefined,
        },
        signal: context.mcpReq.signal,
      }),
    );
    return ctx.toolJson({ success: results.length > 0, outcomes: results });
  }

  // rag_ingest — Add content to a topic from local files, a web page, or a GitHub repository
  ctx.registerTool(
    "rag_ingest",
    "Add content to a RAG topic from one of three sources: 'files' (local paths inside the server's allowed roots, " +
      "PDF/Markdown/HTML/plain text), 'url' (one public HTTP(S) page, with SSRF and size protections), or " +
      "'github' (a repository from an allowlisted GitHub or GHES host).",
    ingestInput,
    ctx.networkWriteAnnotations,
    async (input: IngestInput, context) => {
      try {
        switch (input.source) {
          case "files":
            return await ingestFiles(input, context);
          case "url":
            return await ingestUrl(input, context);
          case "github":
            return await ingestGithub(input, context);
        }
      } catch (error) {
        return ctx.toolError(error);
      }
    },
  );
}
