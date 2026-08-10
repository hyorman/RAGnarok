# Phase 4: Memory Integration + LangGraph Orchestration — Implementation Plan

> **Superseded.** The document knowledge graph, entity extraction over ingested
> documents, the `graph`/`graph_hybrid`/`ensemble` retrieval strategies, and the
> LangGraph orchestration layer were all removed. Graphs now exist only in the
> memory subsystem. This document is retained as design history only — see
> [ARCHITECTURE.md](../../ARCHITECTURE.md) and
> [docs/RETRIEVAL-PIPELINE.md](../RETRIEVAL-PIPELINE.md) for current behavior.

## TL;DR

Add rememory-inspired persistent memory (Fact/Preference/Episode entities with typed edges, temporal decay, cross-topic links) to the KnowledgeGraph from Phases 1-3, introduce a forgetting engine, adopt LangGraph for pipeline orchestration, and expose memory via MCP tools + VS Code UI.

---

## Prerequisites

This plan assumes Phase 1-3 deliverables exist:
- **Phase 1**: `KnowledgeGraph` class in `packages/core/src/stores/knowledgeGraph.ts` wrapping graphology + LanceDB persistence, with `GraphEntity` and `GraphRelationship` types
- **Phase 2**: `EntityExtractor` in `packages/core/src/agents/entityExtractor.ts` — LLM-powered entity/relationship extraction integrated into `DocumentPipeline`
- **Phase 3**: `GraphRetriever` in `packages/core/src/retrievers/graphRetriever.ts`, `GRAPH` and `GRAPH_HYBRID` in `RetrievalStrategy` enum, query routing in `QueryPlannerAgent`

If any are missing, they must be built first.

---

## Phase A: Memory Layer (packages/core)

### A1. Memory Types — `packages/core/src/utils/memoryTypes.ts` (NEW, ~120 lines)

Define memory-specific types extending Phase 1 graph types:

```
MemoryType = "fact" | "preference" | "episode"

MemoryEntity extends GraphEntity {
  memoryType: MemoryType
  confidence: number        // 0.0–1.0 (facts start at 1.0, episodes decay)
  strength: number          // access-based reinforcement counter
  accessCount: number
  lastAccessedAt: number    // epoch ms
  expiresAt?: number        // epoch ms, only for episodes
  isLatest: boolean         // versioning: false when superseded
  sourceTopicId: string     // topic where memory was created
}

MemoryRelationshipType = "updates" | "extends" | "derives"

MemoryRelationship extends GraphRelationship {
  memoryRelationType: MemoryRelationshipType
}

CrossTopicLink {
  id: string
  sourceTopicId: string
  sourceEntityId: string
  targetTopicId: string
  targetEntityId: string
  linkType: "same_entity" | "related" | "extends"
  confidence: number
  createdAt: number
}

MemoryStats {
  totalMemories: number
  byType: { fact: number, preference: number, episode: number }
  activeMemories: number  // isLatest=true
  expiredCount: number
  avgConfidence: number
  crossTopicLinks: number
}
```

### A2. MemoryManager — `packages/core/src/managers/memoryManager.ts` (NEW, ~400 lines)

Orchestrates memory CRUD operations. Methods:

- `storeMemory(entity: MemoryEntity, topicId: string)` — add to KnowledgeGraph for topicId, embed, check for duplicates/updates
- `recallMemory(query: string, options: RecallOptions)` — search across topics using cross-topic links
- `accessMemory(entityId: string)` — increment accessCount, update lastAccessedAt, boost strength
- `forgetMemory(entityId: string)` — mark as expired, cascade to relationships
- `getMemoryStats(topicId?: string)` — aggregate stats
- `findRelatedMemories(entityId: string)` — traverse `updates`/`extends`/`derives` edges

Constructor dependencies: `TopicManager`, `KnowledgeGraph` (per-topic), `EmbeddingService`, `ILLMProvider`

