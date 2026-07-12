# RAGnarok Structural Code Review — Assessment Report

**Branch:** `mcp-server` (1 commit: monorepo restructure + MCP server)
**Date:** April 18, 2026
**Scope:** 110+ changed files across `packages/core`, `packages/mcp-server`, `packages/vscode`
**Review Team:** 5 specialist reviewers (RAG Architecture, Retrieval Strategies, Query Planning, MCP/API Layer, Benchmarks)
**Focus:** RAG and Graph retrieval approaches — structural quality and best-practice alignment

---

## Executive Summary

| Reviewer                    | Verdict                           | Critical | Major  | Minor  |
| --------------------------- | --------------------------------- | -------- | ------ | ------ |
| R1: RAG Architecture        | **APPROVED** with findings        | 0        | 2      | 4      |
| R2: Retrieval Strategies    | **APPROVED** with findings        | 0        | 3      | 3      |
| R3: Query Planning & Agent  | **APPROVED** with recommendations | 0        | 3      | 5      |
| R4: MCP/API Layer           | **CONDITIONAL APPROVAL**          | 0        | 2      | 6      |
| R5: Benchmarks & Evaluation | **REQUIRED FOLLOW-UP**            | 2        | 5      | 5      |
| **TOTAL**                   |                                   | **2**    | **15** | **23** |

**Overall Verdict: CONDITIONAL APPROVAL** — No architectural blockers, but 2 critical formula issues in metrics and 1 security concern must be addressed before merge.

---

## SECTION 1: CRITICAL ISSUES (Fix Before Merge)

### C1. `stddev()` Uses Population Formula, Not Sample

**File:** `packages/core/test/helpers/metrics.ts`
**Impact:** All statistical summaries in benchmarks report artificially tight confidence bounds.
**Fix:** Use Bessel's correction: divide by `n - 1` instead of `n`.

### C2. `MAP@K` Uses Non-Standard Denominator

**File:** `packages/core/test/helpers/metrics.ts`
**Impact:** MAP scores are incomparable with published BEIR numbers.
**Fix:** Standard MAP@K divides by `min(k, |relevant|)`, not by `k`.

---

## SECTION 2: MAJOR FINDINGS BY DOMAIN

### 2.1 RAG Architecture (Reviewer 1)

#### F1: Stale Agent Cache After Document Mutation — ✅ DONE

- **File:** `packages/core/src/managers/topicManager.ts` — `addDocuments()` invalidates `vectorStoreCache` but does NOT call `notifyAgentCacheCleanup()`.
- **Result:** After adding new documents, the cached `RAGAgent` still searches the OLD vector store. Users get stale results without knowing.
- **Reproduction:**
  1. Create topic "Docs", add `file-a.md` → RAGAgent cached with VectorStore A
  2. Add `file-b.md` → TopicManager invalidates its VectorStore cache, but RAGAgent still holds VectorStore A
  3. Query "content from file-b" → RAGAgent searches VectorStore A → misses file-b chunks
- **Fix:** Add `this.notifyAgentCacheCleanup(topicId)` after `this.vectorStoreCache.delete(topicId)` in `addDocuments()`.
- **Implementation:** Added `this.notifyAgentCacheCleanup(topicId)` call in `addDocuments()` after vector store cache invalidation. `RAGTool` subscribes to `TopicManager.onAgentCacheCleanup` and calls `ragQueryService.clearAgentCache(topicId)`.

#### F2: No AbortSignal Propagation — ✅ DONE

- **Files:** `packages/vscode/src/ragTool.ts`, `packages/mcp-server/src/tools.ts`
- **The chain that's broken:**
  ```
  VS Code CancellationToken → ??? → RAGQueryService.executeQuery() → ??? → RAGAgentOptions.signal
  ```
