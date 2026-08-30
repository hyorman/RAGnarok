/**
 * MemoryStore — Main orchestrator for the standalone memory module.
 *
 * Coordinates:
 * - MemoryVectorStore (LanceDB persistence)
 * - MemoryGraph (graphology entity graph, one per scope partition)
 * - MemoryEntityExtractor (LLM entity extraction)
 * - MemoryMarkdownExporter (memories.md generation)
 * - GitBranchDetector (auto branch detection)
 */

import * as crypto from "crypto";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { Mutex } from "async-mutex";
import { EmbeddingService } from "../embeddings/embeddingService";
import { ILLMProvider } from "../interfaces";
import { Logger } from "../logger";
import {
  MemoryEntry,
  MemoryEntity,
  MemoryScope,
  MemoryStats,
  MemoryGraphSnapshot,
  StoreOptions,
  RecallOptions,
  RecallResult,
  ForgetOptions,
  DecayStatus,
  ScopeLink,
  DUPLICATE_SIMILARITY_THRESHOLD,
  DEFAULT_TOP_K,
} from "./types";
import { MemoryVectorStore } from "./memoryVectorStore";
import { MemoryGraph } from "./memoryGraph";
import { MemoryEntityExtractor } from "./memoryEntityExtractor";
import { MemoryMarkdownExporter } from "./memoryMarkdownExporter";
import { GitBranchDetector } from "./gitBranchDetector";
import { MemoryDecayEngine } from "./memoryDecayEngine";
import { MemoryScopeLinker } from "./memoryScopeLinker";
import { cosineSimilarity } from "../utils/vectorMath";
import { atomicWriteFile, atomicWriteJson, ensureStorageFormatV2, inspectStorage } from "../utils/storageV2";
import { acquireOperationLease, StorageBusyError } from "../utils/storageLock";
import type { StorageLockHandle } from "../utils/storageLock";
import type { EmbeddingFingerprint } from "../embeddings/embeddingBackend";

/** The two storage-dir files whose replacement signals a foreign memory write. */
const MEMORY_MANIFEST_FILENAME = "memory-manifest.json";
const MEMORIES_MARKDOWN_FILENAME = "memories.md";
const MEMORY_WATCH_DEBOUNCE_MS = 250;
/** How long a mutation waits for a foreign writer before reporting StorageBusyError. */
const MUTATION_LEASE_WAIT_MS = 5_000;

export interface MemoryStoreOptions {
  /** LanceDB storage directory */
  storageDir: string;
  /** Embedding service for vectorizing memories */
  embeddingService: EmbeddingService;
  /** LLM provider for entity extraction (optional — graceful degradation) */
  llmProvider?: ILLMProvider;
  /** Working directory for git branch detection */
  workingDir?: string;
  /** Path to write memories.md (null to disable) */
  markdownPath?: string | null;
  /** Decay engine configuration */
  decayOptions?: {
    lambda?: number;
    minConfidence?: number;
    autoDecayIntervalMs?: number;
  };
}

export class MemoryStore {
  private logger = new Logger("MemoryStore");
  private vectorStore: MemoryVectorStore;
  private extractor: MemoryEntityExtractor | null;
  private exporter: MemoryMarkdownExporter;
  private branchDetector: GitBranchDetector;
  private embeddingService: EmbeddingService;
  private markdownPath: string | null;
  private decayEngine: MemoryDecayEngine;
  private scopeLinker: MemoryScopeLinker;
  private autoDecayTimer: ReturnType<typeof setInterval> | null = null;

  // In-memory graph caches (lazy-loaded from LanceDB)
  private graphCache = new Map<string, MemoryGraph>();
  // In-memory entry caches (lazy-loaded from LanceDB)
  private entryCache = new Map<string, MemoryEntry[]>();
  // In-flight cache loads, so concurrent misses share one result
  private graphLoads = new Map<string, Promise<MemoryGraph>>();
  private entryLoads = new Map<string, Promise<MemoryEntry[]>>();

  // Debounced memories.md regeneration: every mutation used to rescan every
  // scope twice (markdown + stats) and rewrite the file, and concurrent
  // fire-and-forget writes could land out of order.
  private markdownDirty = false;
  private markdownFlushing = false;
  private markdownTimer: ReturnType<typeof setTimeout> | null = null;

  // Deferred recall-reinforcement persistence: bumping two counters used to
  // rewrite the entire scope table (all rows + vectors) on every read.
  private reinforcementDirty = new Set<string>();
  private reinforcementTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryManifestPath: string;
  // Both memoise CONFIRMED outcomes only. A read path that deliberately
  // skipped a write (no marker/manifest, no lease) must leave them null so a
  // later mutation still stamps.
  private fingerprintCheck: Promise<void> | null = null;
  private storageReady: Promise<void> | null = null;
  private storageDir: string;
  // Bumped whenever caches are dropped. An in-flight single-flight load that
  // started before the drop must not repopulate the cache with the state it
  // read before: reads are lock-free, so such a load can easily be older than
  // the mutation or foreign write that invalidated it.
  private cacheGeneration = 0;
  // Foreign-change watcher over the storage DIRECTORY (never a file).
  private storageWatcher: fsSync.FSWatcher | null = null;
  private watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherStopped = false;
  private watcherFailureLogged = false;
  // Depth of this store's own operation leases; a watch event that fires while
  // one is open describes our own write, and dropping caches mid-mutation
  // would discard the optimistic in-memory state the mutation is about to
  // persist.
  private activeMutationLeases = 0;
  private backgroundTasks = new Set<Promise<unknown>>();
  // Staged destructive writes must not race stores that captured an older
  // scope snapshot and could otherwise republish deleted entries.
  private mutationMutex = new Mutex();
  private disposing = false;
  private disposed = false;

  constructor(options: MemoryStoreOptions) {
    const lanceDbUri = path.join(options.storageDir, "memory-lancedb");
    this.storageDir = options.storageDir;
    this.vectorStore = new MemoryVectorStore(lanceDbUri);
    this.memoryManifestPath = path.join(options.storageDir, MEMORY_MANIFEST_FILENAME);
    this.embeddingService = options.embeddingService;
    this.extractor = options.llmProvider ? new MemoryEntityExtractor(options.llmProvider) : null;
    this.exporter = new MemoryMarkdownExporter();
    this.branchDetector = new GitBranchDetector(options.workingDir);
    this.markdownPath = options.markdownPath ?? null;
    this.decayEngine = new MemoryDecayEngine(options.decayOptions);
    this.scopeLinker = new MemoryScopeLinker(this.vectorStore);

    if (options.decayOptions?.autoDecayIntervalMs) {
      this.autoDecayTimer = setInterval(() => {
        const task = this.trackBackgroundTask(this.runDecay());
        void task.catch((err) => this.logger.debug("Auto-decay cycle failed", err));
      }, options.decayOptions.autoDecayIntervalMs);
    }
  }

  // ── Store ──────────────────────────────────────────────────────────

  async store(options: StoreOptions): Promise<MemoryEntry> {
    return this.mutationMutex.runExclusive(async () => {
      // Resolved before the lease so the scope whose caches must be dropped is
      // known when the lease opens (and so a branch-detection failure still
      // surfaces without contending for the lease).
      const resolved = await this.resolveBranch(options);
      return this.withMutationLease([this.scopeKey(resolved.scope, resolved.branch)], () =>
        this.storeUnlocked({ ...options, ...resolved }),
      );
    });
  }