**Duplicate Detection**: Before storing, embed the memory content and search existing memories in same topic. If cosine similarity > 0.92:
- LLM classifies relationship: `updates` (supersedes), `extends` (additive), or `new` (distinct)
- If `updates`: set old memory `isLatest=false`, add `updates` edge
- If `extends`: add `extends` edge, increase old memory's strength

**Cross-Topic Memory**: When storing a memory, also search the `_memory` overlay table. If a match is found in a different topic, create a `CrossTopicLink`.

### A3. Cross-Topic Link Table — `packages/core/src/stores/crossTopicLinkStore.ts` (NEW, ~200 lines)

LanceDB table named `_cross_topic_links` in the shared LanceDB directory:

Schema:
- `id` (string): UUID
- `vector` (float[]): embedding of source entity description
- `sourceTopicId` (string)
- `sourceEntityId` (string)
- `targetTopicId` (string)
- `targetEntityId` (string)
- `linkType` (string): "same_entity" | "related" | "extends"
- `confidence` (float): similarity score when link was created
- `createdAt` (number): epoch ms

Operations:
- `addLink(link: CrossTopicLink)` — insert, embed source entity description for vector search
- `findLinksForEntity(entityId: string)` — filter by sourceEntityId or targetEntityId
- `findLinksForTopic(topicId: string)` — all links involving topic
- `deleteLinksByTopic(topicId: string)` — cascade when topic deleted
- `search(query: string, topK: number)` — vector search across all links

Link creation triggers:
1. During `MemoryManager.storeMemory()` — compare with other topics
2. During `EntityExtractor` Phase 2 extraction — if entity matches cross-topic

Cascade on topic deletion: `TopicManager.deleteTopic()` calls `crossTopicLinkStore.deleteLinksByTopic(topicId)`.

### A4. Memory-Specific Entity Extraction — Modify `EntityExtractor` (~50 lines added)

Extend existing EntityExtractor prompt to also classify memory type:
- Facts: statements of truth, definitions, specifications
- Preferences: repeated patterns, style guidelines, conventions
- Episodes: dated events, version releases, deployment records

Add `extractMemories(chunk: TextChunk, topicId: string): Promise<MemoryEntity[]>` method that wraps `extractEntities()` with memory-type classification.

### A5. Memory Overlay Topic — Convention

Use a special topic name `_memory` (prefixed with underscore to indicate system-internal). This topic stores:
- User-explicitly-created memories (via MCP `rag_store_memory` or VS Code UI)
- Cross-topic inferred memories

The `_memory` topic is created lazily on first memory operation. It is excluded from `getAllTopics()` listing unless explicitly requested. Add `isSystemTopic(name: string): boolean` helper to `TopicManager`.

---

## Phase B: Forgetting Engine (packages/core)

### B1. ForgettingEngine — `packages/core/src/managers/forgettingEngine.ts` (NEW, ~250 lines)

**Decay Formula** (from rememory):
```
decayedConfidence = confidence × e^(-λ × daysSinceLastAccess) × (1 + 0.1 × accessCount)
```
Where `λ` = `DECAY_LAMBDA` config (default: 0.05)

Methods:
- `runDecayCycle(topicId?: string)` — iterate all Episode and Preference entities, apply decay formula, update confidence
- `expireMemories(topicId?: string)` — remove entities where `expiresAt < Date.now()` or `confidence < CONFIDENCE_THRESHOLD`
- `cleanupOrphans(topicId?: string)` — remove relationships pointing to deleted entities
- `getDecayStatus(topicId?: string)` — report entities near threshold, recently expired counts

Constructor deps: `KnowledgeGraph` (per-topic or iterable), `MemoryManager`

**Automatic Scheduling**: In MCP server, start `setInterval` at `CLEANUP_INTERVAL_MINUTES` (default: 60). In VS Code, trigger on workspace startup + periodic (configurable). The interval is managed by whoever instantiates ForgettingEngine (MCP `index.ts` or VS Code `extension.ts`).

**Safety**: Facts never decay (confidence stays at initial value). Only Episode and Preference entities are subject to decay.

### B2. Strength Reinforcement