- **Impact:** Complex queries with `maxIterations: 3` can run 30+ seconds with no cancellation path. `RAGAgent` already supports `options.signal` but no consumer passes one.
- **Fix:** Thread `AbortSignal` from VS Code's `CancellationToken` and MCP request context through `RAGQueryService.executeQuery()` → `RAGAgentOptions.signal`.
- **Implementation:** (1) `ragTool.ts` invoke handler now creates an `AbortController`, registers `token.onCancellationRequested`, disposes the listener in `finally`, and passes `signal` to `executeQuery()`. (2) `ragQueryService.ts` `executeQuery()` and `executeQueryLegacy()` accept `signal?: AbortSignal`; signal is included in `agentOptions` and threaded through both the legacy and LangGraph fallback paths. (3) `ragAgent.ts` checks `signal.aborted` at each iteration boundary and chains the user signal to the LLM abort controller.

---

### 2.2 Retrieval Strategies (Reviewer 2)

#### F3: Score Distribution Mismatch in Hybrid Fusion — ✅ DONE

- **File:** `packages/core/src/retrievers/hybridRetriever.ts`
- **Issue:** The weighted linear combination `0.9 * vectorScore + 0.1 * keywordScore` assumes both scores are in [0,1]. Vector (cosine) is naturally [0,1], but BM25 is [0,∞). The code normalizes BM25 by dividing by `maxBm25Score`, but this is rank-dependent and unstable with small result sets.
- **Best Practice:** Use **percentile-rank normalization** or **z-score normalization** rather than max-normalization. Literature (Cormack et al., 2009) recommends min-max normalization across the candidate set.
- **Impact:** With small result sets (< 10 BM25 results), the max value may be unrepresentative, leading to score inflation/deflation for the keyword component.
- **Implementation:** Replaced max-normalization (`rawBm25 / maxBm25Score`) with min-max normalization (`(rawBm25 - minBm25Score) / bm25Range`). When all BM25 scores are identical (range = 0), assigns uniform 1.0. Fallback TF-scorer for non-BM25 candidates unchanged.

#### F4: RRF k=60 Not Tuned for Corpus Size — ✅ DONE

- **File:** `packages/core/src/retrievers/ensembleRetriever.ts`
- **Issue:** RRF uses `k=60` (the original Cormack et al. value) but this was optimized for web-scale TREC data. For 30-1000 document corpora, k=20-30 often performs better.
- **Recommendation:** Make `k` configurable and test with k ∈ {20, 30, 60} in the benchmark.
- **Implementation:** Added `rrfK?: number` to `EnsembleSearchOptions`. Constructor now accepts `rrfK` parameter (default 60). `search()` uses `options.rrfK ?? this.RRF_CONSTANT`. `reciprocalRankFusion()` accepts `rrfK` parameter. Fully backward-compatible.

#### F5: No Cross-Encoder Reranking

- **All retrievers** return first-stage results without reranking.
- **Impact:** Adding a lightweight cross-encoder (e.g., `cross-encoder/ms-marco-MiniLM-L-6-v2`) as a post-retrieval step typically improves NDCG@10 by 5-15% per BEIR benchmarks.
- This is the **single highest-impact retrieval improvement** available.

---

### 2.3 Query Planning & Agent (Reviewer 3)

#### F6: Unquoted `${query}` in LLM JSON Template — ✅ DONE

- **File:** `packages/core/src/agents/queryPlannerAgent.ts` ~line 221
- **Issue:** In `buildRefinementPrompt()`, the JSON example template contains `"originalQuery": ${query}` without `JSON.stringify()`. Queries with `"`, `\n`, or JSON-special chars produce invalid JSON, degrading LLM output quality.
- **Fix:** `"originalQuery": ${JSON.stringify(query)}`
- **Implementation:** Changed to `"originalQuery": ${JSON.stringify(query)}` — properly escapes quotes, backslashes, and newlines.

#### F7: Confidence = avg(retrieval_scores), Not Answer Quality

- **File:** `packages/core/src/agents/ragAgent.ts` ~line 1092
- **Issue:** `calculateAvgConfidence()` computes `mean(top-K retrieval scores)`. The iterative refinement loop optimizes this proxy metric, not actual answer quality.
- **Why problematic:**
  1. High-scoring irrelevant documents pass (e.g., "Python snake species" for "Python programming")
  2. Score distributions vary by corpus — same threshold means different quality levels
  3. Follow-up queries that find high-scoring but irrelevant docs increase "confidence" without improving answers
