import { expect } from "chai";
import { reduceMemoryOperationResult, type MemoryOperationResult, type MemoryResultMeasurement } from "../src";

const prettyLength: MemoryResultMeasurement = async (candidate: MemoryOperationResult) =>
  JSON.stringify(candidate, null, 2).length;

describe("reduceMemoryOperationResult", function () {
  it("returns a fitting result unchanged", async function () {
    const result = listResult([listMemory("first", "short")]);

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(result), prettyLength);

    expect(reduced).to.equal(result);
    expect(reduced).to.not.have.property("responseMeta");
  });

  it("truncates text prefixes before dropping list records without mutating the result", async function () {
    const first = listMemory("first", "a".repeat(200));
    const second = listMemory("second", "b".repeat(200));
    const result = listResult([first, second]);
    const snapshot = structuredClone(result);
    const expected = {
      ...result,
      memories: [
        { ...first, content: "a".repeat(100) },
        { ...second, content: "b".repeat(100) },
      ],
      responseMeta: tokenBudgetMeta(2, 2),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
    expect(result).to.deep.equal(snapshot);
    expect(reduced).to.not.equal(result);
  });

  it("retains a stable list prefix with exact counts and metadata", async function () {
    const first = listMemory("first", "");
    const second = listMemory("second", "");
    const third = listMemory("third", "");
    const result = listResult([first, second, third]);
    const expected = {
      action: "list",
      memories: [first],
      count: 1,
      responseMeta: tokenBudgetMeta(1, 3),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
  });

  it("returns the minimal truthful list receipt when one record is oversized", async function () {
    const result = listResult([listMemory("first", "x".repeat(1_000))]);
    const expected = {
      action: "list",
      memories: [],
      count: 0,
      responseMeta: tokenBudgetMeta(0, 1),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, (await prettyLength(expected)) - 1, prettyLength);

    expect(reduced).to.deep.equal(expected);
  });

  it("reduces recall memory content and entity descriptions before independently dropping stable prefixes", async function () {
    const memories = [recallMemory("first", "abcdefgh"), recallMemory("second", "ijklmnop")];
    const entities = [recallEntity("first", "qrstuvwx"), recallEntity("second", "yzabcdef")];
    const result: MemoryOperationResult = { action: "recall", memories, entities, count: 2 };
    const expected = {
      action: "recall",
      memories: [{ ...memories[0], content: "" }],
      entities: [{ ...entities[0], description: "" }],
      count: 1,
      responseMeta: tokenBudgetMeta(1, 2),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
  });

  it("reduces history content and preserves its entry identity", async function () {
    const versions = [historyVersion("first", "abcdef"), historyVersion("second", "ghijkl")];
    const result: MemoryOperationResult = { action: "history", entryId: "memory-1", versions, count: 2 };
    const expected = {
      action: "history",
      entryId: "memory-1",
      versions: [{ ...versions[0], content: "" }],
      count: 1,
      responseMeta: tokenBudgetMeta(1, 2),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
  });

  it("reduces links only by retaining a stable prefix", async function () {
    const links = [link("first"), link("second")];
    const result: MemoryOperationResult = { action: "links", links, count: 2 };
    const expected = {
      action: "links",
      links: [links[0]],
      count: 1,
      responseMeta: tokenBudgetMeta(1, 2),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
  });

  it("reduces community entity-name entries before the hint and then communities", async function () {
    const communities = [
      { id: 1, entityNames: ["alpha", "b".repeat(200)] },
      { id: 2, entityNames: ["gamma", "d".repeat(200)] },
    ];
    const result: MemoryOperationResult = {
      action: "communities",
      scope: "branch",
      branch: "feature",
      communities,
      count: 2,
      entityExtractionEnabled: true,
      hint: "h".repeat(200),
    };
    const namesReduced = {
      ...result,
      communities: communities.map((community) => ({ ...community, entityNames: community.entityNames.slice(0, 1) })),
      responseMeta: tokenBudgetMeta(2, 2),
    } satisfies MemoryOperationResult;
    const hintReduced = {
      ...result,
      communities: communities.map((community) => ({ ...community, entityNames: [] })),
      hint: "h".repeat(100),
      responseMeta: tokenBudgetMeta(2, 2),
    } satisfies MemoryOperationResult;
    const { hint: _hint, ...withoutHint } = hintReduced;
    const recordsReduced = {
      ...withoutHint,
      communities: [withoutHint.communities[0]],
      count: 1,
      responseMeta: tokenBudgetMeta(1, 2),
    } satisfies MemoryOperationResult;

    expect(await reduceMemoryOperationResult(result, await prettyLength(namesReduced), prettyLength)).to.deep.equal(
      namesReduced,
    );
    expect(await reduceMemoryOperationResult(result, await prettyLength(hintReduced), prettyLength)).to.deep.equal(
      hintReduced,
    );
    expect(await reduceMemoryOperationResult(result, await prettyLength(recordsReduced), prettyLength)).to.deep.equal(
      recordsReduced,
    );
  });

  it("truncates only store content while preserving a truthful successful mutation receipt", async function () {
    const result: MemoryOperationResult = {
      action: "store",
      memory: {
        id: "memory-1",
        content: "x".repeat(400),
        scope: "branch",
        branch: "feature",
        entityIds: ["entity-1"],
        tags: ["important"],
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    };
    const expected = {
      ...result,
      memory: { ...result.memory, content: "x".repeat(100) },
      responseMeta: tokenBudgetMeta(1, 1),
    } satisfies MemoryOperationResult;

    const reduced = await reduceMemoryOperationResult(result, await prettyLength(expected), prettyLength);

    expect(reduced).to.deep.equal(expected);
    expect(result.memory.content).to.equal("x".repeat(400));
  });

  it("returns the fixed minimal store receipt even when it exceeds the budget", async function () {
    const result: MemoryOperationResult = {
      action: "store",
      memory: {
        id: "memory-1",
        content: "large content",
        scope: "workspace",
        entityIds: [],
        tags: [],
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    };

    expect(await reduceMemoryOperationResult(result, 0, prettyLength)).to.deep.equal({
      ...result,
      memory: { ...result.memory, content: "" },
      responseMeta: tokenBudgetMeta(1, 1),
    });
  });

  it("does not reduce scalar results or add metadata", async function () {
    const stats: MemoryOperationResult = {
      action: "stats",
      totalMemories: 100,
      totalEntities: 50,
      totalRelationships: 25,
      byScope: { workspace: 60, branch: 40 },
      branches: ["feature"],
      entityTypes: { project: 50 },
      lastUpdated: 1,
      workspace: { workingDir: "/workspace", detectedBranch: "feature" },
    };
    const forget: MemoryOperationResult = { action: "forget", forgottenCount: 3 };

    expect(await reduceMemoryOperationResult(stats, 0, prettyLength)).to.equal(stats);
    expect(await reduceMemoryOperationResult(forget, 0, prettyLength)).to.equal(forget);
  });

  it("returns the original completed result when measurement rejects", async function () {
    const result: MemoryOperationResult = {
      action: "store",
      memory: {
        id: "memory-1",
        content: "content",
        scope: "workspace",
        entityIds: [],
        tags: [],
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    };
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const measure: MemoryResultMeasurement = async (_candidate: MemoryOperationResult, signal?: AbortSignal) => {
      observedSignal = signal;
      throw new Error("measurement unavailable");
    };

    const reduced = await reduceMemoryOperationResult(result, 1, measure, controller.signal);

    expect(reduced).to.equal(result);
    expect(observedSignal).to.equal(controller.signal);
  });
});

function tokenBudgetMeta(returnedCount: number, totalCount: number) {
  return { truncated: true, returnedCount, totalCount, reason: "tokenBudget" } as const;
}

function listResult(memories: ReturnType<typeof listMemory>[]): Extract<MemoryOperationResult, { action: "list" }> {
  return { action: "list", memories, count: memories.length };
}

function listMemory(id: string, content: string) {
  return {
    id,
    content,
    scope: "workspace" as const,
    tags: [],
    accessCount: 0,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function recallMemory(id: string, content: string) {
  return {
    id,
    content,
    scope: "workspace" as const,
    score: 1,
    tags: [],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function recallEntity(name: string, description: string) {
  return { name, type: "project", description, score: 1 };
}

function historyVersion(id: string, content: string) {
  return {
    id,
    content,
    version: 1,
    isLatest: false,
    confidence: 1,
    supersededBy: null,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function link(entityName: string) {
  return {
    sourceScope: "workspace",
    targetScope: "branch:feature",
    entityName,
    entityType: "project",
    confidence: 1,
  };
}
