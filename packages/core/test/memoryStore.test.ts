import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemoryStore, MemoryStoreOptions } from "../src/memory/memoryStore";
import { EmbeddingService } from "../src/embeddings/embeddingService";

// ── Mock Embedding Service ───────────────────────────────────────────
// Returns a deterministic 32-dim vector derived from a simple text hash.
// Identical texts always produce the same vector.

const VECTOR_DIM = 32;

function textToVector(text: string): number[] {
  const hash = crypto.createHash("sha256").update(text).digest();
  const vec = new Array<number>(VECTOR_DIM);
  for (let i = 0; i < VECTOR_DIM; i++) {
    vec[i] = (hash[i % hash.length] - 128) / 128;
  }
  // Normalize to unit vector for cosine similarity
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

function createMockEmbeddingService(): EmbeddingService {
  const mock = {
    embed: async (text: string): Promise<number[]> => textToVector(text),
    embedBatch: async (texts: string[]): Promise<number[][]> => texts.map(textToVector),
  } as unknown as EmbeddingService;
  return mock;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryStore", function () {
  this.timeout(30000);

  let store: MemoryStore;
  let tempDir: string;

  before(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-test-"));
    const options: MemoryStoreOptions = {
      storageDir: tempDir,
      embeddingService: createMockEmbeddingService(),
      // No llmProvider — tests graceful degradation
      workingDir: tempDir, // Not a git repo → branch detection returns null
      markdownPath: null,
    };
    store = new MemoryStore(options);
  });

  after(async function () {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── 1. Store workspace memory ──────────────────────────────────────

  it("should store a workspace memory with vector", async function () {
    const entry = await store.store({ content: "TypeScript is preferred over JavaScript" });

    expect(entry).to.have.property("id").that.is.a("string");
    expect(entry.content).to.equal("TypeScript is preferred over JavaScript");
    expect(entry.scope).to.equal("workspace");
    expect(entry.branch).to.be.undefined;
    expect(entry.vector).to.be.an("array").with.lengthOf(VECTOR_DIM);
    expect(entry.createdAt).to.be.a("number");
    expect(entry.updatedAt).to.be.a("number");
    expect(entry.tags).to.deep.equal([]);
    expect(entry.entityIds).to.deep.equal([]);
  });

  // ── 2. Store branch memory ─────────────────────────────────────────

  it("should store a branch-scoped memory", async function () {
    const entry = await store.store({
      content: "Feature branch uses new API pattern",
      scope: "branch",
      branch: "feature/new-api",
      tags: ["api"],
    });

    expect(entry.scope).to.equal("branch");
    expect(entry.branch).to.equal("feature/new-api");
    expect(entry.tags).to.deep.equal(["api"]);
    expect(entry.vector).to.be.an("array").with.lengthOf(VECTOR_DIM);
  });

  // ── 3. Store duplicate → update existing entry ─────────────────────

  it("should update existing entry on duplicate content", async function () {
    const original = await store.store({ content: "exact duplicate test content abc123" });
    const duplicate = await store.store({ content: "exact duplicate test content abc123", tags: ["new-tag"] });

    // Versioning: duplicate creates a new entry that supersedes the original
    expect(duplicate.id).to.not.equal(original.id);
    expect(duplicate.tags).to.include("new-tag");
    expect(duplicate.isLatest).to.equal(true);
    expect(duplicate.previousVersionId).to.equal(original.id);
    expect(duplicate.version).to.equal(2);
    // updatedAt should be bumped
    expect(duplicate.updatedAt).to.be.greaterThanOrEqual(original.updatedAt);

    // Original should be marked as superseded
    const all = await store.list({ scope: "workspace", includeSuperseded: true });
    const origEntry = all.find((e) => e.id === original.id);
    expect(origEntry).to.not.be.undefined;
    expect(origEntry!.isLatest).to.equal(false);
    expect(origEntry!.supersededBy).to.equal(duplicate.id);
  });

  // ── 4. Recall workspace → vector similarity results ────────────────

  it("should recall memories by vector similarity", async function () {
    // Store a few distinct memories
    await store.store({ content: "We use React for the frontend framework" });
    await store.store({ content: "Database migrations run with Prisma" });
    await store.store({ content: "CI pipeline deploys to AWS" });

    const result = await store.recall({
      query: "What frontend framework do we use?",
      scope: "workspace",
    });

    expect(result.memories).to.be.an("array");
    expect(result.memories.length).to.be.greaterThan(0);
    // Each result should have an entry and a score
    for (const m of result.memories) {
      expect(m.entry).to.have.property("content");
      expect(m.score).to.be.a("number");
    }
  });

  // ── 5. Forget by ID ───────────────────────────────────────────────

  it("should forget a memory by ID", async function () {
    const entry = await store.store({ content: "temporary memory to be forgotten" });

    const removed = await store.forget({ id: entry.id });
    expect(removed).to.equal(1);

    // Verify it's no longer in list results
    const listed = await store.list({ scope: "workspace" });
    const found = listed.find((e) => e.id === entry.id);
    expect(found).to.be.undefined;
  });

  // ── 6. Stats ───────────────────────────────────────────────────────

  it("should return accurate stats", async function () {
    const stats = await store.stats();

    expect(stats.totalMemories).to.be.a("number").and.be.greaterThan(0);
    expect(stats.byScope).to.have.property("workspace").that.is.a("number");
    expect(stats.byScope).to.have.property("branch").that.is.a("number");
    expect(stats.branches).to.be.an("array");
    // Branch names round-trip: table names use reversible base64url encoding
    expect(stats.branches).to.include("feature/new-api");
    expect(stats.totalEntities).to.equal(0); // No LLM → no entities
    expect(stats.totalRelationships).to.equal(0);
    expect(stats.lastUpdated).to.be.a("number").and.be.greaterThan(0);
  });

  // ── 7. List → filtered results ─────────────────────────────────────

  it("should list workspace memories", async function () {
    const entries = await store.list({ scope: "workspace" });
    expect(entries).to.be.an("array");
    for (const e of entries) {
      expect(e.scope).to.equal("workspace");
    }
  });

  it("should list branch memories filtered by branch name", async function () {
    const entries = await store.list({ scope: "branch", branch: "feature/new-api" });
    expect(entries).to.be.an("array");
    expect(entries.length).to.be.greaterThan(0);
    for (const e of entries) {
      expect(e.scope).to.equal("branch");
      expect(e.branch).to.equal("feature/new-api");
    }
  });

  it("should respect limit parameter", async function () {
    const entries = await store.list({ limit: 2 });
    expect(entries.length).to.be.at.most(2);
  });

  // ── 8. Store without LLM → entities empty (graceful degradation) ──

  it("should store memory with empty entities when no LLM provided", async function () {
    const entry = await store.store({
      content: "Python 3.12 has improved error messages",
    });

    expect(entry.entityIds).to.deep.equal([]);

    const stats = await store.stats();
    expect(stats.totalEntities).to.equal(0);
  });

  // ── 9. Branch detection fallback to workspace ──────────────────────

  it("should fall back to workspace when branch scope requested but no branch available", async function () {
    // Request branch scope without specifying a branch,
    // and workingDir is undefined → no git detection → falls back to workspace.
    const entry = await store.store({
      content: "Fallback test — no branch available",
      scope: "branch",
      // branch: undefined → triggers detection → fails → workspace fallback
    });

    expect(entry.scope).to.equal("workspace");
    expect(entry.branch).to.be.undefined;
  });
});

// ── Restart persistence (regression: forgetting the last memory must survive restart) ──

describe("MemoryStore restart persistence", function () {
  this.timeout(30000);

  let tempDir: string;

  const makeStore = () =>
    new MemoryStore({
      storageDir: tempDir,
      embeddingService: createMockEmbeddingService(),
      workingDir: tempDir,
      markdownPath: null,
    });

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-restart-test-"));
  });

  afterEach(async function () {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("forgetting the last entry in a scope survives a restart", async function () {
    const first = makeStore();
    const entry = await first.store({ content: "the only memory in this scope" });
    expect(await first.forget({ id: entry.id })).to.equal(1);
    expect(await first.list({ scope: "workspace" })).to.deep.equal([]);

    // Fresh store over the same storage dir = process restart
    const second = makeStore();
    const listed = await second.list({ scope: "workspace" });
    expect(listed, "forgotten memory resurrected after restart").to.deep.equal([]);

    const recalled = await second.recall({ query: "the only memory", scope: "workspace" });
    expect(recalled.memories).to.deep.equal([]);
  });

  it("forgetting one of several entries persists the remaining set across restart", async function () {
    const first = makeStore();
    const keep = await first.store({ content: "memory that stays" });
    const drop = await first.store({ content: "memory that goes away entirely" });
    expect(await first.forget({ id: drop.id })).to.equal(1);

    const second = makeStore();
    const listed = await second.list({ scope: "workspace" });
    expect(listed.map((e) => e.id)).to.deep.equal([keep.id]);
  });
});
