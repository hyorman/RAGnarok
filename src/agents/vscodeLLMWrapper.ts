/**
 * VS Code LLM Wrapper - LangChain integration for VS Code Language Model API
 * Implements BaseChatModel interface for seamless LangChain compatibility
 *
 * Architecture: Adapter pattern wrapping VS Code LM API
 * Enables: Streaming, message conversion, model selection
 */

import * as vscode from 'vscode';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
  ChatMessage,
} from '@langchain/core/messages';
import { ChatGeneration, ChatResult } from '@langchain/core/outputs';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { Logger } from '../utils/logger';
import { CONFIG } from '../utils/constants';

export interface VSCodeLLMParams extends BaseChatModelParams {
  /** Model family to use (e.g., 'gpt-4o', 'gpt-3.5-turbo') */
  modelFamily?: string;

  /** Vendor to use (default: 'copilot') */
  vendor?: string;

  /** Temperature for generation (0-1) */
  temperature?: number;

  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * LangChain-compatible wrapper for VS Code Language Model API
 */
export class VSCodeLLM extends BaseChatModel {
  private logger: Logger;
  private modelFamily: string;
  private vendor: string;
  private temperature: number;
  private maxTokens: number;
  private cachedModel: vscode.LanguageModelChat | null = null;

  constructor(params: VSCodeLLMParams = {}) {
    super(params);

    this.logger = new Logger('VSCodeLLM');
    this.modelFamily = params.modelFamily || 'gpt-4o';
    this.vendor = params.vendor || 'copilot';
    this.temperature = params.temperature ?? 0.7;
    this.maxTokens = params.maxTokens ?? 4000;

    this.logger.info('VSCodeLLM initialized', {
      modelFamily: this.modelFamily,
      vendor: this.vendor,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
  }

  /**
   * LangChain identifier for the model
   */
  _llmType(): string {
    return 'vscode-lm';
  }

  /**
   * Get or select the VS Code language model
   */
  private async getModel(): Promise<vscode.LanguageModelChat> {
    // Return cached model if available
    if (this.cachedModel) {
      return this.cachedModel;
    }

    try {
      this.logger.debug('Selecting VS Code language model', {
        vendor: this.vendor,
        family: this.modelFamily,
      });

      const models = await vscode.lm.selectChatModels({
        vendor: this.vendor,
        family: this.modelFamily,
      });

      if (models.length === 0) {
        throw new Error(
          `No language model found for vendor: ${this.vendor}, family: ${this.modelFamily}`
        );
      }

      this.cachedModel = models[0];

      this.logger.info('Language model selected', {
        id: this.cachedModel.id,
        family: this.cachedModel.family,
        vendor: this.cachedModel.vendor,
        maxInputTokens: this.cachedModel.maxInputTokens,
      });

      return this.cachedModel;
    } catch (error) {
      this.logger.error('Failed to get language model', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate chat response (core LangChain method)
   */
  async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    try {
      this.logger.debug('Generating chat response', {
        messageCount: messages.length,
      });

      // Get model
      const model = await this.getModel();

      // Convert LangChain messages to VS Code messages
      const vscodeMessages = this.convertToVSCodeMessages(messages);

      // Create cancellation token
      const cancellationToken = new vscode.CancellationTokenSource().token;

      // Send request
      const response = await model.sendRequest(
        vscodeMessages,
        {
          // VS Code LM API doesn't support temperature/maxTokens directly
          // These would need to be handled differently or ignored
        },
        cancellationToken
      );

      // Collect response text
      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;

        // Stream to callback manager if provided
        if (runManager) {
          await runManager.handleLLMNewToken(chunk);
        }
      }

      this.logger.debug('Response generated', {
        responseLength: responseText.length,
      });

      // Create LangChain ChatGeneration
      const generation: ChatGeneration = {
        text: responseText,
        message: new AIMessage(responseText),
      };

      return {
        generations: [generation],
        llmOutput: {
          model: model.id,
          family: model.family,
          vendor: model.vendor,
        },
      };
    } catch (error) {
      this.logger.error('Failed to generate response', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Convert LangChain messages to VS Code messages
   */
  private convertToVSCodeMessages(
    messages: BaseMessage[]
  ): vscode.LanguageModelChatMessage[] {
    return messages.map((message) => {
      const content = message.content.toString();

      if (message instanceof HumanMessage || message._getType() === 'human') {
        return vscode.LanguageModelChatMessage.User(content);
      } else if (message instanceof AIMessage || message._getType() === 'ai') {
        return vscode.LanguageModelChatMessage.Assistant(content);
      } else if (message instanceof SystemMessage || message._getType() === 'system') {
        // VS Code doesn't have a System message type, treat as User
        return vscode.LanguageModelChatMessage.User(content);
      } else {
        // Default to User for other types
        return vscode.LanguageModelChatMessage.User(content);
      }
    });
  }

  /**
   * Get model parameters for serialization
   */
  invocationParams(): Record<string, any> {
    return {
      modelFamily: this.modelFamily,
      vendor: this.vendor,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    };
  }

  /**
   * Clear cached model (useful when switching models)
   */
  public clearCache(): void {
    this.cachedModel = null;
    this.logger.debug('Model cache cleared');
  }

  /**
   * Update model family
   */
  public setModelFamily(family: string): void {
    if (family !== this.modelFamily) {
      this.modelFamily = family;
      this.clearCache();
      this.logger.info('Model family updated', { family });
    }
  }

  /**
   * Check if a model is available
   */
  public static async isModelAvailable(
    vendor: string = 'copilot',
    family: string = 'gpt-4o'
  ): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor, family });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  public static async listAvailableModels(): Promise<
    Array<{
      id: string;
      family: string;
      vendor: string;
      maxInputTokens: number;
    }>
  > {
    try {
      // Query Copilot models
      const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });

      return copilotModels.map((model) => ({
        id: model.id,
        family: model.family,
        vendor: model.vendor,
        maxInputTokens: model.maxInputTokens,
      }));
    } catch (error) {
      return [];
    }
  }
}

/**
 * Factory function for creating VSCodeLLM instances
 */
export function createVSCodeLLM(params: VSCodeLLMParams = {}): VSCodeLLM {
  return new VSCodeLLM(params);
}

/**
 * Helper to get configured LLM from VS Code settings
 */
export async function getConfiguredLLM(): Promise<VSCodeLLM> {
  const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
  const modelFamily = config.get<string>(CONFIG.AGENTIC_LLM_MODEL, 'gpt-4o-mini');

  return new VSCodeLLM({
    modelFamily,
    vendor: 'copilot',
    temperature: 0.7,
  });
}
