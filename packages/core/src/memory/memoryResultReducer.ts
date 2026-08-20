import type {
  CommunitiesMemoryResult,
  HistoryMemoryResult,
  LinksMemoryResult,
  ListMemoryResult,
  MemoryOperationResult,
  MemoryResponseMeta,
  RecallMemoryResult,
  StoreMemoryResult,
} from "./memoryServiceTypes";

export type MemoryResultMeasurement = (candidate: MemoryOperationResult, signal?: AbortSignal) => Promise<number>;

export async function reduceMemoryOperationResult(
  result: MemoryOperationResult,
  tokenBudget: number,
  measure: MemoryResultMeasurement,
  signal?: AbortSignal,
): Promise<MemoryOperationResult> {
  if (
    result.action === "stats" ||
    result.action === "forget" ||
    result.action === "decay" ||
    result.action === "promote"
  ) {
    return result;
  }

  const fits = async (candidate: MemoryOperationResult): Promise<boolean> =>
    (await measure(candidate, signal)) <= tokenBudget;

  try {
    if (await fits(result)) {
      return result;
    }

    switch (result.action) {
      case "store":
        return await reduceStore(result, fits);
      case "recall":
        return await reduceRecall(result, fits);
      case "list":
        return await reduceList(result, fits);
      case "history":
        return await reduceHistory(result, fits);
      case "links":
        return await reduceLinks(result, fits);
      case "communities":
        return await reduceCommunities(result, fits);
    }
  } catch {
    return result;
  }
}

type Fits = (candidate: MemoryOperationResult) => Promise<boolean>;

async function reduceStore(result: StoreMemoryResult, fits: Fits): Promise<StoreMemoryResult> {
  const responseMeta = tokenBudgetMeta(1, 1);
  const withContent = (length: number): StoreMemoryResult => ({
    ...result,
    memory: { ...result.memory, content: result.memory.content.slice(0, length) },
    responseMeta,
  });
  const minimal = withContent(0);

  if (!(await fits(minimal))) {
    return minimal;
  }

  return withContent(await greatestFitting(result.memory.content.length, (length) => fits(withContent(length))));
}

async function reduceList(result: ListMemoryResult, fits: Fits): Promise<ListMemoryResult> {
  const totalCount = result.memories.length;
  const withText = (length: number): ListMemoryResult => ({
    ...result,
    memories: result.memories.map((memory) => ({ ...memory, content: memory.content.slice(0, length) })),
    count: totalCount,
    responseMeta: tokenBudgetMeta(totalCount, totalCount),
  });
  const emptyText = withText(0);

  if (await fits(emptyText)) {
    return withText(
      await greatestFitting(maxLength(result.memories.map(({ content }) => content)), (length) =>
        fits(withText(length)),
      ),
    );
  }

  return reduceListRecords(emptyText, totalCount, fits);
}

async function reduceListRecords(result: ListMemoryResult, totalCount: number, fits: Fits): Promise<ListMemoryResult> {
  const withCount = (count: number): ListMemoryResult => ({
    ...result,
    memories: result.memories.slice(0, count),
    count,
    responseMeta: tokenBudgetMeta(count, totalCount),
  });
  const minimal = withCount(0);

  if (!(await fits(minimal))) {
    return minimal;
  }

  return withCount(await greatestFitting(totalCount, (count) => fits(withCount(count))));
}

async function reduceRecall(result: RecallMemoryResult, fits: Fits): Promise<RecallMemoryResult> {
  const totalCount = result.memories.length;
  const textLengths = [
    ...result.memories.map(({ content }) => content.length),
    ...result.entities.map(({ description }) => description.length),
  ];
  const withText = (length: number): RecallMemoryResult => ({
    ...result,
    memories: result.memories.map((memory) => ({ ...memory, content: memory.content.slice(0, length) })),
    entities: result.entities.map((entity) => ({ ...entity, description: entity.description.slice(0, length) })),
    count: totalCount,
    responseMeta: tokenBudgetMeta(totalCount, totalCount),
  });
  const emptyText = withText(0);

  if (await fits(emptyText)) {
    return withText(await greatestFitting(maxLength(textLengths), (length) => fits(withText(length))));
  }

  const empty: RecallMemoryResult = {
    action: "recall",
    memories: [],
    entities: [],
    count: 0,
    responseMeta: tokenBudgetMeta(0, totalCount),
  };
  if (!(await fits(empty))) {
    return empty;
  }

  const memoryCount = await greatestFitting(totalCount, (count) =>
    fits({
      ...empty,
      memories: emptyText.memories.slice(0, count),
      count,
      responseMeta: tokenBudgetMeta(count, totalCount),
    }),
  );
  const withMemories: RecallMemoryResult = {
    ...empty,
    memories: emptyText.memories.slice(0, memoryCount),
    count: memoryCount,
    responseMeta: tokenBudgetMeta(memoryCount, totalCount),
  };
  const entityCount = await greatestFitting(emptyText.entities.length, (count) =>
    fits({ ...withMemories, entities: emptyText.entities.slice(0, count) }),
  );

  return { ...withMemories, entities: emptyText.entities.slice(0, entityCount) };
}

