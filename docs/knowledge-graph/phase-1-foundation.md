# Phase 1 Plan: Knowledge Graph Foundation — Data Layer

## TL;DR
Add graphology as an in-memory graph engine with new KG types, a `KnowledgeGraph` class wrapping graphology, and LanceDB persistence for entity/edge tables — all scoped per-topic, matching the existing architecture. No new retrieval strategy — just the data layer and serialization.

---

## Dependencies

### Production (packages/core/package.json `dependencies`)
| Package | Version | Purpose |
|---------|---------|---------|
| `graphology` | `^0.26.0` | In-memory directed graph (951K weekly DL, built-in TS) |
| `graphology-communities-louvain` | `^2.0.2` | Louvain community detection (37K weekly DL, built-in TS) |
| `graphology-traversal` | `^0.3.1` | BFS/DFS traversal helpers (407K weekly DL, built-in TS) |
| `graphology-types` | `^0.24.8` | TypeScript type declarations for graphology (peer dep) |

### Dev Dependencies — none needed (all graphology packages ship built-in TS declarations)

---

## Steps

### Phase 1A: Types & Dependencies

**Step 1 — Add graphology dependencies** (*no dependency*)
- Add `graphology`, `graphology-types`, `graphology-communities-louvain`, `graphology-traversal` to `packages/core/package.json` `dependencies`
- Run `npm install` from workspace root

**Step 2 — Add KG types** (*no dependency*)
- Create new file `packages/core/src/utils/graphTypes.ts`
- Keep separate from `types.ts` to avoid bloating the existing file and to future-proof for memory types
- Types to define:

```
EntityType — string union: "class" | "function" | "module" | "concept" | "person" | "organization" | "location" | "event" | "fact" | "preference" | "episode" | "other"
  (string union, not enum, to match codebase convention for extensibility — allows future types without breaking changes)

RelationshipType — string union: "calls" | "imports" | "inherits" | "implements" | "references" | "contains" | "related_to" | "depends_on" | "similar_to" | "contradicts" | "other"
  (same reasoning as EntityType)

GraphEntity — interface:
  id: string                       // unique entity ID (UUID)
  name: string                     // canonical entity name
  type: EntityType                 // entity classification
  description: string              // natural language description (embedded for vector search)
  vector: number[]                 // embedding of description (same model as topic's chunks)
  sourceChunkIds: string[]         // provenance: which TextChunks mentioned this entity
  confidence: number               // 0-1, extraction confidence (default 1.0)
  strength: number                 // 0-1, how prominent/important this entity is (default 0.5)
  lastAccessedAt: number           // timestamp for future LRU/decay
  metadata: Record<string, unknown> // extensible metadata bag

GraphRelationship — interface:
  id: string                       // unique edge ID (UUID)
  sourceId: string                 // source entity ID
  targetId: string                 // target entity ID
  type: RelationshipType           // relationship classification
  weight: number                   // 0-1, relationship strength (default 0.5)
  description?: string             // optional NL description of the relationship
  sourceChunkIds: string[]         // provenance: which TextChunks produced this edge
  confidence: number               // 0-1, extraction confidence (default 1.0)
  metadata: Record<string, unknown> // extensible metadata bag

KnowledgeGraphData — interface (serializable snapshot):
  entities: GraphEntity[]
  relationships: GraphRelationship[]
  communities: GraphCommunity[]
  metadata: {
    topicId: string
    createdAt: number
    updatedAt: number
    entityCount: number
    edgeCount: number
    communityCount: number
    embeddingModel: string
  }

GraphCommunity — interface:
  id: number                       // Louvain community label (integer)
  entityIds: string[]              // entities in this community
  summary?: string                 // LLM-generated summary (Phase 2+)
  level: number                    // hierarchy level (0 = base)
  parentId?: number                // parent community at higher level
  metadata: Record<string, unknown>

KnowledgeGraphStats — interface:
  entityCount: number
  edgeCount: number
  averageDegree: number
  communityCount: number
  density: number
  connectedComponents: number
```

**Step 3 — Export new types** (*depends on Step 2*)
- Add exports to `packages/core/src/index.ts`:
  - `export { EntityType, RelationshipType, GraphEntity, GraphRelationship, KnowledgeGraphData, GraphCommunity, KnowledgeGraphStats } from "./utils/graphTypes"`
  - `export { KnowledgeGraph } from "./stores/knowledgeGraph"` (added in Step 4)

### Phase 1B: KnowledgeGraph Class

**Step 4 — Create KnowledgeGraph class** (*depends on Step 1, Step 2*)
- Create new file `packages/core/src/stores/knowledgeGraph.ts`
- Class wraps a graphology `DirectedGraph` with typed node/edge attributes
- Scoped to a single topic (accepts `topicId` in constructor)

