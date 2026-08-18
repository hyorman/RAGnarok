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

class TopicInputError extends Error {}

export async function executeTopicRead(
  input: TopicReadInput,
  deps: TopicToolDeps,
): Promise<TopicListPayload | TopicStatsPayload> {
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

  const match = await deps.topicManager.resolveTopicByName(input.topic.trim());
  const stats = await deps.topicManager.getTopicStats(match.topic.id);
  if (!stats) {
    throw new TopicInputError(`No statistics available for topic '${match.topic.name}'`);
  }
  const documents = deps.topicManager.listDocuments(match.topic.id).map((document) => ({
    ...document,
    documentId: document.id,
  }));
  return { ...stats, documents };
}