Handled in `MemoryManager.accessMemory()`:
- Increment `accessCount`
- If `accessCount > 5` and `memoryType === "preference"`: `strength = Math.min(strength + 0.1, 2.0)`
- Update `lastAccessedAt` to `Date.now()`
- Recalculate confidence using decay formula (may increase due to access boost)

---

## Phase C: LangGraph Integration (packages/core)

### C1. Dependencies

Add to `packages/core/package.json`:
- `@langchain/langgraph`: `^1.2.8`

Already present: `@langchain/core` `^1.0.0`

Estimated bundle size impact: @langchain/langgraph is ~200KB (minified), primarily pure TS with no native deps.

### C2. State Annotations — `packages/core/src/agents/graphState.ts` (NEW, ~100 lines)

Define LangGraph state schemas using `Annotation.Root`:

**QueryPipelineState**:
```
query: Annotation<string>
topicId: Annotation<string>
queryType: Annotation<"factual" | "relational" | "holistic" | "hybrid" | "memory_recall">
plan: Annotation<QueryPlan | null>
retrievalResults: Annotation<RetrievalResult[]>({ reducer: concat, default: [] })
memoryResults: Annotation<MemoryEntity[]>({ reducer: concat, default: [] })
confidence: Annotation<number>
iterations: Annotation<number>
answer: Annotation<string>
metadata: Annotation<Record<string, unknown>>
```

**IndexingPipelineState**:
```
filePaths: Annotation<string[]>
topicId: Annotation<string>
loadedDocs: Annotation<LangChainDocument[]>
chunks: Annotation<LangChainDocument[]>
embeddedChunks: Annotation<LangChainDocument[]>
extractedEntities: Annotation<GraphEntity[]>({ reducer: concat, default: [] })
extractedRelationships: Annotation<GraphRelationship[]>({ reducer: concat, default: [] })
communities: Annotation<Community[]>
pipelineResult: Annotation<PipelineResult | null>
checkpoint: Annotation<string>  // last completed stage name
errors: Annotation<string[]>({ reducer: concat, default: [] })
```

### C3. Query Pipeline Graph — `packages/core/src/agents/queryGraph.ts` (NEW, ~350 lines)

LangGraph `StateGraph` replacing the procedural flow in `RAGAgent.query()`:

**Nodes**:
1. `classifyQuery` — uses QueryPlannerAgent to determine query type + create plan
2. `vectorSearch` — runs VectorRetriever or HybridRetriever
3. `graphLocalSearch` — runs GraphRetriever in local mode (Phase 3)
4. `graphGlobalSearch` — runs GraphRetriever in global mode (Phase 3)
5. `memorySearch` — runs MemoryManager.recallMemory() with cross-topic expansion
6. `fuseResults` — merge multi-source results (RRF or weighted score fusion)
7. `evaluateConfidence` — check avgConfidence vs threshold
8. `refineQuery` — generate follow-up (existing gap analysis from RAGAgent)

**Edges**:
- `START → classifyQuery`
- `classifyQuery → [conditional]`:
  - `"factual"` → `vectorSearch`
  - `"relational"` → `graphLocalSearch`
  - `"holistic"` → `graphGlobalSearch`
  - `"hybrid"` → parallel `vectorSearch` + `graphLocalSearch`
  - `"memory_recall"` → `memorySearch`
- `vectorSearch → evaluateConfidence`
- `graphLocalSearch → evaluateConfidence`
- `graphGlobalSearch → END` (map-reduce, no iteration)
- `memorySearch → evaluateConfidence`
- `fuseResults → evaluateConfidence`
- `evaluateConfidence → [conditional]`:
  - confidence met → `END`
  - iterations < max → `refineQuery → [route back to retriever]`
  - iterations >= max → `END`

**Compilation**: `queryGraph.compile({ checkpointer })` — checkpointer optional, used for observability.

### C4. Indexing Pipeline Graph — `packages/core/src/agents/indexingGraph.ts` (NEW, ~300 lines)

LangGraph `StateGraph` wrapping `DocumentPipeline` stages:

