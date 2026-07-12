# Code Review: `packages/core/` — Cross-Encoder Reranker + RAGAgent Refactor

**Branch:** `mcp-server`
**Reviewer:** Copilot (automated)
**Date:** 2025-04-19
**Verdict:** Approve with required fixes (2 critical, 4 important)

---

## Scope

This review covers the `packages/core/` changes in the mcp-server branch:

- **New files:** `rerankers/crossEncoderReranker.ts`, `rerankers/reranker.ts`, `rerankers/index.ts`, `models/findAssetsModelsDir.ts`, `models/modelRegistry.ts` (moved), `models/rerankerModelRegistry.ts`, `models/index.ts`, `agents/ragQueryService.ts`
- **Modified files:** `agents/ragAgent.ts`, `agents/queryPlannerAgent.ts`, `constants.ts`, `index.ts`, `managers/topicManager.ts`, `managers/documentPipeline.ts`, `retrievers/ensembleRetriever.ts`, `retrievers/hybridRetriever.ts`, `embeddings/embeddingService.ts`, `embeddings/huggingFaceBackend.ts`, `utils/types.ts`
- **Test files:** `crossEncoderReranker.test.ts`, `rerankerModelRegistry.test.ts`, `rerankBenchmark.test.ts`, `ragAgent.test.ts`, `ragQueryService.test.ts`, `integration.test.ts`

---

## 1. Critical Issues (must fix before merge)

### C1. Default value mismatch: `RERANKER_CANDIDATE_MULTIPLIER`

|              |                                                                |
| ------------ | -------------------------------------------------------------- |
| **Files**    | `constants.ts:55`, `agents/ragAgent.ts:450`                    |
| **Impact**   | Over-fetch multiplier silently differs from documented default |
| **Severity** | **Critical** — changes retrieval behavior unpredictably        |

`DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER` is `4`, but `ragAgent.ts` uses `6` as the inline fallback:

```typescript
// ragAgent.ts:450
const multiplier = this.config.get<number>(CONFIG.RERANKER_CANDIDATE_MULTIPLIER, 6);
//                                                                                ^  should be DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER (4)
```

When no config provider overrides the value, the agent over-fetches by 6× instead of the intended 4×. The DEFAULTS constant is the canonical source of truth, but this code bypasses it.

**Fix:** Replace inline `6` with `DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER`:

```typescript
import { CONFIG, DEFAULTS } from "../constants";
// ...
const multiplier = this.config.get<number>(
  CONFIG.RERANKER_CANDIDATE_MULTIPLIER,
  DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER,
);
```

---

### C2. Default value mismatch: `RERANKER_MAX_CANDIDATES`

|              |                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ |
| **Files**    | `constants.ts:54`, `agents/ragQueryService.ts:402`, `rerankers/crossEncoderReranker.ts:24` |
| **Impact**   | Three different defaults for the same concept                                              |
| **Severity** | **Critical** — constructor receives unexpected value                                       |

| Location                                         | Default Value |
| ------------------------------------------------ | ------------- |
| `DEFAULTS.RERANKER_MAX_CANDIDATES`               | `20`          |
| `ragQueryService.createRerankerIfEnabled()`      | **`30`**      |
| `crossEncoderReranker.ts DEFAULT_MAX_CANDIDATES` | `20`          |

`ragQueryService.ts:402`:

```typescript
const maxCandidates = this.config.get<number>(CONFIG.RERANKER_MAX_CANDIDATES, 30);
//                                                                            ^^ should be DEFAULTS.RERANKER_MAX_CANDIDATES (20)
```

When the config provider has no value, the service passes `30` to the `CrossEncoderReranker` constructor, overriding the class default of `20`.

**Fix:** Use `DEFAULTS.RERANKER_MAX_CANDIDATES`:

```typescript
const maxCandidates = this.config.get<number>(CONFIG.RERANKER_MAX_CANDIDATES, DEFAULTS.RERANKER_MAX_CANDIDATES);
```

---

## 2. Important Issues (should fix, not blocking)

### I1. Reranker created per-agent — N copies of ONNX model in memory

|              |                                                    |
| ------------ | -------------------------------------------------- |
| **File**     | `agents/ragQueryService.ts:375`                    |
| **Impact**   | Memory waste + repeated ONNX model loading latency |
| **Severity** | **Important** — performance regression at scale    |

`createRerankerIfEnabled()` creates a **new** `CrossEncoderReranker` and calls `initialize()` (full ONNX model load) for every new `RAGAgent`. With `MAX_CACHED_AGENTS = 10`, up to 10 copies of the same ~23 MB cross-encoder model can live in memory simultaneously.

The reranker is stateless with respect to topics — it scores `(query, document)` pairs with no topic-specific state.

**Fix:** Cache the reranker at the `RAGQueryService` level:

