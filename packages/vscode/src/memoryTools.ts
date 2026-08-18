import * as vscode from "vscode";
import {
  MemoryServiceError,
  normalizeMemoryInput,
  reduceMemoryOperationResult,
  type MemoryService,
  type MemoryToolInput,
} from "@ragnarok/core";
import { TOOLS } from "./constants";
import type { ExtensionOperationRunner } from "./extensionLifecycle";
import { resolveMemoryHostContext, type MemoryHostContextHost } from "./memoryHostContext";

export interface MemoryToolRegistrationHost {
  registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>): vscode.Disposable;
  createToolResult(content: Array<vscode.LanguageModelTextPart | unknown>): vscode.LanguageModelToolResult;
  createTextPart(value: string): vscode.LanguageModelTextPart;
}

const vscodeMemoryToolRegistrationHost: MemoryToolRegistrationHost = {
  registerTool: <T>(name: string, tool: vscode.LanguageModelTool<T>) => vscode.lm.registerTool(name, tool),
  createToolResult: (content) => new vscode.LanguageModelToolResult(content),
  createTextPart: (value) => new vscode.LanguageModelTextPart(value),
};

function serviceErrorResult(
  registrationHost: MemoryToolRegistrationHost,
  error: MemoryServiceError,
): vscode.LanguageModelToolResult {
  // Returned, not thrown: a thrown error reaches the model as an opaque tool
  // failure, while a structured payload lets it correct its arguments.
  return registrationHost.createToolResult([
    registrationHost.createTextPart(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)),
  ]);
}

function bridgeCancellation(
  token: vscode.CancellationToken,
  operationRunner: ExtensionOperationRunner,
  label: string,
  operation: (signal: AbortSignal) => Promise<vscode.LanguageModelToolResult>,
): Promise<vscode.LanguageModelToolResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error(`${label} cancelled`));
  if (token.isCancellationRequested) {
    cancel();
  }
  const cancellation = token.onCancellationRequested(cancel);

  return operationRunner(label, async (lifecycleSignal) => {
    const stop = () => controller.abort(lifecycleSignal.reason);
    if (lifecycleSignal.aborted) {
      stop();
    } else {
      lifecycleSignal.addEventListener("abort", stop, { once: true });
    }
    try {
      controller.signal.throwIfAborted();
      return await operation(controller.signal);
    } finally {
      lifecycleSignal.removeEventListener("abort", stop);
    }
  }).finally(() => cancellation.dispose());
}

export interface RegisterMemoryToolsOptions {
  registrationHost?: MemoryToolRegistrationHost;
  contextHost?: MemoryHostContextHost;
}

/**
 * Registers the single model-callable memory tool. Resetting memory is not one:
 * it is irreversible, so it stays a human action in the RAGnarōk sidebar.
 */
export function registerMemoryTools(
  memoryService: Pick<MemoryService, "execute">,
  operationRunner: ExtensionOperationRunner,
  options: RegisterMemoryToolsOptions = {},
): vscode.Disposable {
  const { registrationHost = vscodeMemoryToolRegistrationHost, contextHost } = options;

  return registrationHost.registerTool<MemoryToolInput>(TOOLS.RAG_MEMORY, {
    invoke: (options, token) =>
      bridgeCancellation(token, operationRunner, TOOLS.RAG_MEMORY, async (signal) => {
        try {
          const input = normalizeMemoryInput(options.input);
          const hostContext = await resolveMemoryHostContext(input, contextHost);
          signal.throwIfAborted();
          const result = await memoryService.execute(input, hostContext, signal);
          const reduced = await reduceMemoryOperationResult(
            result,
            options.tokenizationOptions?.tokenBudget ?? Number.POSITIVE_INFINITY,
            async (candidate) =>
              options.tokenizationOptions
                ? options.tokenizationOptions.countTokens(JSON.stringify(candidate, null, 2), token)
                : 0,
            signal,
          );
          signal.throwIfAborted();
          return registrationHost.createToolResult([registrationHost.createTextPart(JSON.stringify(reduced, null, 2))]);
        } catch (error) {
          if (error instanceof MemoryServiceError) {
            return serviceErrorResult(registrationHost, error);
          }
          throw error;
        }
      }),
  });
}
