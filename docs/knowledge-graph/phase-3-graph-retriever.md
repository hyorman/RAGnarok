# Phase 3 Plan: Graph Retriever + Query Routing

## TL;DR
Add a `GraphRetriever` that queries the Phase 1/2 KnowledgeGraph (local search via entity neighborhood traversal, global search via community summaries), introduce `GRAPH` and `GRAPH_HYBRID` retrieval strategies, and update query routing so the QueryPlannerAgent can dynamically select graph-based retrieval for relationship-aware and holistic queries.

## Assumptions (Phase 1 & 2 deliverables)
Phase 3 assumes these already exist:
- **KnowledgeGraph class** (`packages/core/src/stores/knowledgeGraph.ts`): wraps graphology, stores `GraphEntity` (name, type, description, embedding, sourceChunkIds[]) and `GraphRelationship` (source, target, description, weight), persists to LanceDB entity/relationship tables, loads graph from LanceDB into graphology, exposes entity lookup, neighbor traversal, community detection (Louvain via graphology-communities-louvain)
- **GraphEntity/GraphRelationship types** in `packages/core/src/utils/types.ts` or the KnowledgeGraph module
- **EntityExtractor** (`packages/core/src/agents/entityExtractor.ts`): LLM-based entity+relationship extraction from document chunks, integrated into DocumentPipeline as optional post-chunking step
- **LanceDB tables per topic**: `<topicId>` (chunks), `<topicId>_entities`, `<topicId>_relationships`

---

## Steps

### Phase A: GraphRetriever Core (no dependencies on other phases)

**Step 1. Create `GraphRetriever` class**
- File: `packages/core/src/retrievers/graphRetriever.ts` (NEW, ~250-300 lines)
- Constructor: `(knowledgeGraph: KnowledgeGraph, vectorRetriever: VectorRetriever, llmProvider: ILLMProvider)`
- Store refs to KG, vectorRetriever, llmProvider

**Step 2. Implement Local Search** (entity-specific queries)
- Method: `public async localSearch(query: string, k: number): Promise<GraphSearchResult[]>`
- Step 2a: Extract entity mentions from query
  - Simple: keyword match against KG entity names (case-insensitive substring/token matching against `knowledgeGraph.getEntityNames()`)
  - Enhanced (if LLM available): send query to LLM asking "Extract entity names from this query" — use `ILLMProvider.selectModel()` + `sendRequest()` with short timeout (5s), fall back to keyword if LLM unavailable
