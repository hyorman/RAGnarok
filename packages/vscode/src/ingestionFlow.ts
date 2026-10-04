/**
 * The topic picker and ingestion tail shared by the add-document, add-GitHub
 * and add-web-URL commands.
 */

import * as vscode from "vscode";
import { DocumentLoaderFactory, Logger, type Topic, type TopicManager } from "@ragnarok/core";
import { waitForAbortableUi } from "./extensionLifecycle";

const logger = new Logger("IngestionFlow");

export class NoDocumentsIngestedError extends Error {
  constructor() {
    super("No documents were ingested. Check the selected source and the extension logs for details.");
    this.name = "NoDocumentsIngestedError";
  }
}

/**
 * Bridge extension lifecycle cancellation into the core ingestion pipeline.
 * Once durable ingestion starts, shutdown aborts the supported core operation
 * and waits for it to unwind.
 */
export async function addDocumentsWithLifecycleSignal(
  topicManager: Pick<TopicManager, "addDocuments">,
  topicId: string,
  sources: string[],
  signal: AbortSignal | undefined,
  options: NonNullable<Parameters<TopicManager["addDocuments"]>[2]> = {},
) {
  signal?.throwIfAborted();
  const results = await topicManager.addDocuments(topicId, sources, { ...options, signal });
  signal?.throwIfAborted();
  if (results.length === 0) {
    throw new NoDocumentsIngestedError();
  }
  return results;
}

export interface TopicPickerDeps {
  topicManager: Pick<TopicManager, "getAllTopics" | "isSharedTopic">;
  createTopic(signal?: AbortSignal): Promise<void>;
}

/** The tree item's topic, or one the user picks; undefined when they back out or pick a shared topic. */
export async function pickWritableTopic(
  deps: TopicPickerDeps,
  item: { topic?: Topic } | undefined,
  signal?: AbortSignal,
): Promise<Topic | undefined> {
  let topic = item?.topic;
  if (!topic) {
    const topics = deps.topicManager.getAllTopics();
    if (topics.length === 0) {
      const create = await waitForAbortableUi(
        signal,
        vscode.window.showInformationMessage("No topics available. Would you like to create one?", "Create Topic"),
      );
      if (create !== "Create Topic") {
        return undefined;
      }
      await deps.createTopic(signal);
      return pickWritableTopic(deps, undefined, signal);
    }
    const selected = await waitForAbortableUi(
      signal,
      vscode.window.showQuickPick(
        topics.map((candidate) => ({
          label: candidate.name,
          description: `${candidate.documentCount} document(s)`,
          topic: candidate,
        })),
        { placeHolder: "Select a topic" },
      ),
    );
    if (!selected) {
      return undefined;
    }
    topic = selected.topic;
  }
  if (deps.topicManager.isSharedTopic(topic.id)) {
    vscode.window.showWarningMessage(`Cannot add documents to "${topic.name}": shared topics are read-only.`);
    return undefined;
  }
  return topic;
}

export interface IngestionDeps {
  topicManager: Pick<TopicManager, "addDocuments" | "getTopicStats">;
  refresh(): void;
}

export interface IngestionRequest {
  /** Progress notification title. */
  title: string;
  /** What was added, for the log and the success message ("Documents", "Web page", …). */
  label: string;
  loaderOptions: NonNullable<Parameters<TopicManager["addDocuments"]>[2]>["loaderOptions"];
  /** Fraction of the progress bar the pipeline's 0-100 progress fills. */
  progressShare: number;
  /** Reported before ingestion starts, for sources with a slow first step (a repository listing). */
  initialProgress?: { message: string; increment: number };
  /** Increment reported with the final "Complete!"; omitted means the message only. */
  completionIncrement?: number;
}

/** Ingest under a progress notification, then report the topic's new totals and refresh the tree. */
export async function ingestWithProgress(
  deps: IngestionDeps,
  topic: Topic,
  sources: string[],
  request: IngestionRequest,
  signal?: AbortSignal,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: request.title, cancellable: false },
    async (progress) => {
      if (request.initialProgress) {
        progress.report(request.initialProgress);
      }
      const results = await addDocumentsWithLifecycleSignal(deps.topicManager, topic.id, sources, signal, {
        onProgress: (pipeline) =>
          progress.report({ message: pipeline.message, increment: pipeline.progress * request.progressShare }),
        loaderOptions: request.loaderOptions,
      });
      progress.report(
        request.completionIncrement === undefined
          ? { message: "Complete!" }
          : { message: "Complete!", increment: request.completionIncrement },
      );
      const chunks = results.reduce((sum, result) => sum + result.pipelineResult.metadata.chunksStored, 0);
      const documents = results.reduce((sum, result) => sum + result.pipelineResult.metadata.originalDocuments, 0);
      logger.info(`${request.label} added: ${documents} documents, ${chunks} chunks`);
    },
  );
  signal?.throwIfAborted();
  const stats = await deps.topicManager.getTopicStats(topic.id);
  vscode.window.showInformationMessage(
    `${request.label} added to "${topic.name}" successfully! Total: ${stats?.documentCount ?? 0} documents, ${stats?.chunkCount ?? 0} chunks.`,
  );
  deps.refresh();
}

/** File-dialog filters built from the extensions core can load, so a new format cannot drift. */
export function supportedDocumentFilters(): Record<string, string[]> {
  const supported = DocumentLoaderFactory.getSupportedExtensions().map((extension) => extension.replace(/^\./, ""));
  return {
    "All Files": ["*"],
    "Supported Documents": supported,
    PDF: ["pdf"],
    Markdown: ["md", "markdown"],
    HTML: ["html", "htm"],
    Text: ["txt"],
  };
}
