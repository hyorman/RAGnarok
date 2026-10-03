/**
 * One place that decides what kind of failure a tool hit, and what a person
 * should be told about it. Hosts render the result in their own dialect —
 * an MCP tool payload, a VS Code notification, a language-model tool result —
 * but they must not each re-derive the classification. They drifted once:
 * the MCP host mapped StorageBusyError while the VS Code language-model tools
 * did not, even though MemoryService rethrows it untouched precisely so a
 * host can match it by name and offer a retry.
 *
 * Routing is on `error.name`, never on message text, and never on a bare
 * object that merely carries a matching `name` field — a look-alike payload
 * must not be able to claim a retryable kind.
 */

export type ToolErrorKind = "storage-busy" | "shared-topic-read-only" | "generic";

export interface ClassifiedToolError {
  readonly kind: ToolErrorKind;
  /** Ready to show to a person or return to a model. */
  readonly message: string;
  /** Present only for "storage-busy", and only when the lock recorded a pid. */
  readonly holderPid?: number;
}

interface StorageBusyShape extends Error {
  holder?: { pid?: number } | null;
}

export function classifyToolError(error: unknown): ClassifiedToolError {
  if (!(error instanceof Error)) {
    return { kind: "generic", message: String(error) };
  }

  if (error.name === "StorageBusyError") {
    const pid = (error as StorageBusyShape).holder?.pid;
    const suffix = typeof pid === "number" ? ` (pid ${pid})` : "";
    return {
      kind: "storage-busy",
      message: `Storage is busy: another RAGnarōk process is writing${suffix}. Retry shortly.`,
      ...(typeof pid === "number" ? { holderPid: pid } : {}),
    };
  }

  if (error.name === "SharedTopicReadOnlyError") {
    return { kind: "shared-topic-read-only", message: error.message };
  }

  return { kind: "generic", message: error.message };
}
