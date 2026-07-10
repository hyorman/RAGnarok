import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemoryScopeLinker } from "../src/memory/memoryScopeLinker";
import { MemoryVectorStore } from "../src/memory/memoryVectorStore";
import {
  MemoryEntry,
  MemoryEntity,
  MemoryScope,
} from "../src/memory/types";

// ── Helpers ──────────────────────────────────────────────────────────

const VECTOR_DIM = 32;

function randomVector(): number[] {
  const vec = new Array<number>(VECTOR_DIM);
  for (let i = 0; i < VECTOR_DIM; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < VECTOR_DIM; i++) {
    vec[i] /= norm;
  }
  return vec;
}

function createTestEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    content: "test memory content",
    scope: "workspace" as MemoryScope,
    vector: randomVector(),
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    tags: [],
    entityIds: [],
    metadata: {},
    ...overrides,
  };
}

function createTestEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "test-entity",
    type: "concept",
    description: "A test entity",
    vector: randomVector(),
    scope: "workspace" as MemoryScope,
    confidence: 0.9,
    strength: 1.0,
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: [],
    metadata: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryScopeLinker", function () {
  this.timeout(30000);

  let store: MemoryVectorStore;
  let linker: MemoryScopeLinker;
  let tempDir: string;

  beforeEach(async function () {
    tempDir = path.join(os.tmpdir(), `scope-linker-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new MemoryVectorStore(path.join(tempDir, "lancedb"));
    linker = new MemoryScopeLinker(store);
  });

  afterEach(async function () {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── discoverLinks ──────────────────────────────────────────────────

  describe("discoverLinks", function () {
    it("should find matching entities across workspace and branch scopes", async function () {
      const wsEntity = createTestEntity({ name: "TypeScript", type: "tool", scope: "workspace" });
      const branchEntity = createTestEntity({
        name: "typescript",
        type: "tool",
        scope: "branch",
        branch: "feat-x",
      });

      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat-x");

      const links = await linker.discoverLinks("workspace", "branch:feat-x");

      expect(links).to.have.lengthOf(1);
      expect(links[0].sourceEntityId).to.equal(wsEntity.id);
      expect(links[0].targetEntityId).to.equal(branchEntity.id);
      expect(links[0].entityName).to.equal("TypeScript");
      expect(links[0].entityType).to.equal("tool");
      expect(links[0].confidence).to.equal(1.0);
    });

    it("should not link entities with same name but different type", async function () {
      const wsEntity = createTestEntity({ name: "React", type: "tool", scope: "workspace" });
      const branchEntity = createTestEntity({
        name: "React",
        type: "concept",
        scope: "branch",
        branch: "feat-y",
      });

      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat-y");

      const links = await linker.discoverLinks("workspace", "branch:feat-y");
      expect(links).to.have.lengthOf(0);
    });

    it("should return empty array when source scope has no entities", async function () {
      const branchEntity = createTestEntity({
        name: "Node",
        type: "tool",
        scope: "branch",
        branch: "feat-z",
      });
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat-z");

      const links = await linker.discoverLinks("workspace", "branch:feat-z");
      expect(links).to.have.lengthOf(0);
    });

    it("should return empty array when target scope has no entities", async function () {
      const wsEntity = createTestEntity({ name: "Node", type: "tool", scope: "workspace" });
      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");

      const links = await linker.discoverLinks("workspace", "branch:empty-branch");
      expect(links).to.have.lengthOf(0);
    });

    it("should discover multiple links when multiple entities match", async function () {
      const wsEntities = [
        createTestEntity({ name: "TypeScript", type: "tool", scope: "workspace" }),
        createTestEntity({ name: "ESLint", type: "tool", scope: "workspace" }),
        createTestEntity({ name: "Unmatched", type: "concept", scope: "workspace" }),
      ];
      const branchEntities = [
        createTestEntity({ name: "typescript", type: "tool", scope: "branch", branch: "feat" }),
        createTestEntity({ name: "eslint", type: "tool", scope: "branch", branch: "feat" }),
      ];

      await store.saveGraph({ entities: wsEntities, relationships: [] }, "workspace");
      await store.saveGraph({ entities: branchEntities, relationships: [] }, "branch", "feat");

      const links = await linker.discoverLinks("workspace", "branch:feat");
      expect(links).to.have.lengthOf(2);

      const names = links.map((l) => l.entityName.toLowerCase()).sort();
      expect(names).to.deep.equal(["eslint", "typescript"]);
    });
  });

  // ── promoteToWorkspace ─────────────────────────────────────────────

  describe("promoteToWorkspace", function () {
    it("should copy branch entries to workspace scope", async function () {
      const branchEntries = [
        createTestEntry({ content: "branch fact 1", scope: "branch", branch: "feat" }),
        createTestEntry({ content: "branch fact 2", scope: "branch", branch: "feat" }),
      ];
      await store.saveEntries(branchEntries, "branch", "feat");

      const count = await linker.promoteToWorkspace("branch:feat", "workspace");
      expect(count).to.equal(2);

      const wsEntries = await store.loadEntries("workspace");
      expect(wsEntries).to.have.lengthOf(2);
      expect(wsEntries.every((e) => e.scope === "workspace")).to.be.true;
      expect(wsEntries.every((e) => !e.branch)).to.be.true;
    });

    it("should dedup against existing workspace entries", async function () {
      // Use identical vector for "shared fact" so cosine similarity = 1.0 triggers dedup
      const sharedVector = randomVector();
      const existingWs = [createTestEntry({ content: "shared fact", scope: "workspace", vector: sharedVector })];
      await store.saveEntries(existingWs, "workspace");

      const branchEntries = [
        createTestEntry({ content: "shared fact", scope: "branch", branch: "feat", vector: sharedVector }),
        createTestEntry({ content: "unique fact", scope: "branch", branch: "feat" }),
      ];
      await store.saveEntries(branchEntries, "branch", "feat");

      const count = await linker.promoteToWorkspace("branch:feat", "workspace");
      expect(count).to.equal(1);

      const wsEntries = await store.loadEntries("workspace");
      expect(wsEntries).to.have.lengthOf(2);
      const contents = wsEntries.map((e) => e.content).sort();
      expect(contents).to.deep.equal(["shared fact", "unique fact"]);
    });

    it("should only promote specific entryIds when provided", async function () {
      const entry1 = createTestEntry({ content: "fact A", scope: "branch", branch: "feat" });
      const entry2 = createTestEntry({ content: "fact B", scope: "branch", branch: "feat" });
      await store.saveEntries([entry1, entry2], "branch", "feat");

      const count = await linker.promoteToWorkspace("branch:feat", "workspace", [entry1.id]);
      expect(count).to.equal(1);

      const wsEntries = await store.loadEntries("workspace");
      expect(wsEntries).to.have.lengthOf(1);
      expect(wsEntries[0].content).to.equal("fact A");
    });

    it("should return 0 for invalid branch scope", async function () {
      const count = await linker.promoteToWorkspace("workspace", "workspace");
      expect(count).to.equal(0);
    });

    it("should return 0 when branch has no entries", async function () {
      const count = await linker.promoteToWorkspace("branch:empty", "workspace");
      expect(count).to.equal(0);
    });

    it("should merge referenced entities and relationships into the workspace graph", async function () {
      const entityA = createTestEntity({ name: "ServiceA", scope: "branch", branch: "feat" });
      const entityB = createTestEntity({ name: "ServiceB", scope: "branch", branch: "feat" });
      const entry = createTestEntry({
        content: "ServiceA depends on ServiceB",
        scope: "branch",
        branch: "feat",
        entityIds: [entityA.id, entityB.id],
      });
      entityA.sourceMemoryIds = [entry.id];
      entityB.sourceMemoryIds = [entry.id];

      await store.saveEntries([entry], "branch", "feat");
      await store.saveGraph(
        {
          entities: [entityA, entityB],
          relationships: [
            {
              id: crypto.randomUUID(),
              sourceId: entityA.id,
              targetId: entityB.id,
              type: "depends_on",
              description: "A depends on B",
              weight: 0.9,
              scope: "branch",
              branch: "feat",
              metadata: {},
            },
          ],
        },
        "branch",
        "feat",
      );

      const count = await linker.promoteToWorkspace("branch:feat", "workspace");
      expect(count).to.equal(1);

      // Every promoted entityId must resolve in the workspace graph
      const wsEntries = await store.loadEntries("workspace");
      const wsGraph = await store.loadGraph("workspace");
      expect(wsGraph, "workspace graph missing after promotion").to.not.be.null;

      const wsEntityIds = new Set(wsGraph!.entities.map((e) => e.id));
      for (const id of wsEntries[0].entityIds) {
        expect(wsEntityIds.has(id), `dangling entityId ${id} after promotion`).to.be.true;
      }
      expect(wsGraph!.entities.map((e) => e.name)).to.have.members(["ServiceA", "ServiceB"]);
      expect(wsGraph!.entities.every((e) => e.scope === "workspace")).to.be.true;
      expect(wsGraph!.relationships).to.have.lengthOf(1);
      expect(wsGraph!.relationships[0].type).to.equal("depends_on");
    });

    it("should remap entity IDs onto existing workspace entities (name+type dedup)", async function () {
      // Workspace already knows "ServiceA" (concept)
      const wsEntity = createTestEntity({ name: "ServiceA", scope: "workspace" });
      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");

      const branchEntity = createTestEntity({ name: "servicea", scope: "branch", branch: "feat" });
      const entry = createTestEntry({
        content: "branch memory about ServiceA",
        scope: "branch",
        branch: "feat",
        entityIds: [branchEntity.id],
      });
      branchEntity.sourceMemoryIds = [entry.id];

      await store.saveEntries([entry], "branch", "feat");
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat");

      await linker.promoteToWorkspace("branch:feat", "workspace");

      const wsGraph = await store.loadGraph("workspace");
      // No duplicate entity created — branch ID remapped onto the workspace one
      expect(wsGraph!.entities).to.have.lengthOf(1);
      expect(wsGraph!.entities[0].id).to.equal(wsEntity.id);
      // The workspace entity gained the promoted entry as a source
      expect(wsGraph!.entities[0].sourceMemoryIds).to.include(entry.id);

      const wsEntries = await store.loadEntries("workspace");
      expect(wsEntries[0].entityIds).to.deep.equal([wsEntity.id]);
    });
  });

  // ── findLinkedEntities ─────────────────────────────────────────────

  describe("findLinkedEntities", function () {
    it("should find matching entities across all scopes", async function () {
      const wsEntity = createTestEntity({ name: "React", type: "tool", scope: "workspace" });
      const branchEntity = createTestEntity({
        name: "react",
        type: "tool",
        scope: "branch",
        branch: "feat",
      });

      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat");

      const results = await linker.findLinkedEntities("React", "tool");
      expect(results).to.have.lengthOf(2);

      const scopes = results.map((r) => r.scope).sort();
      expect(scopes).to.deep.equal(["branch:feat", "workspace"]);
    });

    it("should respect excludeScope parameter", async function () {
      const wsEntity = createTestEntity({ name: "React", type: "tool", scope: "workspace" });
      const branchEntity = createTestEntity({
        name: "react",
        type: "tool",
        scope: "branch",
        branch: "feat",
      });

      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");
      await store.saveGraph({ entities: [branchEntity], relationships: [] }, "branch", "feat");

      const results = await linker.findLinkedEntities("React", "tool", "workspace");
      expect(results).to.have.lengthOf(1);
      expect(results[0].scope).to.equal("branch:feat");
    });

    it("should return empty when no matching entities exist", async function () {
      const wsEntity = createTestEntity({ name: "Vue", type: "tool", scope: "workspace" });
      await store.saveGraph({ entities: [wsEntity], relationships: [] }, "workspace");

      const results = await linker.findLinkedEntities("Angular", "tool");
      expect(results).to.have.lengthOf(0);
    });

    it("should match case-insensitively on entity name", async function () {
      const entity = createTestEntity({ name: "TYPESCRIPT", type: "tool", scope: "workspace" });
      await store.saveGraph({ entities: [entity], relationships: [] }, "workspace");

      const results = await linker.findLinkedEntities("typescript", "tool");
      expect(results).to.have.lengthOf(1);
      expect(results[0].entity.name).to.equal("TYPESCRIPT");
    });
  });
});