- **This is the single largest structural gap** relative to modern agentic RAG patterns.
- **Best Practice (Self-RAG, Asai et al. 2023):** Use LLM to grade passage relevance (`IsREL` token) when available. Fall back to score-based confidence when LLM is unavailable.

#### F8: Gap Threshold Strategy-Unaware — ✅ DONE

- **File:** `packages/core/src/agents/ragAgent.ts` ~line 660
- **Issue:** `GAP_SCORE_THRESHOLD = 0.4` is applied uniformly across all retrieval strategies. BM25 scores are on a completely different scale than cosine similarity. If BM25 scores aren't normalized to [0,1] before gap analysis, the threshold is meaningless for BM25.
- **Score ranges by strategy:**

  | Strategy                 | Score Range | 0.4 Means                    |
  | ------------------------ | ----------- | ---------------------------- |
  | Vector (cosine)          | [0, 1]      | Below-average match          |
  | BM25                     | [0, ∞)      | Almost everything is a "gap" |
  | Hybrid (weighted fusion) | [0, 1]      | Below-average match          |
  | Ensemble (RRF)           | [0, 1]      | Below-average match          |

- **Fix:** Either normalize all retrieval scores to [0,1] before gap analysis, or use per-strategy thresholds.
- **Implementation:** Added `STRATEGY_GAP_THRESHOLDS` map with BM25=2.0 and ENSEMBLE=0.01. `getGapScoreThreshold(strategy?)` checks the map first, falls back to config default (0.4). `analyzeGaps()` and `iterativeRetrieval()` now pass the strategy through.

---

### 2.4 MCP/API Layer (Reviewer 4)

#### F9: `rag_add_documents` Has No Path Traversal Protection

- **File:** `packages/mcp-server/src/tools.ts`
- **Impact:** In HTTP mode, a malicious client can pass `../../etc/passwd` as a file path. The `filePaths` parameter is passed directly to `topicManager.addDocuments()` without sanitization.
- **Fix:** Validate that all file paths are within the workspace/storage directory before processing. Add a `isPathSafe(filePath, allowedRoot)` utility.

#### F10: Config Split Half-Committed

- **Files:** `packages/core/src/constants.ts`, `packages/vscode/src/constants.ts`
- **Issue:** `INCLUDE_WORKSPACE` and `EMBEDDING_VSCODE_MODEL_ID` were correctly moved to `VSCODE_CONFIG`, but the core `CONFIG` object still exports these keys. The `EnvConfigProvider` in MCP removed the mappings, creating a divergence where the same config key name has different behavior across packages.
- **Recommendation:** Remove the orphaned keys from core `CONFIG` or add deprecation comments.

---

### 2.5 Benchmarks (Reviewer 5)

#### F11: 28-Document Corpus Too Small for BEIR Claims

- The benchmark is titled "BEIR-Style" but uses 28 synthetic documents vs. BEIR's 5K-530K real documents per dataset. With 34 queries, statistical power is very low.
- **Recommendation:** Rename to "Internal Retrieval Benchmark" and add disclaimers. Consider using actual BEIR SciFact dataset (5,183 docs) for publishable numbers.

#### F12: Self-Assigned Relevance Judgments

- All qrels are author-assigned without inter-annotator agreement.
- The benchmark measures consistency with the author's intent, not objective relevance.
- **Recommendation:** At minimum, have 2 independent annotators and compute Cohen's kappa.

---

## SECTION 3: COMPARISON WITH BEST PRACTICES

### 3.1 RAG Architecture Paradigm Mapping

| Pattern                                            | Reference                  | RAGnarok Status                                             | Gap                                                    |
| -------------------------------------------------- | -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| **Naive RAG** (retrieve → generate)                | Gao et al., 2024 Survey    | Implemented (vector retrieval)                              | Baseline only                                          |
| **Advanced RAG** (pre/post retrieval optimization) | Gao et al., 2024           | Partially implemented (hybrid fusion, iterative refinement) | Missing: reranking, context compression                |
| **Modular RAG** (composable pipeline)              | Gao et al., 2024           | Emerging (RAGQueryService as orchestrator)                  | Modules not independently configurable                 |
| **Self-RAG** (self-reflective retrieval)           | Asai et al., 2023          | Not implemented                                             | No relevance verification on retrieved passages        |
| **CRAG** (corrective retrieval)                    | Yan et al., 2024           | Partial (gap analysis ≈ quality classification)             | No external fallback, no decompose-then-recompose      |
| **Adaptive RAG**                                   | Jeong et al., 2024 (NAACL) | Partial (complexity scoring routes to simple/iterative)     | Missing "no retrieval" path for simple factual queries |