**Nodes**:
1. `loadDocuments` — DocumentLoaderFactory
2. `chunkDocuments` — SemanticChunker
3. `embedChunks` — EmbeddingService batch
4. `storeChunks` — VectorStoreFactory
5. `extractEntities` — EntityExtractor (Phase 2) — conditional, only if KG enabled
6. `mergeEntities` — deduplicate entities across chunks
7. `embedEntities` — embed entity descriptions
8. `storeEntities` — write to KnowledgeGraph
9. `detectCommunities` — Louvain via graphology (Phase 3)
10. `summarizeCommunities` — LLM summaries (Phase 3)
11. `extractMemories` — classify entities as Fact/Preference/Episode, check cross-topic links

**Edges**: Linear with checkpoint after each node. `extractEntities` through `extractMemories` are conditional on `KG_ENABLED` config flag.

**Checkpoint storage**: JSON file `<storageDir>/checkpoints/<topicId>-indexing.json` — simple file-based, stores last completed node + state. On crash, resume from last checkpoint.

### C5. Integrate Query Graph into RAGQueryService — Modify `ragQueryService.ts` (~80 lines changed)

Add feature flag `LANGGRAPH_ENABLED` (default: `false`). When enabled:
- `executeQuery()` delegates to compiled `queryGraph.invoke()` instead of manually calling `RAGAgent.query()`
- When disabled: existing RAGAgent flow is unchanged (backward compatible)

`RAGAgent` is NOT deleted — it remains as the non-LangGraph fallback. The query graph nodes internally create and call the same retrievers RAGAgent uses.

### C6. Integrate Indexing Graph into DocumentPipeline — Modify `documentPipeline.ts` (~60 lines changed)

Same feature flag `LANGGRAPH_ENABLED`. When enabled:
- `processDocuments()` delegates to compiled `indexingGraph.invoke()` with checkpoint
- When disabled: existing sequential pipeline is unchanged

---

## Phase D: Memory-Aware Retrieval (packages/core)

### D1. Memory Boosting in Result Ranking — Modify `ragAgent.ts` `rankResults()` (~40 lines)

After standard ranking, boost results whose source entities have:
- **Access boost**: `score *= 1 + 0.05 × log(1 + accessCount)` — frequently accessed entities rank higher
- **Recency boost**: `score *= 1 + 0.1 × e^(-daysSinceLastAccess / 7)` — recently accessed entities get priority
- **Memory confidence boost**: `score *= entityConfidence` — high-confidence memories rank higher

These boosts apply only when memory entities are linked to retrieval results (via entityId metadata on chunks).

### D2. Cross-Topic Memory Expansion — Modify `MemoryManager.recallMemory()` (~60 lines)

When querying topic A:
1. Run standard retrieval in topic A
2. Extract entity IDs from top results
3. Query `CrossTopicLinkStore` for those entity IDs
4. If links found to topic B, run supplementary retrieval in topic B for linked entities
5. Merge cross-topic results with lower weight (0.5x) into final results

This is opt-in via `CROSS_TOPIC_MEMORY` config flag (default: `false`).

---

## Phase E: MCP Server Tools (packages/mcp-server)

### E1. New Tools — Modify `packages/mcp-server/src/tools.ts` (~200 lines added)

Register 4 new tools following existing pattern (`server.tool(name, description, zodSchema, handler)`):

**`rag_store_memory`**:
- Params: `content` (string), `memoryType` ("fact"|"preference"|"episode"), `topic` (string, optional — defaults to `_memory`), `expiresAt` (string ISO date, optional), `tags` (string[], optional)
- Handler: Call `memoryManager.storeMemory()`, return stored entity
- Zod schema: `z.object({ content: z.string(), memoryType: z.enum(...), ... })`

**`rag_recall_memory`**:
- Params: `query` (string), `topK` (number, optional), `memoryTypes` (string[], optional), `topic` (string, optional — null = all topics), `includeRelated` (boolean, optional)
- Handler: Call `memoryManager.recallMemory()`, return matched memories with scores
- Calls `accessMemory()` on each returned result (strength reinforcement)

