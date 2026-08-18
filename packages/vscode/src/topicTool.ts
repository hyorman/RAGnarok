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
  type TopicManager,
  type TopicListPayload,
  type TopicReadInput,
  type TopicStatsPayload,
  type ToolErrorPayload,
} from "@ragnarok/core";
import { TOOLS } from "./constants";

export type TopicToolPayload = TopicListPayload | TopicStatsPayload | ToolErrorPayload;

/**
 * The same seam registerMemoryTools uses: `vscode.lm` is unavailable to unit
 * tests running outside a Copilot-enabled host, so registration is injectable.
 */
export interface TopicToolRegistrationHost {
  registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>): vscode.Disposable;
  createToolResult(content: Array<vscode.LanguageModelTextPart | unknown>): vscode.LanguageModelToolResult;
  createTextPart(value: string): vscode.LanguageModelTextPart;
}

const vscodeTopicToolRegistrationHost: TopicToolRegistrationHost = {
  registerTool: <T>(name: string, tool: vscode.LanguageModelTool<T>) => vscode.lm.registerTool(name, tool),
  createToolResult: (content) => new vscode.LanguageModelToolResult(content),
  createTextPart: (value) => new vscode.LanguageModelTextPart(value),
};

export class TopicTool {
  static async invoke(input: TopicReadInput, topicManager: TopicManager): Promise<TopicToolPayload> {
    try {
      return await executeTopicRead(input, { topicManager });
    } catch (error) {
      // Returned, not thrown: a thrown error reaches the model as an opaque tool
      // failure, while a structured payload lets it correct its arguments.
      return toolErrorPayload("TOPIC_TOOL_INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
  }

  static register(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
    topicManager: TopicManager,
    registrationHost: TopicToolRegistrationHost = vscodeTopicToolRegistrationHost,
  ): vscode.Disposable {
    const registration = registrationHost.registerTool<TopicReadInput>(TOOLS.RAG_TOPIC, {
      invoke: async (options) => {
        const payload = await TopicTool.invoke(options.input, topicManager);
        return registrationHost.createToolResult([registrationHost.createTextPart(JSON.stringify(payload, null, 2))]);
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
