export type MemoryServiceErrorCode =
  | "MEMORY_INVALID_INPUT"
  | "MEMORY_BRANCH_UNAVAILABLE"
  | "MEMORY_BRANCH_AMBIGUOUS"
  | "MEMORY_UNSUPPORTED_SCOPE"
  | "MEMORY_OPERATION_FAILED"
  | "MEMORY_RESET_FAILED"
  | "GRAPH_VISUALIZATION_FAILED";

interface ErrorOptions {
  cause?: unknown;
}

export class MemoryServiceError extends Error {
  declare readonly cause?: unknown;

  constructor(
    readonly code: MemoryServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message);
    this.name = "MemoryServiceError";
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        writable: true,
      });
    }
  }
}
