# Phase 2: Entity Extraction — Implementation Plan

> **Superseded.** The document knowledge graph, entity extraction over ingested
> documents, the `graph`/`graph_hybrid`/`ensemble` retrieval strategies, and the
> LangGraph orchestration layer were all removed. Graphs now exist only in the
> memory subsystem. This document is retained as design history only — see
> [ARCHITECTURE.md](../../ARCHITECTURE.md) and
> [docs/RETRIEVAL-PIPELINE.md](../RETRIEVAL-PIPELINE.md) for current behavior.

## TL;DR

Build an LLM-powered `EntityExtractor` agent that processes document chunks, extracts entities and relationships, and populates the Phase 1 `KnowledgeGraph`. Integrate as an optional step in `DocumentPipeline` (after chunking, before storing). No LangGraph — use simple sequential processing with a per-chunk progress tracker for resumability.

---

## Phase A: Types & Config (no dependencies)

### Step 1: Add KG config keys to constants.ts

**File**: `packages/core/src/constants.ts`

Add to the `CONFIG` object:
- `ENABLE_KNOWLEDGE_GRAPH` — boolean, default `false`. Master switch for entity extraction.
- `KG_BATCH_SIZE` — number, default `5`. How many chunks to extract per LLM call.
- `KG_RATE_LIMIT_MS` — number, default `200`. Delay between LLM calls (ms).
- `KG_MAX_CONSECUTIVE_FAILURES` — number, default `5`. Circuit breaker threshold.
- `KG_ENTITY_TYPES` — string, default `"person,organization,concept,technology,location,event"`. Comma-separated entity types to extract.

Add to `DEFAULTS`:
- `KG_ENABLED: false`

**Pattern reference**: Existing CONFIG keys like `CHUNK_SIZE`, `TOP_K` etc. are camelCase strings matching the VS Code setting suffix. Follow the same pattern: `"enableKnowledgeGraph"`, `"kgBatchSize"`, etc.

**~15 lines changed**

### Step 2: Add extraction types to a new types file

**New file**: `packages/core/src/agents/entityExtractorTypes.ts`

Define Zod schemas + inferred TypeScript types:

```
EntitySchema: z.object({
  name: z.string(),
  type: z.string(),           // "person", "concept", "technology", etc.
  description: z.string(),
})

RelationshipSchema: z.object({
  source: z.string(),         // entity name
  target: z.string(),         // entity name
  type: z.string(),           // "uses", "depends_on", "implements", etc.
  description: z.string(),
  weight: z.number().optional().default(1),
})

ExtractionResultSchema: z.object({
  entities: z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
})

// Inferred types
type ExtractedEntity = z.infer<typeof EntitySchema>
type ExtractedRelationship = z.infer<typeof RelationshipSchema>
type ExtractionResult = z.infer<typeof ExtractionResultSchema>

// Progress tracking
interface ExtractionProgress {
  totalChunks: number;
  processedChunks: number;
  entitiesFound: number;
  relationshipsFound: number;
  failedChunks: number;
  skippedChunks: number;
}

// Options for the extractor
interface EntityExtractorOptions {
  batchSize: number;          // chunks per LLM call
  rateLimitMs: number;        // delay between calls
  maxConsecutiveFailures: number; // circuit breaker
  entityTypes: string[];      // which entity types to extract
  signal?: AbortSignal;       // cancellation
  onProgress?: (progress: ExtractionProgress) => void;
  lastProcessedIndex?: number; // resume from this point (simple checkpointing)
}
```

**Why separate file**: Keeps entityExtractor.ts focused on logic. Types are co-located but cleanly separated. Follows the pattern of `splitters/semanticChunker.ts` exporting `ChunkingOptions` and `ChunkingResult` alongside the class.

**~70 lines**

---

## Phase B: EntityExtractor Agent

### Step 3: Create the EntityExtractor agent

**New file**: `packages/core/src/agents/entityExtractor.ts`

