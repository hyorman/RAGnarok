# RAGQueryService Extraction — Comprehensive Architecture Review

**Date:** April 2, 2026
**Scope:** Extraction of shared RAG query logic into `RAGQueryService` in `@ragnarok/core`
**Files changed:** 8 (7 modified, 1 new)
**Net line delta:** −168

---

## Executive Summary

The refactoring extracts the shared RAG query pipeline — topic resolution, stat checking, agent lifecycle, query execution, and result formatting — from two duplicated implementations (`ragTool.ts` in VS Code, `tools.ts` in MCP server) into a single `RAGQueryService` class in the core package. This is a well-executed application of the **Service Layer / Façade** pattern that eliminates meaningful logic duplication and creates a portable, testable, and extensible query entry point.

The design is sound overall. The main concerns are: a subtle behavioral regression in MCP error handling, a mislabeled cache eviction strategy, and redundant config reads on the VS Code path. None are blockers — all are addressable with targeted follow-ups.

---

## 1. Structural Analysis

### 1.1 Before vs. After

| Aspect                  | Before                                                                        | After                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Query pipeline**      | Duplicated in `ragTool.ts` (~320 lines) and `tools.ts` (~40 lines in handler) | Single `RAGQueryService.executeQuery()` (~100 lines)                    |
| **Agent caching**       | `RAGTool` owned a `Map<string, RAGAgent>` with ad-hoc eviction                | `RAGQueryService` owns the cache with consistent FIFO-10 eviction       |
| **Consumer code**       | Each consumer reimplemented resolve → check → create → query → format         | `ragTool.ts` ~160 lines (VS Code adapter); `tools.ts` handler ~10 lines |
| **Test surface**        | Query logic tested only via VS Code extension host (slow)                     | Core-package tests cover the pipeline in pure Node.js; 317 passing      |
| **New consumer effort** | Copy-paste from existing consumer, adapt                                      | Instantiate `RAGQueryService`, call `executeQuery()`                    |

### 1.2 Dependency Graph

```
┌───────────────────┐     ┌───────────────────┐
│  VS Code ragTool  │     │  MCP tools.ts     │
│  (thin adapter)   │     │  (one-liner)      │
└────────┬──────────┘     └────────┬──────────┘
         │                         │
         │  extraAgentOptions={}   │
         │  + workspaceContext     │
         ▼                         ▼
    ┌─────────────────────────────────┐
    │       RAGQueryService           │
    │  (core package, portable)       │
    ├─────────────────────────────────┤
    │  Dependencies:                  │
    │   • TopicManager (resolve/stats)│
    │   • IConfigProvider (defaults)  │
    │   • ILLMProvider (for RAGAgent) │
    └──────────────┬──────────────────┘
                   │
                   ▼
         ┌──────────────────┐
         │    RAGAgent       │
         │  (query engine)   │
         └──────────────────┘
```

### 1.3 API Surface

```typescript
class RAGQueryService {
  constructor(
    topicManager: TopicManager,
    config: IConfigProvider,
    llmProvider: ILLMProvider,
    options?: RAGQueryServiceOptions, // { cacheAgents?: boolean }
  );

  executeQuery(
    params: RAGQueryParams, // { topic, query, topK?, retrievalStrategy? }
    extraAgentOptions?: Partial<RAGAgentOptions>,
  ): Promise<RAGQueryResult>;

  clearAgentCache(topicId: string): void;
  dispose(): void;
}
```

---

## 2. Pros — Design Benefits

### 2.1 Textbook Façade with Interface Segregation

`RAGQueryService` depends on three narrow interfaces (`TopicManager`, `IConfigProvider`, `ILLMProvider`) rather than concrete VS Code or MCP types. This is a clean application of the **Dependency Inversion Principle** — the high-level query policy doesn't depend on low-level framework details. Any environment that can provide these three collaborators can use the service.

**Citation:** Constructor at `packages/core/src/agents/ragQueryService.ts`, lines 37–43.

### 2.2 Thin Adapter Pattern for Consumer Code

