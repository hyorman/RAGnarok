import { MemoryOperationCoordinator } from "./memoryOperationCoordinator";
import { MemoryServiceError } from "./memoryServiceError";
import type {
  CommunitiesMemoryResult,
  DecayMemoryResult,
  ForgetMemoryResult,
  HistoryMemoryResult,
  LinksMemoryResult,
  ListMemoryResult,
  MemoryHostContext,
  MemoryOperationInput,
  MemoryOperationResult,
  MemoryResetResult,
  MemoryStatsResult,
  PromoteMemoryResult,
  RecallMemoryResult,
  StoreMemoryResult,
} from "./memoryServiceTypes";
import { MemoryStore } from "./memoryStore";
import type { MemoryScope } from "./types";

type StoreInput = Extract<MemoryOperationInput, { action: "store" }>;
type RecallInput = Extract<MemoryOperationInput, { action: "recall" }>;
type ForgetInput = Extract<MemoryOperationInput, { action: "forget" }>;
type ListInput = Extract<MemoryOperationInput, { action: "list" }>;
type DecayInput = Extract<MemoryOperationInput, { action: "decay" }>;
type HistoryInput = Extract<MemoryOperationInput, { action: "history" }>;
type PromoteInput = Extract<MemoryOperationInput, { action: "promote" }>;
type LinksInput = Extract<MemoryOperationInput, { action: "links" }>;
type CommunitiesInput = Extract<MemoryOperationInput, { action: "communities" }>;

const COMMUNITY_EXTRACTION_HINT =
  "New memory graph entities require an LLM provider. Persisted graph data remains available, but newly stored memories will not add entities or relationships until an LLM provider is configured.";

