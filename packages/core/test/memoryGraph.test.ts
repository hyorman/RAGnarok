import { expect } from "chai";
import { MemoryGraph } from "../src/memory/memoryGraph";
import { MemoryEntity, MemoryRelationship } from "../src/memory/types";

// Helper to create test entities with sensible defaults
function createTestEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id: "e1",
    name: "TestEntity",
    type: "concept",
    description: "A test entity",
    vector: [0.1, 0.2, 0.3],
    scope: "workspace",
    confidence: 1.0,
    strength: 0.5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceMemoryIds: ["mem-1"],
    metadata: {},
    ...overrides,
  };
}

function createTestRelationship(overrides: Partial<MemoryRelationship> = {}): MemoryRelationship {
  return {
    id: "r1",
    sourceId: "e1",
    targetId: "e2",
    type: "related_to",
    description: "e1 -> e2",
    weight: 0.5,
    scope: "workspace",
    metadata: {},
    ...overrides,
  };
}

describe("MemoryGraph", function () {
  let graph: MemoryGraph;

  beforeEach(function () {
    graph = new MemoryGraph();
  });

  describe("Entity operations", function () {
    it("should add and retrieve an entity", function () {
      const entity = createTestEntity();
      graph.addEntity(entity);
      const result = graph.getEntity("e1");
      expect(result).to.not.be.null;
      expect(result!.id).to.equal("e1");
      expect(result!.name).to.equal("TestEntity");
      expect(result!.type).to.equal("concept");
    });

    it("should return null for non-existent entity", function () {
      expect(graph.getEntity("missing")).to.be.null;
    });

    it("should update entity attributes", function () {
      graph.addEntity(createTestEntity());
      graph.updateEntity("e1", { name: "Updated", strength: 0.9 });
      const result = graph.getEntity("e1");
      expect(result!.name).to.equal("Updated");
      expect(result!.strength).to.equal(0.9);
      // id should not change
      expect(result!.id).to.equal("e1");
    });

    it("should silently skip update for non-existent entity", function () {
      // Should not throw
      graph.updateEntity("missing", { name: "x" });
      expect(graph.entityCount).to.equal(0);
    });

    it("should update when adding entity with existing ID", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "Original" }));
      graph.addEntity(createTestEntity({ id: "e1", name: "Replacement" }));
      expect(graph.entityCount).to.equal(1);
      const result = graph.getEntity("e1");
      expect(result!.name).to.equal("Replacement");
    });

    it("should remove entity and its connected edges", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C" }));
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r2", sourceId: "e2", targetId: "e1" }));
      graph.addRelationship(createTestRelationship({ id: "r3", sourceId: "e2", targetId: "e3" }));

      graph.removeEntity("e1");
      expect(graph.getEntity("e1")).to.be.null;
      expect(graph.entityCount).to.equal(2);
      // Edges r1 and r2 (involving e1) should be removed; r3 should remain
      expect(graph.edgeCount).to.equal(1);
      expect(graph.getRelationship("r1")).to.be.null;
      expect(graph.getRelationship("r2")).to.be.null;
      expect(graph.getRelationship("r3")).to.not.be.null;
    });

    it("should silently skip removing non-existent entity", function () {
      graph.removeEntity("missing");
      expect(graph.entityCount).to.equal(0);
    });

    it("should return all entities", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C" }));
      expect(graph.getAllEntities()).to.have.length(3);
    });
  });

  describe("findDuplicate", function () {
    it("should find entity by exact name and type (case-insensitive)", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "JavaScript", type: "concept" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "TypeScript", type: "tool" }));

      const result = graph.findDuplicate("javascript", "concept");
      expect(result).to.not.be.null;
      expect(result!.id).to.equal("e1");
    });

    it("should return null when name matches but type differs", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "JavaScript", type: "concept" }));
      expect(graph.findDuplicate("JavaScript", "tool")).to.be.null;
    });

    it("should return null when no match exists", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "JavaScript", type: "concept" }));
      expect(graph.findDuplicate("Python", "concept")).to.be.null;
    });

    it("should match case-insensitively", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "MyProject", type: "project" }));
      expect(graph.findDuplicate("MYPROJECT", "project")).to.not.be.null;
      expect(graph.findDuplicate("myproject", "project")).to.not.be.null;
    });
  });

  describe("findByName", function () {
    beforeEach(function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "JavaScript Runtime" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "TypeScript Compiler" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "Python Interpreter" }));
    });

    it("should find entities by name substring", function () {
      const results = graph.findByName("Script");
      expect(results).to.have.length(2);
      const names = results.map((e) => e.name);
      expect(names).to.include("JavaScript Runtime");
      expect(names).to.include("TypeScript Compiler");
    });

    it("should be case-insensitive", function () {
      const results = graph.findByName("python");
      expect(results).to.have.length(1);
      expect(results[0].name).to.equal("Python Interpreter");
    });

    it("should return empty array when nothing matches", function () {
      expect(graph.findByName("Rust")).to.have.length(0);
    });
  });

  describe("searchByEmbedding", function () {
    it("should return entities ranked by cosine similarity", function () {
      // Vectors chosen so e2 is most similar to query
      graph.addEntity(createTestEntity({ id: "e1", name: "A", vector: [1, 0, 0] }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B", vector: [0.9, 0.1, 0] }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C", vector: [0, 0, 1] }));

      const results = graph.searchByEmbedding([1, 0, 0], 3);
      expect(results).to.have.length(3);
      // e1 should be most similar (exact match), then e2, then e3
      expect(results[0].entity.id).to.equal("e1");
      expect(results[1].entity.id).to.equal("e2");
      expect(results[2].entity.id).to.equal("e3");
      expect(results[0].score).to.be.greaterThan(results[1].score);
      expect(results[1].score).to.be.greaterThan(results[2].score);
    });

    it("should respect the k limit", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A", vector: [1, 0, 0] }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B", vector: [0, 1, 0] }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C", vector: [0, 0, 1] }));

      const results = graph.searchByEmbedding([1, 0, 0], 2);
      expect(results).to.have.length(2);
    });

    it("should skip entities without vectors", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A", vector: [1, 0, 0] }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B", vector: [] }));

      const results = graph.searchByEmbedding([1, 0, 0], 10);
      expect(results).to.have.length(1);
      expect(results[0].entity.id).to.equal("e1");
    });

    it("should return empty when graph is empty", function () {
      const results = graph.searchByEmbedding([1, 0, 0], 5);
      expect(results).to.have.length(0);
    });
  });

  describe("Relationship operations", function () {
    beforeEach(function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C" }));
    });

    it("should add and retrieve a relationship", function () {
      const rel = createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" });
      graph.addRelationship(rel);
      const result = graph.getRelationship("r1");
      expect(result).to.not.be.null;
      expect(result!.sourceId).to.equal("e1");
      expect(result!.targetId).to.equal("e2");
      expect(result!.type).to.equal("related_to");
    });

    it("should silently skip relationship with missing source", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "missing", targetId: "e2" }));
      expect(graph.edgeCount).to.equal(0);
    });

    it("should silently skip relationship with missing target", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "missing" }));
      expect(graph.edgeCount).to.equal(0);
    });

    it("should remove a relationship", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.removeRelationship("r1");
      expect(graph.getRelationship("r1")).to.be.null;
      expect(graph.edgeCount).to.equal(0);
    });

    it("should silently skip removing non-existent relationship", function () {
      graph.removeRelationship("missing");
      expect(graph.edgeCount).to.equal(0);
    });

    it("should return null for non-existent relationship", function () {
      expect(graph.getRelationship("missing")).to.be.null;
    });

    it("should return all relationships", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r2", sourceId: "e2", targetId: "e3" }));
      expect(graph.getAllRelationships()).to.have.length(2);
    });

    it("should not add duplicate relationship with same ID", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e3" }));
      expect(graph.edgeCount).to.equal(1);
    });

    it("preserves multiple relationship types between the same ordered entity pair", function () {
      graph.addEntity(createTestEntity({ id: "e1" }));
      graph.addEntity(createTestEntity({ id: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "uses", type: "uses" }));
      graph.addRelationship(createTestRelationship({ id: "depends", type: "depends_on" }));

      expect(
        graph
          .getAllRelationships()
          .map((relationship) => relationship.type)
          .sort(),
      ).to.deep.equal(["depends_on", "uses"]);
      expect(MemoryGraph.fromJSON(graph.toJSON()).edgeCount).to.equal(2);
    });
  });

  describe("getEntityRelationships", function () {
    beforeEach(function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C" }));
    });

    it("should return all relationships involving an entity", function () {
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r2", sourceId: "e2", targetId: "e1" }));
      graph.addRelationship(createTestRelationship({ id: "r3", sourceId: "e2", targetId: "e3" }));

      const rels = graph.getEntityRelationships("e1");
      expect(rels).to.have.length(2);
      const ids = rels.map((r) => r.id);
      expect(ids).to.include("r1");
      expect(ids).to.include("r2");
    });

    it("should return empty array for entity with no relationships", function () {
      expect(graph.getEntityRelationships("e1")).to.have.length(0);
    });

    it("should return empty array for non-existent entity", function () {
      expect(graph.getEntityRelationships("missing")).to.have.length(0);
    });
  });

  describe("getNeighbors", function () {
    beforeEach(function () {
      // Chain: e1 -> e2 -> e3 -> e4
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addEntity(createTestEntity({ id: "e3", name: "C" }));
      graph.addEntity(createTestEntity({ id: "e4", name: "D" }));
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r2", sourceId: "e2", targetId: "e3" }));
      graph.addRelationship(createTestRelationship({ id: "r3", sourceId: "e3", targetId: "e4" }));
    });

    it("should return direct neighbors (depth 1)", function () {
      const neighbors = graph.getNeighbors("e1", 1);
      expect(neighbors).to.have.length(1);
      expect(neighbors[0].id).to.equal("e2");
    });

    it("should return multi-hop neighbors (depth 2)", function () {
      const neighbors = graph.getNeighbors("e1", 2);
      expect(neighbors).to.have.length(2);
      const ids = neighbors.map((e) => e.id);
      expect(ids).to.include("e2");
      expect(ids).to.include("e3");
    });

    it("should return all reachable nodes with sufficient depth", function () {
      const neighbors = graph.getNeighbors("e1", 3);
      expect(neighbors).to.have.length(3);
      const ids = neighbors.map((e) => e.id);
      expect(ids).to.include("e2");
      expect(ids).to.include("e3");
      expect(ids).to.include("e4");
    });

    it("should not include the start node", function () {
      const neighbors = graph.getNeighbors("e2", 2);
      const ids = neighbors.map((e) => e.id);
      expect(ids).to.not.include("e2");
    });

    it("should use default depth of 1", function () {
      const neighbors = graph.getNeighbors("e1");
      expect(neighbors).to.have.length(1);
    });

    it("should return empty array for non-existent entity", function () {
      expect(graph.getNeighbors("missing")).to.have.length(0);
    });

    it("should return empty array for isolated entity", function () {
      graph.addEntity(createTestEntity({ id: "e5", name: "Isolated" }));
      expect(graph.getNeighbors("e5")).to.have.length(0);
    });
  });

  describe("Serialization", function () {
    it("should round-trip through toJSON / fromJSON", function () {
      graph.addEntity(createTestEntity({ id: "e1", name: "A" }));
      graph.addEntity(createTestEntity({ id: "e2", name: "B" }));
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));

      const json = graph.toJSON();
      const restored = MemoryGraph.fromJSON(json);

      expect(restored.entityCount).to.equal(2);
      expect(restored.edgeCount).to.equal(1);
      expect(restored.getEntity("e1")!.name).to.equal("A");
      expect(restored.getEntity("e2")!.name).to.equal("B");
      expect(restored.getRelationship("r1")!.sourceId).to.equal("e1");
    });

    it("should serialize empty graph", function () {
      const json = graph.toJSON();
      expect(json.entities).to.have.length(0);
      expect(json.relationships).to.have.length(0);

      const restored = MemoryGraph.fromJSON(json);
      expect(restored.entityCount).to.equal(0);
      expect(restored.edgeCount).to.equal(0);
    });

    it("should preserve entity attributes through round-trip", function () {
      const entity = createTestEntity({
        id: "e1",
        name: "FullEntity",
        type: "preference",
        description: "A preference entity",
        vector: [0.5, 0.6, 0.7],
        scope: "branch",
        branch: "main",
        confidence: 0.95,
        strength: 0.8,
        sourceMemoryIds: ["mem-1", "mem-2"],
        metadata: { key: "value" },
      });
      graph.addEntity(entity);

      const restored = MemoryGraph.fromJSON(graph.toJSON());
      const result = restored.getEntity("e1")!;
      expect(result.name).to.equal("FullEntity");
      expect(result.type).to.equal("preference");
      expect(result.scope).to.equal("branch");
      expect(result.branch).to.equal("main");
      expect(result.confidence).to.equal(0.95);
      expect(result.vector).to.deep.equal([0.5, 0.6, 0.7]);
      expect(result.sourceMemoryIds).to.deep.equal(["mem-1", "mem-2"]);
      expect(result.metadata).to.deep.equal({ key: "value" });
    });
  });

  describe("Stats", function () {
    it("should report correct entity count", function () {
      expect(graph.entityCount).to.equal(0);
      graph.addEntity(createTestEntity({ id: "e1" }));
      expect(graph.entityCount).to.equal(1);
      graph.addEntity(createTestEntity({ id: "e2" }));
      expect(graph.entityCount).to.equal(2);
    });

    it("should report correct edge count", function () {
      graph.addEntity(createTestEntity({ id: "e1" }));
      graph.addEntity(createTestEntity({ id: "e2" }));
      expect(graph.edgeCount).to.equal(0);
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      expect(graph.edgeCount).to.equal(1);
    });

    it("should decrement counts on removal", function () {
      graph.addEntity(createTestEntity({ id: "e1" }));
      graph.addEntity(createTestEntity({ id: "e2" }));
      graph.addRelationship(createTestRelationship({ id: "r1", sourceId: "e1", targetId: "e2" }));
      expect(graph.entityCount).to.equal(2);
      expect(graph.edgeCount).to.equal(1);

      graph.removeEntity("e1");
      expect(graph.entityCount).to.equal(1);
      expect(graph.edgeCount).to.equal(0);
    });
  });
});