  private async storeUnlocked(options: StoreOptions): Promise<MemoryEntry> {
    options.signal?.throwIfAborted();
    await this.ensureEmbeddingFingerprint(true);
    options.signal?.throwIfAborted();
    const { scope, branch } = await this.resolveBranch(options);
    const cacheKey = this.scopeKey(scope, branch);

    // 1. Embed content
    const vector = await this.embeddingService.embed(options.content, options.signal);
    options.signal?.throwIfAborted();

    // 2. Check for duplicate entries
    const entries = await this.getEntries(scope, branch);
    const duplicate = this.findDuplicateEntry(entries, vector);

    let entry: MemoryEntry;
    if (duplicate) {
      // Version chain: mark old entry as superseded, create new version
      const newId = crypto.randomUUID();
      this.logger.debug(`Duplicate detected, superseding ${duplicate.id} with ${newId}`);

      const oldVersion = duplicate.version ?? 1;

      // Create new versioned entry, carrying forward tags and entity associations
      entry = {
        id: newId,
        content: options.content,
        scope,
        branch,
        vector,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        tags: [...new Set([...duplicate.tags, ...(options.tags ?? [])])],
        entityIds: [...duplicate.entityIds],
        metadata: {},
        confidence: 1.0,
        expiresAt: options.ttlDays ? Date.now() + options.ttlDays * 86_400_000 : undefined,
        isLatest: true,
        previousVersionId: duplicate.id,
        version: oldVersion + 1,
      };
    } else {
      // Create new entry
      entry = {
        id: crypto.randomUUID(),
        content: options.content,
        scope,
        branch,
        vector,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        tags: options.tags ?? [],
        entityIds: [],
        metadata: {},
        confidence: 1.0,
        expiresAt: options.ttlDays ? Date.now() + options.ttlDays * 86_400_000 : undefined,
        isLatest: true,
        version: 1,
      };
    }

    // 3. Extract entities (if LLM available)
    const entityIds = await this.extractAndMergeEntities(options.content, entry.id, scope, branch, options.signal);
    entry.entityIds = [...new Set([...entry.entityIds, ...entityIds])];

    // 4. Persist
    options.signal?.throwIfAborted();
    if (duplicate) {
      duplicate.isLatest = false;
      duplicate.supersededBy = entry.id;
      duplicate.updatedAt = Date.now();
      const graph = await this.getGraph(scope, branch);
      for (const entityId of duplicate.entityIds) {
        const entity = graph.getEntity(entityId);
        if (entity) {
          graph.updateEntity(entityId, {
            sourceMemoryIds: [...new Set(entity.sourceMemoryIds.filter((id) => id !== duplicate.id).concat(entry.id))],
            updatedAt: Date.now(),
          });
        }
      }
    }
    entries.push(entry);
    this.entryCache.set(cacheKey, entries);
    await this.persistScopeOrInvalidate(scope, branch);

    // 5. Regenerate markdown (debounced)
    this.scheduleMarkdownRegeneration();

    return entry;
  }

  // ── Recall ─────────────────────────────────────────────────────────

  async recall(options: RecallOptions): Promise<RecallResult> {
    options.signal?.throwIfAborted();
    // Lock-free: recall never takes the write lease, so it can only stamp a
    // missing manifest opportunistically (see ensureEmbeddingFingerprint).
    await this.ensureEmbeddingFingerprint(false);
    const topK = options.topK ?? DEFAULT_TOP_K;
    const queryVector = await this.embeddingService.embed(options.query, options.signal);
    options.signal?.throwIfAborted();

    const allMemories: Array<{ entry: MemoryEntry; score: number }> = [];
    const allEntities: Array<{ entity: MemoryEntity; score: number }> = [];

    // Determine which scopes to search
    const scopes = await this.resolveScopesForRecall(options);

    for (const { scope, branch } of scopes) {
      options.signal?.throwIfAborted();
      // Search entries via vector store
      const graph = await this.getGraph(scope, branch);
      const results = (await this.vectorStore.searchEntries(queryVector, scope, branch, topK * 2))
        .filter(({ entry }) => options.includeAuto || !entry.tags.some((tag) => tag.startsWith("auto:")))
        .filter(({ entry }) => this.decayEngine.isRecallable(entry, graph))
        .map((result) => ({
          ...result,
          score: result.score * this.decayEngine.effectiveConfidence(result.entry, graph),
        }))
        .slice(0, topK);

      // Reinforce accessed memories and return the UPDATED entries so callers
      // see post-increment accessCount/lastAccessedAt (the search results are
      // detached copies read from LanceDB). Persistence is deferred and
      // batched — reads must not rewrite the whole scope table synchronously.
      if (results.length > 0 && options.reinforce !== false) {
        const entries = await this.getEntries(scope, branch);
        for (const result of results) {
          const cached = entries.find((e) => e.id === result.entry.id);
          if (cached) {
            cached.accessCount += 1;
            cached.lastAccessedAt = Date.now();
            result.entry = cached;
          }
        }
        this.scheduleReinforcementFlush(scope, branch);
      }
      allMemories.push(...results);

      // Include graph entities if requested
      if (options.includeEntities) {
        const entityResults = graph.searchByEmbedding(queryVector, topK);
        allEntities.push(...entityResults);

        // Also include entities linked to returned memories
        for (const { entry } of results) {
          for (const entityId of entry.entityIds) {
            const entity = graph.getEntity(entityId);
            if (entity && !allEntities.some((e) => e.entity.id === entity.id)) {
              allEntities.push({ entity, score: 0.5 }); // Default score for linked entities
            }
          }
        }
      }
    }

    // Sort and deduplicate
    allMemories.sort((a, b) => b.score - a.score);
    allEntities.sort((a, b) => b.score - a.score);

    const seenMemoryIds = new Set<string>();
    const uniqueMemories = allMemories.filter(({ entry }) => {
      if (seenMemoryIds.has(entry.id)) {
        return false;
      }
      // Only return latest versions (backward compat: undefined counts as latest)
      if (entry.isLatest === false) {
        return false;
      }
      seenMemoryIds.add(entry.id);
      return true;
    });

    const seenEntityIds = new Set<string>();
    const uniqueEntities = allEntities.filter(({ entity }) => {
      if (seenEntityIds.has(entity.id)) {
        return false;
      }
      seenEntityIds.add(entity.id);
      return true;
    });

    return {
      memories: uniqueMemories.slice(0, topK),
      entities: uniqueEntities.slice(0, topK),
    };
  }

  // ── Forget ─────────────────────────────────────────────────────────

  async forget(options: ForgetOptions, signal?: AbortSignal): Promise<number> {
    // Scope-wide: a forget by id, or by filter without a scope, walks every
    // branch, so every cached scope has to be re-read under the lease.
    return this.mutationMutex.runExclusive(() =>
      this.withMutationLease(null, () => this.forgetUnlocked(options, signal)),
    );
  }

  private async forgetUnlocked(options: ForgetOptions, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    options = await this.validateAndResolveForgetOptions(options);
    signal?.throwIfAborted();
    let count = 0;

    if (options.expired) {
      count += await this.forgetExpired(options, signal);
    } else if (options.id) {
      // Forget specific memory by ID
      count += await this.forgetById(options.id, signal);
    } else if (options.scope || options.branch || options.olderThan !== undefined) {
      count += await this.forgetByFilter(options, signal);
    }

    // Regenerate markdown (debounced)
    this.scheduleMarkdownRegeneration();

    return count;
  }

