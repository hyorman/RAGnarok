import * as vscode from "vscode";
import {
  MemoryServiceError,
  reduceMemoryOperationResult,
  type MemoryOperationInput,
  type MemoryService,
} from "@ragnarok/core";
import { TOOLS } from "./constants";
import type { ExtensionOperationRunner } from "./extensionLifecycle";
import { resolveMemoryHostContext, type MemoryHostContextHost } from "./memoryHostContext";

type MemoryToolInput = Record<string, unknown> & { action: MemoryOperationInput["action"] };

export interface MemoryToolRegistrationHost {
  registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>): vscode.Disposable;
  createToolResult(content: Array<vscode.LanguageModelTextPart | unknown>): vscode.LanguageModelToolResult;
  createTextPart(value: string): vscode.LanguageModelTextPart;
  createMarkdownString(value: string): vscode.MarkdownString;
}

const vscodeMemoryToolRegistrationHost: MemoryToolRegistrationHost = {
  registerTool: <T>(name: string, tool: vscode.LanguageModelTool<T>) => vscode.lm.registerTool(name, tool),
  createToolResult: (content) => new vscode.LanguageModelToolResult(content),
  createTextPart: (value) => new vscode.LanguageModelTextPart(value),
  createMarkdownString: (value) => new vscode.MarkdownString(value),
};

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function normalizedString(value: unknown, field: string, maxLength?: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MemoryServiceError("MEMORY_INVALID_INPUT", `Memory tool '${field}' must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new MemoryServiceError("MEMORY_INVALID_INPUT", `Memory tool '${field}' must not be empty`);
  }
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new MemoryServiceError(
      "MEMORY_INVALID_INPUT",
      `Memory tool '${field}' must not exceed ${maxLength} characters`,
    );
  }
  return normalized;
}

function normalizedStringArray(value: unknown, field: string, maxLength?: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MemoryServiceError("MEMORY_INVALID_INPUT", `Memory tool '${field}' must be an array`);
  }
  return value.map((item) => {
    const normalized = normalizedString(item, field, maxLength);
    if (normalized === undefined) {
      throw new MemoryServiceError("MEMORY_INVALID_INPUT", `Memory tool '${field}' entries must be strings`);
    }
    return normalized;
  });
}

function normalizeMemoryInput(input: MemoryToolInput): MemoryOperationInput {
  const content = normalizedString(input.content, "content", 50_000);
  const query = normalizedString(input.query, "query");
  const id = normalizedString(input.id, "id");
  const branch = normalizedString(input.branch, "branch", 255);
  const tags = normalizedStringArray(input.tags, "tags", 100);
  const ids = normalizedStringArray(input.ids, "ids");

  switch (input.action) {
    case "store":
      return defined({
        action: "store" as const,
        content: content ?? "",
        scope: input.scope,
        branch,
        tags,
        ttlDays: input.ttlDays,
      }) as MemoryOperationInput;
    case "recall":
      return defined({
        action: "recall" as const,
        query: query ?? "",
        topK: input.topK,
        includeEntities: input.includeEntities,
        includeAuto: input.includeAuto,
        reinforce: input.reinforce,
        scope: input.scope,
        branch,
      }) as MemoryOperationInput;
    case "forget":
      return defined({
        action: "forget" as const,
        id,
        olderThan: input.olderThan,
        expired: input.expired,
        scope: input.scope,
        branch,
      }) as MemoryOperationInput;
    case "stats":
      return { action: "stats" };
    case "list":
      return defined({
        action: "list" as const,
        limit: input.limit,
        includeAuto: input.includeAuto,
        scope: input.scope,
        branch,
      }) as MemoryOperationInput;
    case "decay":
      return defined({ action: "decay" as const, scope: input.scope, branch }) as MemoryOperationInput;
    case "history":
      return { action: "history", id: id ?? "" };
    case "promote":
      return defined({
        action: "promote" as const,
        branch: branch ?? "",
        ids,
        id,
      }) as MemoryOperationInput;
    case "links":
      return defined({ action: "links" as const, scope: input.scope, branch }) as MemoryOperationInput;
    case "communities":
      return defined({
        action: "communities" as const,
        scope: input.scope,
        branch,
      }) as MemoryOperationInput;
  }
}

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

export function registerMemoryTools(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  memoryService: Pick<MemoryService, "execute" | "reset">,
  operationRunner: ExtensionOperationRunner,
  registrationHost: MemoryToolRegistrationHost = vscodeMemoryToolRegistrationHost,
  contextHost?: MemoryHostContextHost,
  addToContextSubscriptions = true,
): vscode.Disposable {
  const memoryRegistration = registrationHost.registerTool<MemoryToolInput>(TOOLS.RAG_MEMORY, {
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

  let resetRegistration: vscode.Disposable;
  try {
    resetRegistration = registrationHost.registerTool<Record<string, never>>(TOOLS.RAG_RESET_MEMORY, {
      invoke: (_options, token) =>
        bridgeCancellation(token, operationRunner, TOOLS.RAG_RESET_MEMORY, async (signal) => {
          try {
            const result = await memoryService.reset(signal);
            return registrationHost.createToolResult([
              registrationHost.createTextPart(JSON.stringify(result, null, 2)),
            ]);
          } catch (error) {
            if (error instanceof MemoryServiceError) {
              return serviceErrorResult(registrationHost, error);
            }
            throw error;
          }
        }),
      prepareInvocation: () => ({
        confirmationMessages: {
          title: "Reset RAGnarok memory?",
          message: registrationHost.createMarkdownString(
            "This will permanently delete all memories in the RAGnarok extension memory location.",
          ),
        },
      }),
    });
  } catch (error) {
    memoryRegistration.dispose();
    throw error;
  }

  const registration: vscode.Disposable = {
    dispose: () => {
      memoryRegistration.dispose();
      resetRegistration.dispose();
    },
  };
  if (addToContextSubscriptions) {
    context.subscriptions.push(registration);
  }
  return registration;
}
