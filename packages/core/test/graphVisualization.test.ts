import { expect } from "chai";
import type { MemoryEntity, MemoryRelationship } from "../src/memory/types";
import {
  projectMemoryGraphVisualization,
  reduceGraphVisualizationDocument,
} from "../src/visualization/graphVisualization";

const workspaceSource = { kind: "memory", scope: "workspace" } as const;

function makeMemoryEntity(id: string, overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id,
    name: `Memory ${id}`,
    type: "fact",
    description: `Memory description ${id}`,
    vector: [0.3, 0.4],
    scope: "workspace",
    confidence: 0.85,
    strength: 0.65,
    createdAt: 200,
    updatedAt: 300,
    sourceMemoryIds: [`memory-${id}`],
    metadata: {},
    ...overrides,
  };
}

function makeMemoryRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  overrides: Partial<MemoryRelationship> = {},
): MemoryRelationship {
  return {
    id,
    sourceId,
    targetId,
    type: "related_to",
    description: `Memory relationship ${id}`,
    weight: 0.5,
    scope: "workspace",
    metadata: {},
    ...overrides,
  };
}

describe("graph visualization", () => {
  it("projects a deterministic bounded memory document with complete non-vector details", () => {
    const a = makeMemoryEntity("a", {
      sourceMemoryIds: ["memory-z", "memory-a"],
      metadata: { owner: "team" },
    });
    const b = makeMemoryEntity("b");
    const c = makeMemoryEntity("c");
    const isolated = makeMemoryEntity("isolated");
    const ab = makeMemoryRelationship("ab", "a", "b", { metadata: { reviewed: true } });
    const bc = makeMemoryRelationship("bc", "b", "c");

    const forward = projectMemoryGraphVisualization(
      { entities: [a, b, c, isolated], relationships: [ab, bc] },
      workspaceSource,
      { maxNodes: 3 },
    );
    const reverse = projectMemoryGraphVisualization(
      { entities: [isolated, c, b, a], relationships: [bc, ab] },
      workspaceSource,
      { maxNodes: 3 },
    );

    expect(JSON.stringify(reverse)).to.equal(JSON.stringify(forward));
    expect(forward.schema).to.equal("ragnarok.graph.visualization.v1");
    expect(forward.source).to.deep.equal(workspaceSource);
    expect(forward.nodes.map((node) => node.id)).to.deep.equal(["b", "a", "c"]);
    expect(forward.nodes).to.have.length(3);
    expect(forward.metadata).to.deep.include({
      originalNodeCount: 4,
      retainedNodeCount: 3,
      originalEdgeCount: 2,
      retainedEdgeCount: 2,
      truncated: true,
      empty: false,
    });
    expect(forward.metadata.truncationReasons).to.deep.equal(["maxNodes"]);
    expect(forward.nodes.every((node) => !("vector" in node.attributes))).to.equal(true);
    expect(forward.nodes.find((node) => node.id === "a")!.attributes).to.deep.equal({
      confidence: 0.85,
      createdAt: 200,
      description: "Memory description a",
      metadata: { owner: "team" },
      scope: "workspace",
      sourceMemoryIds: ["memory-a", "memory-z"],
      strength: 0.65,
      updatedAt: 300,
    });
    expect(forward.edges.find((edge) => edge.id === "ab")!.attributes).to.deep.equal({
      description: "Memory relationship ab",
      metadata: { reviewed: true },
      scope: "workspace",
    });
  });

  it("validates maxNodes and applies the 500-node default", () => {
    for (const maxNodes of [0, -1, 1.5, 2001]) {
      expect(() =>
        projectMemoryGraphVisualization({ entities: [], relationships: [] }, workspaceSource, { maxNodes }),
      ).to.throw(RangeError, "maxNodes must be an integer between 1 and 2000");
    }

    const entities = Array.from({ length: 501 }, (_, index) =>
      makeMemoryEntity(`node-${index.toString().padStart(3, "0")}`),
    );
    const document = projectMemoryGraphVisualization({ entities, relationships: [] }, workspaceSource);
    expect(document.nodes).to.have.length(500);
    expect(document.metadata.truncationReasons).to.deep.equal(["maxNodes"]);
  });

  it("orders degree ties by ordinal ID", () => {
    const document = projectMemoryGraphVisualization(
      {
        entities: [makeMemoryEntity("z"), makeMemoryEntity("b"), makeMemoryEntity("a")],
        relationships: [],
      },
      workspaceSource,
      { maxNodes: 2 },
    );

    expect(document.nodes.map((node) => node.id)).to.deep.equal(["a", "b"]);
  });

  it("retains at most 10,000 edges by descending weight and ordinal ID", () => {
    const relationships = Array.from({ length: 10_001 }, (_, index) => {
      const id = `edge-${index.toString().padStart(5, "0")}`;
      return makeMemoryRelationship(id, "a", "b", { weight: index === 10_000 ? 2 : 1 });
    });
    const document = projectMemoryGraphVisualization(
      { entities: [makeMemoryEntity("a"), makeMemoryEntity("b")], relationships },
      workspaceSource,
    );

    expect(document.edges).to.have.length(10_000);
    expect(document.edges[0].id).to.equal("edge-10000");
    expect(document.edges[1].id).to.equal("edge-00000");
    expect(document.edges.at(-1)!.id).to.equal("edge-09998");
    expect(document.edges.some((edge) => edge.id === "edge-09999")).to.equal(false);
    expect(document.metadata.originalEdgeCount).to.equal(10_001);
    expect(document.metadata.truncationReasons).to.deep.equal(["maxEdges"]);
  });

  it("canonicalizes recursive metadata while preserving ordinary array order", () => {
    const entity = makeMemoryEntity("a", {
      sourceMemoryIds: ["z", "a"],
      metadata: {
        z: [{ b: 2, a: 1 }],
        sequence: ["z", "a"],
        a: { sourceMemoryIds: ["z", "a"] },
      },
    });
    const document = projectMemoryGraphVisualization({ entities: [entity], relationships: [] }, workspaceSource);
    const attributes = document.nodes[0].attributes;

    expect(Object.keys(attributes)).to.deep.equal([
      "confidence",
      "createdAt",
      "description",
      "metadata",
      "scope",
      "sourceMemoryIds",
      "strength",
      "updatedAt",
    ]);
    expect(attributes.sourceMemoryIds).to.deep.equal(["a", "z"]);
    expect(attributes.metadata).to.deep.equal({
      a: { sourceMemoryIds: ["a", "z"] },
      sequence: ["z", "a"],
      z: [{ a: 1, b: 2 }],
    });
    expect(Object.keys(attributes.metadata as Record<string, unknown>)).to.deep.equal(["a", "sequence", "z"]);
  });

  it("preserves __proto__ data and canonicalizes integer-index and ordinal property order", () => {
    const forwardMetadata = Object.fromEntries([
      ["10", "ten"],
      ["z", "last"],
      ["__proto__", { safe: true }],
      ["2", "two"],
      ["a", "first"],
    ]);
    const reverseMetadata = Object.fromEntries([
      ["a", "first"],
      ["2", "two"],
      ["__proto__", { safe: true }],
      ["z", "last"],
      ["10", "ten"],
    ]);

    const forward = projectMemoryGraphVisualization(
      { entities: [makeMemoryEntity("a", { metadata: forwardMetadata })], relationships: [] },
      workspaceSource,
    );
    const reverse = projectMemoryGraphVisualization(
      { entities: [makeMemoryEntity("a", { metadata: reverseMetadata })], relationships: [] },
      workspaceSource,
    );
    const metadata = forward.nodes[0].attributes.metadata as Record<string, unknown>;

    expect(JSON.stringify(reverse)).to.equal(JSON.stringify(forward));
    expect(Object.keys(metadata)).to.deep.equal(["2", "10", "__proto__", "a", "z"]);
    expect(Object.prototype.hasOwnProperty.call(metadata, "__proto__")).to.equal(true);
    expect(metadata.__proto__).to.deep.equal({ safe: true });
  });

  it("rejects unsupported and cyclic values in metadata or provenance", () => {
    for (const bad of [1n, undefined, () => undefined, Symbol("bad")]) {
      const entity = makeMemoryEntity("a", { metadata: { nested: { bad } } });
      expect(() =>
        projectMemoryGraphVisualization({ entities: [entity], relationships: [] }, workspaceSource),
      ).to.throw(TypeError);
    }

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      projectMemoryGraphVisualization(
        { entities: [makeMemoryEntity("a", { metadata: cycle })], relationships: [] },
        workspaceSource,
      ),
    ).to.throw(TypeError);

    const invalidProvenance = makeMemoryEntity("a", { sourceMemoryIds: ["valid", undefined as unknown as string] });
    expect(() =>
      projectMemoryGraphVisualization({ entities: [invalidProvenance], relationships: [] }, workspaceSource),
    ).to.throw(TypeError);
  });

  it("rejects sparse metadata arrays", () => {
    const sparse = Array<string>(3);
    sparse[0] = "first";
    sparse[2] = "third";

    expect(() =>
      projectMemoryGraphVisualization(
        { entities: [makeMemoryEntity("a", { metadata: { sparse } })], relationships: [] },
        workspaceSource,
      ),
    ).to.throw(TypeError, "Sparse graph visualization arrays are not supported");
  });

  it("maps non-finite metadata numbers to null", () => {
    const document = projectMemoryGraphVisualization(
      {
        entities: [
          makeMemoryEntity("a", {
            metadata: { nan: Number.NaN, negative: Number.NEGATIVE_INFINITY, nested: [Number.POSITIVE_INFINITY] },
          }),
        ],
        relationships: [],
      },
      workspaceSource,
    );

    expect(document.nodes[0].attributes.metadata).to.deep.equal({ nan: null, negative: null, nested: [null] });
  });

  it("uses retained-only memory groups and emits no dangling edges", () => {
    const document = projectMemoryGraphVisualization(
      {
        entities: [makeMemoryEntity("hub"), makeMemoryEntity("b"), makeMemoryEntity("c"), makeMemoryEntity("isolated")],
        relationships: [makeMemoryRelationship("hub-b", "hub", "b"), makeMemoryRelationship("hub-c", "hub", "c")],
      },
      workspaceSource,
      { maxNodes: 2 },
    );

    expect(document.nodes.map((node) => node.id)).to.deep.equal(["hub", "b"]);
    expect(document.edges.map((edge) => edge.id)).to.deep.equal(["hub-b"]);
    expect(document.groups).to.have.length(1);
    expect(document.groups[0].retainedNodeCount).to.equal(2);
    expect(document.nodes.every((node) => node.groupId === document.groups[0].id)).to.equal(true);
    expect(document.edges.every((edge) => document.nodes.some((node) => node.id === edge.source))).to.equal(true);
    expect(document.edges.every((edge) => document.nodes.some((node) => node.id === edge.target))).to.equal(true);
  });

  it("separates disconnected components into deterministic groups", () => {
    const entities = [makeMemoryEntity("a"), makeMemoryEntity("b"), makeMemoryEntity("c"), makeMemoryEntity("d")];
    const relationships = [
      makeMemoryRelationship("ab", "a", "b", { weight: 1 }),
      makeMemoryRelationship("cd", "c", "d", { weight: 1 }),
    ];

    const forward = projectMemoryGraphVisualization({ entities, relationships }, workspaceSource);
    const reverse = projectMemoryGraphVisualization(
      { entities: [...entities].reverse(), relationships: [...relationships].reverse() },
      workspaceSource,
    );
    const memberships = forward.groups.map((group) =>
      forward.nodes
        .filter((node) => node.groupId === group.id)
        .map((node) => node.id)
        .sort(),
    );

    expect(memberships).to.deep.equal([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(JSON.stringify(reverse)).to.equal(JSON.stringify(forward));
  });

  it("retains isolated nodes outside grouped extent without creating a group", () => {
    const entities = [
      makeMemoryEntity("a"),
      makeMemoryEntity("b"),
      makeMemoryEntity("c"),
      makeMemoryEntity("isolated"),
    ];
    const relationships = [makeMemoryRelationship("ab", "a", "b"), makeMemoryRelationship("bc", "b", "c")];

    const forward = projectMemoryGraphVisualization({ entities, relationships }, workspaceSource);
    const reverse = projectMemoryGraphVisualization(
      { entities: [...entities].reverse(), relationships: [...relationships].reverse() },
      workspaceSource,
    );
    const isolated = forward.nodes.find((node) => node.id === "isolated")!;
    const grouped = forward.nodes.filter((node) => node.groupId !== null);
    const maximumGroupedExtent = Math.max(...grouped.map((node) => Math.hypot(node.x, node.y) + node.radius));

    expect(isolated.groupId).to.equal(null);
    expect(forward.groups.reduce((count, group) => count + group.retainedNodeCount, 0)).to.equal(grouped.length);
    expect(Math.hypot(isolated.x, isolated.y)).to.be.greaterThan(maximumGroupedExtent);
    expect(reverse.nodes.find((node) => node.id === "isolated")).to.deep.equal(isolated);
    expect(JSON.stringify(reverse)).to.equal(JSON.stringify(forward));
  });

  it("preserves complete memory details and source identity", () => {
    const source = { kind: "memory", scope: "branch", branch: "feature/aurora" } as const;
    const entity = makeMemoryEntity("a", {
      scope: "branch",
      branch: "feature/aurora",
      sourceMemoryIds: ["z", "a"],
      metadata: { priority: 2 },
    });
    const relationship = makeMemoryRelationship("ab", "a", "b", {
      scope: "branch",
      branch: "feature/aurora",
      metadata: { reason: "explicit" },
    });
    const document = projectMemoryGraphVisualization(
      {
        entities: [entity, makeMemoryEntity("b", { scope: "branch", branch: undefined })],
        relationships: [relationship],
      },
      source,
    );

    expect(document.source).to.deep.equal(source);
    expect(document.nodes.find((node) => node.id === "a")!.attributes).to.deep.equal({
      branch: "feature/aurora",
      confidence: 0.85,
      createdAt: 200,
      description: "Memory description a",
      metadata: { priority: 2 },
      scope: "branch",
      sourceMemoryIds: ["a", "z"],
      strength: 0.65,
      updatedAt: 300,
    });
    expect(document.nodes.find((node) => node.id === "b")!.attributes).not.to.have.property("branch");
    expect(document.edges[0].attributes).to.deep.equal({
      branch: "feature/aurora",
      description: "Memory relationship ab",
      metadata: { reason: "explicit" },
      scope: "branch",
    });
  });

  it("reduces deterministic prefixes and recalculates groups and viewport", () => {
    const document = projectMemoryGraphVisualization(
      {
        entities: [makeMemoryEntity("a"), makeMemoryEntity("b"), makeMemoryEntity("c"), makeMemoryEntity("d")],
        relationships: [
          makeMemoryRelationship("ab", "a", "b", { weight: 4 }),
          makeMemoryRelationship("ac", "a", "c", { weight: 3 }),
          makeMemoryRelationship("cd", "c", "d", { weight: 2 }),
        ],
      },
      workspaceSource,
    );
    const reduced = reduceGraphVisualizationDocument(document, 2, 3);
    const reducedAgain = reduceGraphVisualizationDocument(reduced, 2, 1);

    expect(reduced.nodes.map((node) => node.id)).to.deep.equal(["a", "c"]);
    expect(reduced.edges.map((edge) => edge.id)).to.deep.equal(["ac"]);
    expect(reduced.groups).to.have.length(1);
    expect(reduced.groups[0].retainedNodeCount).to.equal(2);
    expect(reduced.metadata).to.deep.include({ retainedNodeCount: 2, retainedEdgeCount: 1, truncated: true });
    expect(reduced.metadata.truncationReasons).to.deep.equal(["responseBytes"]);
    expect(reducedAgain.metadata.truncationReasons).to.deep.equal(["responseBytes"]);
    expect(reduced.viewport).to.deep.equal({
      minX: Math.min(...reduced.nodes.map((node) => node.x - node.radius)),
      minY: Math.min(...reduced.nodes.map((node) => node.y - node.radius)),
      maxX: Math.max(...reduced.nodes.map((node) => node.x + node.radius)),
      maxY: Math.max(...reduced.nodes.map((node) => node.y + node.radius)),
    });
  });

  it("removes empty groups and preserves fixed truncation reason order during reduction", () => {
    const document = projectMemoryGraphVisualization(
      {
        entities: [makeMemoryEntity("a"), makeMemoryEntity("b"), makeMemoryEntity("c"), makeMemoryEntity("d")],
        relationships: [
          makeMemoryRelationship("ab", "a", "b", { weight: 2 }),
          makeMemoryRelationship("cd", "c", "d", { weight: 1 }),
        ],
      },
      workspaceSource,
    );
    const sourceWithLimits: typeof document = {
      ...document,
      metadata: {
        ...document.metadata,
        truncated: true,
        truncationReasons: ["maxNodes", "maxEdges"],
      },
    };

    const reduced = reduceGraphVisualizationDocument(sourceWithLimits, 2, 2);
    const reducedAgain = reduceGraphVisualizationDocument(reduced, 2, 1);

    expect(sourceWithLimits.groups).to.have.length(2);
    expect(reduced.groups.map((group) => group.id)).to.deep.equal([0]);
    expect(reduced.groups[0].retainedNodeCount).to.equal(2);
    expect(reduced.metadata.truncationReasons).to.deep.equal(["maxNodes", "maxEdges", "responseBytes"]);
    expect(reducedAgain.metadata.truncationReasons).to.deep.equal(["maxNodes", "maxEdges", "responseBytes"]);
  });

  it("returns a successful empty memory document", () => {
    const memory = projectMemoryGraphVisualization({ entities: [], relationships: [] }, workspaceSource);

    expect(memory.nodes).to.deep.equal([]);
    expect(memory.edges).to.deep.equal([]);
    expect(memory.groups).to.deep.equal([]);
    expect(memory.viewport).to.deep.equal({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(memory.metadata).to.deep.equal({
      originalNodeCount: 0,
      retainedNodeCount: 0,
      originalEdgeCount: 0,
      retainedEdgeCount: 0,
      truncated: false,
      truncationReasons: [],
      empty: true,
    });
    expect(memory.source).to.deep.equal(workspaceSource);
  });

  it("projects a 32,000-node graph with indexed lookup and queue traversal in under five seconds", () => {
    const rawEntities = Array.from({ length: 32_000 }, (_, index) =>
      makeMemoryEntity(`node-${index.toString().padStart(5, "0")}`),
    );
    const relationships = Array.from({ length: rawEntities.length - 1 }, (_, index) =>
      makeMemoryRelationship(
        `edge-${index.toString().padStart(5, "0")}`,
        rawEntities[index].id,
        rawEntities[index + 1].id,
      ),
    );
    let entityIndexReads = 0;
    let entityFindCalls = 0;
    const entities = new Proxy(rawEntities, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          entityIndexReads += 1;
        }
        if (property === "find") {
          entityFindCalls += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let shiftCalls = 0;
    const originalShift = Array.prototype.shift;
    Array.prototype.shift = function <T>(this: T[]): T | undefined {
      shiftCalls += 1;
      return originalShift.call(this) as T | undefined;
    };

    let document;
    const startedAt = performance.now();
    try {
      document = projectMemoryGraphVisualization({ entities, relationships }, workspaceSource, { maxNodes: 100 });
    } finally {
      Array.prototype.shift = originalShift;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(document.nodes).to.have.length(100);
    expect(document.edges).to.have.length(99);
    expect(elapsedMs).to.be.lessThan(5_000);
    expect(entityIndexReads).to.equal(rawEntities.length);
    expect(entityFindCalls).to.equal(0);
    expect(shiftCalls).to.equal(0);
  });
});
