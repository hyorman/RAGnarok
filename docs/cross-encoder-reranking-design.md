# F5: Cross-Encoder Reranking — Design & Implementation Plan

**Status:** Proposed
**Priority:** #1 from structural review (single highest-impact retrieval improvement)
**Expected Impact:** +5-15% NDCG@10 on BEIR benchmarks (Thakur et al., 2021)
**Finding:** STRUCTURAL-REVIEW-REPORT.md §2.2 F5, Proposal A

---

## 1. Background & Motivation

### The Problem

All current RAGnarok retrieval strategies (vector, hybrid, ensemble, BM25, graph) are **first-stage retrievers** — they trade accuracy for speed using bi-encoder (independent query/doc encoding) or lexical matching. This means:

- **Bi-encoders** compress query and document into fixed-size vectors independently — they can't model fine-grained token-level interactions between query and document.
- **BM25** matches exact lexical terms — it misses synonyms, paraphrases, and semantic equivalences.
- **Hybrid/ensemble** fuse these two signals but still inherit their individual weaknesses.

### The Solution: Two-Stage Retrieve & Re-Rank

The industry-standard approach (SBERT Retrieve & Re-Rank pipeline):

```
Query → [Stage 1: Fast Retrieval] → Top-N candidates (N=30-50)
      → [Stage 2: Cross-Encoder Reranking] → Top-K final results (K=5-10)
```

**Cross-encoders** process query-document pairs jointly through a full transformer attention mechanism. This enables:
- Token-level interaction between query and document terms
- Understanding of negation, qualification, and contextual relevance
- Significantly higher accuracy at the cost of O(N) inference per query

### Evidence

| Source | Finding |
|--------|---------|
| SBERT benchmarks | ms-marco-MiniLM-L6-v2: NDCG@10 74.30 on TREC-DL 2019, MRR@10 39.01 on MS MARCO |
| BEIR (Thakur et al., 2021) | Cross-encoder reranking improves NDCG@10 by 5-15% across diverse datasets |
| Mixedbread BEIR eval | mxbai-rerank-xsmall-v1 (70M params): aggregated 70.0 across 11 BEIR datasets |
| RAGnarok baseline | Current best (HYBRID): NDCG@10 = 0.661 on SciFact |

---

## 2. Model Selection

### Candidate Models (ranked by suitability for RAGnarok)

| Model | Params | Architecture | ONNX | Transformers.js | TREC-DL NDCG@10 | MS MARCO MRR@10 | Speed (V100) | License |
|-------|--------|-------------|------|-----------------|-----------------|-----------------|--------------|---------|
| **Xenova/ms-marco-MiniLM-L-6-v2** | 22.7M | MiniLM-L6 | ✅ | ✅ (pre-converted) | 74.30 | 39.01 | 1800 q/s | Apache 2.0 |
| cross-encoder/ms-marco-TinyBERT-L2-v2 | ~15M | TinyBERT-L2 | ✅ | Needs conversion | 69.84 | 32.56 | 9000 q/s | Apache 2.0 |
| cross-encoder/ms-marco-MiniLM-L4-v2 | ~19M | MiniLM-L4 | ✅ | Needs conversion | 73.04 | 37.70 | 2500 q/s | Apache 2.0 |
| cross-encoder/ms-marco-MiniLM-L12-v2 | ~33M | MiniLM-L12 | ✅ | Needs conversion | 74.31 | 39.02 | 960 q/s | Apache 2.0 |
| mixedbread-ai/mxbai-rerank-xsmall-v1 | 70.8M | DeBERTa-v2 | ✅ | ✅ | — | — | — | Apache 2.0 |

### Recommended: `Xenova/ms-marco-MiniLM-L-6-v2`

**Rationale:**
1. **Already ONNX-converted** for Transformers.js — zero conversion work needed
2. **Same model family** as the existing embedding model (`Xenova/all-MiniLM-L6-v2`) — familiar infrastructure, similar WASM memory footprint (~23M params)
3. **Best speed/accuracy tradeoff** — only 1 NDCG point below L12 at 2× the speed
4. **Pre-existing Xenova namespace** already in the project's model directory structure
5. **Apache 2.0** — compatible with the project's license

**Fallback option:** `cross-encoder/ms-marco-TinyBERT-L2-v2` for ultra-low-latency scenarios (4.5× faster, -4.5 NDCG points).