**Constructor**: `constructor(private llmProvider: ILLMProvider, private config: IConfigProvider)`
- Creates `Logger("EntityExtractor")`
- Reads config for defaults (batch size, rate limit, circuit breaker, entity types)

**Core methods**:

#### `async extractFromChunks(chunks: LangChainDocument[], options: EntityExtractorOptions): Promise<ExtractionResult>`

Main entry point. Processes chunks in sequence:
1. Skip chunks up to `options.lastProcessedIndex` (resumability)
2. Group remaining chunks into batches of `options.batchSize`
3. For each batch:
   a. Build prompt from batch chunks
   b. Call LLM with timeout (15s, matching `LLM_TIMEOUT_MS` pattern from QueryPlannerAgent)
   c. Parse JSON response, validate with `ExtractionResultSchema.parse()`
   d. On success: accumulate entities + relationships, reset failure counter
   e. On failure: increment `consecutiveFailures`, log warning, skip batch
   f. If `consecutiveFailures >= maxConsecutiveFailures`: stop extraction, log error (circuit breaker)
   g. Apply rate limit delay (`sleep(options.rateLimitMs)`)
   h. Report progress via `options.onProgress`
   i. Check `options.signal?.aborted` for cancellation
4. After all batches: merge entities, merge relationships
5. Return merged `ExtractionResult`

**Pattern**: Follows `QueryPlannerAgent.refinePlanWithLLM()` pattern:
- `const model = await this.llmProvider.selectModel()`
- `if (!model) return empty result` (graceful degradation when no LLM)
- `const response = await model.sendRequest(messages, signal)`
- Collect stream chunks → parse JSON → Zod validate
- AbortController with timeout + external signal forwarding

#### `mergeEntities(entities: ExtractedEntity[]): ExtractedEntity[]`

Pure function (can be tested independently):
- Group by `(name.toLowerCase(), type.toLowerCase())`
- For each group: keep first name casing, merge descriptions (concatenate unique sentences, cap at 500 chars)
- Return deduplicated list

#### `mergeRelationships(relationships: ExtractedRelationship[]): ExtractedRelationship[]`

Pure function:
- Group by `(source.toLowerCase(), target.toLowerCase(), type.toLowerCase())`
- For each group: merge descriptions, sum weights
- Return deduplicated list

#### Private prompt building methods:

**`buildSystemPrompt(entityTypes: string[]): string`**
- Role: "You are a knowledge graph entity extractor."
- Instructions: Extract entities (name, type, description) and relationships (source, target, type, description) from text.
- Entity type list from config
- Relationship type guidance (uses, depends_on, implements, contains, related_to, etc.)
- Output format: strict JSON matching ExtractionResultSchema
- Instructions for handling different content types:
  - Code: extract classes, functions, modules as entities; imports, calls, inheritance as relationships
  - Documentation/Markdown: extract concepts, technologies, people; "explains", "references" as relationships
  - General text: extract nouns as entities; verbs/prepositions as relationship hints

**`buildUserPrompt(chunks: LangChainDocument[]): string`**
- For each chunk: include `chunk.pageContent` and relevant metadata (source file, chunk index)
- Truncate very long chunks to first 2000 chars to stay within context window
- Include 1-2 few-shot examples inline (not separate messages — VS Code LM API only supports user+system roles)

**Few-shot examples** (embedded in system prompt):
- Example 1 (code): `"The AuthService class uses JwtTokenProvider to generate tokens"` → entities: [{AuthService, technology, "Authentication service"}, {JwtTokenProvider, technology, "JWT token generator"}], relationships: [{AuthService, JwtTokenProvider, "uses", "generates tokens"}]
- Example 2 (documentation): `"React components use hooks for state management"` → entities: [{React, technology, "UI framework"}, {hooks, concept, "React state management pattern"}], relationships: [{React, hooks, "uses", "state management"}]

**LLM timeout**: 30 seconds (entity extraction returns more tokens than query planning, so double the 15s used by QueryPlannerAgent).