export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly coordinator: MemoryOperationCoordinator,
  ) {}

  execute<T extends MemoryOperationInput>(
    input: T,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<Extract<MemoryOperationResult, { action: T["action"] }>>;
  async execute(
    input: MemoryOperationInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<MemoryOperationResult> {
    try {
      switch (input.action) {
        case "store":
          return await this.executeStore(input, context, signal);
        case "recall":
          return await this.executeRecall(input, context, signal);
        case "forget":
          return await this.executeForget(input, context, signal);
        case "stats":
          return await this.executeStats(context, signal);
        case "list":
          return await this.executeList(input, context, signal);
        case "decay":
          return await this.executeDecay(input, signal);
        case "history":
          return await this.executeHistory(input, signal);
        case "promote":
          return await this.executePromote(input, signal);
        case "links":
          return await this.executeLinks(input, context, signal);
        case "communities":
          return await this.executeCommunities(input, context, signal);
      }
    } catch (error) {
      if (error instanceof MemoryServiceError || this.isCancellation(error, signal)) {
        throw error;
      }
      throw new MemoryServiceError("MEMORY_OPERATION_FAILED", `Unable to execute memory action "${input.action}"`, {
        cause: error,
      });
    }
  }

  async reset(signal?: AbortSignal): Promise<MemoryResetResult> {
    try {
      return await this.coordinator.runReset(async () => {
        await this.store.reset(true, signal);
        return { success: true } as const;
      }, signal);
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        throw error;
      }
      throw new MemoryServiceError("MEMORY_RESET_FAILED", "Unable to reset memory", { cause: error });
    }
  }

  private executeStore(
    input: StoreInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<StoreMemoryResult> {
    this.requireValue(input.content, "'content' is required for 'store' action");
    const { scope, branch } = this.resolveStoreScope(input.scope, input.branch, context);
    return this.coordinator.runMutation(async () => {
      const entry = await this.store.store({
        content: input.content,
        scope,
        branch,
        tags: input.tags,
        ...(input.ttlDays !== undefined ? { ttlDays: input.ttlDays } : {}),
        signal,
      });
      return {
        action: "store",
        memory: {
          id: entry.id,
          content: entry.content,
          scope: entry.scope,
          branch: entry.branch,
          entityIds: entry.entityIds,
          tags: entry.tags,
          createdAt: new Date(entry.createdAt).toISOString(),
        },
      };
    }, signal);
  }

  private executeRecall(
    input: RecallInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<RecallMemoryResult> {
    this.requireValue(input.query, "'query' is required for 'recall' action");
    const { scope, branch } = this.resolveSearchScope(input.scope, input.branch, context);
    const operation = async (): Promise<RecallMemoryResult> => {
      const result = await this.store.recall({
        query: input.query,
        scope,
        branch,
        topK: input.topK ?? 10,
        includeEntities: input.includeEntities ?? false,
        ...(input.includeAuto ? { includeAuto: true } : {}),
        ...(input.reinforce !== undefined ? { reinforce: input.reinforce } : {}),
        signal,
      });
      return {
        action: "recall",
        memories: result.memories.map(({ entry, score }) => ({
          id: entry.id,
          content: entry.content,
          scope: entry.scope,
          branch: entry.branch,
          score: this.round(score),
          tags: entry.tags,
          createdAt: new Date(entry.createdAt).toISOString(),
        })),
        entities: result.entities.map(({ entity, score }) => ({
          name: entity.name,
          type: entity.type,
          description: entity.description,
          score: this.round(score),
        })),
        count: result.memories.length,
      };
    };
    return input.reinforce === false
      ? this.coordinator.runRead(operation, signal)
      : this.coordinator.runMutation(operation, signal);
  }

  private executeForget(
    input: ForgetInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<ForgetMemoryResult> {
    this.validateForget(input);
    const { scope, branch } = this.resolveForgetScope(input.scope, input.branch, context);
    return this.coordinator.runMutation(async () => {
      const count = await this.store.forget(
        {
          id: input.id,
          scope,
          branch,
          olderThan: input.olderThan,
          expired: input.expired,
        },
        signal,
      );
      return { action: "forget", forgottenCount: count };
    }, signal);
  }

  private executeStats(context: MemoryHostContext, signal?: AbortSignal): Promise<MemoryStatsResult> {
    return this.coordinator.runRead(async () => {
      const stats = await this.store.stats();
      return {
        action: "stats",
        ...stats,
        workspace: {
          workingDir: context.workingDir,
          detectedBranch: context.branchContext.state === "resolved" ? context.branchContext.branch : null,
        },
      };
    }, signal);
  }

  private executeList(input: ListInput, context: MemoryHostContext, signal?: AbortSignal): Promise<ListMemoryResult> {
    const { scope, branch } = this.resolveSearchScope(input.scope, input.branch, context);
    return this.coordinator.runRead(async () => {
      const entries = await this.store.list({
        scope,
        branch,
        limit: input.limit ?? 50,
        ...(input.includeAuto ? { includeAuto: true } : {}),
      });
      return {
        action: "list",
        memories: entries.map((entry) => ({
          id: entry.id,
          content: this.summarize(entry.content),
          scope: entry.scope,
          branch: entry.branch,
          tags: entry.tags,
          accessCount: entry.accessCount,
          createdAt: new Date(entry.createdAt).toISOString(),
        })),
        count: entries.length,
      };
    }, signal);
  }

  private executeDecay(input: DecayInput, signal?: AbortSignal): Promise<DecayMemoryResult> {
    this.assertScope(input.scope);
    return this.coordinator.runRead(async () => {
      const { expiredCount: belowThresholdCount, ...status } = await this.store.runDecay(input.scope, input.branch);
      return {
        action: "decay",
        ...status,
        belowThresholdCount,
        note: "Use the 'forget' action with expired: true to remove expired entries",
      };
    }, signal);
  }

  private executeHistory(input: HistoryInput, signal?: AbortSignal): Promise<HistoryMemoryResult> {
    this.requireValue(input.id, "'id' is required for 'history' action");
    return this.coordinator.runRead(async () => {
      const versions = await this.store.getVersionHistory(input.id);
      return {
        action: "history",
        entryId: input.id,
        versions: versions.map((version) => ({
          id: version.id,
          content: this.summarize(version.content),
          version: version.version ?? 1,
          isLatest: version.isLatest ?? true,
          confidence: this.round(version.confidence ?? 1),
          supersededBy: version.supersededBy ?? null,
          createdAt: new Date(version.createdAt).toISOString(),
        })),
        count: versions.length,
      };
    }, signal);
  }

  private executePromote(input: PromoteInput, signal?: AbortSignal): Promise<PromoteMemoryResult> {
    this.requireValue(input.branch, "'branch' is required for 'promote' action");
    const entryIds = input.ids ?? (input.id ? input.id.split(",").map((id) => id.trim()) : undefined);
    return this.coordinator.runMutation(async () => {
      const promotedCount = await this.store.promoteToWorkspace(input.branch, entryIds, signal);
      return { action: "promote", branch: input.branch, promotedCount };
    }, signal);
  }

  private executeLinks(
    input: LinksInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<LinksMemoryResult> {
    this.assertScope(input.scope);
    const targetScope =
      context.branchContext.state === "resolved" ? `branch:${context.branchContext.branch}` : undefined;
    if (!targetScope) {
      return this.coordinator.runRead(async () => ({ action: "links", links: [], count: 0 }), signal);
    }
    const sourceScope =
      input.scope === "branch" && input.branch ? `branch:${input.branch}` : (input.scope ?? "workspace");
    return this.coordinator.runRead(async () => {
      const links = await this.store.discoverLinks(sourceScope, targetScope);
      return {
        action: "links",
        links: links.map((link) => ({
          sourceScope: link.sourceScope,
          targetScope: link.targetScope,
          entityName: link.entityName,
          entityType: link.entityType,
          confidence: this.round(link.confidence),
        })),
        count: links.length,
      };
    }, signal);
  }

  private executeCommunities(
    input: CommunitiesInput,
    context: MemoryHostContext,
    signal?: AbortSignal,
  ): Promise<CommunitiesMemoryResult> {
    const { scope, branch } = this.resolveStoreScope(input.scope, input.branch, context);
    return this.coordinator.runRead(async () => {
      const communities = await this.store.recallCommunities(scope, branch);
      const entityExtractionEnabled = this.store.isEntityExtractionEnabled();
      return {
        action: "communities",
        scope,
        branch,
        communities,
        count: communities.length,
        entityExtractionEnabled,
        ...(!entityExtractionEnabled ? { hint: COMMUNITY_EXTRACTION_HINT } : {}),
      };
    }, signal);
  }

  private resolveStoreScope(
    scope: MemoryScope | undefined,
    branch: string | undefined,
    context: MemoryHostContext,
  ): { scope: MemoryScope; branch?: string } {
    this.assertScope(scope);
    const resolvedScope = scope ?? "workspace";
    if (resolvedScope === "workspace") {
      return { scope: "workspace", branch: undefined };
    }
    return { scope: "branch", branch: branch || this.requireHostBranch(context) };
  }

  private resolveSearchScope(
    scope: MemoryScope | undefined,
    branch: string | undefined,
    context: MemoryHostContext,
  ): { scope?: MemoryScope; branch?: string } {
    this.assertScope(scope);
    if (scope === "workspace") {
      return { scope, branch: undefined };
    }
    if (scope === "branch") {
      return { scope, branch: branch || this.requireHostBranch(context) };
    }
    return {
      scope: undefined,
      branch: branch || (context.branchContext.state === "resolved" ? context.branchContext.branch : undefined),
    };
  }

  private resolveForgetScope(
    scope: MemoryScope | undefined,
    branch: string | undefined,
    context: MemoryHostContext,
  ): { scope?: MemoryScope; branch?: string } {
    this.assertScope(scope);
    if (scope === "workspace") {
      return { scope, branch: undefined };
    }
    if (scope === "branch" || branch) {
      return { scope: "branch", branch: branch || this.requireHostBranch(context) };
    }
    return { scope: undefined, branch: undefined };
  }

  private requireHostBranch(context: MemoryHostContext): string {
    if (context.branchContext.state === "resolved") {
      return context.branchContext.branch;
    }
    if (context.branchContext.state === "ambiguous") {
      throw new MemoryServiceError(
        "MEMORY_BRANCH_AMBIGUOUS",
        "Branch scope requires an explicit branch when the workspace root is ambiguous",
      );
    }
    throw new MemoryServiceError(
      "MEMORY_BRANCH_UNAVAILABLE",
      "Branch scope requires an explicit branch or a detectable Git branch",
    );
  }

  private validateForget(input: ForgetInput): void {
    if (input.branch && input.scope === "workspace") {
      this.invalid("'branch' cannot be combined with workspace scope for 'forget'");
    }
    if (input.olderThan !== undefined && (!Number.isInteger(input.olderThan) || input.olderThan < 1)) {
      this.invalid("'olderThan' must be a positive whole number of days for 'forget'");
    }
    if (input.olderThan !== undefined && !input.scope && !input.branch) {
      this.invalid("'olderThan' requires an explicit 'scope' or 'branch' for 'forget'");
    }
    if (input.olderThan !== undefined && input.expired) {
      this.invalid("'olderThan' cannot be combined with 'expired' for 'forget'");
    }
    if (input.id && (input.scope || input.branch || input.olderThan !== undefined || input.expired)) {
      this.invalid("'id' cannot be combined with scope, branch, olderThan, or expired for 'forget'");
    }
    if (!input.id && input.olderThan === undefined && !input.expired) {
      this.invalid("'forget' requires 'id', 'olderThan', or 'expired: true'");
    }
  }

  private assertScope(scope: MemoryScope | undefined): void {
    if (scope !== undefined && scope !== "workspace" && scope !== "branch") {
      throw new MemoryServiceError("MEMORY_UNSUPPORTED_SCOPE", "Memory scope must be 'workspace' or 'branch'");
    }
  }

  private requireValue(value: string, message: string): void {
    if (!value.trim()) {
      this.invalid(message);
    }
  }

  private invalid(message: string): never {
    throw new MemoryServiceError("MEMORY_INVALID_INPUT", message);
  }

  private summarize(content: string): string {
    return content.slice(0, 200) + (content.length > 200 ? "..." : "");
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  private isCancellation(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true && error === signal.reason;
  }
}
