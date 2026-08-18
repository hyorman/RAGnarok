import { MemoryServiceError } from "../memory/memoryServiceError";
import type { MemoryOperationInput } from "../memory/memoryServiceTypes";
import { TOOL_LIMITS } from "./toolContracts";

export type MemoryToolInput = Record<string, unknown> & { action: MemoryOperationInput["action"] };

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

/**
 * Single normalizer for both hosts. Note two deliberate coercions: `history`
 * and `promote` pass an empty string through when their required field is
 * missing, so MemoryService reports a precise error instead of the field
 * silently vanishing.
 */
export function normalizeMemoryInput(input: MemoryToolInput): MemoryOperationInput {
  const content = normalizedString(input.content, "content", TOOL_LIMITS.memoryContent);
  const query = normalizedString(input.query, "query", TOOL_LIMITS.memoryQuery);
  const id = normalizedString(input.id, "id", TOOL_LIMITS.memoryId);
  const branch = normalizedString(input.branch, "branch", TOOL_LIMITS.branch);
  const tags = normalizedStringArray(input.tags, "tags", TOOL_LIMITS.tag);
  const ids = normalizedStringArray(input.ids, "ids", TOOL_LIMITS.memoryId);

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
      return defined({ action: "promote" as const, branch: branch ?? "", ids, id }) as MemoryOperationInput;
    case "links":
      return defined({ action: "links" as const, scope: input.scope, branch }) as MemoryOperationInput;
    case "communities":
      return defined({ action: "communities" as const, scope: input.scope, branch }) as MemoryOperationInput;
    default:
      // Reached only from a host that does not validate the declared input
      // schema before invoking (VS Code does not). Without this arm the switch
      // falls through to undefined and the host TypeErrors far from the cause.
      throw new MemoryServiceError(
        "MEMORY_INVALID_INPUT",
        `Memory tool unsupported action '${String((input as { action?: unknown }).action)}'`,
      );
  }
}
