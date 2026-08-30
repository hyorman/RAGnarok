import { expect } from "chai";
import * as sinon from "sinon";
import {
  MemoryOperationCoordinator,
  MemoryService,
  MemoryServiceError,
  type MemoryHostContext,
  type MemoryOperationInput,
  type MemoryOperationResult,
} from "../src";
import { StorageBusyError } from "../src/utils/storageLock";
import type { MemoryEntry, MemoryEntity } from "../src/memory/types";
import type { MemoryStore } from "../src/memory/memoryStore";

const CREATED_AT = Date.parse("2026-08-13T00:00:00.000Z");
const workspaceContext: MemoryHostContext = {
  workingDir: "/workspace",
  branchContext: { state: "resolved", branch: "feature/shared-memory" },
};

const unavailableContext: MemoryHostContext = {
  workingDir: "",
  branchContext: { state: "unavailable" },
};

const actionFixtures = [
  { action: "store", content: "fact" },
  { action: "recall", query: "fact" },
  { action: "forget", id: "memory-1" },
  { action: "stats" },
  { action: "list" },
  { action: "decay" },
  { action: "history", id: "memory-1" },
  { action: "promote", branch: "feature", ids: ["memory-1"] },
  { action: "links" },
  { action: "communities" },
] satisfies MemoryOperationInput[];

