import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemoryVectorStore } from "../src/memory/memoryVectorStore";
import { MemoryEntry, MemoryEntity, MemoryGraphData, MemoryScope } from "../src/memory/types";

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

describe("MemoryVectorStore", function () {
  this.timeout(30000);

  let store: MemoryVectorStore;
  let tempDir: string;

  before(async function () {
    tempDir = path.join(os.tmpdir(), `memvs-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new MemoryVectorStore(path.join(tempDir, "test-memory-lancedb"));
  });

  after(async function () {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── Entry Operations ───────────────────────────────────────────────

  describe("Entry operations", function () {
    it("should round-trip saveEntries + loadEntries for workspace scope", async function () {
      const entries = [
        createTestEntry({ content: "workspace fact one", tags: ["tag1"] }),
        createTestEntry({ content: "workspace fact two", metadata: { key: "val" } }),
      ];

      await store.saveEntries(entries, "workspace");
      const loaded = await store.loadEntries("workspace");

      expect(loaded).to.have.lengthOf(2);
      const ids = loaded.map((e) => e.id);
      expect(ids).to.include(entries[0].id);
      expect(ids).to.include(entries[1].id);

      const first = loaded.find((e) => e.id === entries[0].id)!;
      expect(first.content).to.equal("workspace fact one");
      expect(first.scope).to.equal("workspace");
      expect(first.tags).to.deep.equal(["tag1"]);
      // LanceDB returns vectors as Float32Array-like objects
      expect(Array.from(first.vector)).to.have.lengthOf(VECTOR_DIM);

      const second = loaded.find((e) => e.id === entries[1].id)!;
      expect(second.metadata).to.deep.equal({ key: "val" });
    });

    it("should round-trip saveEntries + loadEntries for branch scope", async function () {
      const entries = [
        createTestEntry({
          content: "branch-specific memory",
          scope: "branch",
          branch: "feature/login",
        }),
      ];

      await store.saveEntries(entries, "branch", "feature/login");
      const loaded = await store.loadEntries("branch", "feature/login");

      expect(loaded).to.have.lengthOf(1);
      expect(loaded[0].content).to.equal("branch-specific memory");
      expect(loaded[0].scope).to.equal("branch");
    });

    it("should return results ranked by similarity from searchEntries", async function () {
      // Create entries with known vectors: one close to query, one far
      const baseVec = randomVector();
      const closeVec = baseVec.map((v) => v + (Math.random() * 0.01 - 0.005));
      const farVec = baseVec.map((v) => -v); // opposite direction

      // Normalize
      for (const vec of [closeVec, farVec]) {
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        for (let i = 0; i < vec.length; i++) { vec[i] /= norm; }
      }

      const entries = [
        createTestEntry({ content: "close match", vector: closeVec, scope: "workspace" }),
        createTestEntry({ content: "far match", vector: farVec, scope: "workspace" }),
      ];

      await store.saveEntries(entries, "workspace");
      const results = await store.searchEntries(baseVec, "workspace", undefined, 2);

      expect(results).to.have.lengthOf(2);
      expect(results[0].score).to.be.greaterThan(results[1].score);
      expect(results[0].entry.content).to.equal("close match");
      expect(results[0].score).to.be.a("number");
    });

    it("should scope searchEntries to the correct table", async function () {
      const vec = randomVector();
      const wsEntry = createTestEntry({ content: "workspace entry for search", vector: vec, scope: "workspace" });
      const brEntry = createTestEntry({
        content: "branch entry for search",
        vector: vec,
        scope: "branch",
        branch: "search-branch",
      });

      await store.saveEntries([wsEntry], "workspace");
      await store.saveEntries([brEntry], "branch", "search-branch");

      const wsResults = await store.searchEntries(vec, "workspace", undefined, 10);
      const brResults = await store.searchEntries(vec, "branch", "search-branch", 10);

      const wsIds = wsResults.map((r) => r.entry.id);
      const brIds = brResults.map((r) => r.entry.id);

      expect(wsIds).to.include(wsEntry.id);
      expect(wsIds).to.not.include(brEntry.id);
      expect(brIds).to.include(brEntry.id);
      expect(brIds).to.not.include(wsEntry.id);
    });

    it("should return empty array for loadEntries on nonexistent table", async function () {
      const loaded = await store.loadEntries("branch", "nonexistent-branch-xyz");
      expect(loaded).to.deep.equal([]);
    });

    it("should not let superseded versions crowd current memories out of the top-K", async function () {
      const dir = path.join(tempDir, "crowd-out-test");
      await fs.mkdir(dir, { recursive: true });
      const s = new MemoryVectorStore(dir);

      const queryVec = randomVector();

      // 5 superseded historical versions sitting exactly on the query vector…
      const superseded = Array.from({ length: 5 }, (_, i) =>
        createTestEntry({
          content: `historical version ${i}`,
          vector: [...queryVec],
          isLatest: false,
          supersededBy: "someone-newer",
        }),
      );
      // …and one current entry slightly farther away
      const currentVec = queryVec.map((v) => v + (Math.random() * 0.02 - 0.01));
      const current = createTestEntry({ content: "the current version", vector: currentVec, isLatest: true });

      await s.saveEntries([...superseded, current], "workspace");

      // topK smaller than the number of closer historical rows: the filter
      // must be applied BEFORE the limit or the current entry is crowded out
      const results = await s.searchEntries(queryVec, "workspace", undefined, 3);

      expect(results.length).to.be.greaterThan(0);
      expect(results.every(({ entry }) => entry.isLatest !== false)).to.be.true;
      expect(results.map(({ entry }) => entry.id)).to.include(current.id);
    });
  });

  // ── Graph Operations ───────────────────────────────────────────────

  describe("Graph operations", function () {
    it("should round-trip saveGraph + loadGraph with entities and edges", async function () {
      const entity1 = createTestEntity({ name: "TypeScript", type: "concept" });
      const entity2 = createTestEntity({ name: "ESLint", type: "tool" });

      const graph: MemoryGraphData = {
        entities: [entity1, entity2],
        relationships: [
          {
            id: crypto.randomUUID(),
            sourceId: entity1.id,
            targetId: entity2.id,
            type: "uses",
            description: "TypeScript uses ESLint",
            weight: 0.8,
            scope: "workspace",
            metadata: {},
          },
        ],
      };

      await store.saveGraph(graph, "workspace");
      const loaded = await store.loadGraph("workspace");

      expect(loaded).to.not.be.null;
      expect(loaded!.entities).to.have.lengthOf(2);
      expect(loaded!.relationships).to.have.lengthOf(1);

      const names = loaded!.entities.map((e) => e.name);
      expect(names).to.include("TypeScript");
      expect(names).to.include("ESLint");

      const edge = loaded!.relationships[0];
      expect(edge.type).to.equal("uses");
      expect(edge.description).to.equal("TypeScript uses ESLint");
      expect(edge.weight).to.equal(0.8);
    });

    it("should return null for loadGraph on nonexistent graph", async function () {
      const loaded = await store.loadGraph("branch", "no-such-branch-graph");
      expect(loaded).to.be.null;
    });

    it("should handle saveGraph with empty graph (no entities or edges)", async function () {
      const emptyGraph: MemoryGraphData = { entities: [], relationships: [] };
      await store.saveGraph(emptyGraph, "branch", "empty-graph-branch");

      const loaded = await store.loadGraph("branch", "empty-graph-branch");
      expect(loaded).to.be.null;
    });
  });

  // ── Empty-collection persistence (regression: deletions must survive reload) ──

  describe("Empty-collection persistence", function () {
    it("saveEntries with an empty array drops the stale table so deletion survives reload", async function () {
      const dir = path.join(tempDir, "empty-entries-test");
      await fs.mkdir(dir, { recursive: true });
      const s = new MemoryVectorStore(dir);

      await s.saveEntries([createTestEntry({ content: "to be forgotten" })], "workspace");
      expect(await s.loadEntries("workspace")).to.have.lengthOf(1);

      // Forget the last entry → persist the now-empty collection
      await s.saveEntries([], "workspace");

      // Same instance sees it gone…
      expect(await s.loadEntries("workspace")).to.deep.equal([]);

      // …and a fresh instance (simulated restart) must NOT resurrect it
      const reloaded = new MemoryVectorStore(dir);
      expect(await reloaded.loadEntries("workspace")).to.deep.equal([]);
    });

    it("saveGraph with emptied entities drops the stale entity table", async function () {
      const dir = path.join(tempDir, "empty-entities-test");
      await fs.mkdir(dir, { recursive: true });
      const s = new MemoryVectorStore(dir);

      await s.saveGraph({ entities: [createTestEntity()], relationships: [] }, "workspace");
      expect((await s.loadGraph("workspace"))!.entities).to.have.lengthOf(1);

      await s.saveGraph({ entities: [], relationships: [] }, "workspace");

      const reloaded = new MemoryVectorStore(dir);
      expect(await reloaded.loadGraph("workspace")).to.be.null;
    });

    it("saveGraph with emptied edges drops the stale edge table while keeping entities", async function () {
      const dir = path.join(tempDir, "empty-edges-test");
      await fs.mkdir(dir, { recursive: true });
      const s = new MemoryVectorStore(dir);

      const e1 = createTestEntity({ name: "A" });
      const e2 = createTestEntity({ name: "B" });
      await s.saveGraph(
        {
          entities: [e1, e2],
          relationships: [
            {
              id: crypto.randomUUID(),
              sourceId: e1.id,
              targetId: e2.id,
              type: "related_to",
              description: "A related to B",
              weight: 1,
              scope: "workspace",
              metadata: {},
            },
          ],
        },
        "workspace",
      );
      expect((await s.loadGraph("workspace"))!.relationships).to.have.lengthOf(1);

      await s.saveGraph({ entities: [e1, e2], relationships: [] }, "workspace");

      const reloaded = new MemoryVectorStore(dir);
      const loaded = await reloaded.loadGraph("workspace");
      expect(loaded).to.not.be.null;
      expect(loaded!.entities).to.have.lengthOf(2);
      expect(loaded!.relationships).to.deep.equal([]);
    });
  });

  // ── Deletion ───────────────────────────────────────────────────────

  describe("Deletion", function () {
    it("should remove only that branch's data with deleteBranchMemories", async function () {
      const branchA = "delete-test-a";
      const branchB = "delete-test-b";

      await store.saveEntries([createTestEntry({ scope: "branch", branch: branchA })], "branch", branchA);
      await store.saveEntries([createTestEntry({ scope: "branch", branch: branchB })], "branch", branchB);

      // Verify both exist
      expect(await store.loadEntries("branch", branchA)).to.have.lengthOf(1);
      expect(await store.loadEntries("branch", branchB)).to.have.lengthOf(1);

      await store.deleteBranchMemories(branchA);

      // Branch A gone, branch B still present
      expect(await store.loadEntries("branch", branchA)).to.deep.equal([]);
      expect(await store.loadEntries("branch", branchB)).to.have.lengthOf(1);
    });

    it("should remove all tables with deleteAll", async function () {
      // Use a fresh store to avoid interference
      const freshDir = path.join(tempDir, "delete-all-test");
      await fs.mkdir(freshDir, { recursive: true });
      const freshStore = new MemoryVectorStore(freshDir);

      await freshStore.saveEntries([createTestEntry()], "workspace");
      await freshStore.saveEntries(
        [createTestEntry({ scope: "branch", branch: "del-branch" })],
        "branch",
        "del-branch",
      );
      await freshStore.saveGraph(
        { entities: [createTestEntity()], relationships: [] },
        "workspace",
      );

      // Verify data exists
      expect(await freshStore.loadEntries("workspace")).to.have.length.greaterThan(0);

      await freshStore.deleteAll();

      expect(await freshStore.loadEntries("workspace")).to.deep.equal([]);
      expect(await freshStore.loadEntries("branch", "del-branch")).to.deep.equal([]);
      expect(await freshStore.loadGraph("workspace")).to.be.null;
    });
  });

  // ── Branch Listing ─────────────────────────────────────────────────

  describe("Branch listing", function () {
    it("should return all branch keys from listBranches", async function () {
      const listDir = path.join(tempDir, "list-branches-test");
      await fs.mkdir(listDir, { recursive: true });
      const listStore = new MemoryVectorStore(listDir);

      await listStore.saveEntries(
        [createTestEntry({ scope: "branch", branch: "main" })],
        "branch",
        "main",
      );
      await listStore.saveEntries(
        [createTestEntry({ scope: "branch", branch: "develop" })],
        "branch",
        "develop",
      );
      // Workspace entries should not appear in branch list
      await listStore.saveEntries([createTestEntry()], "workspace");

      const branches = await listStore.listBranches();
      expect(branches).to.include("main");
      expect(branches).to.include("develop");
      expect(branches).to.have.lengthOf(2);
    });
  });

  // ── Table Naming / Branch Encoding ─────────────────────────────────

  describe("Table naming", function () {
    it("should round-trip branch names with special characters", async function () {
      const encodeDir = path.join(tempDir, "encode-test");
      await fs.mkdir(encodeDir, { recursive: true });
      const encodeStore = new MemoryVectorStore(encodeDir);

      const specialBranch = "feature/my.branch name";
      const entry = createTestEntry({ scope: "branch", branch: specialBranch });

      await encodeStore.saveEntries([entry], "branch", specialBranch);
      const loaded = await encodeStore.loadEntries("branch", specialBranch);

      expect(loaded).to.have.lengthOf(1);
      expect(loaded[0].id).to.equal(entry.id);

      // listBranches returns the ORIGINAL branch name (base64url round-trip)
      const branches = await encodeStore.listBranches();
      expect(branches).to.have.lengthOf(1);
      expect(branches[0]).to.equal(specialBranch);
    });

    it("should keep similarly-named branches in separate tables (no collisions)", async function () {
      // Lossy sanitization used to map all of these onto the same table,
      // leaking/overwriting memory across branches.
      const collideDir = path.join(tempDir, "collide-test");
      await fs.mkdir(collideDir, { recursive: true });
      const s = new MemoryVectorStore(collideDir);

      const slash = createTestEntry({ scope: "branch", branch: "feature/foo", content: "slash" });
      const underscore = createTestEntry({ scope: "branch", branch: "feature_foo", content: "underscore" });
      const at = createTestEntry({ scope: "branch", branch: "feature@foo", content: "at" });

      await s.saveEntries([slash], "branch", "feature/foo");
      await s.saveEntries([underscore], "branch", "feature_foo");
      await s.saveEntries([at], "branch", "feature@foo");

      const slashLoaded = await s.loadEntries("branch", "feature/foo");
      const underscoreLoaded = await s.loadEntries("branch", "feature_foo");
      const atLoaded = await s.loadEntries("branch", "feature@foo");

      expect(slashLoaded.map((e) => e.content)).to.deep.equal(["slash"]);
      expect(underscoreLoaded.map((e) => e.content)).to.deep.equal(["underscore"]);
      expect(atLoaded.map((e) => e.content)).to.deep.equal(["at"]);

      const branches = await s.listBranches();
      expect(branches).to.have.members(["feature/foo", "feature_foo", "feature@foo"]);

      // Deleting one branch must not touch the others
      await s.deleteBranchMemories("feature/foo");
      expect(await s.loadEntries("branch", "feature/foo")).to.deep.equal([]);
      expect(await s.loadEntries("branch", "feature_foo")).to.have.lengthOf(1);
      expect(await s.loadEntries("branch", "feature@foo")).to.have.lengthOf(1);
    });
  });
});
