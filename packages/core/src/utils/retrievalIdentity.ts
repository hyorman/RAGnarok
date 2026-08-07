import { createHash } from "crypto";
import { Document as LangChainDocument } from "@langchain/core/documents";

export function getChunkId(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.chunkId;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * Stable retrieval identity shared by every fusion path. A missing chunkId
 * never falls back to a lossy prefix; the complete content and canonical
 * metadata participate in the digest.
 */
export function getDocumentIdentity(document: LangChainDocument): string {
  const chunkId = getChunkId(document.metadata);
  if (chunkId) {
    return `chunk:${chunkId}`;
  }
  return `document:${createHash("sha256")
    .update(document.pageContent)
    .update("\0")
    .update(JSON.stringify(canonicalize(document.metadata ?? {})))
    .digest("hex")}`;
}