`ragTool.ts` now contains _only_ VS Code-specific concerns:

| Concern                                       | Location      | Rationale                 |
| --------------------------------------------- | ------------- | ------------------------- |
| `topK` bounds validation (1–20, integer)      | Lines 97–100  | VS Code UX constraint     |
| `EmbeddingService.initialize()`               | Line 103      | Extension lifecycle       |
| `QueryPlannerAgent.canRefineWithLLM()` gating | Lines 106–108 | VS Code workspace context |
| `WorkspaceContextProvider.getContext()`       | Lines 110–117 | VS Code API               |
| Path-sanitizing error messages                | Lines 129–135 | Extension security policy |

Everything else delegates to `ragQueryService.executeQuery()`. This keeps the adapter genuinely thin — a reviewer can audit the full VS Code surface in under 2 minutes.

### 2.3 `extraAgentOptions` as a Low-Ceremony Extension Seam

The design uses `Partial<RAGAgentOptions>` spread over config defaults:

```typescript
const agentOptions: RAGAgentOptions = {
  topicName,
  topK,
  retrievalStrategy,
  maxIterations,
  confidenceThreshold,
  modelFamily,
  ...extraAgentOptions, // VS Code injects workspaceContext + overrides here
};
```

This avoids the over-engineering of a strategy pattern or dedicated builder. The spread is type-safe (TypeScript enforces the partial shape) and additive (new fields in `RAGAgentOptions` are automatically available to callers). It's the right level of abstraction for two known consumers.

### 2.4 Consolidated Agent Caching

The `Map<string, RAGAgent>` with size-bounded eviction was previously duplicated. Now both consumers share the same cache instance and eviction policy. This eliminates the risk of one consumer having unbounded caching while the other doesn't — a real concern in the MCP server (long-lived process).

### 2.5 Portable Result Formatting

The `RAGResult → RAGQueryResult` mapping (lines 99–130 of `ragQueryService.ts`) is non-trivial: it computes `agenticMetadata`, normalizes heading paths into "→"-delimited strings, rounds scores, and extracts position metadata. Having this in one place means the format contract is consistent across all consumers.

### 2.6 MCP Handler Becomes Trivially Auditable

```typescript
const result = await ragQueryService.executeQuery(
  { topic, query, topK, retrievalStrategy: retrievalStrategy as RetrievalStrategy | undefined },
  {},
);
```

The entire rag_query handler in `tools.ts` is now Zod schema declaration + try/catch + delegate. There's no hidden branching, no state management, no result formatting. A reviewer can verify correctness at a glance.

---

## 3. Cons — Risks and Concerns

### 3.1 Behavioral Regression: "No Documents" → Error (Severity: Medium)

**Before:** The MCP handler returned a non-error response when a topic existed but had no documents. MCP clients could display this as informational.

**After:** `RAGQueryService` throws:

```typescript
throw new Error(
  `Topic "${topicMatch.topic.name}" exists but has no documents. ` + `Add documents to the topic before querying.`,
);
```

The MCP handler catches this and returns `isError: true`. Clients that distinguished "no results" from "query failed" now see a reclassified error. This is a **contract change** — not a crash, but a semantic shift that could break client-side error handling or UX flows.

**Recommendation:** Introduce a typed error subclass:

```typescript
export class TopicEmptyError extends Error {
  constructor(topicName: string) {
    super(`Topic "${topicName}" exists but has no documents.`);
    this.name = "TopicEmptyError";
  }
}
```

MCP can then catch `TopicEmptyError` specifically and return a non-error response, preserving backward compatibility while still throwing from the service.

### 3.2 ConfigProvider Double-Read Hazard (Severity: Low)

`ragTool.ts` reads `topK`, `retrievalStrategy`, `maxIterations`, `confidenceThreshold`, and `modelFamily` from `vscode.workspace.getConfiguration()`, then passes them as `extraAgentOptions`. Inside `executeQuery()`, the same CONFIG keys are read from `this.config` as defaults — but they're immediately overwritten by the spread.

**Impact:**

