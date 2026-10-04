import * as fs from "fs/promises";
import * as path from "path";
import type { Document as LangChainDocument } from "@langchain/core/documents";
import type { Mutex } from "async-mutex";
import type { VectorStoreFactory } from "../../stores/vectorStoreFactory";
import { atomicWriteJson } from "../../utils/storage";
import { errnoCode } from "../../utils/fsPaths";
import { isFiniteNumber, isRecord } from "../../utils/typeGuards";
import type { TopicsIndex, Document as TopicDocument } from "../../utils/types";
import type { PipelineSourceDocument } from "../documentPipeline";
import type { TopicStorePaths } from "./topicStorePaths";

export interface IngestionJournalEntry {
  id: string;
  transactionId?: string;
  containerId?: string;
  topicId: string;
  stage: "started" | "vectorCommitted" | "graphCommitted" | "metadataCommitted";
  document: TopicDocument;
  containerLeafIds?: string[];
  warnings?: Array<{ stage: string; message: string }>;
  updatedAt: number;
}

export interface PostCommitCleanupEntry {
  version: 1;
  id: string;
  kind: "document";
  topicId: string;
  documents: TopicDocument[];
  updatedAt: number;
}

/** What the ingestion and post-commit cleanup journals need from the `TopicManager` that owns them. */
export interface TopicJournalHost {
  vectorStoreFactory: VectorStoreFactory | null;
  journalMutex: Mutex;
  topicsIndex: TopicsIndex | null;
  topicDocuments: Map<string, Map<string, TopicDocument>>;
  paths: TopicStorePaths;
  removeDocumentStorage(topicId: string, documentId: string, signal?: AbortSignal): Promise<string[]>;
  summarizePipelineChunks(chunks: LangChainDocument[]): PipelineSourceDocument[];
  createLeafTopicDocuments(
    topicId: string,
    container: TopicDocument,
    sources: PipelineSourceDocument[],
  ): TopicDocument[];
  saveTopicDocuments(topicId: string): Promise<void>;
  saveTopicsIndex(): Promise<void>;
}

export class TopicJournals {
  constructor(private readonly host: TopicJournalHost) {}

  public getIngestionJournalPath(): string {
    return path.join(this.host.paths.databaseDir(), "ingestion-journal.json");
  }

  public getPostCommitCleanupJournalPath(): string {
    return path.join(this.host.paths.databaseDir(), "post-commit-cleanup-journal.json");
  }