### Key Difference from Embeddings

Cross-encoders are **NOT** embedding models. They don't produce embeddings. Instead:

```
Input:  (query_text, document_text) pair
Output: Single relevance score (raw: -10 to +10, or 0 to 1 with sigmoid)
```

This means:
- **No vector store** — scores are computed on-the-fly for each (query, document) pair
- **O(N) inference** per query — score each candidate independently
- **Pipeline type:** `text-classification` (SequenceClassification), NOT `feature-extraction`
- **Tokenizer:** Concatenates [CLS] query [SEP] document [SEP] and produces single logit

---

## 3. Architecture Design

### 3.1 Reranker Interface

A new `Reranker` abstraction layer, parallel to `EmbeddingBackend`:

```typescript
// packages/core/src/rerankers/reranker.ts

export interface ScoredDocument {
  document: LangChainDocument;
  score: number;
  originalScore?: number;  // Pre-reranking score (for diagnostics)
}

export interface RerankerOptions {
  /** Maximum number of candidates to rerank (caps input size) */
  maxCandidates?: number;
  /** Whether to apply sigmoid to normalize scores to [0,1] */
  normalizeScores?: boolean;
}

export interface Reranker {
  readonly name: string;

  /**
   * Rerank a set of candidate documents for a query.
   * Returns documents sorted by relevance (highest first).
   *
   * @param query - The search query
   * @param candidates - Documents to rerank (from first-stage retrieval)
   * @param topK - Number of top results to return
   * @param options - Optional reranking configuration
   */
  rerank(
    query: string,
    candidates: ScoredDocument[],
    topK: number,
    options?: RerankerOptions,
  ): Promise<ScoredDocument[]>;

  /** Initialize the reranker (load model, etc.) */
  initialize(): Promise<void>;

  /** Check if the reranker is available/ready */
  isAvailable(): Promise<boolean>;

  /** Release resources */
  dispose(): void;
}
```

### 3.2 Cross-Encoder Reranker Implementation

```typescript
// packages/core/src/rerankers/crossEncoderReranker.ts

export class CrossEncoderReranker implements Reranker {
  readonly name = "cross-encoder";

  private model: AutoModelForSequenceClassification | null = null;
  private tokenizer: AutoTokenizer | null = null;
  private modelName: string;
  private logger: Logger;
  private initMutex: Mutex;

  // Default: cap at 30 candidates (cross-encoder is O(N) per query)
  private static readonly DEFAULT_MAX_CANDIDATES = 30;
  // Maximum input length for the model (query + document)
  private static readonly MAX_TOKEN_LENGTH = 512;

  constructor(modelName?: string) {
    this.modelName = modelName ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    this.logger = new Logger("CrossEncoderReranker");
    this.initMutex = new Mutex();
  }

  async initialize(): Promise<void> {
    // Same pattern as HuggingFaceBackend: dynamic import + mutex
    await this.initMutex.runExclusive(async () => {
      if (this.model && this.tokenizer) return;

      const transformers = await import("@huggingface/transformers");
      const { AutoModelForSequenceClassification, AutoTokenizer } = transformers;

      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
      this.model = await AutoModelForSequenceClassification.from_pretrained(
        this.modelName,
        { quantized: true }  // Use quantized ONNX for faster inference
      );
    });
  }

  async rerank(
    query: string,
    candidates: ScoredDocument[],
    topK: number,
    options?: RerankerOptions,
  ): Promise<ScoredDocument[]> {
    if (!this.model || !this.tokenizer) {
      await this.initialize();
    }

    const maxCandidates = options?.maxCandidates
      ?? CrossEncoderReranker.DEFAULT_MAX_CANDIDATES;

    // Cap candidates to avoid excessive inference time
    const toRerank = candidates.slice(0, maxCandidates);

    // Score each (query, document) pair
    const scored = await this.scoreAll(query, toRerank, options);

    // Sort by reranked score (descending) and take topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private async scoreAll(
    query: string,
    candidates: ScoredDocument[],
    options?: RerankerOptions,
  ): Promise<ScoredDocument[]> {
    // Build query-document pairs for batch inference
    const queries = candidates.map(() => query);
    const documents = candidates.map(c => c.document.pageContent);

    // Tokenize all pairs at once
    const features = this.tokenizer!(
      queries,
      { text_pair: documents, padding: true, truncation: true, max_length: 512 }
    );

    // Run inference
    const output = await this.model!(features);
    const logits: Float32Array = output.logits.data;

    // Map scores back to documents
    return candidates.map((candidate, i) => {
      const rawScore = logits[i];
      const score = options?.normalizeScores !== false
        ? sigmoid(rawScore)
        : rawScore;

      return {
        document: candidate.document,
        score,
        originalScore: candidate.score,
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;  // WASM/ONNX is always available
  }

  dispose(): void {
    this.model = null;
    this.tokenizer = null;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
```