### 3.2 Retrieval Strategy Comparison

| Feature                                | State of Art               | RAGnarok            | Priority                   |
| -------------------------------------- | -------------------------- | ------------------- | -------------------------- |
| **Dense retrieval** (bi-encoder)       | all-MiniLM-L6-v2           | Implemented         | —                          |
| **Sparse retrieval** (BM25)            | Custom BM25 implementation | Implemented         | Needs stemming             |
| **Hybrid fusion** (weighted)           | 0.9/0.1 vector/keyword     | Implemented         | Needs better normalization |
| **RRF ensemble**                       | k=60, 0.7/0.3              | Implemented         | k needs tuning             |
| **Cross-encoder reranking**            | ms-marco-MiniLM-L-6-v2     | **NOT IMPLEMENTED** | **HIGH**                   |
| **SPLADE** (learned sparse)            | SPLADE-v2                  | Not implemented     | Medium                     |
| **ColBERT** (late interaction)         | ColBERTv2                  | Not implemented     | Low                        |
| **HyDE** (hypothetical doc embeddings) | Gao et al., 2023           | Not implemented     | **HIGH**                   |
| **Query expansion** (PRF)              | RM3, relevance feedback    | Not implemented     | Medium                     |
| **Context compression**                | LongLLMLingua              | Not implemented     | Medium                     |

### 3.3 Graph Retrieval Assessment

The codebase includes Knowledge Graph infrastructure (referenced in `docs/knowledge-graph/`) with phases from foundation to memory integration.

| Feature                         | Best Practice                       | RAGnarok Status           |
| ------------------------------- | ----------------------------------- | ------------------------- |
| Entity extraction               | NER + relation extraction           | Phase 2 planned           |
| Graph traversal retrieval       | Multi-hop entity following          | Phase 3 planned           |
| Knowledge graph + vector hybrid | KG-enhanced retrieval scoring       | Not in current retrievers |
| GraphRAG (Microsoft)            | Community detection + summarization | Not implemented           |
| Entity-aware chunking           | Split on entity boundaries          | Not implemented           |

### 3.4 Agentic RAG Comparison

| Feature                       | Best Practice                          | RAGnarok Status               |
| ----------------------------- | -------------------------------------- | ----------------------------- |
| Query decomposition           | LLM + heuristic fallback               | Implemented (clean design)    |
| Iterative refinement          | Gap analysis → follow-up queries       | Implemented                   |
| Self-reflection (IsREL/IsSUP) | LLM-based passage grading              | Not implemented               |
| Dynamic strategy switching    | Route based on complexity              | Partial (complexity scoring)  |
| Cross-query memory            | Session context / conversation history | Not implemented               |
| Pseudo-relevance feedback     | Use top results to reformulate         | Not implemented               |
| Sequential step execution     | Sub-query 1 output → sub-query 2 input | All parallel                  |
| Answer synthesis              | Generate answer from retrieved context | Not in scope (retrieval only) |
| Confidence calibration        | Corpus-specific score normalization    | Not implemented               |

---

## SECTION 4: TOP 10 RECOMMENDED IMPROVEMENTS (Prioritized)