  /**
   * Destructive filters must resolve to the scope the caller named. In
   * particular, `{ branch, olderThan }` means that branch only; it must never
   * fall through the historical "all scopes" path.
   */
  private async validateAndResolveForgetOptions(options: ForgetOptions): Promise<ForgetOptions> {
    if (options.branch !== undefined && options.branch.trim().length === 0) {
      throw new Error("Memory forget branch must not be empty");
    }
    if (options.scope === "workspace" && options.branch) {
      throw new Error("Memory forget cannot combine workspace scope with a branch");
    }
    if (options.olderThan !== undefined && (!Number.isFinite(options.olderThan) || options.olderThan <= 0)) {
      throw new Error("Memory forget olderThan must be greater than zero days");
    }
    if (options.olderThan !== undefined && options.expired) {
      throw new Error("Memory forget cannot combine olderThan with expired");
    }
    if (options.id && (options.scope || options.branch || options.olderThan !== undefined || options.expired)) {
      throw new Error("Memory forget by id cannot be combined with scope, branch, olderThan, or expired");
    }

    let scope = options.scope;
    let branch = options.branch;
    if (branch && scope === undefined) {
      scope = "branch";
    }
    if (scope === "branch" && !branch) {
      branch = (await this.branchDetector.getCurrentBranch()) ?? undefined;
      if (!branch) {
        throw new Error("Memory forget branch scope requires an explicit branch or a detectable git branch");
      }
    }
    if (options.olderThan !== undefined && scope === undefined) {
      throw new Error("Memory forget with olderThan requires an explicit scope or branch");
    }

    return { ...options, scope, branch };
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async stats(): Promise<MemoryStats> {
    const snapshot = await this.loadAllScopes();
    return this.computeStats(snapshot);
  }

  /** Load entries + graphs for the workspace and every branch, once. */
  private async loadAllScopes(): Promise<{
    branches: string[];
    workspaceEntries: MemoryEntry[];
    workspaceGraph: MemoryGraph;
    branchEntries: Map<string, MemoryEntry[]>;
    branchGraphs: Map<string, MemoryGraph>;
  }> {
    const branches = await this.vectorStore.listBranches();
    const workspaceEntries = await this.getEntries("workspace");
    const workspaceGraph = await this.getGraph("workspace");
    const branchEntries = new Map<string, MemoryEntry[]>();
    const branchGraphs = new Map<string, MemoryGraph>();
    for (const branch of branches) {
      branchEntries.set(branch, await this.getEntries("branch", branch));
      branchGraphs.set(branch, await this.getGraph("branch", branch));
    }
    return { branches, workspaceEntries, workspaceGraph, branchEntries, branchGraphs };
  }

  /** Derive stats from an already-loaded scope snapshot (no extra scans). */
  private computeStats(snapshot: {
    branches: string[];
    workspaceEntries: MemoryEntry[];
    workspaceGraph: MemoryGraph;
    branchEntries: Map<string, MemoryEntry[]>;
    branchGraphs: Map<string, MemoryGraph>;
  }): MemoryStats {
    let totalMemories = 0;
    let totalEntities = 0;
    let totalRelationships = 0;
    let branchCount = 0;
    let lastUpdated = 0;
    const entityTypes: Record<string, number> = {};

    const tallyGraph = (graph: MemoryGraph): void => {
      totalEntities += graph.entityCount;
      totalRelationships += graph.edgeCount;
      for (const entity of graph.getAllEntities()) {
        entityTypes[entity.type] = (entityTypes[entity.type] ?? 0) + 1;
      }
    };

    const workspaceCount = snapshot.workspaceEntries.length;
    totalMemories += workspaceCount;
    for (const entry of snapshot.workspaceEntries) {
      if (entry.updatedAt > lastUpdated) {
        lastUpdated = entry.updatedAt;
      }
    }
    tallyGraph(snapshot.workspaceGraph);

    for (const branch of snapshot.branches) {
      const entries = snapshot.branchEntries.get(branch) ?? [];
      branchCount += entries.length;
      totalMemories += entries.length;
      for (const entry of entries) {
        if (entry.updatedAt > lastUpdated) {
          lastUpdated = entry.updatedAt;
        }
      }
      const graph = snapshot.branchGraphs.get(branch);
      if (graph) {
        tallyGraph(graph);
      }
    }

    return {
      totalMemories,
      totalEntities,
      totalRelationships,
      byScope: { workspace: workspaceCount, branch: branchCount },
      branches: snapshot.branches,
      entityTypes,
      lastUpdated,
    };
  }

  // ── List ───────────────────────────────────────────────────────────

  async list(options?: {
    scope?: MemoryScope;
    branch?: string;
    limit?: number;
    /** If true, include superseded (non-latest) entries. Default false. */
    includeSuperseded?: boolean;
    includeAuto?: boolean;
  }): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 50;
    const includeSuperseded = options?.includeSuperseded ?? false;
    const results: MemoryEntry[] = [];

    if (!options?.scope || options.scope === "workspace") {
      const entries = await this.getEntries("workspace");
      results.push(...entries);
    }

    if (!options?.scope || options.scope === "branch") {
      if (options?.branch) {
        const entries = await this.getEntries("branch", options.branch);
        results.push(...entries);
      } else {
        const branches = await this.vectorStore.listBranches();
        for (const branch of branches) {
          const entries = await this.getEntries("branch", branch);
          results.push(...entries);
        }
      }
    }

    // Sort by most recent first
    results.sort((a, b) => b.updatedAt - a.updatedAt);

    // Filter superseded entries unless explicitly requested
    const versionFiltered = includeSuperseded ? results : results.filter((e) => e.isLatest !== false);
    const filtered = options?.includeAuto
      ? versionFiltered
      : versionFiltered.filter((entry) => !entry.tags.some((tag) => tag.startsWith("auto:")));

    return filtered.slice(0, limit);
  }

  // ── Version History ──────────────────────────────────────────────────

  /**
   * Walk the version chain for a given entry ID.
   * Returns all versions (newest first).
   */
  async getVersionHistory(entryId: string): Promise<MemoryEntry[]> {
    // Find the entry in any scope
    const entry = await this.findEntryById(entryId);
    if (!entry) {
      return [];
    }

    const { scope, branch } = entry;
    const entries = await this.getEntries(scope, branch);
    const byId = new Map(entries.map((e) => [e.id, e]));

    // Collect all versions by walking both directions
    const versions = new Map<string, MemoryEntry>();
    versions.set(entry.id, entry);

    // Walk backwards (previousVersionId)
    let current: MemoryEntry | undefined = entry;
    while (current?.previousVersionId) {
      const prev = byId.get(current.previousVersionId);
      if (!prev || versions.has(prev.id)) {
        break;
      }
      versions.set(prev.id, prev);
      current = prev;
    }

    // Walk forwards (supersededBy)
    current = entry;
    while (current?.supersededBy) {
      const next = byId.get(current.supersededBy);
      if (!next || versions.has(next.id)) {
        break;
      }
      versions.set(next.id, next);
      current = next;
    }

    // Sort newest first (by version number, fallback to updatedAt)
    return [...versions.values()].sort((a, b) => (b.version ?? 1) - (a.version ?? 1));
  }

  // ── Decay ───────────────────────────────────────────────────────────

  /**
   * Run one decay cycle across all entries: evaluates effective confidence
   * (base × time-decay × access boost) against the expiry thresholds.
   * Pure and idempotent — the stored base confidence is never modified, so
   * repeated cycles report the same result for the same wall-clock time.
   * Does not remove entries — call forget({ expired: true }) to purge.
   */
  async runDecay(scope?: MemoryScope, branch?: string): Promise<DecayStatus> {
    const combined: DecayStatus = {
      totalEntries: 0,
      decayedCount: 0,
      expiredCount: 0,
      nearThresholdCount: 0,
    };

    const processScope = async (s: MemoryScope, b?: string) => {
      const entries = await this.getEntries(s, b);
      const graph = await this.getGraph(s, b);
      const status = this.decayEngine.runDecayCycle(entries, graph);

      combined.totalEntries += status.totalEntries;
      combined.decayedCount += status.decayedCount;
      combined.expiredCount += status.expiredCount;
      combined.nearThresholdCount += status.nearThresholdCount;
    };

    if (scope) {
      await processScope(scope, branch);
    } else {
      await processScope("workspace");
      const branches = await this.vectorStore.listBranches();
      for (const b of branches) {
        await processScope("branch", b);
      }
    }

    return combined;
  }