async function reduceHistory(result: HistoryMemoryResult, fits: Fits): Promise<HistoryMemoryResult> {
  const totalCount = result.versions.length;
  const withText = (length: number): HistoryMemoryResult => ({
    ...result,
    versions: result.versions.map((version) => ({ ...version, content: version.content.slice(0, length) })),
    count: totalCount,
    responseMeta: tokenBudgetMeta(totalCount, totalCount),
  });
  const emptyText = withText(0);

  if (await fits(emptyText)) {
    return withText(
      await greatestFitting(maxLength(result.versions.map(({ content }) => content)), (length) =>
        fits(withText(length)),
      ),
    );
  }

  const withCount = (count: number): HistoryMemoryResult => ({
    action: "history",
    entryId: result.entryId,
    versions: emptyText.versions.slice(0, count),
    count,
    responseMeta: tokenBudgetMeta(count, totalCount),
  });
  const minimal = withCount(0);
  if (!(await fits(minimal))) {
    return minimal;
  }

  return withCount(await greatestFitting(totalCount, (count) => fits(withCount(count))));
}

async function reduceLinks(result: LinksMemoryResult, fits: Fits): Promise<LinksMemoryResult> {
  const totalCount = result.links.length;
  const withCount = (count: number): LinksMemoryResult => ({
    action: "links",
    links: result.links.slice(0, count),
    count,
    responseMeta: tokenBudgetMeta(count, totalCount),
  });
  const minimal = withCount(0);

  if (!(await fits(minimal))) {
    return minimal;
  }

  return withCount(await greatestFitting(totalCount, (count) => fits(withCount(count))));
}

async function reduceCommunities(result: CommunitiesMemoryResult, fits: Fits): Promise<CommunitiesMemoryResult> {
  const totalCount = result.communities.length;
  const responseMeta = tokenBudgetMeta(totalCount, totalCount);
  const withEntityNameCount = (count: number): CommunitiesMemoryResult => ({
    ...result,
    communities: result.communities.map((community) => ({
      ...community,
      entityNames: community.entityNames.slice(0, count),
    })),
    count: totalCount,
    responseMeta,
  });
  const noEntityNames = withEntityNameCount(0);

  if (await fits(noEntityNames)) {
    return withEntityNameCount(
      await greatestFitting(maxLength(result.communities.map(({ entityNames }) => entityNames)), (count) =>
        fits(withEntityNameCount(count)),
      ),
    );
  }

  let noText: CommunitiesMemoryResult = noEntityNames;
  if (result.hint !== undefined) {
    const withHint = (length: number): CommunitiesMemoryResult => ({
      ...noEntityNames,
      hint: result.hint?.slice(0, length),
    });
    const emptyHint = withHint(0);
    if (await fits(emptyHint)) {
      return withHint(await greatestFitting(result.hint.length, (length) => fits(withHint(length))));
    }
    const { hint: _hint, ...withoutHint } = emptyHint;
    noText = withoutHint;
  }

  const withCount = (count: number): CommunitiesMemoryResult => ({
    ...noText,
    communities: noText.communities.slice(0, count),
    count,
    responseMeta: tokenBudgetMeta(count, totalCount),
  });
  const minimal = withCount(0);
  if (!(await fits(minimal))) {
    return minimal;
  }

  return withCount(await greatestFitting(totalCount, (count) => fits(withCount(count))));
}

async function greatestFitting(maximum: number, fits: (value: number) => Promise<boolean>): Promise<number> {
  let low = 0;
  let high = maximum;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

function tokenBudgetMeta(returnedCount: number, totalCount: number): MemoryResponseMeta {
  return { truncated: true, returnedCount, totalCount, reason: "tokenBudget" };
}

function maxLength(values: readonly (number | { length: number })[]): number {
  let maximum = 0;
  for (const value of values) {
    maximum = Math.max(maximum, typeof value === "number" ? value : value.length);
  }
  return maximum;
}
