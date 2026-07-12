import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemoryStore, MemoryStoreOptions } from "../src/memory/memoryStore";
import { EmbeddingService } from "../src/embeddings/embeddingService";
import type { EmbeddingFingerprint } from "../src/embeddings/embeddingBackend";

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

function createFingerprintedEmbeddingService(fingerprint: EmbeddingFingerprint): EmbeddingService {
  return {
    embed: async (text: string, signal?: AbortSignal): Promise<number[]> => {
      signal?.throwIfAborted();
      return textToVector(text);
    },
    embedBatch: async (texts: string[], _progress?: unknown, signal?: AbortSignal): Promise<number[][]> => {
      signal?.throwIfAborted();
      return texts.map(textToVector);
    },
    getFingerprint: async (signal?: AbortSignal): Promise<EmbeddingFingerprint> => {
      signal?.throwIfAborted();
      return fingerprint;
    },
  } as unknown as EmbeddingService;
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  let captured: unknown;
  try {
    await operation;
  } catch (error) {
    captured = error;
  }
  if (captured === undefined) {
    throw new Error("Expected operation to reject");
  }
  return captured;
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

  it("a failed persist surfaces the error and rolls the cache back to disk truth", async function () {
    const store = makeStore();
    const kept = await store.store({ content: "persisted before the failure" });

    // Inject a one-shot persistence failure at the vector-store boundary.
    const vectorStore = (store as any).vectorStore;
    const originalSave = vectorStore.saveEntries.bind(vectorStore);
    vectorStore.saveEntries = async () => {
      vectorStore.saveEntries = originalSave;
      throw new Error("simulated LanceDB write failure");
    };

    let caught: unknown;
    try {
      await store.store({ content: "entry whose persist fails" });
    } catch (error) {
      caught = error;
    }
    expect(caught, "persist failure must surface to the caller").to.be.instanceOf(Error);

    // The optimistic cache entry must not survive: the SAME instance reloads
    // disk truth on next access instead of reporting a phantom success.
    const listed = await store.list({ scope: "workspace" });
    expect(listed.map((e) => e.id)).to.deep.equal([kept.id]);

    // And the store keeps working normally once persistence recovers.
    const after = await store.store({ content: "entry stored after recovery" });
    const relisted = await store.list({ scope: "workspace" });
    expect(relisted.map((e) => e.id).sort()).to.deep.equal([kept.id, after.id].sort());
  });
});

// ── Concurrency (single instance, interleaved operations) ────────────

describe("MemoryStore concurrent operations", function () {
  this.timeout(60000);

  let tempDir: string;
  let store: MemoryStore;

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-concurrent-test-"));
    store = new MemoryStore({
      storageDir: tempDir,
      embeddingService: createMockEmbeddingService(),
      workingDir: tempDir,
      markdownPath: null,
    });
  });

  afterEach(async function () {
    await store.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("handles concurrent stores into one scope without losing entries", async function () {
    const contents = Array.from({ length: 8 }, (_, i) => `concurrent workspace memory number ${i}`);
    await Promise.all(contents.map((content) => store.store({ content })));

    const listed = await store.list({ scope: "workspace", limit: 100 });
    expect(listed.map((e) => e.content).sort()).to.deep.equal([...contents].sort());
  });

  it("handles concurrent store/recall/forget across scopes without rejections", async function () {
    const seeded = await store.store({ content: "seed memory for concurrent mix" });

    const operations: Array<Promise<unknown>> = [
      store.store({ content: "mixed op one" }),
      store.store({ content: "branch op", scope: "branch", branch: "feat/concurrent" }),
      store.recall({ query: "seed memory", scope: "workspace" }),
      store.forget({ id: seeded.id }),
      store.recall({ query: "mixed", scope: "workspace" }),
    ];

    // Every operation must settle without throwing; interleaving must not
    // corrupt either scope.
    await Promise.all(operations);

    const workspace = await store.list({ scope: "workspace", limit: 100 });
    expect(
      workspace.some((e) => e.id === seeded.id),
      "forgotten entry survived",
    ).to.equal(false);
    expect(workspace.some((e) => e.content === "mixed op one")).to.equal(true);

    const branch = await store.list({ scope: "branch", branch: "feat/concurrent", limit: 100 });
    expect(branch.map((e) => e.content)).to.deep.equal(["branch op"]);
  });
});

describe("MemoryStore release contracts", function () {
  this.timeout(30000);

  let tempDir: string;
  const stores: MemoryStore[] = [];

  const makeStore = (embeddingService: EmbeddingService = createMockEmbeddingService()) => {
    const result = new MemoryStore({
      storageDir: tempDir,
      embeddingService,
      workingDir: tempDir,
      markdownPath: null,
    });
    stores.push(result);
    return result;
  };

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-contract-test-"));
  });

  afterEach(async function () {
    for (const current of stores.splice(0)) {
      await current.dispose();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("hides reserved auto memories unless includeAuto is explicit", async function () {
    const current = makeStore();
    const automatic = await current.store({
      content: "automatic query insight with a unique violet almanac",
      tags: ["auto:query-insight"],
    });

    expect((await current.list({ scope: "workspace" })).map((entry) => entry.id)).to.not.include(automatic.id);
    expect((await current.list({ scope: "workspace", includeAuto: true })).map((entry) => entry.id)).to.include(
      automatic.id,
    );
    expect(
      (await current.recall({ query: automatic.content, scope: "workspace", reinforce: false })).memories,
    ).to.deep.equal([]);
    expect(
      (
        await current.recall({
          query: automatic.content,
          scope: "workspace",
          includeAuto: true,
          reinforce: false,
        })
      ).memories.map(({ entry }) => entry.id),
    ).to.include(automatic.id);
  });

  it("persists expiresAt and excludes then purges expired TTL memories after restart", async function () {
    const first = makeStore();
    const entry = await first.store({ content: "short lived memory", ttlDays: 0.00000001 });
    expect(entry.expiresAt).to.be.a("number");
    await first.dispose();
    stores.splice(stores.indexOf(first), 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = makeStore();
    const recalled = await second.recall({ query: entry.content, scope: "workspace", reinforce: false });
    expect(recalled.memories).to.deep.equal([]);
    expect(await second.forget({ scope: "workspace", expired: true })).to.equal(1);
  });

  it("rejects a same-dimension embedding fingerprint change", async function () {
    const original: EmbeddingFingerprint = {
      backendKind: "remote",
      providerFormat: "openai",
      model: "model-a",
      revision: "1",
      dimension: VECTOR_DIM,
      endpointHash: "endpoint-a",
    };
    const incompatible: EmbeddingFingerprint = {
      ...original,
      providerFormat: "ollama",
      model: "model-b",
      endpointHash: "endpoint-b",
    };

    const first = makeStore(createFingerprintedEmbeddingService(original));
    await first.store({ content: "fingerprinted memory" });
    await first.dispose();
    stores.splice(stores.indexOf(first), 1);

    const second = makeStore(createFingerprintedEmbeddingService(incompatible));
    const error = await captureError(second.validateEmbeddingFingerprint());
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include("Memory embedding fingerprint mismatch");
  });

  it("does not persist a memory when cancellation is already requested", async function () {
    const current = makeStore();
    const controller = new AbortController();
    controller.abort(new Error("cancel memory store"));

    const error = await captureError(current.store({ content: "must never be written", signal: controller.signal }));
    expect(error).to.be.instanceOf(Error);
    expect(await current.list({ scope: "workspace", includeAuto: true })).to.deep.equal([]);
  });
});