  /**
   * Clear timers and flush pending writes (reinforcement counters and
   * memories.md). Await this during shutdown so nothing is lost.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposing = true;
    this.stopStorageWatcher();
    if (this.autoDecayTimer) {
      clearInterval(this.autoDecayTimer);
      this.autoDecayTimer = null;
    }
    if (this.markdownTimer) {
      clearTimeout(this.markdownTimer);
      this.markdownTimer = null;
    }
    if (this.reinforcementTimer) {
      clearTimeout(this.reinforcementTimer);
      this.reinforcementTimer = null;
    }
    try {
      await this.drainBackgroundTasks();
      await this.flushReinforcement();
      await this.flushMarkdown();
      await this.drainBackgroundTasks();
      await this.vectorStore.dispose();
      this.disposed = true;
    } catch (error) {
      // Failed deferred persistence retains its dirty scope and the store/lease
      // remain open, allowing an explicit retry instead of silently losing it.
      this.disposing = false;
      throw error;
    }
  }

  /** Confirmed destructive reset used before changing embedding vector spaces. */
  async reset(confirm: boolean, signal?: AbortSignal): Promise<void> {
    if (!confirm) {
      throw new Error("Memory reset requires confirm=true");
    }
    signal?.throwIfAborted();

    // Deferred writers flush before the lease is taken: both take the mutation
    // mutex themselves, and async-mutex is not reentrant.
    await this.flushReinforcement();
    await this.flushMarkdown();
    await this.drainBackgroundTasks();
    signal?.throwIfAborted();

    // No scopes to re-read: reset derives nothing from canonical state, it
    // deletes everything and drops the caches itself. Pre-invalidating would
    // only force concurrent readers to queue behind the deletion for state
    // that is about to vanish anyway.
    return this.mutationMutex.runExclusive(() => this.withMutationLease([], () => this.resetUnlocked(signal)));
  }

  private async resetUnlocked(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.cancelMemoryWriteTimers();
    await this.vectorStore.deleteAll();

    this.invalidateAllCaches();
    this.reinforcementDirty.clear();
    this.markdownDirty = false;
    await this.regenerateMarkdown();

    const embeddingFingerprint = await this.embeddingService.getFingerprint();
    await atomicWriteJson(this.memoryManifestPath, { schemaVersion: 2, embeddingFingerprint, updatedAt: Date.now() });
    this.fingerprintCheck = null;
  }

  async validateEmbeddingFingerprint(): Promise<void> {
    await this.ensureEmbeddingFingerprint(false);
  }