**`rag_forget`**:
- Params: `id` (string, optional — forget specific memory), `topic` (string, optional — forget all below threshold in topic), `dryRun` (boolean, optional)
- Handler: If `id`, call `memoryManager.forgetMemory(id)`. If `topic`, call `forgettingEngine.expireMemories(topicId)`. If `dryRun`, return what would be forgotten without acting.

**`rag_memory_stats`**:
- Params: `topic` (string, optional — null = global stats)
- Handler: Call `memoryManager.getMemoryStats(topicId)`, return MemoryStats

### E2. Wire MemoryManager in MCP Server — Modify `packages/mcp-server/src/index.ts` (~30 lines)

After `TopicManager.create()`, instantiate:
1. `MemoryManager(topicManager, embeddingService, llmProvider)`
2. `ForgettingEngine(memoryManager)`
3. Start forgetting interval: `setInterval(() => forgettingEngine.runDecayCycle(), CLEANUP_INTERVAL_MINUTES * 60_000)`
4. Pass `memoryManager` and `forgettingEngine` to `registerTools()`

Update `registerTools()` signature to accept `memoryManager` and `forgettingEngine`.

### E3. MCP Config — Modify `packages/mcp-server/src/config.ts` (~15 lines)

Add to `McpConfig` interface and `loadConfig()`:
- `decayLambda`: `parseFloat(process.env.RAGNAROK_DECAY_LAMBDA || "0.05")`
- `confidenceThreshold`: (already exists) reuse for memory threshold
- `cleanupIntervalMinutes`: `parseInt(process.env.RAGNAROK_CLEANUP_INTERVAL_MINUTES || "60")`
- `kgEnabled`: `process.env.RAGNAROK_KG_ENABLED !== "false"` (default: true)
- `langGraphEnabled`: `process.env.RAGNAROK_LANGGRAPH_ENABLED === "true"` (default: false)
- `crossTopicMemory`: `process.env.RAGNAROK_CROSS_TOPIC_MEMORY === "true"` (default: false)

---

## Phase F: VS Code Extension Integration (packages/vscode)

### F1. Memory Persistence — No additional work needed

Memory persists in LanceDB tables and KnowledgeGraph JSON files under `context.globalStorageUri.fsPath`. These survive VS Code restarts. The `_memory` topic uses the same storage mechanism as regular topics.

### F2. Automatic Episode Creation — Modify `packages/vscode/src/ragTool.ts` (~30 lines)

After each successful query in `RAGTool.executeQuery()`:
- Create an Episode memory: `"User queried topic '{topicName}': '{query}' — {resultCount} results, confidence {confidence}"`
- Set `expiresAt` to 30 days from now (configurable via `EPISODE_TTL_DAYS`)
- Store via `memoryManager.storeMemory()` in the `_memory` topic

This is gated behind `MEMORY_ENABLED` VS Code config.

### F3. VS Code Settings — Modify `packages/vscode/src/constants.ts` (~10 lines)

Add to `VSCODE_CONFIG`:
- `MEMORY_ENABLED`: `"memoryEnabled"` (boolean, default: true)
- `DECAY_LAMBDA`: `"decayLambda"` (number, default: 0.05)
- `EPISODE_TTL_DAYS`: `"episodeTtlDays"` (number, default: 30)
- `KG_ENABLED`: `"kgEnabled"` (boolean, default: true)
- `LANGGRAPH_ENABLED`: `"langGraphEnabled"` (boolean, default: false)
- `CROSS_TOPIC_MEMORY`: `"crossTopicMemory"` (boolean, default: false)

Add corresponding entries to root `package.json` `contributes.configuration.properties`.

### F4. ForgettingEngine Scheduling — Modify `packages/vscode/src/extension.ts` (~20 lines)

On activation, if `MEMORY_ENABLED`:
1. Create `ForgettingEngine` instance
2. Run initial decay cycle (deferred, non-blocking)
3. Start `setInterval` at 60 minutes (configurable)
4. Add interval to `context.subscriptions` for cleanup on deactivation

### F5. Memory UI — Deferred