| #   | Improvement                                                         | Impact                                  | Effort           | Category     |
| --- | ------------------------------------------------------------------- | --------------------------------------- | ---------------- | ------------ |
| 1   | **Add cross-encoder reranking** after first-stage retrieval         | +5-15% NDCG@10 per BEIR                 | Medium           | Retrieval    |
| 2   | ~~**Fix stale agent cache** — notify on `addDocuments()`~~ ✅ DONE  | Prevents silent data freshness bugs     | Trivial (1 line) | Architecture |
| 3   | **Add path traversal protection** in MCP `rag_add_documents`        | Security fix for HTTP mode              | Low              | Security     |
| 4   | **Implement HyDE** (Hypothetical Document Embeddings)               | Better retrieval for abstract queries   | Medium           | Retrieval    |
| 5   | **Add LLM-based relevance grading** for confidence                  | Iterative refinement becomes meaningful | Medium-High      | Agent        |
| 6   | ~~**Normalize BM25 scores properly** (min-max or z-score)~~ ✅ DONE | Fairer hybrid fusion scores             | Low              | Retrieval    |
| 7   | **Fix metrics formulas** (stddev sample, MAP denominator)           | Correct benchmark reporting             | Trivial          | Evaluation   |
| 8   | ~~**Add AbortSignal propagation** through query pipeline~~ ✅ DONE  | User can cancel long queries            | Low              | Architecture |
| 9   | **Implement query routing** (no-retrieval/simple/complex paths)     | Adaptive RAG per Jeong et al.           | Medium           | Agent        |
| 10  | ~~**Make RRF k configurable** and tune for corpus size~~ ✅ DONE    | Better ensemble performance             | Low              | Retrieval    |

---

## SECTION 5: ARCHITECTURAL IMPROVEMENT PROPOSALS

### Proposal A: Two-Stage Retrieval Pipeline (Cross-Encoder Reranking)

```
Query → [First Stage: Hybrid/Ensemble] → Top-30 candidates
      → [Second Stage: Cross-Encoder Reranker] → Top-K final results
```

This is the **single highest-impact improvement** available. Cross-encoders like `ms-marco-MiniLM-L-6-v2` evaluate query-document pairs jointly, catching semantic mismatches that bi-encoders miss. BEIR benchmarks consistently show 5-15% NDCG improvement.

**Implementation Plan:**

1. Add a `Reranker` interface: `rerank(query: string, documents: ScoredDocument[]): Promise<ScoredDocument[]>`
2. Implement `CrossEncoderReranker` using the existing ONNX runtime infrastructure
3. Integrate as a post-retrieval step in `RAGAgent.executeRetrieval()`
4. Make it configurable: `CONFIG.RERANKER_ENABLED`, `CONFIG.RERANKER_MODEL`
5. Benchmark impact with the retrieval evaluation suite

### Proposal B: HyDE (Hypothetical Document Embeddings)

```
Query → [LLM generates hypothetical answer] → [Embed hypothetical answer]
      → [Search with hypothetical embedding] → Results
```

When LLM is available, generate a hypothetical answer to the query, embed it, and search with that embedding instead of the raw query. This bridges the query-document vocabulary gap for abstract/conceptual queries. Per Gao et al. (2023), this improves NDCG@10 by 3-8% on BEIR datasets.

**Implementation Plan:**

1. Add `HyDEQueryTransformer` that takes a query and returns an augmented embedding
2. Integrate into `VectorRetriever` as an optional pre-processing step
3. Fall back to direct query embedding when LLM is unavailable
4. Cache hypothetical document embeddings for repeated similar queries

### Proposal C: CRAG-Style Retrieval Evaluator

```
Results → [Retrieval Evaluator: Correct/Incorrect/Ambiguous]
        → Correct:   use directly
        → Ambiguous: decompose-then-recompose (filter irrelevant passages)
        → Incorrect: reformulate query + retry
```

Replace the simple score-based confidence check with an LLM evaluator that classifies retrieval quality. The existing gap analysis is a good foundation — upgrade it to produce explicit Correct/Incorrect/Ambiguous classifications.

**Implementation Plan:**

1. Add `RetrievalEvaluator` interface with `evaluate(query, results): QualityClassification`
2. Implement `LLMRetrievalEvaluator` that prompts the LLM to classify relevance
3. Implement `ScoreBasedEvaluator` as fallback (current behavior)
4. Wire into the iterative refinement loop in `RAGAgent`

### Proposal D: Graph-Enhanced Retrieval

The knowledge graph phases in `docs/knowledge-graph/` should integrate with retrievers:

```
Query → [Entity Extraction] → [Graph Traversal: related entities]
      → [Vector Search boosted by graph proximity] → Results
```

**Key integration point:** Add a `GraphBoostRetriever` that takes graph proximity scores and uses them as a third signal in hybrid fusion:

