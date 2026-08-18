/**
 * Read-only topic tool. Copilot may enumerate topics and inspect one; creating,
 * renaming, exporting, importing, and deleting stay sidebar commands so a human
 * confirms them. The read half delegates to the same executor the MCP server's
 * rag_topic tool uses, so both hosts return byte-identical payloads.
 */
import * as vscode from "vscode";
import {
  executeTopicRead,
  toolErrorPayload,
  TopicInputError,
  type TopicManager,
  type TopicListPayload,
  type TopicReadInput,
  type TopicStatsPayload,
  type ToolErrorPayload,
} from "@ragnarok/core";
import { TOOLS } from "./constants";
import { vscodeToolRegistrationHost, type LanguageModelToolRegistrationHost } from "./toolRegistrationHost";

export type TopicToolPayload = TopicListPayload | TopicStatsPayload | ToolErrorPayload;

const CANCELLED = "RAG topic read cancelled";

export class TopicTool {
  static async invoke(
    input: TopicReadInput,
    topicManager: TopicManager,
    signal?: AbortSignal,
  ): Promise<TopicToolPayload> {
    try {
      return await executeTopicRead(input, { topicManager }, signal);
    } catch (error) {
      // Cancellation is the host's decision, not a tool failure: rethrow so VS
      // Code reports a cancelled invocation instead of handing the model an
      // error payload it would try to "fix".
      if (signal?.aborted) {
        throw error;
      }
      // Two distinct codes on purpose. Told its input was invalid, a model
      // retries with different arguments — the right move for a bad topic name,
      // and a pointless loop against a down embedding provider or a rate limit.
      const code = error instanceof TopicInputError ? "TOPIC_TOOL_INVALID_INPUT" : "TOPIC_TOOL_FAILED";
      return toolErrorPayload(code, error instanceof Error ? error.message : String(error));
    }
  }

  static register(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
    topicManager: TopicManager,
    registrationHost: LanguageModelToolRegistrationHost = vscodeToolRegistrationHost,
  ): vscode.Disposable {
    const registration = registrationHost.registerTool<TopicReadInput>(TOOLS.RAG_TOPIC, {
      invoke: async (options, token) => {
        // The stats path can be network-bound: resolveTopicByName embeds the
        // query plus one vector per topic when the name is not an exact match.
        const controller = new AbortController();
        const cancel = () => controller.abort(new Error(CANCELLED));
        if (token.isCancellationRequested) {
          cancel();
        }
        const onCancel = token.onCancellationRequested(cancel);
        try {
          const payload = await TopicTool.invoke(options.input, topicManager, controller.signal);
          return registrationHost.createToolResult([registrationHost.createTextPart(JSON.stringify(payload, null, 2))]);
        } finally {
          onCancel.dispose();
        }
      },
      prepareInvocation: async (options) => ({
        invocationMessage:
          options.input.action === "list"
            ? "Listing RAG topics"
            : `Reading statistics for RAG topic "${(options.input as { topic?: string }).topic ?? ""}"`,
      }),
    });
    context.subscriptions.push(registration);
    return registration;
  }
}