Tree view for memory browsing (view/delete memories) is **out of scope for Phase 4**. Can be added as a follow-up. The MCP tools and `rag_recall_memory` provide programmatic access. VS Code users can use Copilot chat with the MCP tools.

---

## Phase G: Config Keys (packages/core)

### G1. New Constants — Modify `packages/core/src/constants.ts` (~15 lines)

Add to `CONFIG`:
- `KG_ENABLED`: `"kgEnabled"` (boolean, default: true)
- `LANGGRAPH_ENABLED`: `"langGraphEnabled"` (boolean, default: false)
- `MEMORY_ENABLED`: `"memoryEnabled"` (boolean, default: true)
- `DECAY_LAMBDA`: `"decayLambda"` (number, default: 0.05)
- `MEMORY_CONFIDENCE_THRESHOLD`: `"memoryConfidenceThreshold"` (number, default: 0.1)
- `CLEANUP_INTERVAL_MINUTES`: `"cleanupIntervalMinutes"` (number, default: 60)
- `EPISODE_TTL_DAYS`: `"episodeTtlDays"` (number, default: 30)
- `CROSS_TOPIC_MEMORY`: `"crossTopicMemory"` (boolean, default: false)

Add to `DEFAULTS`:
- `DECAY_LAMBDA: 0.05`
- `MEMORY_CONFIDENCE_THRESHOLD: 0.1`
- `CLEANUP_INTERVAL_MINUTES: 60`
- `EPISODE_TTL_DAYS: 30`

---

## Phase H: Migration Strategy

### H1. Feature Flags

All Phase 4 features are gated:
- `KG_ENABLED=false` → no entity extraction, no graph retrieval, no memory (pure vector RAG, identical to current)
- `LANGGRAPH_ENABLED=false` → uses existing RAGAgent/DocumentPipeline procedural flow
- `MEMORY_ENABLED=false` → no memory storage, no decay, no cross-topic
- `CROSS_TOPIC_MEMORY=false` → memory works per-topic only

### H2. Backward Compatibility

- Existing topics with no KG data continue to work: all graph/memory operations check for existence before operating
- `RetrievalStrategy` enum additions (`GRAPH`, `GRAPH_HYBRID`) from Phase 3 are already backward-compatible
- LangGraph is an alternative code path, not a replacement — both paths produce identical `RAGQueryResult` output
- No schema migration needed for existing LanceDB tables — new tables are additive

### H3. Gradual Rollout

1. Ship with `LANGGRAPH_ENABLED=false`, `CROSS_TOPIC_MEMORY=false`
2. Users can opt-in via config
3. Once stable, flip defaults

---

## File-by-File Change List

### New Files

| File | Lines (est.) | Description |
|------|-------------|-------------|
| `packages/core/src/utils/memoryTypes.ts` | ~120 | Memory type definitions (MemoryEntity, MemoryRelationship, CrossTopicLink, MemoryStats) |
| `packages/core/src/managers/memoryManager.ts` | ~400 | Memory CRUD, duplicate detection, cross-topic linking |
| `packages/core/src/managers/forgettingEngine.ts` | ~250 | Decay calculation, expiration, orphan cleanup |
| `packages/core/src/stores/crossTopicLinkStore.ts` | ~200 | LanceDB `_cross_topic_links` table operations |
| `packages/core/src/agents/graphState.ts` | ~100 | LangGraph state annotations for query + indexing pipelines |
| `packages/core/src/agents/queryGraph.ts` | ~350 | LangGraph query pipeline (classify→route→retrieve→evaluate) |
| `packages/core/src/agents/indexingGraph.ts` | ~300 | LangGraph indexing pipeline with checkpointing |
| `packages/core/test/memoryManager.test.ts` | ~300 | Memory lifecycle tests |
| `packages/core/test/forgettingEngine.test.ts` | ~200 | Decay, expiration, cleanup tests |
| `packages/core/test/crossTopicLinks.test.ts` | ~200 | Cross-topic link CRUD and cascade tests |
| `packages/core/test/queryGraph.test.ts` | ~250 | LangGraph query pipeline tests |
| `packages/core/test/indexingGraph.test.ts` | ~200 | LangGraph indexing pipeline + checkpoint tests |
| `packages/mcp-server/test/memoryTools.test.ts` | ~200 | MCP memory tool tests |

