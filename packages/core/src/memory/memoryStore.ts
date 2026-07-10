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
import * as fs from "fs/promises";
import * as path from "path";
import { EmbeddingService } from "../embeddings/embeddingService";
import { ILLMProvider } from "../interfaces";
import { Logger } from "../logger";
import {
  MemoryEntry,
  MemoryEntity,
  MemoryScope,
  MemoryStats,
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

  constructor(options: MemoryStoreOptions) {
    const lanceDbUri = path.join(options.storageDir, "memory-lancedb");
    this.vectorStore = new MemoryVectorStore(lanceDbUri);
    this.embeddingService = options.embeddingService;
    this.extractor = options.llmProvider
      ? new MemoryEntityExtractor(options.llmProvider)
      : null;
    this.exporter = new MemoryMarkdownExporter();
    this.branchDetector = new GitBranchDetector(options.workingDir);
    this.markdownPath = options.markdownPath ?? null;
    this.decayEngine = new MemoryDecayEngine(options.decayOptions);
    this.scopeLinker = new MemoryScopeLinker(this.vectorStore);

    if (options.decayOptions?.autoDecayIntervalMs) {
      this.autoDecayTimer = setInterval(() => {
        this.runDecay().catch((err) =>
          this.logger.debug("Auto-decay cycle failed", err),
        );
      }, options.decayOptions.autoDecayIntervalMs);
    }
  }

  // ── Store ──────────────────────────────────────────────────────────

  async store(options: StoreOptions): Promise<MemoryEntry> {
    const { scope, branch } = this.resolveBranch(options);
    const cacheKey = this.scopeKey(scope, branch);

    // 1. Embed content
    const vector = await this.embeddingService.embed(options.content);

    // 2. Check for duplicate entries
    const entries = await this.getEntries(scope, branch);
    const duplicate = this.findDuplicateEntry(entries, vector);

    let entry: MemoryEntry;
    if (duplicate) {
      // Version chain: mark old entry as superseded, create new version
      const newId = crypto.randomUUID();
      this.logger.debug(`Duplicate detected, superseding ${duplicate.id} with ${newId}`);

      const oldVersion = duplicate.version ?? 1;

      // Mark old entry as superseded
      duplicate.isLatest = false;
      duplicate.supersededBy = newId;
      duplicate.updatedAt = Date.now();

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
        isLatest: true,
        previousVersionId: duplicate.id,
        version: oldVersion + 1,
      };
      entries.push(entry);
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
        isLatest: true,
        version: 1,
      };
      entries.push(entry);
    }

    // 3. Extract entities (if LLM available)
    const entityIds = await this.extractAndMergeEntities(options.content, entry.id, scope, branch);
    entry.entityIds = [...new Set([...entry.entityIds, ...entityIds])];

    // 4. Persist
    this.entryCache.set(cacheKey, entries);
    await this.persistEntries(scope, branch);
    await this.persistGraph(scope, branch);

    // 5. Regenerate markdown (non-blocking)
    this.regenerateMarkdown().catch((err) =>
      this.logger.debug("Markdown regeneration failed", err),
    );

    return entry;
  }

  // ── Recall ─────────────────────────────────────────────────────────

  async recall(options: RecallOptions): Promise<RecallResult> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const queryVector = await this.embeddingService.embed(options.query);

    const allMemories: Array<{ entry: MemoryEntry; score: number }> = [];
    const allEntities: Array<{ entity: MemoryEntity; score: number }> = [];

    // Determine which scopes to search
    const scopes = this.resolveScopesForRecall(options);

    for (const { scope, branch } of scopes) {
      // Search entries via vector store
      const results = await this.vectorStore.searchEntries(queryVector, scope, branch, topK);

      // Reinforce accessed memories and return the UPDATED entries so callers
      // see post-increment accessCount/lastAccessedAt (the search results are
      // detached copies read from LanceDB).
      if (results.length > 0) {
        const entries = await this.getEntries(scope, branch);
        for (const result of results) {
          const cached = entries.find((e) => e.id === result.entry.id);
          if (cached) {
            cached.accessCount += 1;
            cached.lastAccessedAt = Date.now();
            result.entry = cached;
          }
        }
        await this.persistEntries(scope, branch);
      }
      allMemories.push(...results);

      // Include graph entities if requested
      if (options.includeEntities) {
        const graph = await this.getGraph(scope, branch);
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

  async forget(options: ForgetOptions): Promise<number> {
    let count = 0;

    if (options.expired) {
      count += await this.forgetExpired(options);
    } else if (options.id) {
      // Forget specific memory by ID
      count += await this.forgetById(options.id);
    } else if (options.scope || options.branch || options.olderThan !== undefined) {
      count += await this.forgetByFilter(options);
    }

    // Regenerate markdown (non-blocking)
    this.regenerateMarkdown().catch((err) =>
      this.logger.debug("Markdown regeneration failed", err),
    );

    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async stats(): Promise<MemoryStats> {
    const branches = await this.vectorStore.listBranches();

    let totalMemories = 0;
    let totalEntities = 0;
    let totalRelationships = 0;
    let workspaceCount = 0;
    let branchCount = 0;
    let lastUpdated = 0;
    const entityTypes: Record<string, number> = {};

    // Workspace stats
    const wsEntries = await this.getEntries("workspace");
    workspaceCount = wsEntries.length;
    totalMemories += wsEntries.length;
    for (const entry of wsEntries) {
      if (entry.updatedAt > lastUpdated) {
        lastUpdated = entry.updatedAt;
      }
    }

    const wsGraph = await this.getGraph("workspace");
    totalEntities += wsGraph.entityCount;
    totalRelationships += wsGraph.edgeCount;
    for (const entity of wsGraph.getAllEntities()) {
      entityTypes[entity.type] = (entityTypes[entity.type] ?? 0) + 1;
    }

    // Branch stats
    for (const branch of branches) {
      const entries = await this.getEntries("branch", branch);
      branchCount += entries.length;
      totalMemories += entries.length;
      for (const entry of entries) {
        if (entry.updatedAt > lastUpdated) {
          lastUpdated = entry.updatedAt;
        }
      }

      const graph = await this.getGraph("branch", branch);
      totalEntities += graph.entityCount;
      totalRelationships += graph.edgeCount;
      for (const entity of graph.getAllEntities()) {
        entityTypes[entity.type] = (entityTypes[entity.type] ?? 0) + 1;
      }
    }

    return {
      totalMemories,
      totalEntities,
      totalRelationships,
      byScope: { workspace: workspaceCount, branch: branchCount },
      branches,
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
    const filtered = includeSuperseded
      ? results
      : results.filter((e) => e.isLatest !== false);

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
      if (!prev || versions.has(prev.id)) {break;}
      versions.set(prev.id, prev);
      current = prev;
    }

    // Walk forwards (supersededBy)
    current = entry;
    while (current?.supersededBy) {
      const next = byId.get(current.supersededBy);
      if (!next || versions.has(next.id)) {break;}
      versions.set(next.id, next);
      current = next;
    }

    // Sort newest first (by version number, fallback to updatedAt)
    return [...versions.values()].sort(
      (a, b) => (b.version ?? 1) - (a.version ?? 1),
    );
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

  /** Clear auto-decay timer and release resources. */
  dispose(): void {
    if (this.autoDecayTimer) {
      clearInterval(this.autoDecayTimer);
      this.autoDecayTimer = null;
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
    const tgt = targetScope ?? this.currentBranchScope();
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
  async promoteToWorkspace(branch: string, entryIds?: string[]): Promise<number> {
    const count = await this.scopeLinker.promoteToWorkspace(
      `branch:${branch}`,
      "workspace",
      entryIds,
    );
    // Invalidate workspace caches so next access reloads from store
    this.invalidateCache("workspace");
    return count;
  }

  /**
   * Find entities matching name+type across all scopes.
   */
  async findLinkedEntities(
    name: string,
    type: string,
  ): Promise<Array<{ scope: string; entity: MemoryEntity }>> {
    return this.scopeLinker.findLinkedEntities(name, type);
  }

  // ── Branch Detection ───────────────────────────────────────────────

  getCurrentBranch(): string | null {
    return this.branchDetector.getCurrentBranch();
  }

  // ── Private Methods ────────────────────────────────────────────────

  private scopeKey(scope: MemoryScope, branch?: string): string {
    return scope === "branch" && branch ? `branch:${branch}` : "workspace";
  }

  private invalidateCache(scopeKey: string): void {
    this.entryCache.delete(scopeKey);
    this.graphCache.delete(scopeKey);
  }

  private currentBranchScope(): string | null {
    const branch = this.branchDetector.getCurrentBranch();
    return branch ? `branch:${branch}` : null;
  }

  private async getGraph(scope: MemoryScope, branch?: string): Promise<MemoryGraph> {
    const key = this.scopeKey(scope, branch);
    let graph = this.graphCache.get(key);

    if (!graph) {
      const data = await this.vectorStore.loadGraph(scope, branch);
      graph = data ? MemoryGraph.fromJSON(data) : new MemoryGraph();
      this.graphCache.set(key, graph);
    }

    return graph;
  }

  private async getEntries(scope: MemoryScope, branch?: string): Promise<MemoryEntry[]> {
    const key = this.scopeKey(scope, branch);
    let entries = this.entryCache.get(key);

    if (!entries) {
      entries = await this.vectorStore.loadEntries(scope, branch);
      this.entryCache.set(key, entries);
    }

    return entries;
  }

  private async findEntryById(
    id: string,
  ): Promise<(MemoryEntry & { scope: MemoryScope; branch?: string }) | null> {
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

  private async persistGraph(scope: MemoryScope, branch?: string): Promise<void> {
    const key = this.scopeKey(scope, branch);
    const graph = this.graphCache.get(key);
    if (graph) {
      await this.vectorStore.saveGraph(graph.toJSON(), scope, branch);
    }
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

  private resolveBranch(options: { scope?: MemoryScope; branch?: string }): {
    scope: MemoryScope;
    branch: string | undefined;
  } {
    const scope = options.scope ?? "workspace";
    if (scope === "branch") {
      const branch = options.branch ?? this.branchDetector.getCurrentBranch() ?? undefined;
      if (!branch) {
        this.logger.warn("Branch scope requested but no branch detected, falling back to workspace");
        return { scope: "workspace", branch: undefined };
      }
      return { scope: "branch", branch };
    }
    return { scope: "workspace", branch: undefined };
  }

  private resolveScopesForRecall(options: RecallOptions): Array<{ scope: MemoryScope; branch?: string }> {
    if (options.scope === "workspace") {
      return [{ scope: "workspace" }];
    }
    if (options.scope === "branch") {
      const branch = options.branch ?? this.branchDetector.getCurrentBranch() ?? undefined;
      if (!branch) {
        return [{ scope: "workspace" }];
      }
      return [{ scope: "branch", branch }];
    }
    // Default: search both workspace and current branch
    const scopes: Array<{ scope: MemoryScope; branch?: string }> = [{ scope: "workspace" }];
    const branch = options.branch ?? this.branchDetector.getCurrentBranch() ?? undefined;
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
      const similarity = this.cosineSimilarity(vector, entry.vector);
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
  ): Promise<string[]> {
    if (!this.extractor) {
      return [];
    }

    const result = await this.extractor.extract(content);
    if (result.entities.length === 0) {
      return [];
    }

    const graph = await this.getGraph(scope, branch);
    const entityIds: string[] = [];

    // Process extracted entities
    const entityNameToId = new Map<string, string>();
    for (const extracted of result.entities) {
      const existing = graph.findDuplicate(extracted.name, extracted.type);

      if (existing) {
        // Merge: update description, add sourceMemoryId, bump strength
        const mergedDescription = existing.description.includes(extracted.description)
          ? existing.description
          : `${existing.description}; ${extracted.description}`;
        graph.updateEntity(existing.id, {
          description: mergedDescription,
          sourceMemoryIds: [...new Set([...existing.sourceMemoryIds, memoryId])],
          strength: Math.min(existing.strength + 0.1, 5.0),
          updatedAt: Date.now(),
        });
        entityIds.push(existing.id);
        entityNameToId.set(extracted.name.toLowerCase(), existing.id);
      } else {
        // New entity: embed description, assign UUID, add to graph
        const entityVector = await this.embeddingService.embed(extracted.description);
        const entity: MemoryEntity = {
          id: crypto.randomUUID(),
          name: extracted.name,
          type: extracted.type,
          description: extracted.description,
          vector: entityVector,
          scope,
          branch,
          confidence: 1.0,
          strength: 1.0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sourceMemoryIds: [memoryId],
          metadata: {},
        };
        graph.addEntity(entity);
        entityIds.push(entity.id);
        entityNameToId.set(extracted.name.toLowerCase(), entity.id);
      }
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

  private async forgetById(id: string): Promise<number> {
    // Search all scopes for this entry
    const wsEntries = await this.getEntries("workspace");
    const wsIdx = wsEntries.findIndex((e) => e.id === id);
    if (wsIdx !== -1) {
      const entry = wsEntries[wsIdx];
      wsEntries.splice(wsIdx, 1);
      await this.cleanupOrphanedEntities(entry, "workspace");
      await this.persistEntries("workspace");
      return 1;
    }

    const branches = await this.vectorStore.listBranches();
    for (const branch of branches) {
      const entries = await this.getEntries("branch", branch);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        const entry = entries[idx];
        entries.splice(idx, 1);
        await this.cleanupOrphanedEntities(entry, "branch", branch);
        await this.persistEntries("branch", branch);
        return 1;
      }
    }

    return 0;
  }

  private async forgetExpired(options: ForgetOptions): Promise<number> {
    let count = 0;

    const processScope = async (scope: MemoryScope, branch?: string) => {
      const entries = await this.getEntries(scope, branch);
      const graph = await this.getGraph(scope, branch);
      const removed = this.decayEngine.expireStale(entries, graph);

      if (removed.length > 0) {
        await this.persistEntries(scope, branch);
        await this.persistGraph(scope, branch);
        count += removed.length;
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

    return count;
  }

  private async forgetByFilter(options: ForgetOptions): Promise<number> {
    let count = 0;
    const now = Date.now();
    const olderThanMs = options.olderThan !== undefined ? options.olderThan * 24 * 60 * 60 * 1000 : undefined;

    // Guard: refuse to delete everything when no meaningful filter is provided
    if (olderThanMs === undefined) {
      this.logger.warn("forgetByFilter called without olderThan — refusing to delete all entries");
      return 0;
    }

    const processScope = async (scope: MemoryScope, branch?: string) => {
      const entries = await this.getEntries(scope, branch);
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
          await this.cleanupOrphanedEntities(entry, scope, branch);
        }
        await this.persistEntries(scope, branch);
        await this.persistGraph(scope, branch);
        count += toRemove.length;
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

    return count;
  }

  private async cleanupOrphanedEntities(
    removedEntry: MemoryEntry,
    scope: MemoryScope,
    branch?: string,
  ): Promise<void> {
    const graph = await this.getGraph(scope, branch);
    const entries = await this.getEntries(scope, branch);

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

  private mergeContent(existing: string, incoming: string): string {
    if (existing.includes(incoming)) {
      return existing;
    }
    return `${existing}\n${incoming}`;
  }

  private async regenerateMarkdown(): Promise<void> {
    if (!this.markdownPath) {
      return;
    }

    const workspaceEntries = await this.getEntries("workspace");
    const wsGraph = await this.getGraph("workspace");
    const branches = await this.vectorStore.listBranches();

    const branchEntries = new Map<string, MemoryEntry[]>();
    const branchEntities = new Map<string, MemoryEntity[]>();
    const branchRelationships = new Map<string, import("./types").MemoryRelationship[]>();

    for (const branch of branches) {
      branchEntries.set(branch, await this.getEntries("branch", branch));
      const graph = await this.getGraph("branch", branch);
      branchEntities.set(branch, graph.getAllEntities());
      branchRelationships.set(branch, graph.getAllRelationships());
    }

    const memoryStats = await this.stats();

    const markdown = this.exporter.generate({
      workspaceEntries,
      workspaceEntities: wsGraph.getAllEntities(),
      workspaceRelationships: wsGraph.getAllRelationships(),
      branchEntries,
      branchEntities,
      branchRelationships,
      stats: memoryStats,
    });

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.markdownPath), { recursive: true });
    await fs.writeFile(this.markdownPath, markdown, "utf-8");
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