const resultFixtures = [
  {
    action: "store",
    memory: {
      id: "memory-1",
      content: "fact",
      scope: "workspace",
      branch: undefined,
      entityIds: [],
      tags: [],
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  },
  { action: "recall", memories: [], entities: [], count: 0 },
  { action: "forget", forgottenCount: 0 },
  {
    action: "stats",
    totalMemories: 0,
    totalEntities: 0,
    totalRelationships: 0,
    byScope: { workspace: 0, branch: 0 },
    branches: [],
    entityTypes: {},
    lastUpdated: 0,
    workspace: { workingDir: "/workspace", detectedBranch: "feature/shared-memory" },
  },
  { action: "list", memories: [], count: 0 },
  {
    action: "decay",
    totalEntries: 0,
    decayedCount: 0,
    nearThresholdCount: 0,
    belowThresholdCount: 0,
    note: "Use the 'forget' action with expired: true to remove expired entries",
  },
  { action: "history", entryId: "memory-1", versions: [], count: 0 },
  { action: "promote", branch: "feature", promotedCount: 0 },
  { action: "links", links: [], count: 0 },
  {
    action: "communities",
    scope: "workspace",
    branch: undefined,
    communities: [],
    count: 0,
    entityExtractionEnabled: true,
  },
] satisfies MemoryOperationResult[];

describe("MemoryService", function () {
  let store: StubbedMemoryStore;
  let coordinator: MemoryOperationCoordinator;
  let service: MemoryService;

  beforeEach(function () {
    store = stubMemoryStore();
    coordinator = new MemoryOperationCoordinator();
    service = new MemoryService(store as unknown as MemoryStore, coordinator);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("defines all ten action input and result variants", function () {
    expect(actionFixtures.map(({ action }) => action)).to.deep.equal([
      "store",
      "recall",
      "forget",
      "stats",
      "list",
      "decay",
      "history",
      "promote",
      "links",
      "communities",
    ]);
    expect(resultFixtures.map(({ action }) => action)).to.deep.equal(actionFixtures.map(({ action }) => action));
  });

  it("formats stored memory and applies workspace defaults", async function () {
    store.store.resolves(memoryEntry({ content: "remember me", entityIds: ["entity-1"], tags: ["shared"] }));

    expect(
      await service.execute({ action: "store", content: "remember me", tags: ["shared"] }, workspaceContext),
    ).to.deep.equal({
      action: "store",
      memory: {
        id: "memory-1",
        content: "remember me",
        scope: "workspace",
        branch: undefined,
        entityIds: ["entity-1"],
        tags: ["shared"],
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    });
    expect(store.store.calledOnce).to.equal(true);
    expect(
      store.store.calledWithMatch({
        content: "remember me",
        scope: "workspace",
        branch: undefined,
        tags: ["shared"],
      }),
    ).to.equal(true);
  });

  it("formats recall exactly once in the shared service", async function () {
    store.recall.resolves({
      memories: [{ entry: memoryEntry({ content: "remember me" }), score: 0.98765 }],
      entities: [{ entity: memoryEntity({ name: "RAGnarok" }), score: 0.55555 }],
    });

    expect(
      await service.execute({ action: "recall", query: "what", includeEntities: true }, workspaceContext),
    ).to.deep.equal({
      action: "recall",
      memories: [
        {
          id: "memory-1",
          content: "remember me",
          scope: "workspace",
          branch: undefined,
          score: 0.988,
          tags: [],
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      entities: [{ name: "RAGnarok", type: "project", description: "", score: 0.556 }],
      count: 1,
    });
    expect(
      store.recall.calledOnce &&
        store.recall.calledWithMatch({
          query: "what",
          scope: undefined,
          branch: "feature/shared-memory",
          topK: 10,
          includeEntities: true,
        }),
    ).to.equal(true);
  });

  it("returns a successful zero-count forget receipt", async function () {
    store.forget.resolves(0);

    expect(await service.execute({ action: "forget", id: "missing" }, workspaceContext)).to.deep.equal({
      action: "forget",
      forgottenCount: 0,
    });
    expect(store.forget.calledOnce && store.forget.calledWithMatch({ id: "missing" })).to.equal(true);
  });

  it("formats stats with host context", async function () {
    store.stats.resolves({
      totalMemories: 3,
      totalEntities: 2,
      totalRelationships: 1,
      byScope: { workspace: 2, branch: 1 },
      branches: ["feature/shared-memory"],
      entityTypes: { project: 2 },
      lastUpdated: CREATED_AT,
    });

    expect(await service.execute({ action: "stats" }, workspaceContext)).to.deep.equal({
      action: "stats",
      totalMemories: 3,
      totalEntities: 2,
      totalRelationships: 1,
      byScope: { workspace: 2, branch: 1 },
      branches: ["feature/shared-memory"],
      entityTypes: { project: 2 },
      lastUpdated: CREATED_AT,
      workspace: { workingDir: "/workspace", detectedBranch: "feature/shared-memory" },
    });
  });

  it("formats list summaries and applies defaults", async function () {
    store.list.resolves([memoryEntry({ content: "x".repeat(201), accessCount: 4 })]);

    expect(await service.execute({ action: "list" }, workspaceContext)).to.deep.equal({
      action: "list",
      memories: [
        {
          id: "memory-1",
          content: `${"x".repeat(200)}...`,
          scope: "workspace",
          branch: undefined,
          tags: [],
          accessCount: 4,
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      count: 1,
    });
    expect(
      store.list.calledOnce &&
        store.list.calledWithMatch({ scope: undefined, branch: "feature/shared-memory", limit: 50 }),
    ).to.equal(true);
  });

  it("formats decay status without deleting entries", async function () {
    store.runDecay.resolves({ totalEntries: 8, decayedCount: 3, expiredCount: 2, nearThresholdCount: 1 });

    expect(
      await service.execute({ action: "decay", scope: "branch", branch: "feature" }, workspaceContext),
    ).to.deep.equal({
      action: "decay",
      totalEntries: 8,
      decayedCount: 3,
      nearThresholdCount: 1,
      belowThresholdCount: 2,
      note: "Use the 'forget' action with expired: true to remove expired entries",
    });
    expect(store.runDecay.calledOnceWithExactly("branch", "feature")).to.equal(true);
  });

  describe("decay scope resolution", function () {
    it("decays the host branch when branch scope is requested without a branch", async function () {
      await service.execute({ action: "decay", scope: "branch" }, workspaceContext);
      expect(store.runDecay.calledOnceWithExactly("branch", "feature/shared-memory")).to.equal(true);
    });

    it("rejects branch-scope decay when no branch is resolvable", async function () {
      const error = await serviceError(service.execute({ action: "decay", scope: "branch" }, unavailableContext));
      expect(error.code).to.equal("MEMORY_BRANCH_UNAVAILABLE");
      expect(store.runDecay.called).to.equal(false);
    });

    it("treats a bare branch as branch scope", async function () {
      await service.execute({ action: "decay", branch: "dev" }, unavailableContext);
      expect(store.runDecay.calledOnceWithExactly("branch", "dev")).to.equal(true);
    });

    it("still decays every scope when neither scope nor branch is given", async function () {
      await service.execute({ action: "decay" }, unavailableContext);
      expect(store.runDecay.calledOnceWithExactly(undefined, undefined)).to.equal(true);
    });

    it("rejects workspace-scope decay combined with a branch", async function () {
      const error = await serviceError(
        service.execute({ action: "decay", scope: "workspace", branch: "dev" }, workspaceContext),
      );
      expect(error.code).to.equal("MEMORY_INVALID_INPUT");
    });
  });

  it("formats history summaries, defaults, confidence rounding, and empty history", async function () {
    store.getVersionHistory.onFirstCall().resolves([
      memoryEntry({
        id: "memory-v2",
        content: "v".repeat(201),
        version: 2,
        isLatest: false,
        confidence: 0.55555,
        supersededBy: "memory-v3",
      }),
    ]);
    store.getVersionHistory.onSecondCall().resolves([]);

    expect(await service.execute({ action: "history", id: "memory-v2" }, workspaceContext)).to.deep.equal({
      action: "history",
      entryId: "memory-v2",
      versions: [
        {
          id: "memory-v2",
          content: `${"v".repeat(200)}...`,
          version: 2,
          isLatest: false,
          confidence: 0.556,
          supersededBy: "memory-v3",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      count: 1,
    });
    expect(await service.execute({ action: "history", id: "missing" }, workspaceContext)).to.deep.equal({
      action: "history",
      entryId: "missing",
      versions: [],
      count: 0,
    });
  });

  it("accepts legacy comma-separated promotion IDs", async function () {
    store.promoteToWorkspace.resolves(2);

    expect(
      await service.execute({ action: "promote", branch: "feature", id: "memory-1, memory-2" }, workspaceContext),
    ).to.deep.equal({ action: "promote", branch: "feature", promotedCount: 2 });
    expect(
      store.promoteToWorkspace.calledOnce &&
        store.promoteToWorkspace.calledWithMatch("feature", ["memory-1", "memory-2"]),
    ).to.equal(true);
  });

  it("formats links using the host current branch", async function () {
    store.discoverLinks.resolves([
      {
        sourceScope: "workspace",
        targetScope: "branch:feature/shared-memory",
        sourceEntityId: "source",
        targetEntityId: "target",
        entityName: "RAGnarok",
        entityType: "project",
        confidence: 0.98765,
      },
    ]);

    expect(await service.execute({ action: "links" }, workspaceContext)).to.deep.equal({
      action: "links",
      links: [
        {
          sourceScope: "workspace",
          targetScope: "branch:feature/shared-memory",
          entityName: "RAGnarok",
          entityType: "project",
          confidence: 0.988,
        },
      ],
      count: 1,
    });
    expect(store.discoverLinks.calledOnceWithExactly("workspace", "branch:feature/shared-memory")).to.equal(true);
  });

  it("returns persisted communities and a no-extractor hint", async function () {
    store.isEntityExtractionEnabled.returns(false);
    store.recallCommunities.resolves([{ id: 7, entityNames: ["RAGnarok", "TypeScript"] }]);

    expect(await service.execute({ action: "communities" }, workspaceContext)).to.deep.equal({
      action: "communities",
      scope: "workspace",
      branch: undefined,
      communities: [{ id: 7, entityNames: ["RAGnarok", "TypeScript"] }],
      count: 1,
      entityExtractionEnabled: false,
      hint: "New memory graph entities require an LLM provider. Persisted graph data remains available, but newly stored memories will not add entities or relationships until an LLM provider is configured.",
    });
    expect(store.recallCommunities.calledOnceWithExactly("workspace", undefined)).to.equal(true);
  });

  it("rejects ambiguous branch auto-detection without selecting a root", async function () {
    await expectServiceError(
      service.execute(
        { action: "store", content: "branch fact", scope: "branch" },
        { workingDir: "/workspace", branchContext: { state: "ambiguous" } },
      ),
      "MEMORY_BRANCH_AMBIGUOUS",
    );
    expect(store.store.called).to.equal(false);
  });

  it("rejects unavailable required branch context", async function () {
    await expectServiceError(
      service.execute(
        { action: "communities", scope: "branch" },
        { workingDir: "/workspace", branchContext: { state: "unavailable" } },
      ),
      "MEMORY_BRANCH_UNAVAILABLE",
    );
    expect(store.recallCommunities.called).to.equal(false);
  });

  it("falls back to workspace-only recall when no current branch is detectable", async function () {
    await service.execute(
      { action: "recall", query: "fact" },
      { workingDir: "/workspace", branchContext: { state: "unavailable" } },
    );
    expect(store.recall.calledWithMatch({ scope: "workspace", branch: undefined })).to.equal(true);
  });

  it("falls back to workspace-only recall when branch context is ambiguous", async function () {
    await service.execute(
      { action: "recall", query: "fact" },
      { workingDir: "/workspace", branchContext: { state: "ambiguous" } },
    );
    expect(store.recall.calledWithMatch({ scope: "workspace", branch: undefined })).to.equal(true);
  });

  it("passes explicit unscoped branches and discards branches for workspace scope", async function () {
    await service.execute({ action: "recall", query: "one", branch: "explicit" }, workspaceContext);
    await service.execute({ action: "list", scope: "workspace", branch: "ignored" }, workspaceContext);

    expect(store.recall.firstCall.calledWithMatch({ scope: undefined, branch: "explicit" })).to.equal(true);
    expect(store.list.firstCall.calledWithMatch({ scope: "workspace", branch: undefined })).to.equal(true);
  });

  describe("recall scope fail-closed", function () {
    it("searches the workspace only when no branch is resolvable", async function () {
      await service.execute({ action: "recall", query: "fact" }, unavailableContext);
      expect(store.recall.calledOnce).to.equal(true);
      expect(store.recall.firstCall.args[0].scope).to.equal("workspace");
      expect(store.recall.firstCall.args[0].branch).to.equal(undefined);
    });

    it("keeps dual-scope search when the host resolves a branch", async function () {
      await service.execute({ action: "recall", query: "fact" }, workspaceContext);
      expect(store.recall.firstCall.args[0].scope).to.equal(undefined);
      expect(store.recall.firstCall.args[0].branch).to.equal("feature/shared-memory");
    });

    it("keeps dual-scope search for an explicit branch without a scope", async function () {
      await service.execute({ action: "recall", query: "fact", branch: "dev" }, unavailableContext);
      expect(store.recall.firstCall.args[0].scope).to.equal(undefined);
      expect(store.recall.firstCall.args[0].branch).to.equal("dev");
    });
  });

  it("resolves branch-scoped recall from host context", async function () {
    await service.execute({ action: "recall", query: "fact", scope: "branch" }, workspaceContext);

    expect(
      store.recall.calledOnceWithExactly({
        query: "fact",
        scope: "branch",
        branch: "feature/shared-memory",
        topK: 10,
        includeEntities: false,
        signal: undefined,
      }),
    ).to.equal(true);
  });

  it("resolves branch-scoped list from host context", async function () {
    await service.execute({ action: "list", scope: "branch" }, workspaceContext);

    expect(
      store.list.calledOnceWithExactly({
        scope: "branch",
        branch: "feature/shared-memory",
        limit: 50,
      }),
    ).to.equal(true);
  });

  it("resolves branch-scoped forget from host context", async function () {
    await service.execute({ action: "forget", scope: "branch", expired: true }, workspaceContext);

    expect(
      store.forget.calledOnceWithExactly(
        {
          id: undefined,
          scope: "branch",
          branch: "feature/shared-memory",
          olderThan: undefined,
          expired: true,
        },
        undefined,
      ),
    ).to.equal(true);
  });

  it("resolves branch-scoped communities from host context", async function () {
    await service.execute({ action: "communities", scope: "branch" }, workspaceContext);

    expect(store.recallCommunities.calledOnceWithExactly("branch", "feature/shared-memory")).to.equal(true);
  });

  it("keeps unscoped list valid when branch context is unavailable", async function () {
    await service.execute({ action: "list" }, { workingDir: "/workspace", branchContext: { state: "unavailable" } });

    expect(store.list.calledOnceWithExactly({ scope: undefined, branch: undefined, limit: 50 })).to.equal(true);
  });

  it("keeps unscoped list valid when branch context is ambiguous", async function () {
    await service.execute({ action: "list" }, { workingDir: "/workspace", branchContext: { state: "ambiguous" } });

    expect(store.list.calledOnceWithExactly({ scope: undefined, branch: undefined, limit: 50 })).to.equal(true);
  });

  it("treats a forget branch as branch scope", async function () {
    await service.execute({ action: "forget", branch: "explicit", expired: true }, workspaceContext);

    expect(
      store.forget.calledOnceWithExactly(
        {
          id: undefined,
          scope: "branch",
          branch: "explicit",
          olderThan: undefined,
          expired: true,
        },
        undefined,
      ),
    ).to.equal(true);
  });

  it("validates all destructive forget combinations", async function () {
    const invalid: MemoryOperationInput[] = [
      { action: "forget", scope: "workspace", branch: "feature", expired: true },
      { action: "forget", olderThan: 0, scope: "workspace" },
      { action: "forget", olderThan: 1.5, scope: "workspace" },
      { action: "forget", olderThan: 2 },
      { action: "forget", olderThan: 2, scope: "workspace", expired: true },
      { action: "forget", id: "memory-1", scope: "workspace" },
      { action: "forget" },
    ];

    for (const input of invalid) {
      await expectServiceError(service.execute(input, workspaceContext), "MEMORY_INVALID_INPUT");
    }
    expect(store.forget.called).to.equal(false);
  });

  it("validates required non-empty action fields", async function () {
    await expectServiceError(
      service.execute({ action: "store", content: "" }, workspaceContext),
      "MEMORY_INVALID_INPUT",
    );
    await expectServiceError(
      service.execute({ action: "recall", query: "" }, workspaceContext),
      "MEMORY_INVALID_INPUT",
    );
    await expectServiceError(service.execute({ action: "history", id: "" }, workspaceContext), "MEMORY_INVALID_INPUT");
    await expectServiceError(
      service.execute({ action: "promote", branch: "", ids: [] }, workspaceContext),
      "MEMORY_INVALID_INPUT",
    );
    await expectServiceError(
      service.execute({ action: "history", id: "   " }, workspaceContext),
      "MEMORY_INVALID_INPUT",
    );
  });

  it("admits store as a mutation", async function () {
    await expectAdmission({ action: "store", content: "fact" }, "mutation");
  });

  it("admits recall with omitted reinforce as a mutation", async function () {
    await expectAdmission({ action: "recall", query: "default reinforcement" }, "mutation");
  });

  it("admits recall with reinforce true as a mutation", async function () {
    await expectAdmission({ action: "recall", query: "reinforced", reinforce: true }, "mutation");
  });

  it("admits recall with reinforce false as a read", async function () {
    await expectAdmission({ action: "recall", query: "ordinary", reinforce: false }, "read");
  });

  it("admits forget as a mutation", async function () {
    await expectAdmission({ action: "forget", id: "memory-1" }, "mutation");
  });

  it("admits stats as a read", async function () {
    await expectAdmission({ action: "stats" }, "read");
  });

  it("admits list as a read", async function () {
    await expectAdmission({ action: "list" }, "read");
  });

  it("admits decay as a read", async function () {
    await expectAdmission({ action: "decay" }, "read");
  });

  it("admits history as a read", async function () {
    await expectAdmission({ action: "history", id: "memory-1" }, "read");
  });

  it("admits links as a read", async function () {
    await expectAdmission({ action: "links" }, "read");
  });

  it("admits communities as a read", async function () {
    await expectAdmission({ action: "communities" }, "read");
  });

  it("admits promote as a mutation", async function () {
    await expectAdmission({ action: "promote", branch: "feature" }, "mutation");
  });

  it("forwards signals to mutating and cancellable store APIs", async function () {
    const signal = new AbortController().signal;

    await service.execute({ action: "store", content: "fact" }, workspaceContext, signal);
    await service.execute({ action: "recall", query: "fact", reinforce: false }, workspaceContext, signal);
    await service.execute({ action: "forget", id: "memory-1" }, workspaceContext, signal);
    await service.execute({ action: "promote", branch: "feature" }, workspaceContext, signal);

    expect(store.store.firstCall.args[0].signal).to.equal(signal);
    expect(store.recall.firstCall.args[0].signal).to.equal(signal);
    expect(store.forget.firstCall.args[1]).to.equal(signal);
    expect(store.promoteToWorkspace.firstCall.args[2]).to.equal(signal);
  });

  it("uses reset admission and returns a successful receipt", async function () {
    const readAdmission = sinon.spy(coordinator, "runRead");
    const mutationAdmission = sinon.spy(coordinator, "runMutation");
    const resetAdmission = sinon.spy(coordinator, "runReset");
    const signal = new AbortController().signal;

    expect(await service.reset(signal)).to.deep.equal({ success: true });
    expect(resetAdmission.calledOnce).to.equal(true);
    expect(readAdmission.called).to.equal(false);
    expect(mutationAdmission.called).to.equal(false);
    expect(store.reset.calledOnceWithExactly(true, signal)).to.equal(true);
  });

  it("sanitizes path-bearing reset failures", async function () {
    const internal = new Error("failed to delete /Users/private/.ragnarok/memory-lancedb");
    store.reset.rejects(internal);

    const error = await captureError(service.reset());
    expect(error).to.be.instanceOf(MemoryServiceError);
    expect((error as MemoryServiceError).code).to.equal("MEMORY_RESET_FAILED");
    expect((error as Error).message).to.equal("Unable to reset memory");
    expect((error as Error).message).not.to.contain("/Users/private");
    expect((error as Error & { cause?: unknown }).cause).to.equal(internal);
    expect(Object.keys(error as object)).not.to.include("cause");
  });

  it("sanitizes unexpected operation failures while preserving the cause", async function () {
    const internal = new Error("cannot open /Users/private/memory.lance");
    store.list.rejects(internal);

    const error = await captureError(service.execute({ action: "list" }, workspaceContext));
    expect(error).to.be.instanceOf(MemoryServiceError);
    expect((error as MemoryServiceError).code).to.equal("MEMORY_OPERATION_FAILED");
    expect((error as Error).message).to.equal('Unable to execute memory action "list"');
    expect((error as Error).message).not.to.contain("/Users/private");
    expect((error as Error & { cause?: unknown }).cause).to.equal(internal);
  });

  it("passes a busy storage lease through both boundaries untouched", async function () {
    // Hosts match this by name to offer a retry; wrapping it in a
    // MemoryServiceError would bury that behind a cause chain.
    const busy = new StorageBusyError("/storage/.ragnarok.lock", {
      pid: 99999,
      hostname: "other-host",
      acquiredAt: Date.now(),
    });
    store.store.rejects(busy);
    store.reset.rejects(busy);

    const storeError = await captureError(
      service.execute({ action: "store", content: "blocked by another writer" }, workspaceContext),
    );
    expect(storeError).to.equal(busy);
    expect((storeError as Error).name).to.equal("StorageBusyError");
    expect(storeError).to.not.be.instanceOf(MemoryServiceError);

    const resetError = await captureError(service.reset());
    expect(resetError).to.equal(busy);
    expect((resetError as Error).name).to.equal("StorageBusyError");
    expect(resetError).to.not.be.instanceOf(MemoryServiceError);
  });

  it("preserves cancellation reasons", async function () {
    const controller = new AbortController();
    const reason = new Error("cancel memory action");
    controller.abort(reason);

    expect(await captureError(service.execute({ action: "list" }, workspaceContext, controller.signal))).to.equal(
      reason,
    );
    expect(await captureError(service.reset(controller.signal))).to.equal(reason);
  });

  it("returns empty links without consulting a store-local branch detector", async function () {
    expect(
      await service.execute({ action: "links" }, { workingDir: "/workspace", branchContext: { state: "unavailable" } }),
    ).to.deep.equal({ action: "links", links: [], count: 0 });
    expect(store.discoverLinks.called).to.equal(false);
  });

  describe("input bounds validation", function () {
    const longString = (length: number) => "x".repeat(length);
    const invalidInputs: Array<{ name: string; input: MemoryOperationInput }> = [
      { name: "non-numeric topK", input: { action: "recall", query: "q", topK: "8" as unknown as number } },
      { name: "topK above 50", input: { action: "recall", query: "q", topK: 51 } },
      { name: "fractional topK", input: { action: "recall", query: "q", topK: 1.5 } },
      { name: "zero limit", input: { action: "list", limit: 0 } },
      { name: "limit above 500", input: { action: "list", limit: 501 } },
      { name: "zero ttlDays", input: { action: "store", content: "x", ttlDays: 0 } },
      { name: "ttlDays above 3650", input: { action: "store", content: "x", ttlDays: 3651 } },
      { name: "olderThan above 3650", input: { action: "forget", olderThan: 3651, scope: "workspace" } },
      {
        name: "non-boolean reinforce",
        input: { action: "recall", query: "q", reinforce: "yes" as unknown as boolean },
      },
      { name: "non-boolean expired", input: { action: "forget", expired: "true" as unknown as boolean } },
      {
        name: "21 tags",
        input: { action: "store", content: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      },
      { name: "tag above 100 chars", input: { action: "store", content: "x", tags: [longString(101)] } },
      { name: "non-string tag", input: { action: "store", content: "x", tags: [7 as unknown as string] } },
      {
        name: "501 ids",
        input: { action: "promote", branch: "dev", ids: Array.from({ length: 501 }, (_, i) => `m${i}`) },
      },
      { name: "content above 50000 chars", input: { action: "store", content: longString(50_001) } },
      { name: "branch above 255 chars", input: { action: "recall", query: "q", branch: longString(256) } },
      { name: "blank branch", input: { action: "recall", query: "q", branch: "   " } },
    ];

    for (const { name, input } of invalidInputs) {
      it(`rejects ${name} with MEMORY_INVALID_INPUT`, async function () {
        const error = await serviceError(service.execute(input, workspaceContext));
        expect(error.code).to.equal("MEMORY_INVALID_INPUT");
        expect(store.store.called || store.recall.called || store.list.called || store.forget.called).to.equal(false);
      });
    }

    it("accepts every documented boundary value", async function () {
      await service.execute(
        { action: "recall", query: "q", topK: 50, includeEntities: true, reinforce: false },
        workspaceContext,
      );
      await service.execute(
        {
          action: "store",
          content: longString(50_000),
          ttlDays: 3650,
          tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
        },
        workspaceContext,
      );
      await service.execute({ action: "list", limit: 500 }, workspaceContext);
      expect(store.recall.calledOnce).to.equal(true);
      expect(store.store.calledOnce).to.equal(true);
      expect(store.list.calledOnce).to.equal(true);
    });
  });

  async function expectAdmission(input: MemoryOperationInput, expected: "read" | "mutation"): Promise<void> {
    const readAdmission = sinon.spy(coordinator, "runRead");
    const mutationAdmission = sinon.spy(coordinator, "runMutation");
    const resetAdmission = sinon.spy(coordinator, "runReset");

    await service.execute(input, workspaceContext);

    expect(readAdmission.calledOnce, `${input.action} read admission`).to.equal(expected === "read");
    expect(mutationAdmission.calledOnce, `${input.action} mutation admission`).to.equal(expected === "mutation");
    expect(resetAdmission.called, `${input.action} reset admission`).to.equal(false);
  }
});

interface StubbedMemoryStore {
  store: sinon.SinonStub;
  recall: sinon.SinonStub;
  forget: sinon.SinonStub;
  stats: sinon.SinonStub;
  list: sinon.SinonStub;
  runDecay: sinon.SinonStub;
  getVersionHistory: sinon.SinonStub;
  promoteToWorkspace: sinon.SinonStub;
  discoverLinks: sinon.SinonStub;
  recallCommunities: sinon.SinonStub;
  isEntityExtractionEnabled: sinon.SinonStub;
  reset: sinon.SinonStub;
}

function stubMemoryStore(): StubbedMemoryStore {
  return {
    store: sinon.stub().callsFake(async (options: Partial<MemoryEntry>) => memoryEntry(options)),
    recall: sinon.stub().resolves({ memories: [], entities: [] }),
    forget: sinon.stub().resolves(0),
    stats: sinon.stub().resolves({
      totalMemories: 0,
      totalEntities: 0,
      totalRelationships: 0,
      byScope: { workspace: 0, branch: 0 },
      branches: [],
      entityTypes: {},
      lastUpdated: 0,
    }),
    list: sinon.stub().resolves([]),
    runDecay: sinon.stub().resolves({ totalEntries: 0, decayedCount: 0, expiredCount: 0, nearThresholdCount: 0 }),
    getVersionHistory: sinon.stub().resolves([]),
    promoteToWorkspace: sinon.stub().resolves(0),
    discoverLinks: sinon.stub().resolves([]),
    recallCommunities: sinon.stub().resolves([]),
    isEntityExtractionEnabled: sinon.stub().returns(true),
    reset: sinon.stub().resolves(),
  };
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "memory-1",
    content: "fact",
    scope: "workspace",
    branch: undefined,
    vector: [1, 0],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    accessCount: 0,
    lastAccessedAt: CREATED_AT,
    tags: [],
    entityIds: [],
    metadata: {},
    ...overrides,
  };
}

function memoryEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id: "entity-1",
    name: "entity",
    type: "project",
    description: "",
    vector: [1, 0],
    scope: "workspace",
    confidence: 1,
    strength: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    sourceMemoryIds: ["memory-1"],
    metadata: {},
    ...overrides,
  };
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

async function serviceError(operation: Promise<unknown>): Promise<MemoryServiceError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the operation to reject with MemoryServiceError").to.be.instanceOf(MemoryServiceError);
  return caught as MemoryServiceError;
}

async function expectServiceError(operation: Promise<unknown>, code: MemoryServiceError["code"]): Promise<void> {
  const error = await captureError(operation);
  expect(error).to.be.instanceOf(MemoryServiceError);
  expect((error as MemoryServiceError).code).to.equal(code);
}
