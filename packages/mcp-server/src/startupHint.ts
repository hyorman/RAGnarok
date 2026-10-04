import { StorageFormatVersionError, UnsupportedStorageError } from "@ragnarok/core";

/**
 * The one-line next action for a startup refusal that has one, or undefined for
 * any other failure. A stdio client shows the operator nothing but stderr, so the
 * refusal names the action there. Routed by error type, never by message text.
 */
export function startupFailureHint(error: unknown): string | undefined {
  if (error instanceof UnsupportedStorageError) {
    const found = error.entries.length > 0 ? ` (found: ${error.entries.join(", ")})` : "";
    return (
      `This storage holds data from an unsupported pre-0.4 build${found}. Start once with RAGNAROK_RESET_STORAGE=1 ` +
      "to move it into a backup folder and begin a new store, or point RAGNAROK_STORAGE_DIR at another directory."
    );
  }
  if (error instanceof StorageFormatVersionError) {
    return "This storage was written by a newer RAGnarok build. Upgrade, or point RAGNAROK_STORAGE_DIR at another directory.";
  }
  return undefined;
}
