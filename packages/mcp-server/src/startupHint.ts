import { StorageFormatVersionError, UnsupportedStorageError } from "@ragnarok/core";

/**
 * The one-line next action for a startup refusal that has one, or undefined for
 * any other failure. A stdio client shows the operator nothing but stderr, so the
 * refusal names the action there. Routed by error type, never by message text.
 * What was found is not repeated: the refusal's own message lists it.
 */
export function startupFailureHint(error: unknown): string | undefined {
  if (error instanceof UnsupportedStorageError) {
    return (
      "This storage holds data from an unsupported pre-0.4 build. Start once with RAGNAROK_RESET_STORAGE=1 " +
      "to move it into a backup folder and begin a new store, or point RAGNAROK_STORAGE_DIR at another directory."
    );
  }
  if (error instanceof StorageFormatVersionError) {
    return (
      "This storage was written by a newer RAGnarok build. " +
      "Upgrade, or point RAGNAROK_STORAGE_DIR at another directory."
    );
  }
  return undefined;
}

const FATAL_STARTUP_PREFIX = "Fatal error starting MCP server:";

/**
 * Print a fatal startup error. A refusal with a next action is expected, not a
 * crash: its message (which names the storage and what was found there) is
 * printed once, without a stack trace, followed by the action. Any other error
 * is printed whole, stack included.
 */
export function reportStartupFailure(error: unknown, write: (...parts: unknown[]) => void = console.error): void {
  const hint = startupFailureHint(error);
  if (hint === undefined) {
    write(FATAL_STARTUP_PREFIX, error);
    return;
  }
  write(`${FATAL_STARTUP_PREFIX} ${error instanceof Error ? error.message : String(error)}`);
  write(hint);
}