- Step 2b: Vector search in entity table — call `knowledgeGraph.searchEntitiesByEmbedding(queryEmbedding, k*2)` to find semantically similar entities by description embedding (this leverages Phase 1's LanceDB entity table vector index)
- Step 2c: Merge entity matches from 2a + 2b, deduplicate by entity name
- Step 2d: For each matched entity, BFS traverse neighbors via graphology, up to `maxHopDepth` hops (default: 2). Collect entity nodes + their `sourceChunkIds`
- Step 2e: Score entities: `entityScore = matchScore * hopDecay^hopDistance` where `hopDecay = 0.5` (configurable). matchScore = 1.0 for exact name match, vector similarity score for embedding match
- Step 2f: Collect unique chunk IDs from all scored entities, weighted by entity score
- Step 2g: Retrieve actual document chunks from vectorRetriever (or direct LanceDB ID lookup via `knowledgeGraph.getChunksByIds(chunkIds)`)
- Step 2h: Return `GraphSearchResult[]` sorted by score, limited to k

**Step 3. Implement Global Search** (holistic queries)
- Method: `public async globalSearch(query: string, k: number): Promise<GraphSearchResult[]>`
- Step 3a: Get community summaries from KG — `knowledgeGraph.getCommunitySummaries()` returns `{communityId, summary, memberEntityNames[], representativeChunkIds[]}`
- Step 3b: If LLM available: map-reduce relevance filtering
  - Map: For each community summary, ask LLM "Is this community relevant to query X? Score 0-1" (batch, short timeout)
  - Reduce: rank communities by relevance score, take top N
  - Fall back to vector similarity of query vs community summary embeddings if LLM unavailable
- Step 3c: From top-ranked communities, collect `representativeChunkIds`
- Step 3d: Retrieve chunks and return scored results

**Step 4. Define result types**
- `GraphSearchResult`: `{ document: LangChainDocument, score: number, graphMetadata?: { matchedEntities: string[], hopDepth: number, communityId?: string } }`
- Ensure it's compatible with `RetrievalResult` in ragAgent.ts (same `document` + `score` shape)

### Phase B: GraphHybridRetriever (depends on Step 1-4)

**Step 5. Create `GraphHybridRetriever` class**
- File: `packages/core/src/retrievers/graphHybridRetriever.ts` (NEW, ~120-150 lines)
- Constructor: `(graphRetriever: GraphRetriever, vectorRetriever: VectorRetriever)`
- Follow the weighted score fusion pattern from `HybridRetriever`
- Method: `public async search(query: string, options: GraphHybridSearchOptions): Promise<GraphHybridSearchResult[]>`

**Step 6. Implement fusion logic**
- Fetch candidates from both GraphRetriever.localSearch() and VectorRetriever.search() in parallel (fetch k*2 from each)
- Build candidate map keyed by chunkId (same dedup pattern as HybridRetriever)
- Score: `fusedScore = graphWeight * graphScore + vectorWeight * vectorScore`
- Default weights: `graphWeight = 0.3, vectorWeight = 0.7` (vector-dominant, graph as boost)
- Normalize graph scores to [0,1] if not already
- Sort, filter by minSimilarity, limit to k

**Step 7. Graceful fallback**
- If GraphRetriever returns 0 results (KG empty/unavailable), return pure vector results
- If VectorRetriever fails, return pure graph results
- Log degradation

### Phase C: Strategy Enum & Config (parallel with Phase B)

**Step 8. Update `RetrievalStrategy` enum**
- File: `packages/core/src/utils/types.ts`
- Add: `GRAPH = "graph"`, `GRAPH_HYBRID = "graph_hybrid"`

**Step 9. Add config constants**
- File: `packages/core/src/constants.ts`
- Add to `CONFIG` object:
  - `GRAPH_WEIGHT: "graphWeight"` (default: 0.3)
  - `VECTOR_WEIGHT_IN_GRAPH_HYBRID: "vectorWeightInGraphHybrid"` (default: 0.7)
  - `MAX_HOP_DEPTH: "maxHopDepth"` (default: 2)
  - `HOP_DECAY: "hopDecay"` (default: 0.5)
  - `COMMUNITY_TOP_N: "communityTopN"` (default: 5)

**Step 10. Update VS Code extension settings**
- File: `package.json` (root) — `ragnarok.retrievalStrategy` enum
- Add `"graph"` and `"graph_hybrid"` to the enum array + enumDescriptions
- Add new settings: `ragnarok.graphWeight`, `ragnarok.maxHopDepth`

**Step 11. Update MCP server strategy enum**
- File: `packages/mcp-server/src/tools.ts` — rag_query tool's retrievalStrategy enum
- Add `"graph"` and `"graph_hybrid"` to the Zod `.enum([...])` list

### Phase D: RAGAgent Integration (depends on Phase A, B, C)

**Step 12. Add KnowledgeGraph to RAGAgent.initialize()**
- File: `packages/core/src/agents/ragAgent.ts`
- Add optional `knowledgeGraph` field: `private knowledgeGraph: KnowledgeGraph | null = null`
- Extend `initialize()` options: `{ documentFetcher?, knowledgeGraph? }`
- Store the KG reference (may be null if no KG exists for this topic)

**Step 13. Add GraphRetriever + GraphHybridRetriever to lazy init**
- Add fields: `private graphRetriever: GraphRetriever | null = null`, `private graphHybridRetriever: GraphHybridRetriever | null = null`
- In `initializeRetrieversForStrategy()`:
  - GRAPH and GRAPH_HYBRID need `this.knowledgeGraph` — if null, throw descriptive error
  - Create VectorRetriever (same as existing)
  - Create GraphRetriever with (knowledgeGraph, vectorRetriever, llmProvider)
  - For GRAPH_HYBRID: create GraphHybridRetriever with (graphRetriever, vectorRetriever)

**Step 14. Update `dispatchSearch()`**
- Add two new branches:
  - `RetrievalStrategy.GRAPH`: call `graphRetriever.localSearch(query, topK)` — map to common result type
  - `RetrievalStrategy.GRAPH_HYBRID`: call `graphHybridRetriever.search(query, { k: topK, graphWeight, vectorWeight })`
- The graph results already return `{ document, score }` so mapping is straightforward (same as VectorRetriever branch)

**Step 15. Handle missing KG fallback in dispatchSearch**
- If strategy is GRAPH/GRAPH_HYBRID but `this.knowledgeGraph` is null:
  - Log warning: "Knowledge graph not available, falling back to vector"
  - Dispatch as VECTOR instead (graceful degradation, not error)
- This avoids breaking queries when KG hasn't been built yet

### Phase E: QueryPlannerAgent Routing (parallel with Phase D)

**Step 16. Update heuristic plan classification**
- File: `packages/core/src/agents/queryPlannerAgent.ts`
- Add graph signal detection in `createHeuristicPlan()`:
  - Relationship words: `/\b(relate[sd]?\s+to|connects?|depends?\s+on|calls?|linked\s+to|associated\s+with|interacts?\s+with|caused?\s+by|leads?\s+to)\b/i`
  - Entity-specific patterns: `/\b(entity|entities|node|relationship|connection|graph)\b/i`
  - Holistic patterns: `/\b(main\s+themes?|overview|summarize|high[\s-]?level|big\s+picture|overall|key\s+concepts?)\b/i`
- When graph signals detected AND strategy is not explicitly set by user:
  - Relationship queries → recommend GRAPH
  - Holistic/summary queries → recommend GRAPH (global search)
  - Mixed relationship + factual → recommend GRAPH_HYBRID

**Step 17. Update LLM refinement prompt**
- In `buildRefinementPrompt()`: add graph/graph_hybrid as strategy options in the prompt text
- Add guidance: "If the query asks about relationships between entities, dependencies, or connections, recommend graph strategy. If the query asks for themes, overviews, or summaries, recommend graph strategy."
- Note: The planner currently doesn't change strategy — it decomposes sub-queries. Strategy recommendation would be informational in the plan's `explanation` field. Actual strategy selection stays with the caller (RAGQueryService or user).

**Step 18. Update `analyzeComplexityScore()`**
- Add relationship pattern detection as a complexity signal (+0.15 for relationship words)
- This naturally upweights graph-suitable queries to at least "moderate" complexity

### Phase F: RAGQueryService Integration (depends on Phase D)

**Step 19. Load KnowledgeGraph in RAGQueryService.getOrCreateAgent()**
- File: `packages/core/src/agents/ragQueryService.ts`
- After loading vectorStore, attempt to load KG: `const kg = await this.topicManager.getKnowledgeGraph(topicId)`
  - This requires TopicManager to have a `getKnowledgeGraph()` method (Phase 1 deliverable)
  - If KG doesn't exist (returns null), pass null to agent — agent will fallback
- Pass KG to `agent.initialize(vectorStore, { documentFetcher, knowledgeGraph: kg })`

**Step 20. Validate strategy against KG availability**
- Before calling `agent.query()`, if strategy is GRAPH/GRAPH_HYBRID and KG is null:
  - Log info: "No knowledge graph for topic X, falling back to hybrid"
  - Override retrievalStrategy to HYBRID (or VECTOR) in agentOptions
  - This gives the user a cleaner experience than the agent-level fallback

### Phase G: Community Summarization (can be deferred, partially parallel)

**Step 21. Community detection runner**
- This lives in KnowledgeGraph class (Phase 1) — expose `runCommunityDetection(): CommunityInfo[]`
- Uses graphology-communities-louvain to partition the graph
- Returns community assignments for each node

**Step 22. Community summarization via LLM**
- Method on KnowledgeGraph or a new `CommunitySummarizer` utility
- For each community: collect member entity names + descriptions, top relationships
- LLM prompt: "Summarize this group of related entities: [entity1: desc1, entity2: desc2, ...]. Key relationships: [A->B: desc]. Provide a 2-3 sentence summary."
- Store summary in KG metadata (graphology node/edge attributes or separate Map)
- Persist to LanceDB as separate `<topicId>_communities` table with columns: `communityId`, `summary`, `memberEntities`, `representativeChunkIds`, `vector` (embedding of summary)

**Step 23. Incremental updates**
- When new entities are added (via EntityExtractor), mark communities as "dirty"
- Re-run community detection + re-summarize only dirty communities
- Store a `lastCommunityUpdate` timestamp in KG metadata

### Phase H: Exports & Config Wiring

**Step 24. Update core barrel exports**
- File: `packages/core/src/index.ts`
- Export: `GraphRetriever`, `GraphHybridRetriever`, `GraphSearchResult`, `GraphHybridSearchResult`, `GraphHybridSearchOptions`

**Step 25. Update VS Code topicTreeView**
- File: `packages/vscode/src/topicTreeView.ts`
- Add GRAPH and GRAPH_HYBRID cases to `formatConfigLabel()` switch

**Step 26. Update MCP config**
- File: `packages/mcp-server/src/config.ts`
- The `retrievalStrategy` default can stay "hybrid"; no special changes needed, just the Zod enum update from Step 11

---

## Relevant Files

### New files
- `packages/core/src/retrievers/graphRetriever.ts` — GraphRetriever class (local + global search), ~250-300 lines
- `packages/core/src/retrievers/graphHybridRetriever.ts` — GraphHybridRetriever class (fusion), ~120-150 lines

### Modified files
- `packages/core/src/utils/types.ts` — Add GRAPH, GRAPH_HYBRID to RetrievalStrategy enum
- `packages/core/src/constants.ts` — Add GRAPH_WEIGHT, VECTOR_WEIGHT_IN_GRAPH_HYBRID, MAX_HOP_DEPTH, HOP_DECAY, COMMUNITY_TOP_N config keys
- `packages/core/src/agents/ragAgent.ts` — Add graphRetriever/graphHybridRetriever fields, extend initialize(), update initializeRetrieversForStrategy(), update dispatchSearch(), add KG fallback logic
- `packages/core/src/agents/queryPlannerAgent.ts` — Add graph signal detection in createHeuristicPlan(), update LLM prompt, update analyzeComplexityScore()
- `packages/core/src/agents/ragQueryService.ts` — Load KG in getOrCreateAgent(), validate strategy against KG availability
- `packages/core/src/index.ts` — Export new retrievers and types
- `package.json` (root) — Add graph/graph_hybrid to ragnarok.retrievalStrategy enum + new config settings
- `packages/mcp-server/src/tools.ts` — Add graph/graph_hybrid to Zod enum
- `packages/vscode/src/topicTreeView.ts` — Add GRAPH/GRAPH_HYBRID display labels

### Reference files (no changes, use as patterns)
- `packages/core/src/retrievers/vectorRetriever.ts` — Base retriever pattern (constructor, search, normalizeDistance)
- `packages/core/src/retrievers/hybridRetriever.ts` — Score fusion pattern (candidateMap, weighted scoring, re-ranking)
- `packages/core/src/retrievers/ensembleRetriever.ts` — RRF pattern, getDocumentId() helper
- `packages/core/src/retrievers/keywordRetriever.ts` — Initialize/search pattern, isInitialized() guard
- `packages/core/src/interfaces.ts` — ILLMProvider, IConfigProvider interfaces

---

## Verification

1. **Unit tests** (`packages/core/test/graphRetriever.test.ts`, NEW):
   - Mock KnowledgeGraph with known entities/relationships
   - Test localSearch: entity extraction from query, BFS traversal (1-hop, 2-hop), hop decay scoring, chunk ID collection
   - Test globalSearch: community summary filtering, chunk retrieval
   - Test edge cases: empty KG, no matching entities, disconnected graph components
   - Test LLM fallback: LLM unavailable → keyword-only entity extraction

2. **Unit tests** (`packages/core/test/graphHybridRetriever.test.ts`, NEW):
   - Test fusion scoring with known graph + vector scores
   - Test fallback: graph returns 0 results → pure vector output
   - Test weight configuration

3. **Integration tests** (extend `packages/core/test/ragAgent.test.ts` or `ragQueryService.test.ts`):
   - RAGAgent dispatches GRAPH strategy correctly
   - RAGAgent falls back to VECTOR when KG is null
   - GRAPH_HYBRID combines results from both retrievers

4. **QueryPlannerAgent tests** (extend `packages/core/test/queryPlannerAgent.test.ts`):
   - "How does X relate to Y?" triggers graph signal detection
   - "What are the main themes?" triggers holistic detection
   - Complexity score increases for relationship-heavy queries

5. **MCP tool test**: verify `rag_query` accepts "graph" and "graph_hybrid" strategy values

6. **Manual verification**:
   - Ingest a topic with documents → build KG (Phase 2) → query with `--strategy graph`
   - Verify graph results contain entities from KG neighborhood
   - Verify GRAPH_HYBRID merges graph + vector results
   - Verify VECTOR still works unchanged (no regressions)

7. **Run existing test suites**: `npm run test:core` to confirm no regressions in existing 303 tests

---

## Decisions

- **No LangGraph dependency**: The existing RAGAgent loop + QueryPlannerAgent pattern is sufficient for routing. LangGraph adds complexity without clear value at this stage.
- **Phase 1/2 assumed complete**: KnowledgeGraph class, GraphEntity/GraphRelationship types, EntityExtractor, and LanceDB entity/relationship tables must exist before Phase 3 can be implemented.
- **Separate GraphRetriever file** (not extending existing retrievers): Graph retrieval is fundamentally different from vector/keyword search. A new file keeps concerns clean.
- **Separate GraphHybridRetriever** (not extending HybridRetriever): HybridRetriever fuses vector+keyword; GraphHybridRetriever fuses vector+graph. Different composition, different defaults, cleaner separation.
- **Strategy fallback at two levels**: RAGQueryService pre-checks KG availability (user-friendly message), RAGAgent.dispatchSearch() also falls back (defensive).
- **Community summarization (Phase G) can be deferred**: GraphRetriever local search works without communities. Global search gracefully returns empty if no communities exist. This can ship after the core GraphRetriever.
- **QueryPlannerAgent doesn't auto-switch strategy**: It detects graph signals and records them in explanation/reasoning, but doesn't override the user's chosen strategy. Strategy selection remains explicit.
- **Default weights V0.7/G0.3**: Conservative start — vector-dominant with graph as boost. Can be tuned via benchmarks later.

## Further Considerations

1. **Entity vector search dependency**: Step 2b requires KnowledgeGraph to expose `searchEntitiesByEmbedding()` backed by the LanceDB entity table. Verify Phase 1 implements this. If not, local search falls back to name-matching only (Step 2a).

2. **Community summarization LLM cost**: Phase G generates one LLM call per community. For large KGs (100+ communities), this could be expensive. Consider: (a) summarize lazily on first global search query, (b) cap at 20 communities, (c) skip small communities (<3 members).

3. **Auto-strategy selection**: Currently the plan keeps strategy selection explicit (user/config). A future enhancement could have QueryPlannerAgent automatically select GRAPH_HYBRID when graph signals are detected AND a KG exists — this would require passing KG availability info to the planner. Recommend deferring to avoid scope creep.