  /**
   * Compare the embedding fingerprint against the stored manifest.
   *
   * `hasLease` says whether the caller holds this store's operation lease, and
   * is passed explicitly rather than sniffed: it decides what the absent-
   * manifest case is allowed to do. Under a lease the manifest is stamped as
   * before. Without one (recall) the stamp is attempted with a try-lock and
   * simply skipped when a foreign writer holds the lease — validation is
   * impossible without a stored fingerprint anyway, and the next writer
   * stamps it. A skipped stamp is deliberately NOT memoised.
   */
  private async ensureEmbeddingFingerprint(hasLease: boolean): Promise<void> {
    await this.ensureStorageReady(hasLease);
    if (this.fingerprintCheck) {
      return this.fingerprintCheck;
    }
    let stamped = true;
    const check = (async () => {
      const current =
        typeof (this.embeddingService as any).getFingerprint === "function"
          ? await this.embeddingService.getFingerprint()
          : {
              backendKind: "test-or-legacy",
              providerFormat: "unknown",
              model: "unknown",
              revision: "unknown",
              dimension: (await this.embeddingService.embed("RAGnarok embedding fingerprint probe")).length,
              endpointHash: "unknown",
            };
      let stored: EmbeddingFingerprint | undefined;
      try {
        const manifest = JSON.parse(await fs.readFile(this.memoryManifestPath, "utf8"));
        stored = manifest.embeddingFingerprint;
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      if (!stored) {
        stamped = await this.stampEmbeddingFingerprint(current, hasLease);
        return;
      }
      if (JSON.stringify(stored) !== JSON.stringify(current)) {
        throw new Error(
          `Memory embedding fingerprint mismatch. Stored ${stored.backendKind}/${stored.model}; ` +
            `current ${current.backendKind}/${current.model}. Run rag_reset_memory with confirmation before switching.`,
        );
      }
    })();
    this.fingerprintCheck = check;
    try {
      await check;
    } catch (error) {
      this.fingerprintCheck = null;
      throw error;
    }
    if (!stamped && this.fingerprintCheck === check) {
      // Nothing was validated and nothing was written: leave the guard
      // unmemoised so the next mutation (which will hold the lease) stamps it.
      this.fingerprintCheck = null;
    }
  }

  /**
   * Write the absent manifest. Returns false when a foreign writer holds the
   * lease and the stamp was skipped.
   */
  private async stampEmbeddingFingerprint(current: EmbeddingFingerprint, hasLease: boolean): Promise<boolean> {
    if (hasLease) {
      await atomicWriteJson(this.memoryManifestPath, {
        schemaVersion: 2,
        embeddingFingerprint: current,
        updatedAt: Date.now(),
      });
      return true;
    }

    let lease: StorageLockHandle;
    try {
      lease = await acquireOperationLease(this.storageDir, { waitMs: 0 });
    } catch (error) {
      if (error instanceof StorageBusyError) {
        this.logger.debug("Skipping the memory manifest stamp: another process holds the storage lease");
        return false;
      }
      throw error;
    }
    try {
      // Now that a lease is held, this is a write path: the format marker
      // comes first, so the manifest can never be the thing that turns a
      // fresh directory into "unversioned legacy storage".
      await ensureStorageFormatV2(this.storageDir);
      // Another process may have stamped it while this read was deciding to.
      try {
        const manifest = JSON.parse(await fs.readFile(this.memoryManifestPath, "utf8"));
        if (manifest.embeddingFingerprint) {
          return true;
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      await atomicWriteJson(this.memoryManifestPath, {
        schemaVersion: 2,
        embeddingFingerprint: current,
        updatedAt: Date.now(),
      });
      return true;
    } finally {
      await lease.release();
    }
  }

  /**
   * Validate the storage format marker, stamping it only for a genuinely
   * empty directory.
   *
   * Classification is read-only, so two windows opening the same healthy store
   * never contend — the overwhelmingly common case costs nothing. Any
   * classification other than "current"/"empty" goes to `ensureStorageFormatV2`
   * purely so it raises its own typed error: an interrupted migration, a legacy
   * directory or a future format version must fail closed on reads too.
   *
   * The empty case is the only one that writes. A mutation stamps it under its
   * own lease. A read stamps it opportunistically, with a TRY-lock — it never
   * waits, never fails, and skips the stamp entirely when someone else holds
   * the lease. The stamp cannot simply be skipped on reads: reads create the
   * LanceDB directory as a side effect of loading, which would leave the store
   * looking like unversioned 0.3 data and fail every subsequent open closed.
   * Skipping it is safe only against a live foreign writer, because that writer
   * stamps the marker under its own lease before it writes anything.
   */
  private async ensureStorageReady(hasLease: boolean): Promise<void> {
    if (this.storageReady) {
      await this.storageReady;
      return;
    }
    const attempt = (async (): Promise<boolean> => {
      const inspection = await inspectStorage(this.storageDir);
      if (inspection.status === "current") {
        return true;
      }
      if (inspection.status !== "empty") {
        await ensureStorageFormatV2(this.storageDir);
        return true;
      }
      if (hasLease) {
        // Re-checked under the lease: another process may have stamped it
        // while this one waited.
        await ensureStorageFormatV2(this.storageDir);
        return true;
      }
      return this.stampStorageFormatOpportunistically();
    })();
    // Memoised only once the outcome is confirmed, so a skipped read-path
    // stamp never suppresses a later write-path stamp.
    const confirmed = await attempt;
    if (confirmed) {
      this.storageReady = attempt.then(() => undefined);
    }
  }

  /** Stamp the v2 marker if the lease is free right now. False when it is not. */
  private async stampStorageFormatOpportunistically(): Promise<boolean> {
    let lease: StorageLockHandle;
    try {
      lease = await acquireOperationLease(this.storageDir, { waitMs: 0 });
    } catch (error) {
      if (error instanceof StorageBusyError) {
        this.logger.debug("Skipping the storage format stamp: another process holds the storage lease");
        return false;
      }
      throw error;
    }
    try {
      await ensureStorageFormatV2(this.storageDir);
      return true;
    } finally {
      await lease.release();
    }
  }

  // ── Cross-Scope Linking ─────────────────────────────────────────────

  /**
   * Discover cross-scope entity links between two scopes.
   * Uses "workspace" and "branch:<name>" scope strings.
   * If no arguments, discovers links between workspace and the current branch.
   */
  async discoverLinks(sourceScope?: string, targetScope?: string): Promise<ScopeLink[]> {
    const src = sourceScope ?? "workspace";
    const tgt = targetScope ?? (await this.currentBranchScope());
    if (!tgt) {
      return [];
    }
    return this.scopeLinker.discoverLinks(src, tgt);
  }

  /**
   * Promote branch memories to workspace scope (e.g. after merge).
   * @param branch — branch name (not scope string)
   * @param entryIds — optional list of specific entry IDs to promote
   */
  async promoteToWorkspace(branch: string, entryIds?: string[], signal?: AbortSignal): Promise<number> {
    return this.mutationMutex.runExclusive(() =>
      this.withMutationLease(["workspace", `branch:${branch}`], () =>
        this.promoteToWorkspaceUnlocked(branch, entryIds, signal),
      ),
    );
  }

  private async promoteToWorkspaceUnlocked(branch: string, entryIds?: string[], signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    await this.ensureStorageReady(true);
    signal?.throwIfAborted();
    const count = await this.scopeLinker.promoteToWorkspace(`branch:${branch}`, "workspace", entryIds, signal);
    // Invalidate workspace caches so next access reloads from store
    this.invalidateCache("workspace");
    return count;
  }

  /**
   * Find entities matching name+type across all scopes.
   */
  async findLinkedEntities(name: string, type: string): Promise<Array<{ scope: string; entity: MemoryEntity }>> {
    return this.scopeLinker.findLinkedEntities(name, type);
  }

  // ── Branch Detection ───────────────────────────────────────────────

  getCurrentBranch(): Promise<string | null> {
    return this.branchDetector.getCurrentBranch();
  }

  async getGraphSnapshot(scope: MemoryScope, branch?: string): Promise<MemoryGraphSnapshot> {
    const graph = await this.getGraph(scope, branch);
    return {
      entities: graph.getAllEntities().map((source) => {
        const { vector: _vector, ...entity } = source;
        return {
          ...entity,
          sourceMemoryIds: [...entity.sourceMemoryIds],
          metadata: this.cloneJsonSafe(entity.metadata),
        };
      }),
      relationships: graph.getAllRelationships().map((relationship) => ({
        ...relationship,
        metadata: this.cloneJsonSafe(relationship.metadata),
      })),
    };
  }

  /**
   * Whether entity extraction — and therefore the entity graph that backs
   * communities, `includeEntities` recall and graph visualization — is active.
   *
   * Extraction needs an LLM provider. Without one memories are still stored and
   * recalled by vector similarity, but the graph stays empty. Callers must tell
   * the user that instead of presenting an empty graph as "nothing known".
   */
  public isEntityExtractionEnabled(): boolean {
    return this.extractor !== null;
  }

  /**
   * Cluster the scope's entity graph and return each community's members,
   * largest community first.
   *
   * Persisted graph data remains readable without an LLM provider. Callers pair
   * the result with {@link isEntityExtractionEnabled} to report whether new
   * entities can currently be extracted.
   */
  public async recallCommunities(
    scope: MemoryScope = "workspace",
    branch?: string,
  ): Promise<Array<{ id: number; entityNames: string[] }>> {
    const resolved = await this.resolveBranch({ scope, branch });
    const graph = await this.getGraph(resolved.scope, resolved.branch);
    const communities = graph.detectCommunities();
    const namesById = new Map(graph.getAllEntities().map((entity) => [entity.id, entity.name]));
    return Array.from(communities.entries())
      .map(([id, entityIds]) => ({
        id,
        entityNames: entityIds.map((entityId) => namesById.get(entityId) ?? entityId),
      }))
      .sort((left, right) => right.entityNames.length - left.entityNames.length || left.id - right.id);
  }

  // ── Private Methods ────────────────────────────────────────────────

  private cloneJsonSafe<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private scopeKey(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch ? `branch:${branch}` : "workspace";
  }

  /**
   * Drop one scope's cached state.
   *
   * The in-flight single-flight loads go too, and the generation counter is
   * bumped: a load that started before this call read a state this caller has
   * just declared stale, so it must neither be joined by the next reader nor
   * allowed to repopulate the cache when it lands.
   */
  private invalidateCache(scopeKey: string): void {
    this.entryCache.delete(scopeKey);
    this.graphCache.delete(scopeKey);
    this.entryLoads.delete(scopeKey);
    this.graphLoads.delete(scopeKey);
    this.cacheGeneration += 1;
  }

  /** Drop every scope's cached state (a foreign write, or a scope-wide mutation). */
  private invalidateAllCaches(): void {
    this.entryCache.clear();
    this.graphCache.clear();
    this.entryLoads.clear();
    this.graphLoads.clear();
    this.cacheGeneration += 1;
  }

  /**
   * Run a mutation under an exclusive, operation-scoped write lease.
   *
   * `scopes` names the scope keys the body will read-modify-write — null for
   * "every scope", empty for a body that reads none. Their caches are dropped
   * BEFORE the body runs, so the single-flight loaders re-read canonical state
   * under the lease instead of deriving the next state from whatever another
   * process left us holding.
   *
   * Reads never come through here — they are lock-free by design, which is
   * what lets a second window read a store this one is writing. Deferred
   * writers (`flushReinforcement`, `regenerateMarkdown`) still write outside
   * any lease; converting them is the deferred-writer task's job.
   */
  private async withMutationLease<T>(scopes: string[] | null, body: () => Promise<T>): Promise<T> {
    const lease = await acquireOperationLease(this.storageDir, { waitMs: MUTATION_LEASE_WAIT_MS });
    this.activeMutationLeases += 1;
    try {
      if (scopes === null) {
        this.invalidateAllCaches();
      } else {
        for (const scope of scopes) {
          this.invalidateCache(scope);
        }
      }
      return await body();
    } finally {
      this.activeMutationLeases -= 1;
      await lease.release();
    }
  }

  private async currentBranchScope(): Promise<string | null> {
    const branch = await this.branchDetector.getCurrentBranch();
    return branch ? `branch:${branch}` : null;
  }

  /**
   * Whether THIS process currently holds the storage lease through one of
   * this store's mutations.
   *
   * The loaders are shared by mutations and by lock-free reads, and threading
   * a flag through every read call site would be noise. This is not a guess
   * about someone else's lease: the count is incremented and decremented by
   * `withMutationLease` alone. A concurrent read that observes it can still
   * legitimately act as leased — the lease is process-wide and refcounted, so
   * a write it makes while the count is positive is genuinely fenced against
   * other processes.
   */
  private get holdsMutationLease(): boolean {
    return this.activeMutationLeases > 0;
  }

  /**
   * Every read below is lock-free on purpose: taking the session lease here
   * is exactly what used to kill a second VS Code window on its first memory
   * read. Reads validate the storage format (never writing it) and then go
   * straight to the vector store.
   */
  private async getGraph(scope: MemoryScope, branch?: string): Promise<MemoryGraph> {
    await this.ensureStorageReady(this.holdsMutationLease);
    this.ensureStorageWatcher();
    const key = this.scopeKey(scope, branch);
    const cached = this.graphCache.get(key);
    if (cached) {
      return cached;
    }

    // Single-flight: concurrent cache misses must share one load, or each
    // caller gets its OWN graph object and mutations to the losers are lost.
    let loading = this.graphLoads.get(key);
    if (!loading) {
      const generation = this.cacheGeneration;
      const load: Promise<MemoryGraph> = this.vectorStore
        .loadGraph(scope, branch)
        .then((data) => {
          const graph = data ? MemoryGraph.fromJSON(data) : new MemoryGraph();
          if (this.cacheGeneration === generation) {
            this.graphCache.set(key, graph);
          }
          return graph;
        })
        .finally(() => {
          if (this.graphLoads.get(key) === load) {
            this.graphLoads.delete(key);
          }
        });
      loading = load;
      this.graphLoads.set(key, load);
    }
    return loading;
  }

  private async getEntries(scope: MemoryScope, branch?: string): Promise<MemoryEntry[]> {
    await this.ensureStorageReady(this.holdsMutationLease);
    this.ensureStorageWatcher();
    const key = this.scopeKey(scope, branch);
    const cached = this.entryCache.get(key);
    if (cached) {
      return cached;
    }

    // Single-flight: two concurrent misses would otherwise each load and
    // cache their OWN array — entries pushed onto the losing array never
    // persist (lost update).
    let loading = this.entryLoads.get(key);
    if (!loading) {
      const generation = this.cacheGeneration;
      const load: Promise<MemoryEntry[]> = this.vectorStore
        .loadEntries(scope, branch)
        .then((entries) => {
          if (this.cacheGeneration === generation) {
            this.entryCache.set(key, entries);
          }
          return entries;
        })
        .finally(() => {
          if (this.entryLoads.get(key) === load) {
            this.entryLoads.delete(key);
          }
        });
      loading = load;
      this.entryLoads.set(key, load);
    }
    return loading;
  }

  // ── Foreign-change watcher ──────────────────────────────────────────
  //
  // Watches the storage DIRECTORY, never a file: memory-manifest.json and
  // memories.md are both published by rename-over, and an inode-following
  // file watch goes silent after the first replacement. Events are filtered
  // to those two names, debounced 250ms, and skipped while this store holds
  // its own operation lease (the debounce re-arms instead of dropping the
  // event, so a foreign change that coincides with our write is still
  // applied once the lease closes).
  //
  // Deliberately coarse: a foreign process's LanceDB writes do NOT reliably
  // surface through these two files, so this signal alone cannot guarantee
  // cross-process memory freshness. It complements — it does not replace —
  // the cache invalidation every mutation performs when it takes its lease.
  // Our own deferred markdown/manifest writes can also trip it (memories.md
  // often lives inside the storage dir); the cost is a reload of state we
  // just wrote, which is correctness-neutral.

  /**
   * Start the watch on first data access. The storage directory may not exist
   * when the (synchronous) constructor runs, so construction is retried until
   * it succeeds; the failure is logged once and never again.
   */
  private ensureStorageWatcher(): void {
    if (this.watcherStopped || this.storageWatcher) {
      return;
    }
    let watcher: fsSync.FSWatcher;
    try {
      watcher = fsSync.watch(this.storageDir, (_eventType, filename) => this.onRawWatchEvent(filename));
    } catch (error) {
      if (!this.watcherFailureLogged) {
        this.watcherFailureLogged = true;
        this.logger.debug("Unable to watch the memory storage directory for external changes", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    watcher.on("error", (error) => {
      this.logger.debug("Memory storage directory watch reported an error", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeStorageWatcher();
    });
    this.storageWatcher = watcher;
  }

  private onRawWatchEvent(filename: string | Buffer | null): void {
    if (this.watcherStopped) {
      return;
    }
    const name = filename ? filename.toString() : null;
    if (name !== null && name !== MEMORY_MANIFEST_FILENAME && name !== MEMORIES_MARKDOWN_FILENAME) {
      return;
    }
    this.scheduleForeignChangeDrop();
  }

  private scheduleForeignChangeDrop(): void {
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer);
    }
    this.watcherDebounceTimer = setTimeout(() => {
      this.watcherDebounceTimer = null;
      if (this.watcherStopped) {
        return;
      }
      if (this.holdsMutationLease) {
        // Our own mutation is mid-flight and holds optimistic in-memory state
        // it has not persisted yet. Re-arm rather than drop the signal.
        this.scheduleForeignChangeDrop();
        return;
      }
      this.invalidateAllCaches();
    }, MEMORY_WATCH_DEBOUNCE_MS);
    this.watcherDebounceTimer.unref?.();
  }

  private closeStorageWatcher(): void {
    if (this.storageWatcher) {
      try {
        this.storageWatcher.close();
      } catch {
        // Already closed, or the underlying handle is gone.
      }
      this.storageWatcher = null;
    }
  }

  private stopStorageWatcher(): void {
    this.watcherStopped = true;
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer);
      this.watcherDebounceTimer = null;
    }
    this.closeStorageWatcher();
  }

  private async findEntryById(id: string): Promise<(MemoryEntry & { scope: MemoryScope; branch?: string }) | null> {
    const wsEntries = await this.getEntries("workspace");
    const wsMatch = wsEntries.find((e) => e.id === id);
    if (wsMatch) {
      return { ...wsMatch, scope: "workspace", branch: undefined };
    }

    const branches = await this.vectorStore.listBranches();
    for (const branch of branches) {
      const entries = await this.getEntries("branch", branch);
      const match = entries.find((e) => e.id === id);
      if (match) {
        return { ...match, scope: "branch", branch };
      }
    }

    return null;
  }

  private async persistEntries(scope: MemoryScope, branch?: string): Promise<void> {
    const key = this.scopeKey(scope, branch);
    const entries = this.entryCache.get(key);
    // An empty cached array must still be persisted — it means the last entry
    // was forgotten, and saveEntries drops the stale on-disk table.
    if (entries) {
      await this.vectorStore.saveEntries(entries, scope, branch);
    }
  }

  /**
   * Persist a scope's cached entries and graph together. On failure the
   * scope's caches are dropped before rethrowing: the optimistic in-memory
   * mutation must not masquerade as persisted state, so the next access
   * reloads disk truth instead.
   */
  private async persistScopeOrInvalidate(scope: MemoryScope, branch?: string): Promise<void> {
    try {
      const key = this.scopeKey(scope, branch);
      const entries = this.entryCache.get(key) ?? (await this.getEntries(scope, branch));
      const graph = this.graphCache.get(key) ?? (await this.getGraph(scope, branch));
      await this.vectorStore.saveScopeAtomic(entries, graph.toJSON(), scope, branch);
    } catch (error) {
      this.invalidateCache(this.scopeKey(scope, branch));
      throw error;
    }
  }

  private async resolveBranch(options: { scope?: MemoryScope; branch?: string }): Promise<{
    scope: MemoryScope;
    branch: string | undefined;
  }> {
    const scope = options.scope ?? "workspace";
    if (scope === "branch") {
      const branch = options.branch ?? (await this.branchDetector.getCurrentBranch()) ?? undefined;
      if (!branch) {
        throw new Error("Branch scope requested but no attached git branch was detected; pass branch explicitly");
      }
      return { scope: "branch", branch };
    }
    return { scope: "workspace", branch: undefined };
  }

  private async resolveScopesForRecall(
    options: RecallOptions,
  ): Promise<Array<{ scope: MemoryScope; branch?: string }>> {
    if (options.scope === "workspace") {
      return [{ scope: "workspace" }];
    }
    if (options.scope === "branch") {
      const branch = options.branch ?? (await this.branchDetector.getCurrentBranch()) ?? undefined;
      if (!branch) {
        throw new Error("Branch scope requested but no attached git branch was detected; pass branch explicitly");
      }
      return [{ scope: "branch", branch }];
    }
    // Default: search both workspace and current branch
    const scopes: Array<{ scope: MemoryScope; branch?: string }> = [{ scope: "workspace" }];
    const branch = options.branch ?? (await this.branchDetector.getCurrentBranch()) ?? undefined;
    if (branch) {
      scopes.push({ scope: "branch", branch });
    }
    return scopes;
  }

  private findDuplicateEntry(entries: MemoryEntry[], vector: number[]): MemoryEntry | null {
    for (const entry of entries) {
      if (entry.vector.length === 0) {
        continue;
      }
      // Only match against latest versions (backward compat: undefined = latest)
      if (entry.isLatest === false) {
        continue;
      }
      const similarity = cosineSimilarity(vector, entry.vector);
      if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        return entry;
      }
    }
    return null;
  }

  private async extractAndMergeEntities(
    content: string,
    memoryId: string,
    scope: MemoryScope,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!this.extractor) {
      return [];
    }

    const result = await this.extractor.extract(content, signal);
    signal?.throwIfAborted();
    if (result.entities.length === 0) {
      return [];
    }

    const graph = await this.getGraph(scope, branch);
    const entityIds: string[] = [];

    // Partition into merges (existing entities) and brand-new entities so all
    // new descriptions embed in ONE batch instead of K serial inference calls.
    const entityNameToId = new Map<string, string>();
    const newEntities: typeof result.entities = [];
    const existingEntities: Array<{ extracted: (typeof result.entities)[number]; entity: MemoryEntity }> = [];
    for (const extracted of result.entities) {
      const existing = graph.findDuplicate(extracted.name, extracted.type);

      if (existing) {
        existingEntities.push({ extracted, entity: existing });
        entityIds.push(existing.id);
        entityNameToId.set(extracted.name.toLowerCase(), existing.id);
      } else {
        newEntities.push(extracted);
      }
    }

    const vectors =
      newEntities.length > 0
        ? await this.embeddingService.embedBatch(
            newEntities.map((e) => e.description),
            undefined,
            signal,
          )
        : [];
    signal?.throwIfAborted();

    const preparedEntities = newEntities.map((extracted, i) => {
      const entity: MemoryEntity = {
        id: crypto.randomUUID(),
        name: extracted.name,
        type: extracted.type,
        description: extracted.description,
        vector: vectors[i],
        scope,
        branch,
        confidence: 1.0,
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceMemoryIds: [memoryId],
        metadata: {},
      };
      entityIds.push(entity.id);
      entityNameToId.set(extracted.name.toLowerCase(), entity.id);
      return entity;
    });

    // Apply graph mutations only after every cancellable operation succeeded.
    for (const { extracted, entity } of existingEntities) {
      const mergedDescription = entity.description.includes(extracted.description)
        ? entity.description
        : `${entity.description}; ${extracted.description}`;
      graph.updateEntity(entity.id, {
        description: mergedDescription,
        sourceMemoryIds: [...new Set([...entity.sourceMemoryIds, memoryId])],
        strength: Math.min(entity.strength + 0.1, 5.0),
        updatedAt: Date.now(),
      });
    }
    for (const entity of preparedEntities) {
      graph.addEntity(entity);
    }

    // Process extracted relationships
    for (const rel of result.relationships) {
      const sourceId = entityNameToId.get(rel.source.toLowerCase());
      const targetId = entityNameToId.get(rel.target.toLowerCase());
      if (sourceId && targetId) {
        graph.addRelationship({
          id: crypto.randomUUID(),
          sourceId,
          targetId,
          type: rel.type,
          description: rel.description,
          weight: rel.weight,
          scope,
          branch,
          metadata: {},
        });
      }
    }

    return entityIds;
  }

  private async forgetById(id: string, signal?: AbortSignal): Promise<number> {
    // Search all scopes for this entry
    signal?.throwIfAborted();
    const wsEntries = await this.getEntries("workspace");
    const wsIdx = wsEntries.findIndex((e) => e.id === id);
    if (wsIdx !== -1) {
      const entries = this.cloneEntries(wsEntries);
      const graph = MemoryGraph.fromJSON((await this.getGraph("workspace")).toJSON());
      const [entry] = entries.splice(wsIdx, 1);
      this.repairVersionChain(entries, entry);
      this.cleanupOrphanedEntities(entry, entries, graph);
      signal?.throwIfAborted();
      await this.persistStagedScope(entries, graph, "workspace");
      return 1;
    }

    const branches = await this.vectorStore.listBranches();
    for (const branch of branches) {
      signal?.throwIfAborted();
      const entries = await this.getEntries("branch", branch);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        const stagedEntries = this.cloneEntries(entries);
        const graph = MemoryGraph.fromJSON((await this.getGraph("branch", branch)).toJSON());
        const [entry] = stagedEntries.splice(idx, 1);
        this.repairVersionChain(stagedEntries, entry);
        this.cleanupOrphanedEntities(entry, stagedEntries, graph);
        signal?.throwIfAborted();
        await this.persistStagedScope(stagedEntries, graph, "branch", branch);
        return 1;
      }
    }

    return 0;
  }

