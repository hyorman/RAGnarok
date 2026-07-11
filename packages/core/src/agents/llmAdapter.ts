/**
 * LangChain BaseChatModel adapter for the project's ILLMProvider interface.
 *
 * Bridges ILLMProvider (selectModel → sendRequest) into LangChain's
 * chat-model abstraction so it can be used with LangGraph and other
 * LangChain tooling.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { ILLMProvider, ILLMMessage } from "../interfaces";

/**
 * Convert a LangChain BaseMessage to the project's ILLMMessage format.
 */
function toILLMMessage(msg: BaseMessage): ILLMMessage {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

  if (msg instanceof SystemMessage) {
    return { role: "system", content };
  }
  if (msg instanceof AIMessage) {
    return { role: "assistant", content };
  }
  // HumanMessage or any other type → user
  return { role: "user", content };
}

/**
 * A LangChain BaseChatModel that delegates to an ILLMProvider.
 *
 * Usage:
 * ```ts
 * const chatModel = new LLMProviderChatModel(llmProvider, "gpt-4o");
 * const result = await chatModel.invoke([new HumanMessage("hello")]);
 * ```
 */
export class LLMProviderChatModel extends BaseChatModel {
  private llmProvider: ILLMProvider;
  private modelFamily: string | undefined;

  constructor(llmProvider: ILLMProvider, modelFamily?: string) {
    super({});
    this.llmProvider = llmProvider;
    this.modelFamily = modelFamily;
  }

  _llmType(): string {
    return "ragnarok-llm-adapter";
  }

  _identifyingParams(): Record<string, unknown> {
    return { modelFamily: this.modelFamily };
  }

  async _generate(messages: BaseMessage[], options?: this["ParsedCallOptions"]): Promise<ChatResult> {
    // 1. Convert LangChain messages → ILLMMessage[]
    const mapped: ILLMMessage[] = messages.map(toILLMMessage);

    // 2. Select the model from the provider
    const model = await this.llmProvider.selectModel({
      family: this.modelFamily,
    });
    if (!model) {
      throw new Error(
        `LLMProviderChatModel: no model available` + (this.modelFamily ? ` for family "${this.modelFamily}"` : ""),
      );
    }

    // 3. Send request — returns AsyncIterable<string>
    const response = await model.sendRequest(mapped, options?.signal);

    // 4. Collect fragments into a single string
    let fullText = "";
    for await (const chunk of response) {
      fullText += chunk;
    }

    // 5. Return as ChatResult
    return {
      generations: [
        {
          text: fullText,
          message: new AIMessage(fullText),
        },
      ],
    };
  }
}
