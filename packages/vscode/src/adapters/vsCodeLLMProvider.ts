/**
 * VS Code implementation of ILLMProvider
 * Wraps vscode.lm.selectChatModels() and language model API
 */

import * as vscode from "vscode";
import { ILLMProvider, ILLMModel, ILLMMessage } from "@ragnarok/core";

class VsCodeLLMModel implements ILLMModel {
  id: string;
  family: string;

  constructor(private model: vscode.LanguageModelChat) {
    this.id = model.id;
    this.family = model.family;
  }

  async sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Convert ILLMMessage to vscode.LanguageModelChatMessage
    const vsMessages = messages.map((m) => {
      switch (m.role) {
        case "user":
          return vscode.LanguageModelChatMessage.User(m.content);
        case "assistant":
          return vscode.LanguageModelChatMessage.Assistant(m.content);
        default:
          return vscode.LanguageModelChatMessage.User(m.content);
      }
    });

    // Convert AbortSignal to CancellationToken
    const cts = new vscode.CancellationTokenSource();
    if (signal) {
      signal.addEventListener("abort", () => cts.cancel(), { once: true });
    }

    const response = await this.model.sendRequest(vsMessages, {}, cts.token);

    // Wrap the response as AsyncIterable<string>
    return {
      [Symbol.asyncIterator]() {
        const reader = response.stream[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<string>> {
            const result = await reader.next();
            if (result.done) {
              return { done: true, value: undefined };
            }
            // vscode.LanguageModelTextPart has a `value` property
            const part = result.value;
            const text = typeof part === "string" ? part : ((part as any).value ?? String(part));
            return { done: false, value: text };
          },
        };
      },
    };
  }
}

export class VsCodeLLMProvider implements ILLMProvider {
  async selectModel(options?: { family?: string; vendor?: string }): Promise<ILLMModel | null> {
    try {
      const selector: vscode.LanguageModelChatSelector = {};
      if (options?.vendor) {
        selector.vendor = options.vendor;
      } else {
        selector.vendor = "copilot";
      }
      if (options?.family) {
        selector.family = options.family;
      }

      let models = await vscode.lm.selectChatModels(selector);

      // Fallback: try without family constraint
      if (models.length === 0 && options?.family) {
        models = await vscode.lm.selectChatModels({ vendor: selector.vendor });
      }

      if (models.length === 0) {
        return null;
      }

      return new VsCodeLLMModel(models[0]);
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
        return false;
      }
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      return models.length > 0;
    } catch {
      return false;
    }
  }
}