### 3.3 Remote Reranker (API-based)

For users who prefer to use hosted reranking services (Cohere, Jina, OpenAI):

```typescript
// packages/core/src/rerankers/remoteReranker.ts

export class RemoteReranker implements Reranker {
  readonly name = "remote";

  // Supports:
  // - Cohere /v1/rerank
  // - Jina /v1/rerank
  // - Any OpenAI-compatible rerank endpoint
  constructor(private baseUrl: string, private apiKey: string, private model?: string) {}

  async rerank(query, candidates, topK, options): Promise<ScoredDocument[]> {
    const response = await fetch(`${this.baseUrl}/v1/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map(c => c.document.pageContent),
        top_n: topK,
      }),
    });
    // Map response scores back to ScoredDocument[]
  }
}
```

### 3.4 Integration Point: RAGAgent

The reranker slots into `RAGAgent` between retrieval and result return, as a **post-retrieval step**:

```
RAGAgent.query()
  ├── Step 1: createPlan()
  ├── Step 2: executeRetrieval() / iterativeRetrieval()
  │     ├── executeSubQuery() → dispatchSearch() → [vector|hybrid|ensemble|bm25|graph]
  │     └── returns: RetrievalResult[] (first-stage, N=30+ candidates)
  ├── Step 3: deduplicateResults()
  ├── Step 4: rankResults()
  ├── ★ Step 4.5 (NEW): rerankResults()  ← Cross-encoder reranking
  ├── Step 5: slice(0, topK)
  └── return RAGResult
```

**Key design decisions:**

1. **Rerank AFTER deduplication** — no point scoring duplicate content twice
2. **Rerank BEFORE topK slicing** — reranker sees more candidates than final K
3. **Over-fetch in first stage** — when reranking is enabled, retrieve `topK * 3` (default 30) candidates instead of `topK` (default 5-10). This gives the reranker more candidates to work with.
4. **Reranker is optional** — disabled by default, behind `CONFIG.RERANKER_ENABLED` flag
5. **Score replacement** — reranked scores replace first-stage scores in `RetrievalResult.score`. Original score preserved in new `originalScore` field for diagnostics.

**Modified flow in `RAGAgent.query()`:**

```typescript
// Step 4.5: Optional reranking
if (this.reranker && await this.reranker.isAvailable()) {
  const reranked = await this.reranker.rerank(
    query,
    rankedResults.map(r => ({ document: r.document, score: r.score })),
    options.topK,
    { normalizeScores: true },
  );
  // Map reranked scores back to RetrievalResult[]
  finalResults = reranked.map(r => ({
    ...existingResult,        // preserve subQuery, source, etc.
    score: r.score,           // cross-encoder score
    originalScore: r.originalScore,
  }));
} else {
  finalResults = rankedResults.slice(0, options.topK);
}
```

### 3.5 Over-Fetch Strategy

When reranking is enabled, the first-stage retriever should fetch more candidates:

| Setting | Without Reranker | With Reranker |
|---------|-----------------|---------------|
| topK requested | 5 | 5 |
| First-stage fetch | 5 | 30 (topK × 6, capped at 50) |
| Cross-encoder input | — | 30 candidates |
| Final output | 5 | 5 |

The over-fetch multiplier is configurable via `CONFIG.RERANKER_CANDIDATE_MULTIPLIER` (default: 6).

---

## 4. Configuration

### 4.1 New Config Keys

```typescript
// packages/core/src/constants.ts — additions to CONFIG
RERANKER_ENABLED: "rerankerEnabled",           // boolean, default: false
RERANKER_MODEL: "rerankerModel",               // string, default: "Xenova/ms-marco-MiniLM-L-6-v2"
RERANKER_MAX_CANDIDATES: "rerankerMaxCandidates",  // number, default: 30
RERANKER_CANDIDATE_MULTIPLIER: "rerankerCandidateMultiplier",  // number, default: 6
```

### 4.2 VS Code Settings

```json
{
  "ragnarok.rerankerEnabled": false,
  "ragnarok.rerankerModel": "Xenova/ms-marco-MiniLM-L-6-v2"
}
```

### 4.3 MCP Environment Variables

```
RAGNAROK_RERANKER_ENABLED=true
RAGNAROK_RERANKER_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
RAGNAROK_RERANKER_API_URL=https://...  (for remote reranker)
RAGNAROK_RERANKER_API_KEY=...
```

---

## 5. File Plan

### New Files

| File | Purpose |
|------|---------|
| `packages/core/src/rerankers/reranker.ts` | `Reranker` interface + `ScoredDocument` types |
| `packages/core/src/rerankers/crossEncoderReranker.ts` | Local ONNX cross-encoder implementation |
| `packages/core/src/rerankers/remoteReranker.ts` | HTTP API reranker (Cohere/Jina compatible) |
| `packages/core/src/rerankers/index.ts` | Barrel export |
| `packages/core/test/crossEncoderReranker.test.ts` | Unit tests |
| `packages/core/test/rerankerBenchmark.test.ts` | BEIR benchmark with reranking |

### Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/constants.ts` | Add `RERANKER_*` config keys |
| `packages/core/src/agents/ragAgent.ts` | Add reranker injection, over-fetch logic, post-retrieval reranking step |
| `packages/core/src/agents/ragQueryService.ts` | Wire reranker into agent creation |
| `packages/core/src/index.ts` | Export new reranker types |
| `packages/vscode/src/constants.ts` | Add VS Code setting contributions |
| `packages/mcp-server/src/config.ts` | Add env var mappings for reranker config |