**Error handling per batch**:
- JSON parse failure → log warning, skip batch
- Zod validation failure → try to salvage partial data (parse entities and relationships arrays independently)
- LLM timeout → skip batch, increment failure counter
- AbortSignal → throw immediately (don't catch)

**~250 lines**

### Step 4: Export from index.ts

**File**: `packages/core/src/index.ts`

Add exports:
```
export { EntityExtractor } from "./agents/entityExtractor";
export type { ExtractedEntity, ExtractedRelationship, ExtractionResult, ExtractionProgress, EntityExtractorOptions } from "./agents/entityExtractorTypes";
```

**~5 lines**

---

## Phase C: Pipeline Integration

### Step 5: Add entity extraction stage to DocumentPipeline

**File**: `packages/core/src/managers/documentPipeline.ts`

**Changes**:

1. **Add optional dependencies**: Constructor or new setter method for KnowledgeGraph + EntityExtractor:
   - `setKnowledgeGraph(kg: KnowledgeGraph, llmProvider: ILLMProvider): void`
   - Stores `knowledgeGraph` and creates `entityExtractor` instance
   - This avoids changing the constructor signature (backward compatible)

2. **Add config check**: Read `CONFIG.ENABLE_KNOWLEDGE_GRAPH` from `IConfigProvider`

3. **Add new pipeline stage** between chunking (Stage 2) and embedding/storing (Stage 3+4):
   - New stage: `"extracting"` added to `PipelineProgress.stage` union type
   - New field in `PipelineResult.stages`: `extracting: boolean`
   - New field in `PipelineResult.metadata`: `entitiesExtracted: number`, `relationshipsExtracted: number`
   - New timing: `stageTimings.extracting: number`

4. **Pipeline flow** (updated):
   ```
   Stage 1: Load documents
   Stage 2: Chunk documents
   Stage 3: Extract entities (optional — only if KG enabled + KG instance set + LLM available)
   Stage 4: Generate embeddings + Store in vector database (existing)
   ```

5. **Entity extraction logic** in `processDocuments()`:
   ```
   if (this.knowledgeGraph && this.entityExtractor && config.get(CONFIG.ENABLE_KNOWLEDGE_GRAPH, false)) {
     reportProgress("extracting", 35, "Extracting entities...")
     const extractionResult = await this.entityExtractor.extractFromChunks(chunks, {
       batchSize: config.get(CONFIG.KG_BATCH_SIZE, 5),
       rateLimitMs: config.get(CONFIG.KG_RATE_LIMIT_MS, 200),
       maxConsecutiveFailures: config.get(CONFIG.KG_MAX_CONSECUTIVE_FAILURES, 5),
       entityTypes: config.get(CONFIG.KG_ENTITY_TYPES, "...").split(","),
       signal: options.signal,
       onProgress: (p) => reportProgress("extracting", 35 + (p.processedChunks/p.totalChunks)*15, `Extracted ${p.entitiesFound} entities...`)
     })
     // Populate KG
     for (const entity of extractionResult.entities) {
       this.knowledgeGraph.addEntity({ id: generateId(), ...entity, sourceChunkIds: [] })
     }
     for (const rel of extractionResult.relationships) {
       this.knowledgeGraph.addRelationship({ id: generateId(), ...rel })
     }
     result.metadata.entitiesExtracted = extractionResult.entities.length
     result.metadata.relationshipsExtracted = extractionResult.relationships.length
     result.stages.extracting = true
   }
   ```

6. **Progress percentages** (adjusted):
   - Loading: 0-10%
   - Chunking: 10-25%
   - Extracting: 25-50% (new)
   - Embedding+Storing: 50-100%

7. **Error handling**: Entity extraction failure should NOT block the pipeline. Wrap in try/catch, log error, continue to embedding/storing. Set `result.stages.extracting = false` and push error to `result.errors`.

**~60 lines changed/added**

### Step 6: Update PipelineProgress and PipelineResult types

**File**: `packages/core/src/managers/documentPipeline.ts` (same file, type definitions at top)

- `PipelineProgress.stage`: add `"extracting"` to union
- `PipelineResult.stages`: add `extracting: boolean`
- `PipelineResult.metadata`: add `entitiesExtracted: number`, `relationshipsExtracted: number`
- `PipelineResult.metadata.stageTimings`: add `extracting: number`

**~10 lines changed**

---

## Phase D: Entity Embedding

### Step 7: Embed entity descriptions after extraction

**File**: `packages/core/src/agents/entityExtractor.ts` (add method)

**New method**: `async embedEntities(entities: ExtractedEntity[], embeddingService: EmbeddingService): Promise<Map<string, number[]>>`

- Collect all entity descriptions
- Call `embeddingService.embedBatch(descriptions)` — uses existing batch infrastructure (HuggingFace batch 1000, Remote batch 100)
- Return `Map<entityName, embedding>`
- Called from DocumentPipeline after entity extraction, before storing

**Alternative integration point**: In DocumentPipeline Step 5, after populating the KG, call:
```
const entityEmbeddings = await this.entityExtractor.embedEntities(extractionResult.entities, this.embeddingService)
// Store in KG entity LanceDB table (Phase 1 provides this mechanism)
for (const entity of extractionResult.entities) {
  this.knowledgeGraph.updateEntityEmbedding(entity.name, entityEmbeddings.get(entity.name))
}
```

This leverages the existing `EmbeddingService.embedBatch()` which handles backend routing, batching, and progress reporting.

**~25 lines**

---

## Phase E: Tests

### Step 8: Unit tests for EntityExtractor

**New file**: `packages/core/test/entityExtractor.test.ts`

**Test structure** (following `queryPlannerAgent.test.ts` pattern):

```
Mock ILLMProvider (no LLM available):
  - returns empty result when no LLM model available

Mock ILLMProvider (with mock responses):
  - extracts entities from a single chunk
  - extracts entities from multiple chunks in batch
  - merges duplicate entities (same name + type)
  - merges duplicate relationships (same source + target + type, weights summed)
  - handles JSON parse failure gracefully (skip batch)
  - handles Zod validation failure (partial salvage)
  - respects circuit breaker (N consecutive failures → stop)
  - respects AbortSignal cancellation
  - reports progress correctly
  - handles empty chunks array
  - handles chunks with very long text (truncation)
  - resumes from lastProcessedIndex
```

**Mock LLM pattern** (from ragAgent.test.ts):
```typescript
const mockLLMProvider: ILLMProvider = {
  selectModel: async () => ({
    id: "mock-model",
    family: "mock",
    sendRequest: async (messages, signal) => {
      // Return async iterable of JSON response
      async function* generate() {
        yield JSON.stringify({
          entities: [{ name: "TypeScript", type: "technology", description: "Programming language" }],
          relationships: []
        });
      }
      return generate();
    }
  }),
  isAvailable: async () => true,
};
```

**Test fixtures** (inline or in test/helpers/):
- Sample code chunk → expected entities (class names, function names)
- Sample markdown chunk → expected entities (concepts, technologies)
- Sample with overlapping entities across chunks → expected merged result

**~300 lines**

### Step 9: Unit tests for merging logic

**Same file**: `packages/core/test/entityExtractor.test.ts`

Dedicated `describe("Entity Merging")` and `describe("Relationship Merging")` blocks:
- Pure function tests, no mocks needed
- Edge cases: empty arrays, single entity, all duplicates, case-insensitive matching, description concatenation limits

**~80 lines**

### Step 10: Integration test — pipeline with KG extraction

**New file**: `packages/core/test/entityExtractorIntegration.test.ts`

Tests the full flow:
1. Create DocumentPipeline with mock notifier, real EmbeddingService (HuggingFace backend)
2. Set up KnowledgeGraph (Phase 1 class) + mock LLM provider
3. Call `pipeline.setKnowledgeGraph(kg, mockLLM)`
4. Enable KG via mock config provider
5. Process a test fixture file (e.g., `test/fixtures/sample.md`)
6. Assert: KG has entities, KG has relationships, pipeline result shows extraction metadata

**~100 lines**

---

## Relevant Files

### New files
- `packages/core/src/agents/entityExtractorTypes.ts` — Zod schemas, TypeScript types, options interface (~70 lines)
- `packages/core/src/agents/entityExtractor.ts` — EntityExtractor agent class (~250 lines)
- `packages/core/test/entityExtractor.test.ts` — Unit tests (~380 lines)
- `packages/core/test/entityExtractorIntegration.test.ts` — Integration test (~100 lines)

### Modified files
- `packages/core/src/constants.ts` — Add KG config keys (~15 lines)
- `packages/core/src/managers/documentPipeline.ts` — Optional extraction stage, type updates (~70 lines)
- `packages/core/src/index.ts` — Export new types and class (~5 lines)

### Reference files (read-only, use as patterns)
- `packages/core/src/agents/queryPlannerAgent.ts` — LLM calling, Zod schema, timeout, abort signal pattern
- `packages/core/src/agents/ragAgent.ts` — Agent constructor pattern, config reading
- `packages/core/test/queryPlannerAgent.test.ts` — Test structure, mock ILLMProvider
- `packages/core/test/ragAgent.test.ts` — Mock VectorStore, mock LLM, integration testing

### Phase 1 dependency files (assumed to exist)
- `packages/core/src/stores/knowledgeGraph.ts` — KnowledgeGraph class wrapping graphology, `addEntity()`, `addRelationship()`, `updateEntityEmbedding()`
- GraphEntity, GraphRelationship types from Phase 1

---

## Verification

1. **Lint**: `npm run lint` — no new errors in modified/created files
2. **Compile**: `npm run compile` — TypeScript compiles cleanly
3. **Unit tests**: `npm test --workspace=packages/core` — all entityExtractor tests pass
4. **Integration test**: Same command — entityExtractorIntegration tests pass
5. **Existing tests**: `npm run test:all` — no regressions (pipeline changes are additive, KG is opt-in)
6. **Manual verification**: Enable KG in config, process a markdown fixture, verify KG.getEntities() returns results

---

## Decisions

1. **Pipeline position**: Entity extraction goes AFTER chunking, BEFORE embedding/storing. Rationale: chunks are the input to extraction, and extraction doesn't depend on embeddings. Entity embeddings are a separate sub-step.

2. **KG lifecycle**: Per-topic, injected via `pipeline.setKnowledgeGraph()` setter. Not constructed inside the pipeline — the caller (TopicManager) owns the KG instance. This keeps the pipeline testable and avoids tight coupling.

3. **No LangGraph**: Simple sequential loop with a progress counter is sufficient. KG extraction is embarrassingly sequential (LLM call per batch, rate-limited). Checkpointing is handled by `lastProcessedIndex` in options — the caller can persist this to resume on failure. LangGraph adds ~2MB of dependencies for no architectural benefit at this phase.

4. **Backward compatibility**: All new pipeline stages are opt-in. The `extracting` stage only runs when (a) `CONFIG.ENABLE_KNOWLEDGE_GRAPH` is `true`, AND (b) a KnowledgeGraph instance has been set via `setKnowledgeGraph()`. Existing users see zero behavioral change.

5. **Prompt strategy**: Single system prompt with file-type hints embedded in user prompt metadata, rather than separate prompts per file type. The LLM can adapt based on the content — keeping one prompt simplifies maintenance and testing.

6. **Entity ID generation**: Use a simple `crypto.randomUUID()` or counter-based ID when adding to KG. The entity's natural key for merging is `(name, type)`.

7. **Extraction failure tolerance**: Per-batch try/catch means individual bad chunks don't block the pipeline. Circuit breaker prevents burning LLM tokens on consistently failing prompts. Entire extraction stage failure doesn't block the rest of the pipeline.

---

## Estimated Total

- **New code**: ~800 lines across 4 new files
- **Modified code**: ~90 lines across 3 existing files
- **Dependencies**: None new (uses existing zod, ILLMProvider, EmbeddingService)