```
score = α × vectorScore + β × keywordScore + γ × graphProximityScore
```

**Implementation Plan:**

1. Complete Phase 2 (entity extraction) and Phase 3 (graph retriever)
2. Add `GraphRetriever` interface with `searchByEntity(entities: string[]): ScoredDocument[]`
3. Extend `HybridRetriever` to accept an optional third retriever
4. Add `graphWeight` to `HybridSearchOptions`
5. Benchmark the three-signal fusion against two-signal

---

## SECTION 6: CODE QUALITY OBSERVATIONS

### Positives

- **Clean monorepo separation** (core/vscode/mcp-server) with proper interface boundaries
- **RAGQueryService extraction** from `RAGTool` is a well-executed refactoring — shared logic between VS Code and MCP consumers
- **Shared `keywords.ts` utility** eliminates 3 duplicate stop-word lists
- **Comprehensive test coverage** (303 core + 74 MCP + 20 VS Code tests)
- **BEIR-style benchmark** with 7 strategy configs is ambitious and useful for internal comparison
- **Removed dead features** (strategy/priority fields) — good simplification
- **QueryPlannerAgent cleanup** — removing unused `IConfigProvider` dependency and consolidating options into `QueryPlannerOptions`
- **TopicManager.resolveTopicByName()** — proper abstraction for topic matching logic

### Concerns

- Benchmark claims ("BEIR-Style") overstate the methodology's rigor given 28 synthetic documents
- Error handling diverges between VS Code (sanitized messages) and MCP (raw messages) paths
- Config split between `CONFIG` and `VSCODE_CONFIG` is incomplete — orphaned keys in core
- LangGraph fallback is silent — could mask persistent failures in production
- Defensive config defaults (topK=0, maxIterations=0) produce confusing error messages

---

## SECTION 7: REVIEWER DETAILS

### Reviewer 1: RAG Architecture Specialist

**Focus:** RAGQueryService, RAGAgent lifecycle, topic resolution, agent caching, consumer boundaries

**Key Findings:**

1. **(Major)** Stale agent cache after `addDocuments()` — missing `notifyAgentCacheCleanup()` call
2. **(Major)** No AbortSignal propagation from VS Code/MCP consumers to RAGAgent
3. **(Minor)** LRU eviction race under concurrent async queries (Map grows past MAX_CACHED_AGENTS)
4. **(Minor)** TopicEmptyError returns misleading `topicMatched: "fallback"` in VS Code path
5. **(Minor)** Defensive config defaults (topK=0) produce confusing error messages
6. **(Info)** Silent LangGraph fallback hides persistent pipeline failures

**Verdict:** APPROVED — Clean abstraction boundaries. The RAGQueryService refactoring is well-executed.

---

### Reviewer 2: Retrieval Strategy Specialist

**Focus:** HybridRetriever, EnsembleRetriever, KeywordRetriever, VectorRetriever, score fusion, BM25

**Key Findings:**

1. **(Major)** BM25 max-normalization is rank-dependent and unstable for small result sets
2. **(Major)** RRF k=60 is not tuned for small corpora (30-1000 docs)
3. **(Major)** No cross-encoder reranking — single highest-impact missing feature
4. **(Minor)** No stemming/lemmatization in BM25 keyword extraction
5. **(Minor)** KeywordRetriever BM25 parameters (k1=1.5, b=0.75) are standard but not tuned
6. **(Minor)** Vector similarity type (cosine vs L2) not explicitly documented per store configuration

**Verdict:** APPROVED — Solid implementation of standard retrieval strategies. Main gap is the absence of a reranking stage.

---

### Reviewer 3: Query Planning & Agent Design Specialist

**Focus:** QueryPlannerAgent, iterative refinement, complexity analysis, LLM prompts

**Key Findings:**

