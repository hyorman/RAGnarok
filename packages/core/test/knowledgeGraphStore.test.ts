import { expect } from "chai";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { KnowledgeGraphStore, KnowledgeGraph, GraphEntity, GraphRelationship, KnowledgeGraphData } from "../src/index";

// Helper to create test entities
function createEntity(id: string, name: string, type: string = "concept"): GraphEntity {
  return {
    id,
    name,
    type: type as any,
    description: `Description of ${name}`,
    vector: [0.1, 0.2, 0.3, 0.4, 0.5],
    sourceChunkIds: ["chunk-1", "chunk-2"],
    confidence: 0.95,
    strength: 0.7,
    lastAccessedAt: Date.now(),
    metadata: { source: "test" },
  };
}

function createRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: string = "related_to",
): GraphRelationship {
  return {
    id,
    sourceId,
    targetId,
    type: type as any,
    weight: 0.8,
    description: `${sourceId} -> ${targetId}`,
    sourceChunkIds: ["chunk-1"],
    confidence: 0.9,
    metadata: { extracted: true },
  };
}

function createTestGraphData(topicId: string): KnowledgeGraphData {
  const entities = [
    createEntity("e1", "JavaScript", "module"),
    createEntity("e2", "TypeScript", "module"),
    createEntity("e3", "React", "module"),
  ];
  const relationships = [
    createRelationship("r1", "e1", "e2", "related_to"),
    createRelationship("r2", "e2", "e3", "depends_on"),
  ];
  return {
    entities,
    relationships,
    communities: [],
    metadata: {
      topicId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entityCount: entities.length,
      edgeCount: relationships.length,
      communityCount: 0,
      embeddingModel: "test-model",
      embeddingDimension: 5,
      embeddingFingerprint: {
        backendKind: "test",
        providerFormat: "test-format",
        model: "test-model",
        revision: "v1",
        dimension: 5,
        endpointHash: "local",
      },
    },
  };
}