---

## 6. Implementation Phases

### Phase 1: Core Reranker Infrastructure (MVP)

**Goal:** Working cross-encoder reranking behind a feature flag.

1. Create `Reranker` interface and `ScoredDocument` type
2. Implement `CrossEncoderReranker` using `@huggingface/transformers`
   - Dynamic import (same pattern as `HuggingFaceBackend`)
   - `AutoModelForSequenceClassification.from_pretrained()` + `AutoTokenizer.from_pretrained()`
   - Batch inference: tokenize all pairs, single forward pass
   - Sigmoid normalization to [0, 1]
3. Add config keys (`RERANKER_ENABLED`, `RERANKER_MODEL`)
4. Integrate into `RAGAgent`:
   - Accept optional `Reranker` in `initialize()`
   - Add `rerankResults()` step between `rankResults()` and topK slicing
   - Over-fetch when reranker is present
5. Wire reranker creation in `RAGQueryService.getOrCreateAgent()`
6. Unit tests for `CrossEncoderReranker`

**Estimated new code:** ~400 lines (implementation) + ~200 lines (tests)

### Phase 2: Benchmarking & Tuning

**Goal:** Quantify impact and optimize parameters.

1. Add reranking to the BEIR SciFact benchmark
2. Measure NDCG@10 lift across all strategies (vector, hybrid, ensemble)
3. Tune parameters:
   - `maxCandidates` sweep: {20, 30, 50}
   - Quantized vs unquantized model
   - Latency profiling per query
4. Compare with/without reranking for each strategy:

   | Strategy | NDCG@10 (no rerank) | NDCG@10 (rerank) | Δ |
   |----------|--------------------|--------------------|---|
   | VECTOR | 0.603 | ? | ? |
   | HYBRID | 0.661 | ? | ? |
   | ENSEMBLE | 0.635 | ? | ? |
   | BM25 | 0.588 | ? | ? |

### Phase 3: Remote Reranker Support

**Goal:** Support hosted reranking APIs for production deployments.

1. Implement `RemoteReranker` (Cohere `/v1/rerank` format)
2. Add MCP env var configuration
3. Auto-select local vs remote based on availability
4. Test with Cohere and Jina endpoints

### Phase 4: Model Management

**Goal:** Download/cache cross-encoder models seamlessly.

1. Extend `ModelRegistry` to track reranker models separately from embedding models
2. Add `rag_reranker_info` / `rag_switch_reranker_model` MCP tools
3. Support model download with progress reporting
4. Consider bundling the default model in the VSIX (23MB, similar to embedding model)

---

## 7. Performance Considerations

### Latency Budget