### Modified Files

| File | Lines Changed (est.) | What Changes |
|------|---------------------|-------------|
| `packages/core/src/constants.ts` | +15 | Add CONFIG keys and DEFAULTS for memory/KG/LangGraph |
| `packages/core/src/index.ts` | +20 | Export new types, MemoryManager, ForgettingEngine, CrossTopicLinkStore, graph states |
| `packages/core/src/utils/types.ts` | +5 | Add `GRAPH`, `GRAPH_HYBRID`, `MEMORY_RECALL` to RetrievalStrategy (if not already from Phase 3) |
| `packages/core/src/agents/ragQueryService.ts` | +80 | Feature-flagged delegation to queryGraph when LANGGRAPH_ENABLED |
| `packages/core/src/agents/ragAgent.ts` | +40 | Memory boost in rankResults(), memory-aware scoring |
| `packages/core/src/managers/documentPipeline.ts` | +60 | Feature-flagged delegation to indexingGraph when LANGGRAPH_ENABLED |
| `packages/core/src/managers/topicManager.ts` | +20 | `isSystemTopic()` helper, cascade cross-topic link deletion on topic delete |
| `packages/core/src/agents/entityExtractor.ts` | +50 | `extractMemories()` method for memory-type classification (Phase 2 file) |
| `packages/mcp-server/src/tools.ts` | +200 | 4 new tools: rag_store_memory, rag_recall_memory, rag_forget, rag_memory_stats |
| `packages/mcp-server/src/index.ts` | +30 | Instantiate MemoryManager, ForgettingEngine, forgetting interval |
| `packages/mcp-server/src/config.ts` | +15 | New env vars for decay/cleanup/KG/LangGraph |
| `packages/vscode/src/ragTool.ts` | +30 | Automatic Episode creation on query |
| `packages/vscode/src/extension.ts` | +20 | ForgettingEngine scheduling |
| `packages/vscode/src/constants.ts` | +10 | New VSCODE_CONFIG keys |
| `packages/core/package.json` | +1 | Add @langchain/langgraph dependency |
| `package.json` | +20 | Add contributes.configuration.properties for new settings |

**Total estimated new code**: ~2,870 lines (source) + ~1,350 lines (tests) = ~4,220 lines

---

## Dependencies

| Package | Version | Purpose | Bundle Impact |
|---------|---------|---------|--------------|
| `@langchain/langgraph` | `^1.2.8` | Pipeline orchestration, state graphs | ~200KB minified |

Already present: `@langchain/core` `^1.0.0`, `graphology` (Phase 1), `graphology-communities-louvain` (Phase 1)

No new native dependencies. No SQLite needed (unlike rememory) — all storage uses existing LanceDB + JSON.

---

## Verification Plan

### Automated Tests

1. **Memory lifecycle** (`memoryManager.test.ts`):
   - Store fact, preference, episode → verify in KnowledgeGraph
   - Duplicate detection: store similar memory → verify `updates` edge created, old `isLatest=false`
   - `extends` edge: store additive memory → verify both remain `isLatest=true`
   - `accessMemory()` → verify accessCount, lastAccessedAt, strength updates
   - `forgetMemory()` → verify entity and relationships removed

2. **Forgetting engine** (`forgettingEngine.test.ts`):
   - Decay calculation: create episode, advance time, verify confidence decreases
   - Access boost: create episode, access it, verify decay is slower
   - Fact immunity: create fact, advance time, verify confidence unchanged
   - Expiration: create episode with expiresAt in past, run cycle, verify removed
   - Orphan cleanup: delete entity, verify dangling relationships removed
   - Threshold: set confidence threshold to 0.5, verify low-confidence entities removed