  private async forgetExpired(options: ForgetOptions, signal?: AbortSignal): Promise<number> {
    const stagedScopes: Array<{
      entries: MemoryEntry[];
      graph: MemoryGraph;
      scope: MemoryScope;
      branch?: string;
      removedCount: number;
    }> = [];

    const processScope = async (scope: MemoryScope, branch?: string) => {
      signal?.throwIfAborted();
      const entries = this.cloneEntries(await this.getEntries(scope, branch));
      const graph = MemoryGraph.fromJSON((await this.getGraph(scope, branch)).toJSON());
      const removed = this.decayEngine.expireStale(entries, graph);

      if (removed.length > 0) {
        for (const entry of removed) {
          this.repairVersionChain(entries, entry);
          this.cleanupOrphanedEntities(entry, entries, graph);
        }
        stagedScopes.push({ entries, graph, scope, branch, removedCount: removed.length });
      }
    };

    if (!options.scope || options.scope === "workspace") {
      await processScope("workspace");
    }

    if (!options.scope || options.scope === "branch") {
      if (options.branch) {
        await processScope("branch", options.branch);
      } else {
        const branches = await this.vectorStore.listBranches();
        for (const branch of branches) {
          await processScope("branch", branch);
        }
      }
    }

    signal?.throwIfAborted();
    for (const staged of stagedScopes) {
      await this.persistStagedScope(staged.entries, staged.graph, staged.scope, staged.branch);
    }
    return stagedScopes.reduce((count, staged) => count + staged.removedCount, 0);
  }