- On the VS Code path, `RAGQueryService`'s config reads are **dead code** — they produce values that are always replaced.
- On the MCP path, those defaults are the _only_ source of truth, so they're critical.
- A developer modifying config handling must understand that two different reads happen for VS Code, introducing cognitive overhead and divergence risk.

**Recommendation:** Consider one of:

1. Document the override precedence in a JSDoc comment on `extraAgentOptions`
2. Have `executeQuery` skip building defaults for keys already present in `extraAgentOptions` (micro-optimization but clarifies intent)
3. Long-term: have the VS Code adapter only pass _VS Code-specific_ overrides (e.g., `workspaceContext`) and let the service own all config reads via the `IConfigProvider` it already holds

### 3.3 FIFO Eviction Mislabeled as "LRU" (Severity: Low)

The eviction code:

```typescript
if (this.ragAgents.size >= MAX_CACHED_AGENTS) {
  const firstKey = this.ragAgents.keys().next().value;
  if (firstKey) this.ragAgents.delete(firstKey);
}
this.ragAgents.set(topicId, agent);
```

This evicts the **first-inserted** key. A cache hit in `getOrCreateAgent` returns the existing agent _without promoting it_, so a frequently-accessed topic can be evicted if it was inserted earliest. This is FIFO, not LRU.

**Impact:** For workloads with >10 active topics, the most popular topic could be evicted while idle topics survive. Agent creation (vector store load) can be expensive — a thrashing cache degrades latency.

**Recommendation:** Promote on hit with delete-then-re-insert:

```typescript
if (this.cacheAgents && this.ragAgents.has(topicId)) {
  const agent = this.ragAgents.get(topicId)!;
  // Promote to most-recently-used position
  this.ragAgents.delete(topicId);
  this.ragAgents.set(topicId, agent);
  return agent;
}
```

This makes `Map` iteration order match access order — true LRU semantics with zero extra dependencies.

### 3.4 `registerTools` Parameter List Growing (Severity: Low)

`registerTools` now takes 6 positional parameters:

```typescript
registerTools(server, topicManager, configProvider, llmProvider, embeddingService, ragQueryService);
```

This is trending toward the **Long Parameter List** code smell. If another service is extracted (e.g., topic management service), the signature grows further.

**Recommendation:** Bundle into a context object:

```typescript
interface ServerContext {
  topicManager: TopicManager;
  config: IConfigProvider;
  llmProvider: ILLMProvider;
  embeddingService: EmbeddingService;
  ragQueryService: RAGQueryService;
}
```

### 3.5 Stale Fields in `RAGTool` (Severity: Low)

After the refactoring:

- `topicManager` is stored as `Promise<TopicManager>` but never directly accessed — all topic operations go through `ragQueryService`.
- `embeddingService` is used only for `initialize()` on line 103.

These leftovers create ambiguity about which object owns topic/embedding responsibilities.

**Recommendation:** Make `embeddingService` a local parameter or function-scoped. Remove `topicManager` from instance state if it's truly unused (verify no other method references it).

---

## 4. Benefits — Concrete Team Improvements

### 4.1 Onboarding and Comprehension

| Metric                                 | Before                       | After                              |
| -------------------------------------- | ---------------------------- | ---------------------------------- |
| Lines to understand query flow         | ~360 (ragTool) + ~40 (tools) | ~170 (ragQueryService) — one place |
| Consumer-specific code to audit        | ~320 (ragTool)               | ~80 (VS Code adapter logic only)   |
| "Where does result formatting happen?" | Two files                    | One file                           |

New team members can understand the full query pipeline by reading a single 170-line class.

### 4.2 Bug Fix Propagation

Previously, a bug in topic resolution fallback logic, stat checking, or result formatting had to be fixed in two places. With the service extraction:

- **Single fix location** for query pipeline bugs
- **Automatic consistency** — both consumers get the fix
- Zero risk of "fixed in VS Code but not in MCP" regressions

### 4.3 Test Coverage Quality

The critical query pipeline is now testable in pure Node.js via the core package's test suite (317 tests). This is faster to execute, more reliable (no VS Code extension host), and easier to add new cases to. The VS Code tests (22) can focus on VS Code-specific adapter behavior.