3. **Cross-topic links** (`crossTopicLinks.test.ts`):
   - Add link between topic A entity and topic B entity → verify stored in LanceDB
   - `findLinksForEntity()` → finds by source or target
   - Topic deletion cascade → all links involving deleted topic removed
   - Vector search on links → returns relevant cross-topic matches

4. **LangGraph query pipeline** (`queryGraph.test.ts`):
   - Factual query → routes to vectorSearch → returns results
   - Relational query → routes to graphLocalSearch
   - Holistic query → routes to graphGlobalSearch
   - Confidence loop: low confidence → refineQuery → re-retrieve → converge
   - Memory recall query → routes to memorySearch

5. **LangGraph indexing pipeline** (`indexingGraph.test.ts`):
   - Full pipeline: load → chunk → embed → store → extract → communities
   - Checkpoint/resume: interrupt mid-pipeline, resume from checkpoint
   - KG disabled: pipeline skips extraction nodes

6. **MCP memory tools** (`memoryTools.test.ts`):
   - `rag_store_memory` → success response with entity
   - `rag_recall_memory` → returns matching memories
   - `rag_forget` → removes memory; dry-run returns count
   - `rag_memory_stats` → returns valid stats object
   - Error handling: invalid memoryType, missing content

7. **Integration** (add to existing `integration.test.ts`):
   - End-to-end: index document → extract memories → query → memory surfaces → forget → query again → memory gone

### Manual Verification

1. Run `npm test --workspace=packages/core` — all existing + new tests pass
2. Run `npm test --workspace=packages/mcp-server` — memory tool tests pass
3. Start MCP server, call `rag_store_memory`, `rag_recall_memory`, verify round-trip
4. Set `LANGGRAPH_ENABLED=true`, run `rag_query`, compare results with `LANGGRAPH_ENABLED=false`
5. Load VS Code extension, index a topic, check that Episode memories appear in `_memory` topic
6. Run `npm run lint` — no errors
7. Run `npm run format:check` — no formatting issues

---

## Decisions

1. **No SQLite**: Unlike rememory which uses SQLite for graph + FTS5, RAGnarōk uses LanceDB for everything (vectors, link tables) and graphology for in-memory graph ops. This maintains the zero-external-dependency embedded architecture.
2. **LangGraph as opt-in**: `LANGGRAPH_ENABLED=false` by default. Existing procedural code remains the primary path until thoroughly validated.
3. **Cross-topic memory off by default**: Searching across topics adds latency and complexity. Users opt in explicitly.
4. **No Memory UI in Phase 4**: Tree view for browsing memories deferred to avoid scope creep. MCP tools provide full CRUD.
5. **`_memory` topic convention**: System topics prefixed with `_` rather than a separate storage mechanism. Reuses existing TopicManager infrastructure.
6. **File-based checkpointing**: LangGraph checkpoints stored as JSON files rather than SQLite. Simpler for embedded use, sufficient for crash recovery.
7. **Memory boost is multiplicative**: Applied after standard ranking, not as a separate retrieval signal. Avoids disrupting existing retrieval benchmarks for non-memory queries.

---

## Implementation Order & Dependencies

```
Phase A (Memory Layer) ← no deps, can start immediately
  A1 → A2, A3, A4, A5 (A1 must be first; A2-A5 parallel after A1)

Phase B (Forgetting Engine) ← depends on A2
  B1 → B2

Phase C (LangGraph) ← depends on Phase 1-3 deliverables
  C1 → C2 → C3, C4 (parallel) → C5, C6 (parallel)

Phase D (Memory-Aware Retrieval) ← depends on A2, A3
  D1, D2 (parallel)

Phase E (MCP Tools) ← depends on A2, B1
  E1 → E2 → E3

Phase F (VS Code) ← depends on A2, B1
  F1 (no work), F2, F3, F4 (parallel)

Phase G (Config) ← start early, no deps
  G1 (do first, other phases reference these keys)

Phase H (Migration) ← docs/validation, do last
```

**Recommended execution order**: G1 → A1 → A2+A3+A4+A5 → B1+B2 → C1→C2→C3+C4→C5+C6 → D1+D2 → E1+E2+E3 → F2+F3+F4 → tests → H
