/**
 * The installed-VSIX smoke: creates a temporary topic, ingests a unique
 * document, queries it back with vector evidence, then deletes everything.
 * Driven by `scripts/vsix-extension-host-smoke.cjs` through the
 * `ragnarok._runInstalledSmoke` command.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import { TopicManager, RetrievalStrategy } from "@ragnarok/core";
import { RAGTool } from "./ragTool";

export interface InstalledSmokeDeps {
  context: vscode.ExtensionContext;
  topicManager: TopicManager;
  ragTool: ReturnType<typeof RAGTool.register> | undefined;
}

export async function runInstalledSmoke(
  deps: InstalledSmokeDeps,
  signal: AbortSignal,
): Promise<{ topicCreated: boolean; queryExecuted: boolean; topicDeleted: boolean }> {
  const { context, topicManager, ragTool: ragToolRegistration } = deps;
  signal.throwIfAborted();
  const smokeId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const evidenceToken = `ragnarok installed smoke evidence ${smokeId}`;
  const smokePath = vscode.Uri.joinPath(context.globalStorageUri, `installed-smoke-${smokeId}.txt`).fsPath;
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  await fs.writeFile(
    smokePath,
    `This temporary document contains the unique ${evidenceToken}. It verifies installed artifact ingestion and retrieval.`,
    "utf8",
  );
  let topic: { id: string; name: string } | undefined;
  let queryExecuted = false;
  let topicDeleted = false;
  let cleanupFailure: unknown;
  try {
    signal.throwIfAborted();
    topic = await topicManager.createTopic({
      name: `RAGnarōk Installed Smoke ${smokeId}`,
      description: "Temporary topic created by the installed VSIX smoke gate",
    });
    if (!ragToolRegistration) {
      throw new Error("The RAG language-model tool is unavailable in this VS Code build");
    }
    const ingestion = await topicManager.addDocuments(topic.id, [smokePath], { signal });
    const chunksStored = ingestion.reduce((total, item) => total + item.pipelineResult.metadata.chunksStored, 0);
    if (chunksStored < 1) {
      throw new Error("Installed VSIX smoke ingested no document chunks");
    }
    signal.throwIfAborted();
    const queryResult = await ragToolRegistration.tool.executeQuery(
      {
        topic: topic.name,
        query: evidenceToken,
        topK: 1,
        retrievalStrategy: RetrievalStrategy.VECTOR,
      },
      signal,
    );
    const evidence = queryResult.results.find((result) => result.text.includes(evidenceToken));
    const hasDirectVectorEvidence =
      evidence?.metadata.scoreKind === "vector_similarity" &&
      typeof evidence.metadata.componentScores?.vector === "number" &&
      Number.isFinite(evidence.metadata.componentScores.vector);
    const hasRerankedVectorEvidence =
      evidence?.metadata.scoreKind === "cross_encoder_probability" &&
      evidence.metadata.originalScoreKind === "vector_similarity" &&
      typeof evidence.metadata.originalComponentScores?.vector === "number" &&
      Number.isFinite(evidence.metadata.originalComponentScores.vector);
    if (!evidence || (!hasDirectVectorEvidence && !hasRerankedVectorEvidence)) {
      throw new Error("Installed VSIX smoke query did not return the ingested content with vector evidence");
    }
    queryExecuted = true;
  } finally {
    if (topic) {
      try {
        await topicManager.deleteTopic(topic.id);
        topicDeleted = topicManager.getTopic(topic.id) === null;
      } catch (error) {
        cleanupFailure = error;
      }
    }
    try {
      await fs.rm(smokePath, { force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  if (!topicDeleted) {
    throw new Error("Installed VSIX smoke topic remained visible after deletion");
  }
  try {
    await fs.access(smokePath);
    throw new Error("Installed VSIX smoke temporary document was not cleaned up");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  return {
    topicCreated: true,
    queryExecuted,
    topicDeleted,
  };
}