### 4.4 Future Consumer Velocity

Adding a new consumer (CLI, HTTP API, desktop app) requires:

1. Implement `IConfigProvider` and `ILLMProvider` for the new environment
2. Instantiate `RAGQueryService`
3. Call `executeQuery()`

No query logic, caching, or result formatting to reimplement.

### 4.5 Net Line Reduction

−168 lines across the refactoring. The codebase is smaller _and_ more capable (shared caching, consistent formatting). This is the rare refactoring that reduces complexity on every axis.

---

## 5. Drawbacks — Trade-offs Made

### 5.1 Increased Coupling Surface

Both consumers now depend on `RAGQueryService`'s exact contract: its error types, result shape, and config key expectations. A breaking change to `executeQuery` (e.g., renaming a field in `RAGQueryResult`) requires updating both consumers simultaneously. Before, each consumer could evolve independently — at the cost of drift.

**Mitigation:** This is the correct trade-off for a shared business pipeline. The `RAGQueryResult` type in `packages/core/src/utils/types.ts` serves as the explicit contract. Breaking changes are caught at compile time.

### 5.2 Error Handling Asymmetry

`RAGQueryService` throws raw errors. Error formatting (path sanitization, user-friendly messages) stays in `ragTool.ts`. The MCP handler wraps errors in `{ error: message, isError: true }` but does no sanitization. This means:

- VS Code users get sanitized error messages
- MCP clients get raw error messages that may contain file paths

If MCP clients display errors to end users, this could leak path information. Acceptable for developer tooling, but worth noting.

### 5.3 Implicit Contract on `extraAgentOptions`

The `Partial<RAGAgentOptions>` spread is flexible but **unvalidated** at the service boundary. A caller could pass `{ topK: -1 }` or `{ confidenceThreshold: 999 }` and the service would use them without protest. The VS Code adapter validates `topK` before calling, but nothing enforces that other callers do the same.

**Risk level:** Low for the current two consumers (both are internal/controlled). Would become a concern if the service is exposed to external callers.

### 5.4 "No Documents" Is No Longer a Distinct State

