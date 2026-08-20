import type { TopicManager } from "../managers/topicManager";
import { TOOL_LIMITS } from "./toolContracts";

export type TopicReadInput = { action: "list" } | { action: "stats"; topic: string };

export interface TopicToolDeps {
  topicManager: TopicManager;
}

export interface TopicListPayload {
  topics: Array<{
    name: string;
    description: string | undefined;
    documentCount: number;
    createdAt: string;
    updatedAt: string;
    source: string;
  }>;
  count: number;
}

export interface TopicStatsPayload {
  documentCount: number;
  chunkCount: number;
  lastUpdated: number;
  embeddingModel: string;
  documents: Array<Record<string, unknown> & { documentId: string }>;
}

/**
 * Thrown only for arguments this executor rejects. Exported so a host can tell
 * "the model sent bad arguments" (worth retrying with different ones) apart from
 * a backend failure such as an embedding outage (retrying arguments will not
 * help), and report a different error code for each.
 */
export class TopicInputError extends Error {}

/**
 * `signal` is optional so the MCP host can keep calling with two arguments. The
 * stats path is worth interrupting: resolveTopicByName embeds the query plus one
 * vector per topic whenever the name is not an exact match.
 */
export async function executeTopicRead(
  input: TopicReadInput,
  deps: TopicToolDeps,
  signal?: AbortSignal,
): Promise<TopicListPayload | TopicStatsPayload> {
  signal?.throwIfAborted();

  if (input.action === "list") {
    const topics = deps.topicManager.getAllTopics().map((topic) => ({
      name: topic.name,
      description: topic.description,
      documentCount: topic.documentCount,
      createdAt: new Date(topic.createdAt).toISOString(),
      updatedAt: new Date(topic.updatedAt).toISOString(),
      source: topic.source ?? "local",
    }));
    return { topics, count: topics.length };
  }

  if (typeof input.topic !== "string" || !input.topic.trim()) {
    throw new TopicInputError("Topic tool 'topic' is required for the 'stats' action");
  }
  if (input.topic.trim().length > TOOL_LIMITS.topicName) {
    throw new TopicInputError(`Topic tool 'topic' must not exceed ${TOOL_LIMITS.topicName} characters`);
  }

  signal?.throwIfAborted();
  const match = await deps.topicManager.resolveTopicByName(input.topic.trim());
  signal?.throwIfAborted();
  const stats = await deps.topicManager.getTopicStats(match.topic.id);
  if (!stats) {
    // Deliberately NOT a TopicInputError. TopicManager.getTopicStats catches
    // every internal failure, logs it, and returns null, so null is equally
    // what an embedding outage, a rate limit, and unreadable storage look like
    // from here. The topic resolved, so nothing about the argument is wrong,
    // and a host that reported this as bad input would send the model looking
    // for a better topic name against infrastructure that is down.
    throw new Error(`No statistics available for topic '${match.topic.name}'`);
  }
  signal?.throwIfAborted();
  const documents = deps.topicManager.listDocuments(match.topic.id).map((document) => ({
    ...document,
    documentId: document.id,
  }));
  return { ...stats, documents };
}