Constructor & Properties:
- `constructor(topicId: string)` — creates empty DirectedGraph
- Private `graph: DirectedGraph<GraphEntityNodeAttrs, GraphRelationshipEdgeAttrs>`
- Private `topicId: string`
- Private `logger: Logger`

Node attributes (stored on graphology nodes): all GraphEntity fields except `id` (the graphology node key IS the entity id)
Edge attributes (stored on graphology edges): all GraphRelationship fields except `id`, `sourceId`, `targetId` (graphology manages source/target; edge key IS the relationship id)

Methods:

Entity operations:
- `addEntity(entity: GraphEntity): void` — adds node with entity.id as key, rest as attributes. Throws if duplicate ID.
- `updateEntity(id: string, updates: Partial<Omit<GraphEntity, "id">>): void` — merges attributes
- `getEntity(id: string): GraphEntity | null` — returns full GraphEntity or null
- `removeEntity(id: string): void` — removes node + all incident edges
- `findEntitiesByName(name: string): GraphEntity[]` — case-insensitive name search
- `findEntitiesByType(type: EntityType): GraphEntity[]` — filter by type
- `getAllEntities(): GraphEntity[]` — iterate all nodes

Relationship operations:
- `addRelationship(rel: GraphRelationship): void` — adds directed edge. Throws if source/target node missing.
- `getRelationship(id: string): GraphRelationship | null`
- `removeRelationship(id: string): void`
- `getRelationshipsBetween(sourceId: string, targetId: string): GraphRelationship[]`
- `getAllRelationships(): GraphRelationship[]`

Graph traversal:
- `getNeighbors(entityId: string, options?: { direction?: "in" | "out" | "both"; maxDepth?: number }): GraphEntity[]`
  — Uses graphology's native `outNeighbors`/`inNeighbors`/`neighbors` for depth 1, graphology-traversal `bfsFromNode` for deeper
- `getSubgraph(entityIds: string[]): KnowledgeGraphData`
  — Extract subgraph containing given entities + edges between them
- `traverseBFS(startId: string, callback: (entity: GraphEntity, depth: number) => boolean | void, maxDepth?: number): void`
  — Use graphology-traversal bfsFromNode, stop when callback returns true or maxDepth reached

Community detection:
- `detectCommunities(options?: { resolution?: number }): Map<number, string[]>`
  — Runs graphology-communities-louvain on the graph, returns Map<communityId, entityId[]>
  — Assigns `community` attribute to each node
- `getCommunities(): GraphCommunity[]`
  — Returns community structures from last detectCommunities() run

Serialization:
- `toJSON(): KnowledgeGraphData` — exports all entities, relationships, communities, and metadata
- `static fromJSON(data: KnowledgeGraphData): KnowledgeGraph` — reconstructs graph from serialized data
- These are the key bridge between in-memory graphology and LanceDB persistence

Statistics:
- `getStats(): KnowledgeGraphStats` — entity count, edge count, avg degree, community count, density, connected components
- Uses graphology's built-in `order`, `size`, `density` properties

Internal helpers:
- `private nodeToEntity(nodeId: string): GraphEntity` — reads graphology node attrs → GraphEntity
- `private edgeToRelationship(edgeId: string): GraphRelationship` — reads graphology edge attrs → GraphRelationship

### Phase 1C: LanceDB Persistence