```typescript
private reranker: Reranker | null | undefined = undefined; // undefined = not yet attempted

private async getOrCreateReranker(): Promise<Reranker | null> {
  if (this.reranker !== undefined) return this.reranker;
  this.reranker = await this.createRerankerIfEnabled();
  return this.reranker;
}
```

---

### I2. `resolveModelIdentifier()` defined but never called during model loading

|              |                                                                                   |
| ------------ | --------------------------------------------------------------------------------- |
| **Files**    | `models/rerankerModelRegistry.ts:76`, `rerankers/crossEncoderReranker.ts:220-230` |
| **Impact**   | Path traversal protection and bundled model resolution are ineffective            |
| **Severity** | **Important** — defense-in-depth gap                                              |

`RerankerModelRegistry.resolveModelIdentifier()` resolves model names to bundled local paths and blocks path traversal, but `CrossEncoderReranker._loadModel()` passes `this.modelName` directly to `from_pretrained()` without calling it.

This means:

- Bundled models may not be resolved to their local paths (the `localModelPath` env var partially compensates, but explicit resolution is more reliable)
- The path traversal protection in the registry is bypassed for actual model loading

**Fix:** Add resolution in `_loadModel()`:

```typescript
private async _loadModel(): Promise<void> {
  const resolvedName = this.registry.resolveModelIdentifier(this.modelName);
  // ... use resolvedName for from_pretrained()
}
```

---

### I3. No config flag to disable reranker

|              |                                                                           |
| ------------ | ------------------------------------------------------------------------- |
| **File**     | `agents/ragQueryService.ts:398-412`                                       |
| **Impact**   | Unnecessary ONNX import + model load attempts when reranking isn't wanted |
| **Severity** | **Important** — startup latency in deployments without models             |

`createRerankerIfEnabled()` always attempts to create a reranker. Despite the name "IfEnabled", there is no `RERANKER_ENABLED` config key. If the ONNX runtime or model files aren't available (e.g., lightweight MCP deployments), every agent creation will:

1. Dynamic-import the module
2. Attempt ONNX model load
3. Catch the error and log a warning

This adds per-topic startup latency. The error is silently swallowed, making it hard to debug.

**Fix:** Add a `CONFIG.RERANKER_ENABLED` key (default: `true`) and short-circuit:

```typescript
private async createRerankerIfEnabled(): Promise<Reranker | null> {
  const enabled = this.config.get<boolean>(CONFIG.RERANKER_ENABLED, true);
  if (!enabled) return null;
  // ... existing logic
}
```

---

### I4. `switchModel()` path traversal check is incomplete

|              |                                             |
| ------------ | ------------------------------------------- |
| **File**     | `rerankers/crossEncoderReranker.ts:140-143` |
| **Impact**   | Potential path traversal on Windows         |
| **Severity** | **Important** — security hardening gap      |

