# RAGnarōk Retrieval Benchmarks

Comprehensive benchmark results for RAGnarōk's retrieval strategies, evaluated
across multiple standard IR datasets. Default results use the **all-MiniLM-L6-v2**
embedding model (384-dim); see [Model Comparison](#model-comparison) for
cross-model benchmarks.

---

## Retrieval Strategies

| Strategy              | Description                                                                      |
| --------------------- | -------------------------------------------------------------------------------- |
| **HYBRID-default**    | Weighted score fusion (V0.9 / K0.1) combining vector + BM25 keyword scores       |
| **HYBRID-kw-bm25**    | Same as HYBRID-default but BM25 receives extracted keywords instead of raw query |
| **ENSEMBLE-default**  | Reciprocal Rank Fusion (RRF, k=60) with default weights (V0.5 / B0.5)            |
| **ENSEMBLE-raw-bm25** | Same as ENSEMBLE-default but BM25 receives the raw natural-language query        |
| **VECTOR-only**       | Pure semantic search via cosine similarity                                       |
| **BM25-raw**          | BM25 with the raw natural-language query                                         |
| **BM25-keyword**      | BM25 with extracted keywords                                                     |
| **+rerank**           | Any strategy above with cross-encoder reranking (Xenova/ms-marco-MiniLM-L-6-v2)  |

---

## Quick Reference — Cross-Dataset Comparison (NDCG@10)

| Strategy         | SciFact   | NFCorpus  | FiQA      | FRAMES     |
| ---------------- | --------- | --------- | --------- | ---------- |
| HYBRID-default   | **0.661** | **0.335** | 0.318     | 0.481¹     |
| ENSEMBLE-default | 0.635     | 0.320     | 0.326     | 0.417¹     |
| VECTOR-only      | 0.603     | 0.319     | **0.358** | **0.535**¹ |
| BM25-keyword     | 0.588     | 0.259     | 0.169     | 0.321¹     |

¹ FRAMES uses NDCG@5 (MRR@10 reported separately).

**Key finding:** HYBRID leads on small domain-specific corpora where keywords
overlap with domain vocabulary. VECTOR-only dominates on large corpora and
complex multi-hop queries where semantic understanding outperforms keyword
matching.

---

## 1. BEIR SciFact

- **Corpus:** 5,183 scientific claim documents
- **Queries:** 300
- **Task:** Scientific fact verification — claim → evidence retrieval
- **Source:** [BEIR Benchmark](https://github.com/beir-cellar/beir)

### Results

| Config             | NDCG@1    | NDCG@5 | NDCG@10   | Recall@5  | MRR   |
| ------------------ | --------- | ------ | --------- | --------- | ----- |
| **HYBRID-default** | **0.550** | —      | **0.661** | 68.6%     | 0.629 |
| ENSEMBLE-default   | 0.487     | —      | 0.635     | **68.9%** | 0.589 |
| VECTOR-only        | —         | —      | 0.603     | —         | —     |
| BM25-keyword       | —         | —      | 0.588     | —         | —     |

### Weight Sweep

- **HYBRID optimal:** V0.9/K0.1 (default is already optimal)
- **ENSEMBLE optimal:** V0.5/B0.5 (NDCG@10=0.635); default V0.7/B0.3 is suboptimal (0.623)

### Head-to-Head

HYBRID wins 49 queries vs ENSEMBLE's 43 at NDCG@10 (208 ties). HYBRID excels
at ranking quality (NDCG@1 +8.3%, MRR +5.2%); ENSEMBLE has marginally better
recall (+1.6%).

---

## 2. BEIR NFCorpus

- **Corpus:** 3,633 biomedical documents (nutrition/fitness)
- **Queries:** 323
- **Task:** Biomedical information retrieval
- **Source:** [BEIR Benchmark](https://github.com/beir-cellar/beir)

### Results

| Config             | NDCG@1    | NDCG@5    | NDCG@10   | Recall@5 | MRR       |
| ------------------ | --------- | --------- | --------- | -------- | --------- |
| **HYBRID-default** | **0.432** | **0.365** | **0.335** | 12.6%    | **0.534** |
| HYBRID-kw-bm25     | 0.432     | 0.365     | 0.335     | 12.6%    | 0.534     |
| VECTOR-only        | 0.377     | 0.344     | 0.319     | 12.2%    | 0.502     |
| ENSEMBLE-raw-bm25  | 0.401     | 0.340     | 0.322     | 11.7%    | 0.517     |
| ENSEMBLE-default   | 0.402     | 0.339     | 0.320     | 11.8%    | 0.522     |
| BM25-keyword       | 0.338     | 0.282     | 0.259     | 10.0%    | 0.434     |
| BM25-raw           | 0.315     | 0.266     | 0.246     | 9.8%     | 0.413     |

### Weight Sweep

- **HYBRID optimal:** V0.95/K0.05 (NDCG@10=0.345, Δ=+0.009 vs default)
- **ENSEMBLE optimal:** V0.9/B0.1 (NDCG@10=0.327, Δ=+0.007 vs default)

### Notes

Low Recall@5 (10–13%) is expected: NFCorpus has many relevant documents per
query (high relevance depth), so top-5 captures only a fraction. HYBRID excels
here because biomedical terminology provides strong keyword signals.

---

## 3. BEIR FiQA

- **Corpus:** 57,638 financial QA documents
- **Queries:** 648
- **Task:** Financial opinion/advice retrieval
- **Source:** [BEIR Benchmark](https://github.com/beir-cellar/beir)
- **Runtime:** ~2 hours (CPU, all-MiniLM-L6-v2)

### Results

| Config            | NDCG@1    | NDCG@5    | NDCG@10   | Recall@5  | MRR       |
| ----------------- | --------- | --------- | --------- | --------- | --------- |
| **VECTOR-only**   | **0.347** | **0.332** | **0.358** | **34.1%** | **0.433** |
| HYBRID-default    | 0.327     | 0.301     | 0.318     | 30.7%     | 0.401     |
| ENSEMBLE-raw-bm25 | 0.278     | 0.298     | 0.331     | 33.1%     | 0.391     |
| ENSEMBLE-default  | 0.295     | 0.297     | 0.326     | 33.0%     | 0.397     |
| BM25-keyword      | 0.159     | 0.147     | 0.169     | 15.8%     | 0.217     |
| BM25-raw          | 0.120     | 0.116     | 0.134     | 12.3%     | 0.171     |

### Weight Sweep

- **HYBRID optimal:** V0.95/K0.05 (NDCG@10=0.363, Δ=+0.045 vs default)
- **ENSEMBLE optimal:** V0.95/B0.05 (NDCG@10=0.363, Δ=+0.038 vs default)

Both converge to near-pure vector search (V≈1.0), confirming VECTOR-only
superiority on this dataset.

### Head-to-Head

HYBRID wins 119 vs ENSEMBLE 101 at NDCG@5 (428 ties). At NDCG@10, ENSEMBLE
wins 152 vs HYBRID 140 (356 ties) — ENSEMBLE's RRF slightly better at deeper
ranking.

---

## 4. FRAMES Multi-Hop Benchmark

- **Corpus:** 2,314 Wikipedia article summaries (fetched from 2,503 unique URLs;
  189 unavailable due to API rate limits — 92.5% coverage)
- **Queries:** 822 multi-hop reasoning questions
- **Task:** Multi-hop QA — find all relevant Wikipedia articles for complex
  questions requiring multiple reasoning steps
- **Source:** [Google FRAMES Dataset](https://huggingface.co/datasets/google/frames-benchmark)

### Results (all-MiniLM-L6-v2, 384-dim)

| Config           | NDCG@5    | Recall@5  | MRR@10    |
| ---------------- | --------- | --------- | --------- |
| **VECTOR-only**  | **0.535** | **52.2%** | **0.675** |
| HYBRID-default   | 0.485     | 48.0%     | 0.615     |
| ENSEMBLE-default | 0.398     | 42.7%     | 0.513     |
| BM25-keyword     | 0.223     | 23.2%     | 0.321     |

### Results (bge-base-en-v1.5, 768-dim)

| Config           | NDCG@5    | Recall@5  | MRR@10    |
| ---------------- | --------- | --------- | --------- |
| **VECTOR-only**  | **0.667** | **64.8%** | **0.823** |
| HYBRID-default   | 0.509     | 49.3%     | 0.686     |
| ENSEMBLE-default | 0.491     | 50.2%     | 0.661     |
| BM25-keyword     | 0.256     | 25.4%     | 0.397     |

### Model Comparison on FRAMES

| Metric          | all-MiniLM-L6-v2 | bge-base-en-v1.5 | Δ (improvement) |
| --------------- | ---------------- | ---------------- | --------------- |
| VECTOR NDCG@5   | 0.535            | **0.667**        | **+24.7%**      |
| VECTOR Recall@5 | 52.2%            | **64.8%**        | **+24.1%**      |
| VECTOR MRR@10   | 0.675            | **0.823**        | **+21.9%**      |
| HYBRID NDCG@5   | 0.485            | 0.509            | +4.9%           |

### Recall@5 by Reasoning Type

| Type                 | MiniLM VECTOR | bge-base VECTOR | MiniLM HYBRID | bge-base HYBRID |
| -------------------- | ------------- | --------------- | ------------- | --------------- |
| Numerical reasoning  | 57.7%         | **66.7%**       | 51.0%         | 49.1%           |
| Post processing      | 53.9%         | **66.3%**       | 50.2%         | 47.2%           |
| Tabular reasoning    | 50.3%         | **60.4%**       | 48.1%         | 47.4%           |
| Multiple constraints | 49.3%         | **60.9%**       | 45.5%         | 46.7%           |
| Temporal reasoning   | 48.5%         | **63.7%**       | 43.6%         | 47.0%           |

### Notes

- **bge-base VECTOR-only dominates FRAMES**, with +24.7% NDCG@5 over MiniLM.
  The 768-dim embeddings capture multi-hop semantic relationships far better.
- VECTOR-only beats HYBRID on both models — BM25's keyword component
  actively dilutes ranking for complex multi-hop queries where keyword overlap
  with relevant articles is low.
- bge-base improves recall uniformly across all reasoning types (+10–15pp).
- Temporal reasoning closes the gap with bge-base (63.7% vs 48.5%), suggesting
  higher-dim embeddings better capture temporal concepts.
- 92.5% corpus coverage (2,314/2,503 articles). Improved from 72% through
  incremental caching across runs.

---

## Model Comparison

Cross-model benchmark results on **BEIR SciFact** (5,183 docs, 300 queries).
All models use ONNX fp32 weights with CPU inference. Times measured on Apple M-series.

### Summary

| Model                     | Dims | ONNX Size | Time   | Best NDCG@10 | Best Strategy |
| ------------------------- | ---- | --------- | ------ | ------------ | ------------- |
| all-MiniLM-L6-v2          | 384  | ~23 MB    | 8 min  | 0.661        | HYBRID        |
| bge-small-en-v1.5         | 384  | ~33 MB    | 9 min  | 0.661        | HYBRID        |
| **bge-base-en-v1.5**      | 768  | ~109 MB   | 14 min | **0.706**    | VECTOR        |
| text-embedding-3-small¹   | 512  | remote    | 10 min | 0.703        | VECTOR        |
| multi-qa-MiniLM-L6-cos-v1 | 384  | ~23 MB    | 8 min  | 0.617        | HYBRID        |

¹ OpenAI API model, tested via remote embedding backend.

### Per-Strategy Results

| Model                     | HYBRID NDCG@10 | HYBRID Recall@5 | ENSEMBLE NDCG@10 | VECTOR NDCG@10 | VECTOR Recall@5 | BM25 NDCG@10 |
| ------------------------- | -------------- | --------------- | ---------------- | -------------- | --------------- | ------------ |
| all-MiniLM-L6-v2          | 0.661          | 71.7%           | 0.635            | 0.603          | 67.7%           | 0.545        |
| bge-small-en-v1.5         | 0.661          | 71.1%           | 0.647            | 0.644          | 70.5%           | 0.545        |
| **bge-base-en-v1.5**      | 0.677          | 73.3%           | 0.670            | **0.706**      | **76.5%**       | 0.545        |
| text-embedding-3-small¹   | 0.692          | 74.3%           | 0.676            | 0.703          | 76.4%           | 0.545        |
| multi-qa-MiniLM-L6-cos-v1 | 0.617          | 67.3%           | 0.576            | 0.499          | 55.3%           | 0.545        |

<details>
<summary>Full per-model metrics (NDCG@5, MRR)</summary>

| Model                     | Strategy | NDCG@5 | NDCG@10 | Recall@5 | MRR   |
| ------------------------- | -------- | ------ | ------- | -------- | ----- |
| all-MiniLM-L6-v2          | HYBRID   | 0.641  | 0.661   | 71.7%    | 0.629 |
| all-MiniLM-L6-v2          | ENSEMBLE | 0.594  | 0.635   | 68.5%    | 0.585 |
| all-MiniLM-L6-v2          | VECTOR   | 0.574  | 0.603   | 67.7%    | 0.558 |
| bge-small-en-v1.5         | HYBRID   | 0.643  | 0.661   | 71.1%    | 0.636 |
| bge-small-en-v1.5         | ENSEMBLE | 0.614  | 0.647   | 70.0%    | 0.609 |
| bge-small-en-v1.5         | VECTOR   | 0.619  | 0.644   | 70.5%    | 0.608 |
| bge-base-en-v1.5          | HYBRID   | 0.666  | 0.677   | 73.3%    | 0.658 |
| bge-base-en-v1.5          | ENSEMBLE | 0.639  | 0.670   | 74.4%    | 0.627 |
| bge-base-en-v1.5          | VECTOR   | 0.676  | 0.706   | 76.5%    | 0.667 |
| multi-qa-MiniLM-L6-cos-v1 | HYBRID   | 0.594  | 0.617   | 67.3%    | 0.586 |
| multi-qa-MiniLM-L6-cos-v1 | ENSEMBLE | 0.533  | 0.576   | 62.4%    | 0.530 |
| multi-qa-MiniLM-L6-cos-v1 | VECTOR   | 0.478  | 0.499   | 55.3%    | 0.469 |
| text-embedding-3-small    | HYBRID   | 0.678  | 0.692   | 74.3%    | 0.671 |
| text-embedding-3-small    | ENSEMBLE | 0.646  | 0.676   | 73.8%    | 0.638 |
| text-embedding-3-small    | VECTOR   | 0.679  | 0.703   | 76.4%    | 0.669 |

</details>

### Key Findings

1. **bge-base-en-v1.5 is the accuracy winner.** Its VECTOR-only NDCG@10 of
   0.706 is the highest single score across all model/strategy combinations —
   and it beats its own HYBRID score (0.677). This is the only local model
   where pure vector search outperforms hybrid fusion.

2. **text-embedding-3-small (remote API) nearly matches bge-base.** With
   VECTOR NDCG@10=0.703 (vs 0.706 for bge-base), OpenAI's small embedding
   model delivers top-tier accuracy without local ONNX weights. Its HYBRID
   optimal weight sweep converges to V0.95/K0.05 (NDCG@10=0.721), confirming
   that keyword augmentation adds minimal value when embeddings are strong.

3. **bge-small-en-v1.5 offers the best accuracy-per-MB.** At 33 MB it achieves
   VECTOR NDCG@10=0.644, a +6.8% improvement over all-MiniLM-L6-v2 (0.603)
   for only 43% more model weight. Its HYBRID score ties MiniLM at 0.661.

4. **all-MiniLM-L6-v2 remains the default** for its best speed/size/accuracy
   tradeoff. At 23 MB and 8 minutes it matches bge-small HYBRID performance
   and is 5× smaller than bge-base.

5. **multi-qa-MiniLM-L6-cos-v1 underperforms all others.** Despite being
   optimized for QA retrieval, it scores lowest across every strategy. Its
   training objective (question-answer similarity) doesn't generalize well to
   passage-level ranking on SciFact.

6. **BGE models close the HYBRID vs VECTOR gap.** For MiniLM, HYBRID leads
   VECTOR by +9.6% NDCG@10. For bge-small only +2.6%, and bge-base VECTOR
   actually exceeds HYBRID by +4.3%. Higher-quality embeddings reduce the need
   for keyword augmentation.

7. **BM25 scores are identical across all models** (0.545), as expected — BM25
   is a text-only method that doesn't use embeddings.

### Bug Fix: HuggingFaceBackend.initialize()

During multi-model benchmarking, a bug was discovered and fixed:
`HuggingFaceBackend.initialize()` was ignoring the `initialModel` constructor
parameter on the first call, always falling through to
`getAvailableModels()[0]`. This caused benchmarks to silently use the wrong
model. The fix ensures the constructor's `initialModel` is respected.

### Recommendations

| Use Case                  | Recommended Model                                                      |
| ------------------------- | ---------------------------------------------------------------------- |
| **Default / general use** | all-MiniLM-L6-v2 — smallest, fastest, strong HYBRID performance        |
| **Accuracy-sensitive**    | bge-base-en-v1.5 — highest scores, use VECTOR strategy                 |
| **Remote API**            | text-embedding-3-small — near bge-base accuracy, no local model needed |
| **Balanced upgrade**      | bge-small-en-v1.5 — near-MiniLM speed, meaningfully better vectors     |
| **QA / question-answer**  | Avoid multi-qa-MiniLM-L6-cos-v1 for general retrieval                  |

---

## Cross-Encoder Reranking

Two-stage retrieval pipeline: first-stage retriever fetches a larger candidate
pool, then a cross-encoder reranker rescores all query-document pairs to produce
the final top-k results.

- **Cross-encoder:** Xenova/ms-marco-MiniLM-L-6-v2 (ONNX, ~25 MB)
- **Dataset:** BEIR SciFact (5,183 docs, 300 queries)
- **Bi-encoder:** all-MiniLM-L6-v2 (384-dim)
- **Candidate pool:** 30, **Final k:** 10

### Reranking Impact by Strategy

| Strategy     | Base NDCG@10 | +Rerank NDCG@10 | Δ NDCG     | Win/Loss/Tie     |
| ------------ | ------------ | --------------- | ---------- | ---------------- |
| **BM25**     | 0.489        | 0.594           | **+0.105** | 87W / 18L / 195T |
| **VECTOR**   | 0.603        | 0.676           | **+0.073** | 80W / 45L / 175T |
| **ENSEMBLE** | 0.628        | **0.688**       | **+0.060** | 84W / 55L / 161T |
| **HYBRID**   | 0.677        | 0.686           | +0.009     | 61W / 55L / 184T |

### Detailed Metrics

| Config              | NDCG@10   | MRR@10    | Recall@5  | Time (ms) |
| ------------------- | --------- | --------- | --------- | --------- |
| VECTOR              | 0.603     | 0.558     | 67.7%     | 51        |
| VECTOR+rerank       | 0.676     | 0.643     | 72.3%     | 2,148     |
| HYBRID              | 0.677     | 0.644     | 71.2%     | 225       |
| HYBRID+rerank       | 0.686     | 0.653     | 73.0%     | 2,085     |
| ENSEMBLE            | 0.628     | 0.585     | 68.5%     | 221       |
| **ENSEMBLE+rerank** | **0.688** | **0.657** | **72.8%** | 2,060     |
| BM25                | 0.489     | 0.452     | 53.7%     | 263       |
| BM25+rerank         | 0.594     | 0.579     | 63.3%     | 2,076     |

### Candidate Pool Size Sweep (HYBRID+rerank)

| Candidates | NDCG@10   | MRR@10    | Recall@5 | Time (ms) |
| ---------- | --------- | --------- | -------- | --------- |
| 10         | 0.674     | 0.643     | 73.3%    | 818       |
| **20**     | **0.689** | **0.655** | 73.2%    | 1,521     |
| 30         | 0.686     | 0.653     | 73.0%    | 2,267     |
| 50         | 0.691     | 0.658     | 73.8%    | 2,220     |

### Key Findings

1. **Reranking helps all strategies**, with the biggest lift on weak first-stage
   retrievers. BM25 gains +0.105 NDCG (87W/18L), while HYBRID gains only +0.009
   because its base ranking is already strong.

2. **ENSEMBLE+rerank achieves the best absolute NDCG@10 (0.688)**, surpassing
   HYBRID's base score. Reranking compensates for ENSEMBLE's weaker initial
   ranking (RRF) by rescoring with true cross-attention.

3. **20 candidates is the practical sweet spot.** NDCG@10 jumps +0.015 from
   10→20 candidates, but only +0.002 from 20→50. The latency savings are
   significant: 1.5s vs 2.2s per query.

4. **Reranking adds ~2s latency** per query (from ~50–260ms to ~2,050–2,150ms
   on CPU). The cross-encoder dominates total query time.

5. **Score distributions tighten** with reranking (σ decreases) for
   VECTOR/HYBRID/ENSEMBLE, indicating more consistent ranking quality.

### Running Reranking Benchmarks

```bash
BEIR_RERANK_BENCHMARK=1 npm test --workspace=packages/core -- --grep "Reranking Benchmark"
```

---

### Running with Alternative Models

Select a model via the `BEIR_MODEL` environment variable:

```bash
# Default (all-MiniLM-L6-v2)
BEIR_BENCHMARK=1 npm run bench:beir

# bge-small
BEIR_BENCHMARK=1 BEIR_MODEL="Xenova/bge-small-en-v1.5" npm run bench:beir

# bge-base (768-dim, larger model)
BEIR_BENCHMARK=1 BEIR_MODEL="Xenova/bge-base-en-v1.5" npm run bench:beir

# multi-qa-MiniLM
BEIR_BENCHMARK=1 BEIR_MODEL="Xenova/multi-qa-MiniLM-L6-cos-v1" npm run bench:beir

# Remote API (OpenAI-compatible server)
BEIR_BENCHMARK=1 BEIR_REMOTE_URL="http://localhost:3000/v1" BEIR_REMOTE_MODEL="text-embedding-3-small" npm run bench:beir
```

---

## Running Benchmarks

```bash
# BEIR SciFact (default, ~5 min)
npm run bench:beir

# BEIR with alternative dataset (~2-30 min depending on size)
BEIR_DATASET=nfcorpus npm run bench:beir
BEIR_DATASET=fiqa npm run bench:beir

# FRAMES (default 50 questions, ~2 min)
npm run bench:frames

# FRAMES with custom sample size
FRAMES_SAMPLE_SIZE=100 npm run bench:frames

# FRAMES full dataset (822 questions, ~12 min with warm cache)
FRAMES_SAMPLE_SIZE=824 npm run bench:frames
```

### Supported BEIR Datasets

| Dataset             | Docs      | Queries | Domain                 |
| ------------------- | --------- | ------- | ---------------------- |
| `scifact` (default) | 5,183     | 300     | Scientific claims      |
| `nfcorpus`          | 3,633     | 323     | Biomedical / nutrition |
| `fiqa`              | 57,638    | 648     | Financial QA           |
| `scidocs`           | 25,657    | 1,000   | Scientific papers      |
| `arguana`           | 8,674     | 1,396   | Argument mining        |
| `quora`             | 522,931   | 10,000  | Duplicate questions    |
| `hotpotqa`          | 5,233,329 | 7,405   | Multi-hop QA           |

### Environment Variables

| Variable                | Default                   | Description                                                                |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `BEIR_BENCHMARK`        | —                         | Set to `1` to enable BEIR benchmark                                        |
| `BEIR_RERANK_BENCHMARK` | —                         | Set to `1` to enable BEIR reranking benchmark                              |
| `BEIR_DATASET`          | `scifact`                 | BEIR dataset name                                                          |
| `BEIR_MODEL`            | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID for embeddings                                        |
| `BEIR_REMOTE_URL`       | —                         | OpenAI-compatible embedding API base URL (e.g. `http://localhost:3000/v1`) |
| `BEIR_REMOTE_MODEL`     | —                         | Model name for remote API (e.g. `text-embedding-3-small`)                  |
| `BEIR_REMOTE_FORMAT`    | `openai`                  | Remote API format: `openai` or `ollama`                                    |
| `FRAMES_BENCHMARK`      | —                         | Set to `1` to enable FRAMES benchmark                                      |
| `FRAMES_SAMPLE_SIZE`    | `50`                      | Number of FRAMES questions to evaluate                                     |

### Caching

- **BEIR:** Datasets cached in `.cache/beir/{dataset}/`
- **FRAMES:** TSV cached in `.cache/frames/`, Wikipedia articles in
  `.cache/frames/articles/`. Articles are cached permanently; each run fetches
  uncached articles incrementally.

---

## Methodology

- **Embedding Model:** all-MiniLM-L6-v2 (384 dimensions, fp32, CPU inference)
- **Metrics:** NDCG (2^rel − 1 gain), MAP, Recall, Precision, MRR
- **Vector Store:** In-memory cosine similarity (RealVectorStore test helper)
- **BM25:** In-memory keyword retriever with term frequency scoring
- **FRAMES Relevance:** Binary (each referenced Wikipedia article → grade 1)
- **BEIR Relevance:** TREC-style graded judgments from dataset qrels
