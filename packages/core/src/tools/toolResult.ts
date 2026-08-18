/**
 * The canonical error payload shared by both hosts. Each host wraps it in its
 * own protocol envelope: MCP sets isError alongside the JSON, VS Code returns
 * it as a text part. The JSON itself is identical.
 */

export interface ToolErrorPayload {
  error: { code: string; message: string };
}

export function toolErrorPayload(code: string, message: string): ToolErrorPayload {
  return { error: { code, message } };
}

export function isToolErrorPayload(value: unknown): value is ToolErrorPayload {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const error = (value as ToolErrorPayload).error;
  return typeof error === "object" && error !== null && typeof error.code === "string";
}
