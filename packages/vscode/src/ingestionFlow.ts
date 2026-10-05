/**
 * The topic picker and ingestion tail shared by the add-document, add-GitHub
 * and add-web-URL commands.
 */

import * as vscode from "vscode";
import {
  DocumentLoaderFactory,
  Logger,
  type LocalFileType,
  type PipelineProgress,
  type Topic,
  type TopicManager,
} from "@ragnarok/core";
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
  /**
   * Fraction of the progress bar the whole ingest fills at most, split evenly across the sources. A source that
   * stops part-way fills less than its part.
   */
  progressShare: number;
  /** Reported before ingestion starts, for sources with a slow first step (a repository listing). */
  initialProgress?: { message: string; increment: number };
}

/**
 * `Progress.report` takes increments, but the pipeline reports where it is: 0 to 100 through the stages of one
 * source, starting again at 0 for the next. This reports how far the pipeline moved since its last report, scaled so
 * that all the sources together fill at most `share` of the bar.
 *
 * It relies on the pipeline's progress for one source never going down (true of documentPipeline today): a drop is
 * read as the start of the next source, so a source that went backwards would be counted twice.
 */
function pipelineProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  share: number,
  sourceCount: number,
): (pipeline: PipelineProgress) => void {
  const sourceShare = share / Math.max(sourceCount, 1);
  let previous = 0;
  return (pipeline) => {
    // A drop means the pipeline moved on to the next source.
    const moved = pipeline.progress >= previous ? pipeline.progress - previous : pipeline.progress;
    previous = pipeline.progress;
    progress.report({ message: pipeline.message, increment: moved * sourceShare });
  };
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
        onProgress: pipelineProgressReporter(progress, request.progressShare, sources.length),
        loaderOptions: request.loaderOptions,
      });
      progress.report({ message: "Complete!" });
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

/** The file-dialog group each core loader type is offered under; exhaustive, so a new loader type must be labelled. */
const FILTER_LABELS: Readonly<Record<LocalFileType, string>> = {
  pdf: "PDF",
  markdown: "Markdown",
  html: "HTML",
  text: "Text",
};

const withoutDots = (extensions: readonly string[]): string[] =>
  extensions.map((extension) => extension.replace(/^\./, ""));

/** File-dialog filters built from the extensions core can load, so a new format cannot drift. */
export function supportedDocumentFilters(): Record<string, string[]> {
  const byType = DocumentLoaderFactory.getSupportedExtensionsByType();
  const filters: Record<string, string[]> = {
    "All Files": ["*"],
    "Supported Documents": withoutDots(DocumentLoaderFactory.getSupportedExtensions()),
  };
  for (const [fileType, label] of Object.entries(FILTER_LABELS) as Array<[LocalFileType, string]>) {
    // A type with no extensions would be an empty, useless group in the dialog.
    if (byType[fileType].length > 0) {
      filters[label] = withoutDots(byType[fileType]);
    }
  }
  return filters;
}