1. **(Major)** Unquoted `${query}` in JSON template corrupts LLM prompt for special-char queries
2. **(Major)** Confidence metric is a retrieval-score proxy, not an answer-quality signal
3. **(Major)** Gap threshold (0.4) is strategy-unaware — meaningless for BM25 scores
4. **(Minor)** No prompt injection protection on initial LLM refinement prompt (unlike follow-up prompt)
5. **(Minor)** Complexity scoring misses multi-hop, temporal, and negation patterns
6. **(Minor)** Convergence tracks gap count, not gap identity — premature convergence possible
7. **(Minor)** `broadenQuery()` is a no-op for all-content-word queries
8. **(Minor)** `convertPlanToKeywords()` only applied for BM25, not ENSEMBLE

**Removed Features Assessment:** The removal of `strategy`, `priority`, `maxSubQueries`, `topKMultipliers`, and `validatePlan` is a **net positive**. The `strategy` field was dead code (RAGAgent always used `Promise.all`). The `priority` field's only effect was dynamic topK — marginal value with small sub-query counts.

**Verdict:** APPROVED with recommendations — Well-designed heuristic-first, LLM-enhanced planning.

---

### Reviewer 4: MCP/API Layer & Service Design Specialist

**Focus:** MCP tools, config management, adapter patterns, service boundaries, security

**Key Findings:**

1. **(Major)** `rag_add_documents` has no path traversal protection — exploitable in HTTP mode
2. **(Major)** Config split is half-committed — orphaned keys in core CONFIG
3. **(Minor)** No MCP server dispose/shutdown lifecycle management
4. **(Minor)** `rag_memory` forget mass-delete risk (no confirmation for bulk operations)
5. **(Minor)** topK default divergence between legacy (5) and LangGraph paths
6. **(Minor)** No topic name validation (length, characters)
7. **(Minor)** EnvConfigProvider missing mappings for new config keys
8. **(Minor)** `rag_memory` Zod schema allows invalid parameter combinations
9. **(Info)** Error messages may leak internal paths in MCP (unlike sanitized VS Code)
10. **(Info)** CORS origin defaults to wildcard in HTTP mode

**Verdict:** CONDITIONAL APPROVAL — Service boundaries are clean. Security gap (path traversal) must be fixed before HTTP mode is production-ready.

---

### Reviewer 5: Benchmark & Evaluation Methodology Specialist

**Focus:** retrievalBenchmark.test.ts, retrievalEvaluation.test.ts, metrics, test coverage

**Key Findings:**

1. **(Critical)** `stddev()` uses population formula (n) instead of sample formula (n-1)
2. **(Critical)** `MAP@K` uses non-standard denominator (k instead of min(k, |relevant|))
3. **(Major)** No significance testing (paired t-test, bootstrap confidence intervals)
4. **(Major)** 28-doc corpus too small for BEIR claims — rename to "Internal Benchmark"
5. **(Major)** `evalCorpus.ts` may not be committed (referenced but not in diff)
6. **(Major)** Self-assigned qrels without inter-annotator agreement
7. **(Major)** HYBRID-kw-bm25 config duplicates internal hybrid logic for comparison
8. **(Minor)** Synthetic qrels in eval test use ad-hoc grading
9. **(Minor)** Lenient assertion thresholds (NDCG@5 > 0.2)
10. **(Minor)** No delta p-values in ablation study
11. **(Minor)** No-op assertion in decomposition test
12. **(Minor)** Duplicate metric implementations between eval and benchmark files

**Verdict:** REQUIRED FOLLOW-UP — Formula corrections are blocking. Rename "BEIR-Style" claims.

---

## References

1. Lewis et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks." NeurIPS 2020. arXiv:2005.11401
2. Gao et al. (2024). "Retrieval-Augmented Generation for Large Language Models: A Survey." arXiv:2312.10997
3. Asai et al. (2023). "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection." arXiv:2310.11511
4. Yan et al. (2024). "Corrective Retrieval Augmented Generation." arXiv:2401.15884
5. Jeong et al. (2024). "Adaptive-RAG: Learning to Adapt Retrieval-Augmented Large Language Models through Question Complexity." NAACL 2024. arXiv:2403.14403
6. Gao et al. (2023). "Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)." ACL 2023. arXiv:2212.10496
7. Cormack et al. (2009). "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods." SIGIR 2009
8. Thakur et al. (2021). "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models." NeurIPS 2021
9. Microsoft GraphRAG (2024). "From Local to Global: A Graph RAG Approach to Query-Focused Summarization."