As discussed in Con 3.1, collapsing the "exists but empty" state into a generic error loses information. The MCP protocol distinguishes error responses from normal responses — using `isError: true` for an empty topic is semantically misleading (it's not an error in the topic or the query; the topic just needs documents).

---

## 6. Recommendations (Prioritized)

| Priority | Item                                                         | Effort  | Impact                                   |
| -------- | ------------------------------------------------------------ | ------- | ---------------------------------------- |
| **P1**   | Introduce `TopicEmptyError` subclass for "no documents" case | Small   | Restores MCP backward compatibility      |
| **P2**   | Fix FIFO→LRU with delete+re-insert on cache hit              | Trivial | Correctness of cache eviction under load |
| **P2**   | Document `extraAgentOptions` override precedence in JSDoc    | Trivial | Developer comprehension                  |
| **P3**   | Bundle `registerTools` params into `ServerContext`           | Small   | Prevents parameter list growth           |
| **P3**   | Remove unused `topicManager` field from `RAGTool`            | Trivial | Code clarity                             |
| **P4**   | Consider MCP-side error message sanitization                 | Medium  | Security hardening for path exposure     |

> **All P1 and P2 items have been implemented.** See §8 below for details.

---

## 7. Verdict

**Approve with minor follow-ups.** The refactoring is well-motivated, well-executed, and the net result is a simpler, more testable, and more maintainable codebase. The cons are all addressable without rework — the P1 item (typed error subclass) is the only one that affects external behavior and has been addressed (see §8).

The design demonstrates good architectural judgment: extracting shared logic without over-abstracting, using interfaces for portability without introducing unnecessary indirection, and keeping consumer-specific concerns in their respective adapters. The 427 passing tests provide strong confidence in the refactoring's correctness.

---

## 8. Implemented Fixes (P1 + P2)

All three P1/P2 recommendations have been implemented and verified (317 core + 88 MCP tests passing, clean compilation).

### 8.1 P1: `TopicEmptyError` — Typed Error Subclass

**Problem:** `RAGQueryService` threw a generic `Error` when a topic had no documents. The MCP handler caught all errors uniformly with `isError: true`, reclassifying what was previously a non-error informational response into a failure. MCP clients that distinguished "empty topic" from "query failed" would see a behavioral regression.

**Fix:**

- **New class `TopicEmptyError`** (`packages/core/src/agents/ragQueryService.ts`):

  ```typescript
  export class TopicEmptyError extends Error {
    public readonly topicName: string;
    constructor(topicName: string) {
      super(`Topic "${topicName}" exists but has no documents. Add documents to the topic before querying.`);
      this.name = "TopicEmptyError";
      this.topicName = topicName;
    }
  }
  ```

- **`RAGQueryService.executeQuery()`** now throws `TopicEmptyError` instead of generic `Error`:

  ```typescript
  if (!stats || stats.documentCount === 0) {
    throw new TopicEmptyError(topicMatch.topic.name);
  }
  ```

- **MCP handler** (`packages/mcp-server/src/tools.ts`) now catches `TopicEmptyError` distinctly and returns a **non-error response**, preserving backward compatibility:

  ```typescript
  if (error instanceof TopicEmptyError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ message: error.message, topicName: error.topicName }),
        },
      ],
    };
  }
  ```

- **Exported** from `packages/core/src/index.ts` for consumer use.

**Impact:** MCP clients see `isError: false` for empty topics (matching pre-refactoring behavior). The VS Code adapter's catch-all error formatter handles `TopicEmptyError` identically to other errors (path sanitization + rethrow), which is acceptable since VS Code surfaces errors through the LM tool framework.

### 8.2 P2: FIFO → True LRU Cache Eviction

**Problem:** The agent cache in `getOrCreateAgent()` evicted the first-inserted key when the `Map` hit capacity, but cache _hits_ didn't promote entries. This was FIFO (first-in, first-out), not LRU — a frequently-accessed topic could be evicted if it was created earliest, causing expensive vector store reloads.

**Fix:** Cache hits now delete and re-insert the entry, promoting it to the most-recently-used position in `Map` iteration order:

```typescript
if (this.cacheAgents && this.ragAgents.has(topicId)) {
  const agent = this.ragAgents.get(topicId)!;
  // Promote to most-recently-used position for true LRU eviction
  this.ragAgents.delete(topicId);
  this.ragAgents.set(topicId, agent);
  return agent;
}
```

Eviction still removes `keys().next().value` — which is now the **least** recently used entry, not just the oldest inserted. This is the standard `Map`-based LRU pattern (O(1) get/put) without needing a doubly-linked list.

**Impact:** Under workloads with >10 active topics, frequently-queried topics are no longer evicted prematurely. Worst-case agent creation (vector store load) is avoided for hot topics.

### 8.3 P2: JSDoc on `extraAgentOptions` Override Precedence

**Problem:** `ragTool.ts` reads config values from `vscode.workspace.getConfiguration()` and passes them as `extraAgentOptions`. Inside `executeQuery()`, the same CONFIG keys are also read from `this.config` as defaults — but immediately overwritten by the spread. The dual-read pattern was undocumented, making it unclear which config source "wins" for future maintainers.

**Fix:** Enhanced the JSDoc on `executeQuery()`:

```typescript
/**
 * @param extraAgentOptions - Additional {@link RAGAgentOptions} merged on top of
 *        config-derived defaults at call time. Values in `extraAgentOptions` take
 *        precedence over both `params` and `IConfigProvider` defaults.
 *        VS Code uses this to inject `workspaceContext` and VS Code setting overrides;
 *        MCP passes `{}`.
 * @throws {TopicEmptyError} if the resolved topic has no documents
 */
```

**Impact:** Future developers understand the precedence chain: `IConfigProvider` defaults → `params` fields → `extraAgentOptions` spread. The `@throws` tag makes the error contract explicit in IDE tooltips.
