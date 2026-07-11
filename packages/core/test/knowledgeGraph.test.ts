import { expect } from "chai";
import { KnowledgeGraph, GraphEntity, GraphRelationship } from "../src/index";

// Helper to create test entities with minimal boilerplate
function createEntity(id: string, name: string, type: string = "concept"): GraphEntity {
  return {
    id,
    name,
    type: type as any,
    description: `Description of ${name}`,
    vector: [0.1, 0.2, 0.3],
    sourceChunkIds: ["chunk-1"],
    confidence: 1.0,
    strength: 0.5,
    lastAccessedAt: Date.now(),
    metadata: {},
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
    weight: 0.5,
    description: `${sourceId} -> ${targetId}`,
    sourceChunkIds: ["chunk-1"],
    confidence: 1.0,
    metadata: {},
  };
}

describe("KnowledgeGraph", function () {
  let kg: KnowledgeGraph;

  beforeEach(function () {
    kg = new KnowledgeGraph("test-topic");
  });

  describe("Entity operations", function () {
    it("should add and retrieve an entity", function () {
      const entity = createEntity("e1", "TestEntity");
      kg.addEntity(entity);
      const result = kg.getEntity("e1");
      expect(result).to.not.be.null;
      expect(result!.id).to.equal("e1");
      expect(result!.name).to.equal("TestEntity");
      expect(result!.type).to.equal("concept");
    });

    it("should throw on duplicate entity ID", function () {
      kg.addEntity(createEntity("e1", "Entity1"));
      expect(() => kg.addEntity(createEntity("e1", "Entity2"))).to.throw("Entity already exists: e1");
    });

    it("should update entity attributes", function () {
      kg.addEntity(createEntity("e1", "Original"));
      kg.updateEntity("e1", { name: "Updated", strength: 0.9 });
      const result = kg.getEntity("e1");
      expect(result!.name).to.equal("Updated");
      expect(result!.strength).to.equal(0.9);
    });

    it("should throw when updating non-existent entity", function () {
      expect(() => kg.updateEntity("missing", { name: "x" })).to.throw("Entity not found: missing");
    });

    it("should remove entity and its incident edges", function () {
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.removeEntity("e1");
      expect(kg.getEntity("e1")).to.be.null;
      expect(kg.getAllRelationships()).to.have.length(0);
    });

    it("should throw when removing non-existent entity", function () {
      expect(() => kg.removeEntity("missing")).to.throw("Entity not found: missing");
    });

    it("should find entities by name (case-insensitive)", function () {
      kg.addEntity(createEntity("e1", "JavaScript"));
      kg.addEntity(createEntity("e2", "TypeScript"));
      kg.addEntity(createEntity("e3", "Python"));
      const results = kg.findEntitiesByName("script");
      expect(results).to.have.length(2);
    });

    it("should find entities by type", function () {
      kg.addEntity(createEntity("e1", "A", "class"));
      kg.addEntity(createEntity("e2", "B", "function"));
      kg.addEntity(createEntity("e3", "C", "class"));
      const results = kg.findEntitiesByType("class");
      expect(results).to.have.length(2);
    });

    it("should return all entities", function () {
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
      expect(kg.getAllEntities()).to.have.length(3);
    });

    it("should return null for non-existent entity", function () {
      expect(kg.getEntity("missing")).to.be.null;
    });
  });

  describe("Relationship operations", function () {
    beforeEach(function () {
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
    });

    it("should add and retrieve a relationship", function () {
      const rel = createRelationship("r1", "e1", "e2");
      kg.addRelationship(rel);
      const result = kg.getRelationship("r1");
      expect(result).to.not.be.null;
      expect(result!.sourceId).to.equal("e1");
      expect(result!.targetId).to.equal("e2");
    });

    it("should throw when source entity is missing", function () {
      expect(() => kg.addRelationship(createRelationship("r1", "missing", "e2"))).to.throw(
        "Source entity not found: missing",
      );
    });

    it("should throw when target entity is missing", function () {
      expect(() => kg.addRelationship(createRelationship("r1", "e1", "missing"))).to.throw(
        "Target entity not found: missing",
      );
    });

    it("should get relationships between two entities", function () {
      kg.addRelationship(createRelationship("r1", "e1", "e2", "calls"));
      kg.addRelationship(createRelationship("r2", "e1", "e3", "imports"));
      const between = kg.getRelationshipsBetween("e1", "e2");
      expect(between).to.have.length(1);
      expect(between[0].id).to.equal("r1");
    });

    it("should return all relationships", function () {
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.addRelationship(createRelationship("r2", "e2", "e3"));
      expect(kg.getAllRelationships()).to.have.length(2);
    });

    it("should remove a relationship", function () {
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.removeRelationship("r1");
      expect(kg.getRelationship("r1")).to.be.null;
    });

    it("should throw when removing non-existent relationship", function () {
      expect(() => kg.removeRelationship("missing")).to.throw("Relationship not found: missing");
    });

    it("should return null for non-existent relationship", function () {
      expect(kg.getRelationship("missing")).to.be.null;
    });
  });

  describe("Graph traversal", function () {
    beforeEach(function () {
      // Create a chain: e1 -> e2 -> e3 -> e4
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
      kg.addEntity(createEntity("e4", "D"));
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.addRelationship(createRelationship("r2", "e2", "e3"));
      kg.addRelationship(createRelationship("r3", "e3", "e4"));
    });

    it("should get direct outbound neighbors", function () {
      const neighbors = kg.getNeighbors("e1", { direction: "out" });
      expect(neighbors).to.have.length(1);
      expect(neighbors[0].id).to.equal("e2");
    });

    it("should get direct inbound neighbors", function () {
      const neighbors = kg.getNeighbors("e2", { direction: "in" });
      expect(neighbors).to.have.length(1);
      expect(neighbors[0].id).to.equal("e1");
    });

    it("should get both-direction neighbors", function () {
      const neighbors = kg.getNeighbors("e2", { direction: "both" });
      expect(neighbors).to.have.length(2);
      const ids = neighbors.map((n) => n.id);
      expect(ids).to.include("e1");
      expect(ids).to.include("e3");
    });

    it("should traverse BFS to specified depth", function () {
      const neighbors = kg.getNeighbors("e1", { direction: "both", maxDepth: 2 });
      expect(neighbors.length).to.be.greaterThanOrEqual(2);
      const ids = neighbors.map((n) => n.id);
      expect(ids).to.include("e2");
      expect(ids).to.include("e3");
    });

    it("should extract subgraph for given entity IDs", function () {
      const subgraph = kg.getSubgraph(["e1", "e2", "e3"]);
      expect(subgraph.entities).to.have.length(3);
      expect(subgraph.relationships).to.have.length(2); // r1 and r2 (r3 excluded: e4 not in set)
    });

    it("should call traverseBFS callback with entities and depths", function () {
      const visited: Array<{ id: string; depth: number }> = [];
      kg.traverseBFS(
        "e1",
        (entity, depth) => {
          visited.push({ id: entity.id, depth });
        },
        2,
      );
      expect(visited.length).to.be.greaterThanOrEqual(2);
      expect(visited[0].id).to.equal("e1");
      expect(visited[0].depth).to.equal(0);
    });

    it("should stop BFS when callback returns true", function () {
      const visited: string[] = [];
      kg.traverseBFS("e1", (entity) => {
        visited.push(entity.id);
        return entity.id === "e2"; // stop after e2
      });
      // Should have visited e1 and e2 at most (BFS may visit e1 first at depth 0)
      expect(visited).to.include("e1");
      expect(visited).to.include("e2");
    });

    it("should throw when traversing from non-existent entity", function () {
      expect(() => kg.traverseBFS("missing", () => {})).to.throw("Entity not found: missing");
    });
  });

  describe("Community detection", function () {
    it("should detect communities on a graph with clear clusters", function () {
      // Cluster 1: e1 <-> e2 <-> e3
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.addRelationship(createRelationship("r2", "e2", "e3"));
      kg.addRelationship(createRelationship("r3", "e3", "e1"));

      // Cluster 2: e4 <-> e5 <-> e6
      kg.addEntity(createEntity("e4", "D"));
      kg.addEntity(createEntity("e5", "E"));
      kg.addEntity(createEntity("e6", "F"));
      kg.addRelationship(createRelationship("r4", "e4", "e5"));
      kg.addRelationship(createRelationship("r5", "e5", "e6"));
      kg.addRelationship(createRelationship("r6", "e6", "e4"));

      // Weak bridge
      kg.addRelationship(createRelationship("r7", "e3", "e4"));

      const communityMap = kg.detectCommunities();
      expect(communityMap.size).to.be.greaterThanOrEqual(1);

      const communities = kg.getCommunities();
      expect(communities.length).to.be.greaterThanOrEqual(1);
      // Total entities across all communities should equal 6
      const totalEntities = communities.reduce((sum, c) => sum + c.entityIds.length, 0);
      expect(totalEntities).to.equal(6);
    });

    it("should return empty communities for empty graph", function () {
      const communityMap = kg.detectCommunities();
      expect(communityMap.size).to.equal(0);
    });
  });

  describe("Serialization", function () {
    it("should round-trip toJSON/fromJSON", function () {
      kg.addEntity(createEntity("e1", "A", "class"));
      kg.addEntity(createEntity("e2", "B", "function"));
      kg.addRelationship(createRelationship("r1", "e1", "e2", "calls"));

      const json = kg.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);

      expect(restored.getEntity("e1")!.name).to.equal("A");
      expect(restored.getEntity("e2")!.name).to.equal("B");
      expect(restored.getRelationship("r1")!.type).to.equal("calls");
    });

    it("should preserve all entity and relationship data", function () {
      const entity = createEntity("e1", "TestEntity");
      entity.confidence = 0.95;
      entity.strength = 0.8;
      entity.metadata = { key: "value" };
      kg.addEntity(entity);

      kg.addEntity(createEntity("e2", "Target"));
      const rel = createRelationship("r1", "e1", "e2");
      rel.weight = 0.75;
      kg.addRelationship(rel);

      const json = kg.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);

      const restoredEntity = restored.getEntity("e1")!;
      expect(restoredEntity.confidence).to.equal(0.95);
      expect(restoredEntity.strength).to.equal(0.8);
      expect(restoredEntity.metadata).to.deep.equal({ key: "value" });

      const restoredRel = restored.getRelationship("r1")!;
      expect(restoredRel.weight).to.equal(0.75);
    });

    it("should preserve community assignments", function () {
      // Create a graph and detect communities
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.detectCommunities();

      const json = kg.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);
      expect(restored.getCommunities().length).to.equal(kg.getCommunities().length);
    });
  });

  describe("Statistics", function () {
    it("should return correct stats for non-empty graph", function () {
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
      kg.addRelationship(createRelationship("r1", "e1", "e2"));
      kg.addRelationship(createRelationship("r2", "e2", "e3"));

      const stats = kg.getStats();
      expect(stats.entityCount).to.equal(3);
      expect(stats.edgeCount).to.equal(2);
      expect(stats.averageDegree).to.be.closeTo(4 / 3, 0.01);
      expect(stats.connectedComponents).to.equal(1);
      expect(stats.density).to.be.closeTo(2 / 6, 0.01);
    });

    it("should return zero stats for empty graph", function () {
      const stats = kg.getStats();
      expect(stats.entityCount).to.equal(0);
      expect(stats.edgeCount).to.equal(0);
      expect(stats.averageDegree).to.equal(0);
      expect(stats.communityCount).to.equal(0);
      expect(stats.density).to.equal(0);
      expect(stats.connectedComponents).to.equal(0);
    });

    it("should count disconnected components correctly", function () {
      kg.addEntity(createEntity("e1", "A"));
      kg.addEntity(createEntity("e2", "B"));
      kg.addEntity(createEntity("e3", "C"));
      // e1 -> e2, e3 is isolated
      kg.addRelationship(createRelationship("r1", "e1", "e2"));

      const stats = kg.getStats();
      expect(stats.connectedComponents).to.equal(2);
    });
  });
});