describe("KnowledgeGraphStore Integration", function () {
  this.timeout(30000);

  let store: KnowledgeGraphStore;
  let tempDir: string;

  before(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kg-store-test-"));
    store = new KnowledgeGraphStore(tempDir);
  });

  after(async function () {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should save and load a graph round-trip", async function () {
    const testData = createTestGraphData("topic-1");
    await store.saveGraph("topic-1", testData);
    const loaded = await store.loadGraph("topic-1");

    expect(loaded).to.not.be.null;
    expect(loaded!.entities).to.have.length(3);
    expect(loaded!.relationships).to.have.length(2);
    expect(loaded!.entities[0].name).to.equal("JavaScript");
    expect(loaded!.relationships[0].type).to.equal("related_to");
    expect(loaded!.metadata.embeddingDimension).to.equal(5);
    expect(loaded!.metadata.embeddingFingerprint).to.deep.equal(testData.metadata.embeddingFingerprint);
  });

  it("should return null for non-existent graph", async function () {
    const result = await store.loadGraph("nonexistent-topic");
    expect(result).to.be.null;
  });

  it("rejects entity and relationship collections above the persisted graph limits before writing", async function () {
    const base = createTestGraphData("topic-over-limit");
    for (const oversized of [
      { ...base, entities: new Array(100_001).fill(base.entities[0]), relationships: [] },
      { ...base, entities: [], relationships: new Array(100_001).fill(base.relationships[0]) },
    ]) {
      let caught: unknown;
      try {
        await store.saveGraph("topic-over-limit", oversized);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).name).to.equal("KnowledgeGraphLimitError");
      expect((caught as Error).message).to.include("100000 entities, 100000 relationships");
    }
    expect(await store.hasGraph("topic-over-limit")).to.equal(false);
  });

  it("should delete graph tables", async function () {
    const testData = createTestGraphData("topic-delete");
    await store.saveGraph("topic-delete", testData);

    // Verify it exists
    expect(await store.hasGraph("topic-delete")).to.be.true;

    // Delete it
    await store.deleteGraph("topic-delete");

    // Verify it's gone
    expect(await store.hasGraph("topic-delete")).to.be.false;
    const loaded = await store.loadGraph("topic-delete");
    expect(loaded).to.be.null;
  });

  it("should handle empty graph (no entities)", async function () {
    const emptyData: KnowledgeGraphData = {
      entities: [],
      relationships: [],
      communities: [],
      metadata: {
        topicId: "topic-empty",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: 0,
        edgeCount: 0,
        communityCount: 0,
        embeddingModel: "test-model",
      },
    };
    await store.saveGraph("topic-empty", emptyData);
    // Empty graph has no tables created
    const loaded = await store.loadGraph("topic-empty");
    expect(loaded).to.be.null;
  });

  it("should preserve vector data through save/load", async function () {
    const entity = createEntity("vec-e1", "VectorTest");
    entity.vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const data: KnowledgeGraphData = {
      entities: [entity],
      relationships: [],
      communities: [],
      metadata: {
        topicId: "topic-vector",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: 1,
        edgeCount: 0,
        communityCount: 0,
        embeddingModel: "test-model",
      },
    };
    await store.saveGraph("topic-vector", data);
    const loaded = await store.loadGraph("topic-vector");

    expect(loaded).to.not.be.null;
    expect(loaded!.entities[0].vector).to.have.length(8);
    // Verify approximate values (Float32Array precision)
    loaded!.entities[0].vector.forEach((val, i) => {
      expect(val).to.be.closeTo(entity.vector[i], 0.001);
    });
  });

  it("should preserve JSON-encoded arrays through save/load", async function () {
    const entity = createEntity("json-e1", "JSONTest");
    entity.sourceChunkIds = ["chunk-a", "chunk-b", "chunk-c"];
    entity.metadata = { nested: { key: "value" }, count: 42 };
    const data: KnowledgeGraphData = {
      entities: [entity],
      relationships: [],
      communities: [],
      metadata: {
        topicId: "topic-json",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: 1,
        edgeCount: 0,
        communityCount: 0,
        embeddingModel: "test-model",
      },
    };
    await store.saveGraph("topic-json", data);
    const loaded = await store.loadGraph("topic-json");

    expect(loaded).to.not.be.null;
    expect(loaded!.entities[0].sourceChunkIds).to.deep.equal(["chunk-a", "chunk-b", "chunk-c"]);
    expect(loaded!.entities[0].metadata).to.deep.equal({ nested: { key: "value" }, count: 42 });
  });

  it("should overwrite existing graph on re-save", async function () {
    // Save initial data
    const data1 = createTestGraphData("topic-overwrite");
    await store.saveGraph("topic-overwrite", data1);

    // Overwrite with new data
    const entity = createEntity("new-e1", "NewEntity");
    const data2: KnowledgeGraphData = {
      entities: [entity],
      relationships: [],
      communities: [],
      metadata: {
        topicId: "topic-overwrite",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entityCount: 1,
        edgeCount: 0,
        communityCount: 0,
        embeddingModel: "test-model",
      },
    };
    await store.saveGraph("topic-overwrite", data2);

    const loaded = await store.loadGraph("topic-overwrite");
    expect(loaded).to.not.be.null;
    expect(loaded!.entities).to.have.length(1);
    expect(loaded!.entities[0].name).to.equal("NewEntity");
  });

  it("should report hasGraph correctly", async function () {
    expect(await store.hasGraph("topic-has-test")).to.be.false;
    await store.saveGraph("topic-has-test", createTestGraphData("topic-has-test"));
    expect(await store.hasGraph("topic-has-test")).to.be.true;
  });

  it("surfaces an incomplete entity/edge table set as corruption", async function () {
    const topicId = "topic-corrupt-table-set";
    await store.saveGraph(topicId, createTestGraphData(topicId));
    const db = await (store as any).getDb();
    await db.dropTable(`kg-entities-${topicId}`);

    let caught: unknown;
    try {
      await store.loadGraph(topicId);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include("corrupt");
  });

  it("surfaces metadata-only state with non-zero counts as a torn graph", async function () {
    const topicId = "topic-metadata-only-torn";
    const data = createTestGraphData(topicId);
    data.relationships = [];
    data.metadata.edgeCount = 0;
    await store.saveGraph(topicId, data);
    const db = await (store as any).getDb();
    await db.dropTable(`kg-entities-${topicId}`);

    for (const operation of [() => store.hasGraph(topicId), () => store.loadGraph(topicId)]) {
      let caught: unknown;
      try {
        await operation();
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).message).to.include("corrupt");
    }
  });

  it("should integrate with KnowledgeGraph toJSON/fromJSON", async function () {
    // Build graph in-memory
    const kg = new KnowledgeGraph("topic-integrate");
    kg.addEntity(createEntity("e1", "A"));
    kg.addEntity(createEntity("e2", "B"));
    kg.addRelationship(createRelationship("r1", "e1", "e2"));

    // Serialize and save
    const json = kg.toJSON();
    await store.saveGraph("topic-integrate", json);

    // Load and deserialize
    const loaded = await store.loadGraph("topic-integrate");
    expect(loaded).to.not.be.null;
    const restored = KnowledgeGraph.fromJSON(loaded!);
    expect(restored.getEntity("e1")!.name).to.equal("A");
    expect(restored.getEntity("e2")!.name).to.equal("B");
    expect(restored.getRelationship("r1")).to.not.be.null;
  });
});

describe("KnowledgeGraphStore atomic recovery", function () {
  this.timeout(30000);

  it("restores the previous entity+edge snapshot after restart", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kg-atomic-recovery-"));
    const topicId = "atomic-topic";
    const first = new KnowledgeGraphStore(directory);
    const original = createTestGraphData(topicId);
    await first.saveGraph(topicId, original);

    const rawSave = (first as any).saveGraphUnlocked.bind(first);
    let injectedFailures = 2;
    (first as any).saveGraphUnlocked = async (...args: unknown[]) => {
      await rawSave(...args);
      if (injectedFailures-- > 0) {
        throw new Error("simulated entity/edge commit interruption");
      }
    };
    let caught: unknown;
    try {
      await first.saveGraph(topicId, {
        ...createTestGraphData(topicId),
        entities: [createEntity("replacement", "Replacement")],
        relationships: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    first.dispose();

    const restarted = new KnowledgeGraphStore(directory);
    const recovered = await restarted.loadGraph(topicId);
    expect(recovered?.entities.map((entity) => entity.id).sort()).to.deep.equal(
      original.entities.map((entity) => entity.id).sort(),
    );
    expect(recovered?.relationships.map((relationship) => relationship.id).sort()).to.deep.equal(
      original.relationships.map((relationship) => relationship.id).sort(),
    );
    restarted.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