  private async readPostCommitCleanupJournal(): Promise<PostCommitCleanupEntry[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.getPostCommitCleanupJournalPath(), "utf8"));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return [];
      }
      throw new Error("Post-commit cleanup journal is corrupt; refusing to expose potentially orphaned storage");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Post-commit cleanup journal is invalid; expected an array");
    }
    for (const entry of parsed) {
      if (
        !isRecord(entry) ||
        entry.version !== 1 ||
        typeof entry.id !== "string" ||
        typeof entry.topicId !== "string" ||
        !isFiniteNumber(entry.updatedAt) ||
        entry.kind !== "document"
      ) {
        throw new Error("Post-commit cleanup journal contains an invalid entry");
      }
      if (!Array.isArray(entry.documents)) {
        throw new Error("Post-commit cleanup journal contains invalid cleanup details");
      }
    }
    return parsed as PostCommitCleanupEntry[];
  }

  public async upsertPostCommitCleanup(entry: PostCommitCleanupEntry): Promise<void> {
    await this.host.journalMutex.runExclusive(async () => {
      const entries = await this.readPostCommitCleanupJournal();
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      await atomicWriteJson(this.getPostCommitCleanupJournalPath(), entries);
    });
  }

  public async removePostCommitCleanup(id: string): Promise<void> {
    await this.host.journalMutex.runExclusive(async () => {
      const entries = (await this.readPostCommitCleanupJournal()).filter((entry) => entry.id !== id);
      await atomicWriteJson(this.getPostCommitCleanupJournalPath(), entries);
    });
  }

  public async completePostCommitCleanup(entry: PostCommitCleanupEntry): Promise<string[]> {
    if (!this.host.vectorStoreFactory) {
      throw new Error("Vector store is not initialized");
    }
    const removedChunkIds: string[] = [];
    for (const document of entry.documents) {
      removedChunkIds.push(...(await this.host.removeDocumentStorage(entry.topicId, document.id)));
    }
    const stats = await this.host.vectorStoreFactory.getStoredStats(entry.topicId);
    const existing = await this.host.vectorStoreFactory.getStoreMetadata(entry.topicId);
    await this.host.vectorStoreFactory.saveStore(entry.topicId, {
      ...existing,
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount,
    });
    return removedChunkIds;
  }

  public async recoverPostCommitCleanup(): Promise<void> {
    const entries = await this.readPostCommitCleanupJournal();
    for (const entry of entries) {
      const documents = this.host.topicDocuments.get(entry.topicId);
      if (!this.host.topicsIndex?.topics[entry.topicId]) {
        await this.removePostCommitCleanup(entry.id);
        continue;
      }
      // If any selected document is still advertised, coordinator recovery
      // rolled metadata publication back. Physical rows remain live.
      if (entry.documents.some((document) => documents?.has(document.id))) {
        await this.removePostCommitCleanup(entry.id);
        continue;
      }
      await this.completePostCommitCleanup(entry);
      await this.removePostCommitCleanup(entry.id);
    }
  }

  private async readIngestionJournal(): Promise<IngestionJournalEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.getIngestionJournalPath(), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  public async upsertIngestion(entry: IngestionJournalEntry): Promise<void> {
    await this.host.journalMutex.runExclusive(async () => {
      const entries = await this.readIngestionJournal();
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      await atomicWriteJson(this.getIngestionJournalPath(), entries);
    });
  }

  public async replaceIngestionTransaction(transactionId: string, replacement: IngestionJournalEntry[]): Promise<void> {
    await this.host.journalMutex.runExclusive(async () => {
      const entries = (await this.readIngestionJournal()).filter(
        (entry) => (entry.transactionId ?? entry.id) !== transactionId,
      );
      entries.push(...replacement);
      await atomicWriteJson(this.getIngestionJournalPath(), entries);
    });
  }

  public async markAndRemoveCommittedIngestion(transactionId: string): Promise<void> {
    await this.host.journalMutex.runExclusive(async () => {
      const entries = await this.readIngestionJournal();
      const committedAt = Date.now();
      const marked = entries.map((entry) =>
        (entry.transactionId ?? entry.id) === transactionId
          ? { ...entry, stage: "metadataCommitted" as const, updatedAt: committedAt }
          : entry,
      );
      await atomicWriteJson(this.getIngestionJournalPath(), marked);
      await atomicWriteJson(
        this.getIngestionJournalPath(),
        marked.filter((entry) => (entry.transactionId ?? entry.id) !== transactionId),
      );
    });
  }

  public async recoverIngestion(): Promise<void> {
    if (!this.host.vectorStoreFactory || !this.host.topicsIndex) {
      return;
    }
    await this.host.journalMutex.runExclusive(async () => {
      const pending = await this.readIngestionJournal();
      if (pending.length === 0) {
        return;
      }
      const touched = new Set<string>();
      const rowsByTopic = new Map<string, LangChainDocument[]>();
      const transactions = new Map<string, IngestionJournalEntry[]>();
      for (const entry of pending) {
        const transactionId = entry.transactionId ?? entry.id;
        const group = transactions.get(transactionId) ?? [];
        group.push(entry);
        transactions.set(transactionId, group);
      }

      for (const [transactionId, originalEntries] of transactions) {
        const starter = originalEntries.find((entry) => entry.stage === "started") ?? originalEntries[0];
        const topic = this.host.topicsIndex!.topics[starter.topicId];
        if (!topic) {
          continue;
        }

        let durableEntries = originalEntries.filter((entry) => entry.stage !== "started");
        if (durableEntries.length === 0) {
          let rows = rowsByTopic.get(starter.topicId);
          if (!rows) {
            rows = await this.host.vectorStoreFactory!.getAllDocuments(starter.topicId, 1_000_000);
            rowsByTopic.set(starter.topicId, rows);
          }
          const transactionRows = rows.filter(
            (row) => String(row.metadata.ingestionTransactionId ?? "") === transactionId,
          );
          let sourceDocuments = this.host.summarizePipelineChunks(transactionRows);
          if (sourceDocuments.length === 0) {
            // Backward compatibility for the pre-transaction journal.
            const legacyCount = await this.host.vectorStoreFactory!.getDocumentChunkCount(
              starter.topicId,
              starter.document.id,
            );
            if (legacyCount > 0) {
              sourceDocuments = [
                {
                  documentId: starter.document.id,
                  canonicalSource: starter.document.filePath,
                  sourceType: starter.document.fileType === "web" ? "web" : starter.document.fileType,
                  sourceRevision: starter.document.sourceRevision ?? "",
                  fileName: starter.document.name,
                  filePath: starter.document.filePath,
                  fileType: starter.document.fileType,
                  chunkCount: legacyCount,
                },
              ];
            }
          }
          if (sourceDocuments.length === 0) {
            // No durable vector row exists for this starter. Recovery rolls it
            // back by removing the journal record without publishing metadata.
            continue;
          }
          const leaves = this.host.createLeafTopicDocuments(starter.topicId, starter.document, sourceDocuments);
          const leafIds = leaves.map((document) => document.id);
          durableEntries = leaves.map((document) => ({
            id: `${transactionId}:${document.id}`,
            transactionId,
            containerId: starter.containerId ?? starter.document.id,
            topicId: starter.topicId,
            stage: "vectorCommitted",
            document,
            containerLeafIds: leafIds,
            updatedAt: Date.now(),
          }));
        }

        const documents = this.host.topicDocuments.get(starter.topicId) ?? new Map<string, TopicDocument>();
        const durableLeafIds = new Set<string>();
        for (const entry of durableEntries) {
          const chunkCount = await this.host.vectorStoreFactory!.getDocumentChunkCount(
            entry.topicId,
            entry.document.id,
          );
          if (chunkCount === 0) {
            continue;
          }
          durableLeafIds.add(entry.document.id);
          documents.set(entry.document.id, { ...entry.document, chunkCount });
        }
        if (durableLeafIds.size === 0) {
          continue;
        }
        const containerId = starter.containerId ?? starter.document.containerId ?? starter.document.id;
        const declaredLeafIds = new Set(durableEntries.flatMap((entry) => entry.containerLeafIds ?? []));
        const desiredLeafIds = declaredLeafIds.size > 0 ? declaredLeafIds : durableLeafIds;
        const staleDocuments = [...documents.values()].filter(
          (document) =>
            (document.containerId === containerId || document.id === containerId) && !desiredLeafIds.has(document.id),
        );
        for (const staleDocument of staleDocuments) {
          await this.host.removeDocumentStorage(starter.topicId, staleDocument.id);
          documents.delete(staleDocument.id);
        }

        this.host.topicDocuments.set(starter.topicId, documents);
        topic.documentCount = documents.size;
        topic.updatedAt = Math.max(topic.updatedAt, ...durableEntries.map((entry) => entry.updatedAt));
        touched.add(starter.topicId);
      }
      for (const topicId of touched) {
        await this.host.saveTopicDocuments(topicId);
      }
      if (touched.size > 0) {
        this.host.topicsIndex!.lastUpdated = Date.now();
        await this.host.saveTopicsIndex();
      }
      // Every transaction was either completed from proven rows or rolled back
      // because no durable row existed. The metadata writes above must all
      // succeed before the journal is cleared.
      await atomicWriteJson(this.getIngestionJournalPath(), []);
    });
  }
}