The validation checks for `..`, leading `/`, and leading `\`, but doesn't check for **embedded** backslashes:

```typescript
// Current check
if (modelName.includes("..") || modelName.startsWith("/") || modelName.startsWith("\\")) {
```

An input like `org\..\..\etc\passwd` would pass this validation. On Windows, `\` is a valid path separator. Additionally, `resolveModelIdentifier()` in the registry has a stricter check (`path.isAbsolute()` which handles Windows drive letters), but `switchModel()` doesn't delegate to it.

**Fix:** Either delegate all validation to `resolveModelIdentifier()`, or add:

```typescript
if (modelName.includes("..") || modelName.includes("\\") || modelName.startsWith("/")) {
```

---

## 3. Minor Issues (nice to have improvements)

### M1. `_heuristicFallback` in Zod schema leaks internal detail to LLM

| **File** | `agents/queryPlannerAgent.ts` — `QueryPlanSchema` |
| -------- | ------------------------------------------------- |

`_heuristicFallback: z.boolean().optional()` was added to the Zod schema that validates LLM responses. This internal flag shouldn't be in the parse schema — the LLM could theoretically set it to `true` and cause the agent to skip LLM-based gap analysis.

**Fix:** Remove from `QueryPlanSchema`, add it after parsing:

```typescript
const plan = QueryPlanSchema.parse(parsed);
plan._heuristicFallback = false; // only set to true by heuristic codepath
```

### M2. `getGapScoreThreshold()` ignores user config for strategy-specific strategies

| **File** | `agents/ragAgent.ts:155-160` |
| -------- | ---------------------------- |

When `STRATEGY_GAP_THRESHOLDS[strategy]` is defined (BM25, ENSEMBLE), the user's `CONFIG.GAP_SCORE_THRESHOLD` is completely ignored. If a user sets a custom threshold, it won't apply to those strategies. Consider using the config value as an override when explicitly set.

### M3. `listAvailableModels()` is async but fully synchronous

| **File** | `models/rerankerModelRegistry.ts:122` |
| -------- | ------------------------------------- |

Everything called by `listAvailableModels()` is synchronous (`listBundledModels()` does sync FS). The method doesn't need to be `async`. Not a bug, but misleading.

### M4. Over-fetch cap of 50 may be too restrictive

| **File** | `agents/ragAgent.ts:451` |
| -------- | ------------------------ |

`Math.min(topK * multiplier, 50)` — with `topK=10` and `multiplier=6`, the computed value is 60 but gets capped to 50. Consider making the cap configurable or deriving it from `DEFAULTS.RERANKER_MAX_CANDIDATES`.

### M5. `executeRetrieval` now always runs all sub-queries in parallel

| **File** | `agents/ragAgent.ts:432-435` |
| -------- | ---------------------------- |

The old code supported `sequential`, `parallel`, `hybrid`, and `priority-based` execution strategies. The refactored code uses `Promise.all()` for all plans. This is fine for the current architecture, but worth noting that sequential execution capability was intentionally removed alongside the `strategy` field.

---

## 4. Positive Observations

1. **Graceful degradation in reranker:** The `rerank()` method catches scoring errors and returns original-order results — excellent fault tolerance that prevents the reranker from being a single point of failure.

2. **Clean Reranker interface:** The `Reranker` interface is minimal (`rerank`, `initialize`, `isAvailable`, `dispose`) — easy to add alternative backends (e.g., Cohere API reranker) in the future.

3. **Strategy-aware gap thresholds:** Adding `STRATEGY_GAP_THRESHOLDS` for BM25/ENSEMBLE is a good insight — BM25 scores are unbounded and RRF scores are tiny fractions, so a single threshold doesn't work.

4. **Shared `findAssetsModelsDir()`:** Extracting to `models/` eliminates duplication between `ModelRegistry` and `CrossEncoderReranker`.

5. **LRU agent cache with correct promotion:** The `delete + set` pattern in `getOrCreateAgent` gives proper LRU semantics using Map iteration order.

6. **Path traversal protection at two layers:** Both `RerankerModelRegistry.resolveModelIdentifier()` and `CrossEncoderReranker.switchModel()` check for traversal — defense in depth.

7. **`TopicEmptyError` as a typed exception:** Lets callers distinguish "empty topic" from other errors without string matching.

8. **Thorough test coverage for logit shapes:** Tests cover `[N,1]`, `[N,2]`, and flat array logit shapes — critical for cross-model compatibility.

9. **text_pair tokenizer API usage:** Correctly passes `text_pair` as an option (not positional), avoiding the silent bug documented in repo memory.

---

## 5. Validation Gaps

| Gap                                                                      | Severity | Impact                                         |
| ------------------------------------------------------------------------ | -------- | ---------------------------------------------- |
| No `ragAgent.test.ts` tests for reranker integration or over-fetch logic | High     | Reranker integration untested in agent context |
| No `ragQueryService.test.ts` tests for `createRerankerIfEnabled`         | Medium   | Always-on creation untested                    |
| No `switchModel` path traversal rejection tests                          | Medium   | Security validation untested                   |
| No test for reranker being shared vs per-agent                           | Low      | Performance regression not caught by tests     |
| No test for `_heuristicFallback` not being settable by LLM               | Low      | Schema leak untested                           |

---

## Files Reviewed

| File                                | Status   | Verdict                                                                  |
| ----------------------------------- | -------- | ------------------------------------------------------------------------ |
| `rerankers/reranker.ts`             | New      | ✅ Clean interface                                                       |
| `rerankers/crossEncoderReranker.ts` | New      | ⚠️ Missing resolveModelIdentifier call (I2), switchModel validation (I4) |
| `rerankers/index.ts`                | New      | ✅                                                                       |
| `models/findAssetsModelsDir.ts`     | New      | ✅                                                                       |
| `models/modelRegistry.ts`           | Moved    | ✅ Import path updated                                                   |
| `models/rerankerModelRegistry.ts`   | New      | ✅ Path traversal protection present                                     |
| `models/index.ts`                   | New      | ✅                                                                       |
| `agents/ragQueryService.ts`         | New      | ⚠️ Default mismatches (C2), per-agent reranker (I1), no enable flag (I3) |
| `agents/ragAgent.ts`                | Modified | ⚠️ Default mismatch (C1), otherwise clean integration                    |
| `agents/queryPlannerAgent.ts`       | Modified | ⚠️ Minor: `_heuristicFallback` in schema (M1)                            |
| `constants.ts`                      | Modified | ✅ Canonical defaults are correct                                        |
| `index.ts`                          | Modified | ✅ Proper barrel exports                                                 |
| `utils/types.ts`                    | Modified | ✅                                                                       |
| `embeddings/embeddingService.ts`    | Modified | ✅ Import path change only                                               |
| `embeddings/huggingFaceBackend.ts`  | Modified | ✅ Import path change only                                               |
| `retrievers/hybridRetriever.ts`     | Modified | ✅                                                                       |
| `retrievers/ensembleRetriever.ts`   | Modified | ✅                                                                       |
| `managers/topicManager.ts`          | Modified | ✅                                                                       |
| `managers/documentPipeline.ts`      | Modified | ✅                                                                       |