**Step 5 — Create KnowledgeGraphStore class** (*depends on Step 2, Step 4; parallel with Step 4*)
- Create new file `packages/core/src/stores/knowledgeGraphStore.ts`
- Handles LanceDB persistence of entity and edge tables
- Does NOT use LangChain wrapper — uses `@lancedb/lancedb` directly (same as VectorStoreFactory's raw table operations in `getAllDocuments()` and `deleteStore()`)

Constructor:
- `constructor(lanceDbUri: string)` — same URI as VectorStoreFactory's `this.lanceDbUri`
- Private `logger: Logger`

Table naming convention:
- Entity table: `kg-entities-{topicId}`
- Edge table: `kg-edges-{topicId}`
- These follow the existing pattern where topicId = table name, but with a `kg-` prefix to avoid collision

Methods:

- `async saveGraph(topicId: string, data: KnowledgeGraphData): Promise<void>`
  — Connect to LanceDB, drop existing kg tables for topic if present, create new tables
  — Entity table columns: `id` (string), `name` (string), `type` (string), `description` (string), `vector` (float[]), `sourceChunkIds` (string, JSON-encoded array), `confidence` (float), `strength` (float), `lastAccessedAt` (float), `metadata` (string, JSON-encoded), `community` (int, -1 if none)
  — Edge table columns: `id` (string), `sourceId` (string), `targetId` (string), `type` (string), `weight` (float), `description` (string), `sourceChunkIds` (string, JSON-encoded), `confidence` (float), `metadata` (string, JSON-encoded)
  — Uses `db.createTable(tableName, data)` with array of plain objects (LanceDB infers Arrow schema from JS objects)
  — For vector column: pass as `Float32Array` or plain `number[]` — LanceDB handles both

- `async loadGraph(topicId: string): Promise<KnowledgeGraphData | null>`
  — Connect to LanceDB, check if entity table exists via `db.tableNames()`
  — If not found, return null (no KG for this topic yet)
  — Query both tables with `table.query().limit(MAX).toArray()` (same pattern as `VectorStoreFactory.getAllDocuments()`)
  — Deserialize JSON-encoded fields (sourceChunkIds, metadata)
  — Construct and return KnowledgeGraphData

- `async deleteGraph(topicId: string): Promise<void>`
  — Drop `kg-entities-{topicId}` and `kg-edges-{topicId}` tables if they exist
  — Same pattern as `VectorStoreFactory.deleteStore()`: `db.dropTable(tableName)`

- `async hasGraph(topicId: string): Promise<boolean>`
  — Check if entity table exists in `db.tableNames()`

Design decisions:
- JSON-encode array fields (`sourceChunkIds`) as strings — LanceDB flat schema works best with scalars; avoids nested Arrow list types that complicate queries
- Store `vector` as native vector column — enables future `table.search(queryVector)` for semantic entity search without loading full graph
- Community ID stored on entity rows — avoids separate community table for now; community summaries (Phase 2+) will need their own table later
- Separate class from VectorStoreFactory — keeps KG persistence isolated, avoids expanding the already-large VectorStoreFactory

**Step 6 — Export KnowledgeGraphStore** (*depends on Step 5*)
- Add to `packages/core/src/index.ts`:
  - `export { KnowledgeGraphStore } from "./stores/knowledgeGraphStore"`

### Phase 1D: TopicManager Integration

**Step 7 — Extend TopicManager for KG lifecycle** (*depends on Step 5*)
- Modify `packages/core/src/managers/topicManager.ts`:

In `deleteTopic()`:
- After `await this.vectorStoreFactory.deleteStore(topicId)`, add:
  ```
  // Delete knowledge graph tables if they exist
  const kgStore = new KnowledgeGraphStore(this.getDatabaseDir() + "/lancedb");  // reuse same URI
  await kgStore.deleteGraph(topicId);
  ```
- Actually — better approach: store a `KnowledgeGraphStore` instance on TopicManager (lazy-init) rather than creating per-call. Add:
  - Private field `private knowledgeGraphStore: KnowledgeGraphStore | null = null`
  - In `loadTopics()` after vectorStoreFactory init: `this.knowledgeGraphStore = new KnowledgeGraphStore(path.join(storageDir, "lancedb"))`
  - In `deleteTopic()`: `await this.knowledgeGraphStore?.deleteGraph(topicId)`

In common DB support:
- No changes needed — common topics are read-only, and KG tables for common topics would live in the common DB's lancedb dir. `KnowledgeGraphStore` already accepts a URI, so loading from common DB works naturally when the caller passes the common path.

New public method:
- `getKnowledgeGraphStore(): KnowledgeGraphStore | null` — expose for external use (by agents in future phases)

### Phase 1E: Tests

**Step 8 — Unit tests for KnowledgeGraph** (*depends on Step 4, parallel with Steps 5-7*)
- Create `packages/core/test/knowledgeGraph.test.ts`
- Follow existing patterns: mocha + chai, `describe/it` blocks, `this.timeout()` for slow tests
- Import from `../src/index` (same as other tests)

Test cases (~15-20 tests):
```
describe("KnowledgeGraph")
  describe("Entity operations")
    it("should add and retrieve an entity")
    it("should throw on duplicate entity ID")
    it("should update entity attributes")
    it("should remove entity and its incident edges")
    it("should find entities by name (case-insensitive)")
    it("should find entities by type")
    it("should return all entities")

  describe("Relationship operations")
    it("should add and retrieve a relationship")
    it("should throw when source entity is missing")
    it("should throw when target entity is missing")
    it("should get relationships between two entities")
    it("should return all relationships")

  describe("Graph traversal")
    it("should get direct neighbors (outbound)")
    it("should get direct neighbors (inbound)")
    it("should traverse BFS to specified depth")
    it("should extract subgraph for given entity IDs")

  describe("Community detection")
    it("should detect communities on a graph with clear clusters")
    it("should return empty communities for empty graph")

  describe("Serialization")
    it("should round-trip toJSON/fromJSON")
    it("should preserve all entity and relationship data")
    it("should preserve community assignments")

  describe("Statistics")
    it("should return correct stats for non-empty graph")
    it("should return zero stats for empty graph")
```

**Step 9 — Integration tests for KnowledgeGraphStore** (*depends on Step 5*)
- Create `packages/core/test/knowledgeGraphStore.test.ts`
- Uses real LanceDB (same pattern as `lancedb.test.ts`): temp dir, cleanup in `after()`
- Does NOT need embeddings — entity vectors are pre-computed arrays

Test cases (~8-10 tests):
```
describe("KnowledgeGraphStore Integration")
  it("should save and load a graph round-trip")
  it("should return null for non-existent graph")
  it("should delete graph tables")
  it("should handle empty graph (no entities)")
  it("should preserve vector data through save/load")
  it("should preserve JSON-encoded arrays through save/load")
  it("should overwrite existing graph on re-save")
  it("should report hasGraph correctly")
```

---

## File-by-File Change List

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `packages/core/src/utils/graphTypes.ts` | KG type definitions (GraphEntity, GraphRelationship, KnowledgeGraphData, etc.) | ~90 |
| `packages/core/src/stores/knowledgeGraph.ts` | KnowledgeGraph class wrapping graphology DirectedGraph | ~350 |
| `packages/core/src/stores/knowledgeGraphStore.ts` | LanceDB persistence for KG entity/edge tables | ~200 |
| `packages/core/test/knowledgeGraph.test.ts` | Unit tests for KnowledgeGraph class | ~300 |
| `packages/core/test/knowledgeGraphStore.test.ts` | Integration tests for LanceDB persistence | ~200 |

### Modified Files

| File | Changes | Est. Lines Changed |
|------|---------|-------------------|
| `packages/core/package.json` | Add 4 graphology dependencies | ~4 |
| `packages/core/src/index.ts` | Add exports for new types + classes | ~10 |
| `packages/core/src/managers/topicManager.ts` | Import KnowledgeGraphStore, add field, init in loadTopics(), delete in deleteTopic(), expose getter | ~15 |

**Total: 5 new files (~1,140 lines), 3 modified files (~29 lines changed)**

---

## Verification

1. **Compile check**: `npm run build --workspace=packages/core` — must pass with no TS errors
2. **Lint check**: `npm run lint` — must pass
3. **Existing tests**: `npm test --workspace=packages/core` — all 303 tests must still pass (no regressions)
4. **New unit tests**: `npm test --workspace=packages/core -- --grep "KnowledgeGraph"` — all ~23 tests pass
5. **New integration tests**: `npm test --workspace=packages/core -- --grep "KnowledgeGraphStore"` — all ~8 tests pass
6. **Manual verification**: Create a KnowledgeGraph, add entities + edges, serialize to JSON, save to LanceDB, load back, verify equality
7. **Topic deletion cascade**: Create topic, save KG for it, delete topic, verify KG tables cleaned up
8. **Bundle size check**: `npx esbuild packages/core/src/index.ts --bundle --platform=node --analyze` — verify graphology adds reasonable overhead

---

## Decisions

- **Separate file for KG types** (`graphTypes.ts`) rather than appending to `types.ts` — keeps the main types file focused on core RAG types; KG types are a distinct domain
- **String unions over enums** for EntityType/RelationshipType — matches extensibility requirement; consumers can pass any string if they extend the union
- **Separate KnowledgeGraphStore from VectorStoreFactory** — KG tables use raw LanceDB API (not LangChain wrapper), different schema, different lifecycle. Avoids bloating the 450-line VectorStoreFactory.
- **JSON-encode arrays in LanceDB** — simplest flat schema; avoids Arrow list type complexity. Deserialize on load.
- **No community summary storage yet** — GraphCommunity.summary is optional, will be populated in Phase 2 when LLM summarization is added
- **KG is topic-scoped** — matches the strict 1:1 topic isolation model. No cross-topic graph queries.
- **Vector column on entities** — stores entity description embeddings for future semantic entity search. Phase 1 populates the field but doesn't query by it.
- **graphology-types as prod dependency** — it's a peer dep of graphology and needed at runtime for type resolution

## Scope

**Included**: Types, KnowledgeGraph class, LanceDB persistence, topic deletion cascade, unit tests, integration tests
**Excluded**: Entity extraction (Phase 2), graph retrieval (Phase 4), LangGraph orchestration, RetrievalStrategy changes, QueryPlannerAgent changes, community summarization