  private async forgetByFilter(options: ForgetOptions, signal?: AbortSignal): Promise<number> {
    const stagedScopes: Array<{
      entries: MemoryEntry[];
      graph: MemoryGraph;
      scope: MemoryScope;
      branch?: string;
      removedCount: number;
    }> = [];
    const now = Date.now();
    const olderThanMs = options.olderThan !== undefined ? options.olderThan * 24 * 60 * 60 * 1000 : undefined;

    // Guard: refuse to delete everything when no meaningful filter is provided
    if (olderThanMs === undefined) {
      this.logger.warn("forgetByFilter called without olderThan — refusing to delete all entries");
      return 0;
    }

    const processScope = async (scope: MemoryScope, branch?: string) => {
      signal?.throwIfAborted();
      const entries = this.cloneEntries(await this.getEntries(scope, branch));
      const graph = MemoryGraph.fromJSON((await this.getGraph(scope, branch)).toJSON());
      const toRemove: MemoryEntry[] = [];

      for (const entry of entries) {
        if (now - entry.createdAt < olderThanMs) {
          continue;
        }
        toRemove.push(entry);
      }

      if (toRemove.length > 0) {
        for (const entry of toRemove) {
          const idx = entries.indexOf(entry);
          if (idx !== -1) {
            entries.splice(idx, 1);
          }
          this.repairVersionChain(entries, entry);
          this.cleanupOrphanedEntities(entry, entries, graph);
        }
        stagedScopes.push({ entries, graph, scope, branch, removedCount: toRemove.length });
      }
    };

    if (!options.scope || options.scope === "workspace") {
      await processScope("workspace");
    }

    if (!options.scope || options.scope === "branch") {
      if (options.branch) {
        await processScope("branch", options.branch);
      } else {
        const branches = await this.vectorStore.listBranches();
        for (const branch of branches) {
          await processScope("branch", branch);
        }
      }
    }

    signal?.throwIfAborted();
    for (const staged of stagedScopes) {
      await this.persistStagedScope(staged.entries, staged.graph, staged.scope, staged.branch);
    }
    return stagedScopes.reduce((count, staged) => count + staged.removedCount, 0);
  }

