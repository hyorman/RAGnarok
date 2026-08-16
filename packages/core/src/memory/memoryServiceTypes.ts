import type { MemoryScope } from "./types";

export type MemoryBranchContext =
  | { state: "resolved"; branch: string }
  | { state: "unavailable" }
  | { state: "ambiguous" };

export interface MemoryHostContext {
  workingDir: string;
  branchContext: MemoryBranchContext;
}

type ScopedInput = { scope?: MemoryScope; branch?: string };

export type MemoryOperationInput =
  | ({ action: "store"; content: string; tags?: string[]; ttlDays?: number } & ScopedInput)
  | ({
      action: "recall";
      query: string;
      topK?: number;
      includeEntities?: boolean;
      includeAuto?: boolean;
      reinforce?: boolean;
    } & ScopedInput)
  | ({ action: "forget"; id?: string; olderThan?: number; expired?: boolean } & ScopedInput)
  | { action: "stats" }
  | ({ action: "list"; limit?: number; includeAuto?: boolean } & ScopedInput)
  | ({ action: "decay" } & ScopedInput)
  | { action: "history"; id: string }
  | { action: "promote"; branch: string; ids?: string[]; id?: string }
  | ({ action: "links" } & ScopedInput)
  | ({ action: "communities" } & ScopedInput);

export interface MemoryResponseMeta {
  truncated: true;
  returnedCount: number;
  totalCount: number;
  reason: "tokenBudget";
}

interface MemoryOperationResultBase {
  responseMeta?: MemoryResponseMeta;
}

export interface StoreMemoryResult extends MemoryOperationResultBase {
  action: "store";
  memory: {
    id: string;
    content: string;
    scope: MemoryScope;
    branch?: string;
    entityIds: string[];
    tags: string[];
    createdAt: string;
  };
}

export interface RecallMemoryResult extends MemoryOperationResultBase {
  action: "recall";
  memories: Array<{
    id: string;
    content: string;
    scope: MemoryScope;
    branch?: string;
    score: number;
    tags: string[];
    createdAt: string;
  }>;
  entities: Array<{
    name: string;
    type: string;
    description: string;
    score: number;
  }>;
  count: number;
}

export interface ForgetMemoryResult extends MemoryOperationResultBase {
  action: "forget";
  forgottenCount: number;
}

export interface MemoryStatsResult extends MemoryOperationResultBase {
  action: "stats";
  totalMemories: number;
  totalEntities: number;
  totalRelationships: number;
  byScope: {
    workspace: number;
    branch: number;
  };
  branches: string[];
  entityTypes: Record<string, number>;
  lastUpdated: number;
  workspace: {
    workingDir: string;
    detectedBranch: string | null;
  };
}

export interface ListMemoryResult extends MemoryOperationResultBase {
  action: "list";
  memories: Array<{
    id: string;
    content: string;
    scope: MemoryScope;
    branch?: string;
    tags: string[];
    accessCount: number;
    createdAt: string;
  }>;
  count: number;
}

export interface DecayMemoryResult extends MemoryOperationResultBase {
  action: "decay";
  totalEntries: number;
  decayedCount: number;
  nearThresholdCount: number;
  belowThresholdCount: number;
  note: string;
}

export interface HistoryMemoryResult extends MemoryOperationResultBase {
  action: "history";
  entryId: string;
  versions: Array<{
    id: string;
    content: string;
    version: number;
    isLatest: boolean;
    confidence: number;
    supersededBy: string | null;
    createdAt: string;
  }>;
  count: number;
}

export interface PromoteMemoryResult extends MemoryOperationResultBase {
  action: "promote";
  branch: string;
  promotedCount: number;
}

export interface LinksMemoryResult extends MemoryOperationResultBase {
  action: "links";
  links: Array<{
    sourceScope: string;
    targetScope: string;
    entityName: string;
    entityType: string;
    confidence: number;
  }>;
  count: number;
}

export interface CommunitiesMemoryResult extends MemoryOperationResultBase {
  action: "communities";
  scope: MemoryScope;
  branch?: string;
  communities: Array<{
    id: number;
    entityNames: string[];
  }>;
  count: number;
  entityExtractionEnabled: boolean;
  hint?: string;
}

export type MemoryOperationResult =
  | StoreMemoryResult
  | RecallMemoryResult
  | ForgetMemoryResult
  | MemoryStatsResult
  | ListMemoryResult
  | DecayMemoryResult
  | HistoryMemoryResult
  | PromoteMemoryResult
  | LinksMemoryResult
  | CommunitiesMemoryResult;

export type MemoryResetResult = { success: true };