| Operation | Estimated Time | Notes |
|-----------|---------------|-------|
| First-stage retrieval | 50-200ms | Existing (unchanged) |
| Cross-encoder model load | 2-5s | One-time, cached |
| Tokenization (30 pairs) | 5-10ms | Batch tokenization |
| ONNX inference (30 pairs) | 50-150ms | WASM, quantized model |
| **Total reranking overhead** | **55-160ms** | Per query, after model load |
| **End-to-end with reranking** | **105-360ms** | First-stage + reranking |

The 50-160ms reranking overhead is acceptable for an interactive RAG tool (user queries are not sub-millisecond sensitive).

### Memory Budget

| Component | Size | Notes |
|-----------|------|-------|
| ONNX model (quantized) | ~12MB | int8 quantization of 22.7M params |
| ONNX model (unquantized) | ~23MB | fp32 |
| Tokenizer | ~500KB | Shared MiniLM tokenizer |
| Runtime WASM overhead | ~50MB | Shared with embedding ONNX runtime |
| **Total additional** | **~12-23MB** | Model only (runtime shared) |

Since RAGnarok already loads the ONNX runtime for embeddings, the reranker only adds the model weights (~12MB quantized).

### Optimization Opportunities

1. **Batch inference** — tokenize and score all 30 candidates in one forward pass (not 30 separate calls)
2. **Quantized model** — use int8 quantized ONNX for ~2× speedup with <1% quality loss
3. **Early termination** — if top candidate has score > 0.95, skip reranking remaining
4. **Lazy loading** — only load the reranker model on first use (not at startup)
5. **Max token length** — truncate long documents to 512 tokens (model's context window)
6. **Shared ONNX runtime** — the WASM runtime is already loaded for embeddings

---

## 8. Testing Strategy

### Unit Tests

```typescript
describe("CrossEncoderReranker", () => {
  it("should rerank candidates by relevance score");
  it("should cap candidates at maxCandidates");
  it("should normalize scores to [0,1] with sigmoid");
  it("should preserve document metadata through reranking");
  it("should handle empty candidate list");
  it("should handle single candidate");
  it("should store original score in originalScore field");
  it("should be idempotent on initialize()");
});
```

### Integration Tests

```typescript
describe("RAGAgent with reranking", () => {
  it("should over-fetch candidates when reranker is enabled");
  it("should produce same topK count with and without reranker");
  it("should improve NDCG@10 on BEIR SciFact");
  it("should fall back gracefully if reranker fails to load");
  it("should respect RERANKER_ENABLED=false config");
});
```

### Benchmark Tests

Extend `beirBenchmark.test.ts` to include reranking variants:
- `VECTOR+RERANK`, `HYBRID+RERANK`, `ENSEMBLE+RERANK`, `BM25+RERANK`
- Compare NDCG@10, MRR, Recall@5 with and without reranking
- Report latency overhead per strategy

---

## 9. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| WASM inference too slow on weak machines | Medium | Quantized model + lazy loading + configurable off |
| Model download size increases VSIX | Medium | Download on first use (not bundled), or optional asset |
| Cross-encoder context window (512 tokens) truncates long chunks | Low | Chunks are already split to ~500 chars by default |
| Score normalization incompatible with gap analysis | Medium | Use original first-stage scores for gap analysis, reranked scores for final ranking only |
| Memory pressure from two ONNX models | Low | Both models share WASM runtime; total ~35MB for both |
| Breaking change to RetrievalResult.score semantics | Medium | New `originalScore` field preserves pre-rerank score; gap analysis uses pre-rerank scores |

---

## 10. References

1. **SBERT Retrieve & Re-Rank Pipeline** — https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html
2. **cross-encoder/ms-marco-MiniLM-L6-v2** — https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2 (NDCG@10: 74.30, MRR@10: 39.01, 1800 q/s)
3. **Xenova/ms-marco-MiniLM-L-6-v2** — https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2 (ONNX/Transformers.js ready)
4. **mxbai-rerank-xsmall-v1** — https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1 (70.0 BEIR aggregate, 70.8M params)
5. **Thakur et al. (2021)** — BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models. NeurIPS 2021.
6. **Nogueira & Cho (2020)** — Passage Re-ranking with BERT. arXiv:1901.04085
7. **Gao et al. (2024)** — Retrieval-Augmented Generation for Large Language Models: A Survey. arXiv:2312.10997
