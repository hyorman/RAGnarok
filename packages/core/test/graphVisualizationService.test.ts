import { expect } from "chai";
import {
  GraphVisualizationService as CoreGraphVisualizationService,
  MemoryOperationCoordinator,
  MemoryServiceError,
  type GraphVisualizationRequest,
} from "../src";
import { GraphVisualizationService } from "../src/visualization/graphVisualizationService";
import type { MemoryGraphSnapshot } from "../src/memory/types";

describe("GraphVisualizationService", function () {
  it("constructs workspace and trimmed branch sources", async function () {
    const calls: Array<{ scope: string; branch?: string }> = [];
    const service = createService(async (scope, branch) => {
      calls.push({ scope, branch });
      return emptySnapshot();
    });

    const workspace = await service.generate({ scope: "workspace" });
    const branch = await service.generate({ scope: "branch", branch: "  feature/shared-graph  " });

    expect(workspace.source).to.deep.equal({ kind: "memory", scope: "workspace" });
    expect(branch.source).to.deep.equal({ kind: "memory", scope: "branch", branch: "feature/shared-graph" });
    expect(calls).to.deep.equal([
      { scope: "workspace", branch: undefined },
      { scope: "branch", branch: "feature/shared-graph" },
    ]);
  });

  it("returns a successful empty graph document", async function () {
    const document = await createService(async () => emptySnapshot()).generate({ scope: "workspace" });

    expect(document.nodes).to.deep.equal([]);
    expect(document.edges).to.deep.equal([]);
    expect(document.groups).to.deep.equal([]);
    expect(document.viewport).to.deep.equal({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(document.metadata.empty).to.equal(true);
  });

  it("forwards maxNodes to the projector", async function () {
    const service = createService(async () => ({
      entities: [memoryEntity("a"), memoryEntity("b")],
      relationships: [],
    }));

    const document = await service.generate({ scope: "workspace", maxNodes: 1 });

    expect(document.nodes.map(({ id }) => id)).to.deep.equal(["a"]);
    expect(document.metadata.truncationReasons).to.deep.equal(["maxNodes"]);
  });

  it("rejects invalid maxNodes through a stable graph error", async function () {
    const service = createService(async () => emptySnapshot());

    for (const maxNodes of [0, -1, 1.5, 2_001]) {
      const error = await rejectionOf(service.generate({ scope: "workspace", maxNodes }));
      expect(error).to.be.instanceOf(MemoryServiceError);
      expect((error as MemoryServiceError).code).to.equal("GRAPH_VISUALIZATION_FAILED");
      expect((error as Error).message).to.equal("Unable to generate graph visualization");
      expect((error as Error & { cause?: unknown }).cause).to.be.instanceOf(RangeError);
    }
  });

  it("rejects an empty branch before reading a snapshot", async function () {
    let snapshotRead = false;
    const service = createService(async () => {
      snapshotRead = true;
      return emptySnapshot();
    });

    const error = await rejectionOf(service.generate({ scope: "branch", branch: "   " }));

    expect(error).to.be.instanceOf(MemoryServiceError);
    expect((error as MemoryServiceError).code).to.equal("MEMORY_INVALID_INPUT");
    expect((error as Error).message).to.equal("Branch graph visualization requires a branch");
    expect(snapshotRead).to.equal(false);
  });

  it("preserves cancellation before snapshot loading", async function () {
    const controller = new AbortController();
    const reason = new Error("cancel before graph snapshot");
    let snapshotRead = false;
    controller.abort(reason);
    const service = createService(async () => {
      snapshotRead = true;
      return emptySnapshot();
    });

    expect(await rejectionOf(service.generate({ scope: "workspace" }, controller.signal))).to.equal(reason);
    expect(snapshotRead).to.equal(false);
  });

  it("preserves cancellation after snapshot loading and before projection", async function () {
    const controller = new AbortController();
    const reason = new Error("cancel before graph projection");
    const malformed = {
      entities: [memoryEntity("broken", { metadata: { unsupported: 1n } })],
      relationships: [],
    } as unknown as MemoryGraphSnapshot;
    const service = createService(async () => {
      controller.abort(reason);
      return malformed;
    });

    expect(await rejectionOf(service.generate({ scope: "workspace" }, controller.signal))).to.equal(reason);
  });

  it("wraps path-bearing snapshot failures without exposing storage details", async function () {
    const internal = new Error("cannot open /Users/private/.ragnarok/memory-lancedb");
    const service = createService(async () => Promise.reject(internal));

    const error = await rejectionOf(service.generate({ scope: "workspace" }));

    expect(error).to.be.instanceOf(MemoryServiceError);
    expect((error as MemoryServiceError).code).to.equal("GRAPH_VISUALIZATION_FAILED");
    expect((error as Error).message).to.equal("Unable to generate graph visualization");
    expect((error as Error).message).not.to.contain("/Users/private");
    expect((error as Error & { cause?: unknown }).cause).to.equal(internal);
    expect(Object.keys(error as object)).not.to.include("cause");
  });

  it("wraps dependency MemoryServiceError failures without exposing storage details", async function () {
    const internal = new MemoryServiceError(
      "MEMORY_OPERATION_FAILED",
      "cannot open /Users/private/.ragnarok/memory-lancedb",
    );
    const service = createService(async () => Promise.reject(internal));

    const error = await rejectionOf(service.generate({ scope: "workspace" }));

    expect(error).to.be.instanceOf(MemoryServiceError);
    expect(error).not.to.equal(internal);
    expect((error as MemoryServiceError).code).to.equal("GRAPH_VISUALIZATION_FAILED");
    expect((error as Error).message).to.equal("Unable to generate graph visualization");
    expect((error as Error).message).not.to.contain("/Users/private");
    expect((error as Error & { cause?: unknown }).cause).to.equal(internal);
    expect(((error as Error & { cause: MemoryServiceError }).cause as Error).message).to.contain("/Users/private");
    expect(Object.keys(error as object)).not.to.include("cause");
  });

  it("wraps unexpected projector failures at the same stable boundary", async function () {
    const malformed = {
      entities: [memoryEntity("broken", { metadata: { unsupported: 1n } })],
      relationships: [],
    } as unknown as MemoryGraphSnapshot;
    const service = createService(async () => malformed);

    const error = await rejectionOf(service.generate({ scope: "workspace" }));

    expect(error).to.be.instanceOf(MemoryServiceError);
    expect((error as MemoryServiceError).code).to.equal("GRAPH_VISUALIZATION_FAILED");
    expect((error as Error).message).to.equal("Unable to generate graph visualization");
    expect((error as Error & { cause?: unknown }).cause).to.be.instanceOf(TypeError);
  });

  it("excludes reset through the shared coordinator", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const snapshotGate = deferred<MemoryGraphSnapshot>();
    const events: string[] = [];
    const service = createService(async () => {
      events.push("graph:start");
      const snapshot = await snapshotGate.promise;
      events.push("graph:snapshot");
      return snapshot;
    }, coordinator);

    const graph = service.generate({ scope: "workspace" });
    const reset = coordinator.runReset(async () => {
      events.push("reset");
    });

    await tick();
    expect(events).to.deep.equal(["graph:start"]);
    snapshotGate.resolve(emptySnapshot());
    await Promise.all([graph, reset]);
    expect(events).to.deep.equal(["graph:start", "graph:snapshot", "reset"]);
  });

  it("exports the service and request type from the core entry point", function () {
    const request: GraphVisualizationRequest = { scope: "branch", branch: "feature/export" };

    expect(request.scope).to.equal("branch");
    expect(CoreGraphVisualizationService).to.equal(GraphVisualizationService);
  });
});

function createService(
  getGraphSnapshot: (scope: "workspace" | "branch", branch?: string) => Promise<MemoryGraphSnapshot>,
  coordinator = new MemoryOperationCoordinator(),
): GraphVisualizationService {
  return new GraphVisualizationService({ getGraphSnapshot }, coordinator);
}

function emptySnapshot(): MemoryGraphSnapshot {
  return { entities: [], relationships: [] };
}

function memoryEntity(
  id: string,
  overrides: Partial<MemoryGraphSnapshot["entities"][number]> = {},
): MemoryGraphSnapshot["entities"][number] {
  return {
    id,
    name: `Memory ${id}`,
    type: "fact",
    description: `Description ${id}`,
    scope: "workspace",
    confidence: 1,
    strength: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceMemoryIds: [`memory-${id}`],
    metadata: {},
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
