import * as path from "path";
import { createHash } from "crypto";

/** Generate a unique topic ID */
export function generateTopicId(): string {
  return `topic-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function documentIdForSource(source: string, sourceType: "file" | "web" | "github" = "file"): string {
  let normalized: string;
  try {
    const url = new URL(source);
    url.hash = "";
    normalized = url.toString();
  } catch {
    normalized = path.resolve(source).replace(/\\/g, "/");
  }
  return `doc-${createHash("sha256")
    .update(JSON.stringify({ type: sourceType, source: normalized }))
    .digest("hex")}`;
}

/** Map file extension to document file type */
export function mapFileType(extension: string): "pdf" | "markdown" | "html" | "text" | "web" | "github" {
  switch (extension.toLowerCase()) {
    case "pdf":
      return "pdf";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    case "txt":
      return "text";
    default:
      return "text";
  }
}