  private cleanupOrphanedEntities(removedEntry: MemoryEntry, entries: MemoryEntry[], graph: MemoryGraph): void {
    for (const entityId of removedEntry.entityIds) {
      const entity = graph.getEntity(entityId);
      if (!entity) {
        continue;
      }

      // Check if any other entry references this entity
      const stillReferenced = entries.some((e) => e.entityIds.includes(entityId));
      if (!stillReferenced) {
        graph.removeEntity(entityId);
      } else {
        // Update sourceMemoryIds
        const updated = entity.sourceMemoryIds.filter((id) => id !== removedEntry.id);
        graph.updateEntity(entityId, { sourceMemoryIds: updated });
      }
    }
  }

  private cloneEntries(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.map((entry) => ({
      ...entry,
      vector: Array.from(entry.vector),
      tags: [...entry.tags],
      entityIds: [...entry.entityIds],
      metadata: this.cloneJsonSafe(entry.metadata),
    }));
  }

  private async persistStagedScope(
    entries: MemoryEntry[],
    graph: MemoryGraph,
    scope: MemoryScope,
    branch?: string,
  ): Promise<void> {
    await this.vectorStore.saveScopeAtomic(entries, graph.toJSON(), scope, branch);
    this.invalidateCache(this.scopeKey(scope, branch));
  }

  private repairVersionChain(entries: MemoryEntry[], removed: MemoryEntry): void {
    const previous = removed.previousVersionId
      ? entries.find((entry) => entry.id === removed.previousVersionId)
      : undefined;
    const next = removed.supersededBy ? entries.find((entry) => entry.id === removed.supersededBy) : undefined;
    if (previous) {
      previous.supersededBy = next?.id;
      previous.isLatest = !next;
      previous.updatedAt = Date.now();
    }
    if (next) {
      next.previousVersionId = previous?.id;
      next.updatedAt = Date.now();
    }
  }

  /**
   * Mark memories.md stale and schedule a debounced regeneration.
   * Coalesces bursts of mutations into a single scan+write, and the
   * flush loop serializes writes so they can't land out of order.
   */
  private scheduleMarkdownRegeneration(): void {
    if (!this.markdownPath) {
      return;
    }
    this.markdownDirty = true;
    if (this.markdownTimer) {
      return;
    }
    this.markdownTimer = setTimeout(() => {
      this.markdownTimer = null;
      const task = this.trackBackgroundTask(this.flushMarkdown());
      void task.catch((err) => this.logger.debug("Markdown regeneration failed", err));
    }, 1_000);
    this.markdownTimer.unref?.();
  }

  private cancelMemoryWriteTimers(): void {
    if (this.markdownTimer) {
      clearTimeout(this.markdownTimer);
      this.markdownTimer = null;
    }
    if (this.reinforcementTimer) {
      clearTimeout(this.reinforcementTimer);
      this.reinforcementTimer = null;
    }
  }

  /** Write memories.md if stale. Single-flight; safe to call at shutdown. */
  async flushMarkdown(): Promise<void> {
    if (this.markdownFlushing) {
      return;
    }
    this.markdownFlushing = true;
    try {
      while (this.markdownDirty) {
        this.markdownDirty = false;
        try {
          await this.regenerateMarkdown();
        } catch (err) {
          this.markdownDirty = true;
          throw err;
        }
      }
    } finally {
      this.markdownFlushing = false;
    }
  }

  private async regenerateMarkdown(): Promise<void> {
    if (!this.markdownPath) {
      return;
    }

    // One scan feeds both the export and its stats section.
    const snapshot = await this.loadAllScopes();

    const visibleScope = (entries: MemoryEntry[], graph: MemoryGraph) => {
      const visibleEntries = entries.filter(
        (entry) =>
          entry.isLatest !== false &&
          !entry.tags.some((tag) => tag.startsWith("auto:")) &&
          this.decayEngine.isRecallable(entry, graph),
      );
      const referencedEntityIds = new Set(visibleEntries.flatMap((entry) => entry.entityIds));
      const entities = graph.getAllEntities().filter((entity) => referencedEntityIds.has(entity.id));
      const entityIds = new Set(entities.map((entity) => entity.id));
      const relationships = graph
        .getAllRelationships()
        .filter((relationship) => entityIds.has(relationship.sourceId) && entityIds.has(relationship.targetId));
      return { entries: visibleEntries, graph: MemoryGraph.fromJSON({ entities, relationships }) };
    };

    const workspace = visibleScope(snapshot.workspaceEntries, snapshot.workspaceGraph);
    const visibleBranchEntries = new Map<string, MemoryEntry[]>();
    const visibleBranchGraphs = new Map<string, MemoryGraph>();
    const branchEntities = new Map<string, MemoryEntity[]>();
    const branchRelationships = new Map<string, import("./types").MemoryRelationship[]>();
    for (const branch of snapshot.branches) {
      const graph = snapshot.branchGraphs.get(branch);
      const visible = visibleScope(snapshot.branchEntries.get(branch) ?? [], graph ?? new MemoryGraph());
      visibleBranchEntries.set(branch, visible.entries);
      visibleBranchGraphs.set(branch, visible.graph);
      branchEntities.set(branch, visible.graph.getAllEntities());
      branchRelationships.set(branch, visible.graph.getAllRelationships());
    }

    const markdown = this.exporter.generate({
      workspaceEntries: workspace.entries,
      workspaceEntities: workspace.graph.getAllEntities(),
      workspaceRelationships: workspace.graph.getAllRelationships(),
      branchEntries: visibleBranchEntries,
      branchEntities,
      branchRelationships,
      stats: this.computeStats({
        branches: snapshot.branches.filter((branch) => (visibleBranchEntries.get(branch)?.length ?? 0) > 0),
        workspaceEntries: workspace.entries,
        workspaceGraph: workspace.graph,
        branchEntries: visibleBranchEntries,
        branchGraphs: visibleBranchGraphs,
      }),
    });

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.markdownPath), { recursive: true });
    await atomicWriteFile(this.markdownPath, markdown);
  }

  /** Queue a scope for deferred reinforcement persistence. */
  private scheduleReinforcementFlush(scope: MemoryScope, branch?: string): void {
    this.reinforcementDirty.add(this.scopeKey(scope, branch));
    if (this.reinforcementTimer) {
      return;
    }
    this.reinforcementTimer = setTimeout(() => {
      this.reinforcementTimer = null;
      const task = this.trackBackgroundTask(this.flushReinforcement());
      void task.catch((err) => this.logger.debug("Reinforcement flush failed", err));
    }, 2_000);
    this.reinforcementTimer.unref?.();
  }

  /** Persist scopes with pending access-counter updates. */
  async flushReinforcement(): Promise<void> {
    return this.mutationMutex.runExclusive(() => this.flushReinforcementUnlocked());
  }

  private async flushReinforcementUnlocked(): Promise<void> {
    const dirty = [...this.reinforcementDirty];
    this.reinforcementDirty.clear();
    const failures: unknown[] = [];
    for (const key of dirty) {
      const { scope, branch } = this.parseScopeKey(key);
      try {
        await this.persistEntries(scope, branch);
      } catch (err) {
        this.reinforcementDirty.add(key);
        failures.push(err);
        this.logger.debug(`Reinforcement flush failed for ${key}`, err);
      }
    }
    if (this.reinforcementDirty.size > 0 && !this.disposing) {
      const { scope, branch } = this.parseScopeKey(this.reinforcementDirty.values().next().value as string);
      this.scheduleReinforcementFlush(scope, branch);
    }
    if (failures.length > 0) {
      const error = new Error(`Failed to persist ${failures.length} reinforced memory scope(s)`) as Error & {
        failures: unknown[];
      };
      error.failures = failures;
      throw error;
    }
  }

  private parseScopeKey(key: string): { scope: MemoryScope; branch?: string } {
    if (key.startsWith("branch:")) {
      return { scope: "branch", branch: key.slice("branch:".length) };
    }
    return { scope: "workspace" };
  }

  private trackBackgroundTask<T>(task: Promise<T>): Promise<T> {
    this.backgroundTasks.add(task);
    void task.finally(() => this.backgroundTasks.delete(task)).catch(() => undefined);
    return task;
  }

  private async drainBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }
}
