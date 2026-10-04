import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { executeTopicRead } from "@ragnarok/core";
import { MCP_LIMITS, type ToolContext } from "./shared";

const topicInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("refresh") }).strict(),
  z
    .object({
      action: z.literal("stats"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The name of the topic to get stats for"),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(100).describe("Name for the new topic"),
      description: z.string().max(2000).optional().describe("Description of the topic"),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The topic to rename"),
      newName: z.string().trim().min(1).max(MCP_LIMITS.topicName).describe("The new topic name"),
    })
    .strict(),
  z
    .object({
      action: z.literal("export"),
      topic: z.string().min(1).max(MCP_LIMITS.topicName).describe("The topic to export"),
    })
    .strict(),
  z
    .object({
      action: z.literal("import"),
      archivePath: z
        .string()
        .min(1)
        .max(MCP_LIMITS.path)
        .describe("Path to a storage-v2 .rag archive inside the allowed roots"),
      confirm: z.literal(true),
    })
    .strict(),
]);

export function registerTopicTools(ctx: ToolContext): void {
  ctx.registerTool(
    "rag_delete_topic",
    "Permanently delete a local topic and all of its data",
    z.object({ topic: z.string().min(1).max(MCP_LIMITS.topicName), confirm: z.literal(true) }),
    ctx.destructiveAnnotations,
    async ({ topic }) => {
      try {
        const match = await ctx.topicManager.resolveTopicByName(topic);
        await ctx.runMutation(() => ctx.topicManager.deleteTopic(match.topic.id));
        return ctx.toolJson({ success: true, deletedTopic: match.topic.name });
      } catch (error) {
        return ctx.toolError(error);
      }
    },
  );

  ctx.registerTool(
    "rag_remove_document",
    "Permanently remove one indexed source from a topic",
    z.object({
      topic: z.string().min(1).max(MCP_LIMITS.topicName),
      documentId: z.string().min(1).max(255),
      confirm: z.literal(true),
    }),
    ctx.destructiveAnnotations,
    async ({ topic, documentId }) => {
      try {
        const match = await ctx.topicManager.resolveTopicByName(topic);
        const result = await ctx.runMutation(() => ctx.topicManager.removeDocument(match.topic.id, documentId));
        return ctx.toolJson({ success: true, document: result.document, chunksRemoved: result.chunksRemoved });
      } catch (error) {
        return ctx.toolError(error);
      }
    },
  );

  type TopicInput = z.infer<typeof topicInput>;

  ctx.registerTool(
    "rag_topic",
    "Manage RAG topics: 'list' all topics, 'refresh' to re-read the shared topic folder, 'stats' for one topic (statistics plus its indexed documents), " +
      "'create' a new topic, 'rename' a topic, 'export' a topic as a storage-v2 .rag archive under the configured " +
      "export directory, or 'import' a .rag archive from an allowlisted path (requires confirm: true).",
    topicInput,
    ctx.writeAnnotations,
    async (input: TopicInput) => {
      try {
        switch (input.action) {
          // The two READ actions delegate to the shared executor. The zod gate
          // above stays in front of it: zod bounds the RAW topic string at 200,
          // the executor bounds the TRIMMED one, so both bounds apply.
          case "list":
            return ctx.toolJson(await executeTopicRead({ action: "list" }, { topicManager: ctx.topicManager }));
          case "refresh": {
            // Shared topics are otherwise only re-read during initialize(), so
            // without this an updated archive needs a server restart. The VS
            // Code host has had a refresh command since shared topics shipped;
            // this closes the gap. refreshSharedTopics never throws and takes
            // no write lease, so a concurrent writer cannot make it fail.
            await ctx.topicManager.refreshSharedTopics();
            const sharedTopicCount = ctx.topicManager
              .getAllTopics()
              .filter((topic) => topic.source === "shared").length;
            return ctx.toolJson({ success: true, sharedTopicCount });
          }
          case "stats":
            return ctx.toolJson(
              await executeTopicRead({ action: "stats", topic: input.topic }, { topicManager: ctx.topicManager }),
            );
          case "create": {
            const topic = await ctx.runMutation(() =>
              ctx.topicManager.createTopic({ name: input.name, description: input.description }),
            );
            return ctx.toolJson({
              success: true,
              topic: { id: topic.id, name: topic.name, description: topic.description },
            });
          }
          case "rename": {
            const match = await ctx.topicManager.resolveTopicByName(input.topic);
            const updated = await ctx.runMutation(() =>
              ctx.topicManager.updateTopic(match.topic.id, { name: input.newName }),
            );
            return ctx.toolJson({ success: true, topic: updated });
          }
          case "export": {
            if (!ctx.config) {
              throw new Error("Export configuration unavailable");
            }
            const match = await ctx.topicManager.resolveTopicByName(input.topic);
            await fs.mkdir(ctx.config.exportDir, { recursive: true });
            const safeName = match.topic.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "topic";
            const exportPath = path.join(ctx.config.exportDir, `${safeName}-${Date.now()}.rag`);
            await ctx.runMutation(() => ctx.topicManager.exportTopic(match.topic.id, exportPath));
            const bytes = await fs.readFile(exportPath);
            return ctx.toolJson({
              path: exportPath,
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
          case "import": {
            const realPath = await ctx.assertPathAllowed(input.archivePath);
            const topic = await ctx.runMutation(() => ctx.topicManager.importTopic(realPath));
            return ctx.toolJson({ success: true, topic });
          }
        }
      } catch (error) {
        return ctx.toolError(error);
      }
    },
  );
}
