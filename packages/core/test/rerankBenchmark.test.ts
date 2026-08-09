/**
 * BEIR Cross-Encoder Reranking Benchmark
 *
 * Measures the impact of cross-encoder reranking on retrieval quality.
 * Compares 3 base strategies (VECTOR, HYBRID, BM25)
 * with and without cross-encoder reranking, plus a candidate-pool sweep.
 *
 * Gated behind BEIR_RERANK_BENCHMARK=1 environment variable.
 * Uses BEIR_RERANK_SAMPLE_SIZE for deterministic query sampling (default: 50, use 0 for full split).
 *
 * Examples:
 *   BEIR_RERANK_BENCHMARK=1 npm test --workspace=packages/core
 *   BEIR_RERANK_BENCHMARK=1 BEIR_DATASET=nfcorpus npm test --workspace=packages/core
 *   BEIR_RERANK_BENCHMARK=1 BEIR_RERANK_SAMPLE_SIZE=0 npm test --workspace=packages/core
 */

import path from "path";
import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  CrossEncoderReranker,
  VectorRetriever,
  KeywordRetriever,
  HybridRetriever,
  DEFAULT_HYBRID_OPTIONS,
  EmbeddingService,
  HuggingFaceBackend,
  ModelRegistry,
  TransformersEmbeddings,
} from "../src/index";
import type { ScoredDocument } from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, stddev, percentile, ndcgAtK, mrrAtK, recallAtK } from "./helpers/metrics";
import { formatSampleSelection, parseBenchmarkSampleSize, sampleDeterministically } from "./helpers/benchmarkSampling";
import { downloadAndExtract, loadCorpus, loadQueries, loadQrels } from "./helpers/beirLoader";

// ═══════════════════════════════════════════════════════════════════════
// §1  Constants
// ═══════════════════════════════════════════════════════════════════════

const DATASET = process.env.BEIR_DATASET || "scifact";
const MODEL = process.env.BEIR_MODEL || "Xenova/all-MiniLM-L6-v2";
const RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const CACHE_DIR = path.resolve(__dirname, "../../../../.cache/beir");
const MAX_K = 10;
const CANDIDATE_K = 30;
const QUERY_SAMPLE_SIZE = parseBenchmarkSampleSize(process.env.BEIR_RERANK_SAMPLE_SIZE);

type StrategyName = "VECTOR" | "HYBRID" | "BM25";

const ALL_STRATEGIES: StrategyName[] = ["VECTOR", "HYBRID", "BM25"];

// ═══════════════════════════════════════════════════════════════════════
// §2  Types
// ═══════════════════════════════════════════════════════════════════════

interface StrategyResult {
  strategy: StrategyName;
  reranked: boolean;
  ndcg10: number[];
  mrr10: number[];
  recall5: number[];
  timesMs: number[];
}

// ═══════════════════════════════════════════════════════════════════════
// §3  Test Suite
// ═══════════════════════════════════════════════════════════════════════

describe("BEIR Reranking Benchmark", function (this: Mocha.Suite) {
  this.timeout(0);

  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;
  let reranker: CrossEncoderReranker;

  let testQueries: { id: string; text: string; qrels: Map<string, number> }[] = [];
  let corpusSize = 0;

  // ─── Helpers ──────────────────────────────────────────────────────

  function docId(doc: LangChainDocument): string {
    return doc.metadata?.id ?? doc.metadata?.chunkId ?? "unknown";
  }

  function fmt(n: number): string {
    return n.toFixed(3).padStart(8);
  }

  function fmtDelta(n: number): string {
    const sign = n >= 0 ? "+" : "";
    return (sign + n.toFixed(3)).padStart(8);
  }

  function fmtMs(n: number): string {
    return Math.round(n).toString().padStart(6);
  }

  /** Run a base retrieval strategy, returning scored documents */
  async function runStrategy(strategy: StrategyName, query: string, k: number): Promise<ScoredDocument[]> {
    switch (strategy) {
      case "VECTOR": {
        const results = await vectorRetriever.search(query, k);
        return results.map((r) => ({ document: r.document, score: r.score ?? 0 }));
      }
      case "HYBRID": {
        const results = await hybridRetriever.search(query, {
          k,
          ...DEFAULT_HYBRID_OPTIONS,
        });
        return results.map((r) => ({ document: r.document, score: r.score ?? 0 }));
      }
      case "BM25": {
        const results = await keywordRetriever.search(query, k);
        return results.map((r) => ({ document: r.document, score: r.score ?? 0 }));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Setup
  // ═══════════════════════════════════════════════════════════════════

  before(async function (this: Mocha.Context) {
    if (!process.env.BEIR_RERANK_BENCHMARK) {
      console.log(`[skip] BEIR Reranking Benchmark disabled. Set BEIR_RERANK_BENCHMARK=1 to run this suite.`);
      this.skip();
      return;
    }

    this.timeout(0);

    // 1. Download and extract BEIR dataset
    const datasetDir = await downloadAndExtract(DATASET, CACHE_DIR);

    // 2. Load corpus, queries, and relevance judgments
    const corpus = await loadCorpus(datasetDir);
    const queries = await loadQueries(datasetDir);
    const qrels = await loadQrels(datasetDir, "test");
    corpusSize = corpus.size;

    // 3. Filter queries to only those with relevance judgments
    const allTestQueries: { id: string; text: string; qrels: Map<string, number> }[] = [];
    for (const [qid, qrelMap] of qrels) {
      const queryText = queries.get(qid);
      if (queryText) {
        allTestQueries.push({ id: qid, text: queryText, qrels: qrelMap });
      }
    }
    testQueries = sampleDeterministically(allTestQueries, QUERY_SAMPLE_SIZE);

    // 4. Convert corpus to LangChain documents
    const docs = Array.from(corpus.entries()).map(
      ([id, { title, text }]) =>
        new LangChainDocument({
          pageContent: title ? `${title}\n${text}` : text,
          metadata: { id, source: DATASET },
        }),
    );

    // 5. Initialize embedding pipeline
    const embeddingService = new EmbeddingService({
      config: mockConfig,
      notifier: mockNotifier,
    });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier, MODEL);
    embeddingService.registerBackend(hfBackend);
    const embeddings = new TransformersEmbeddings({ embeddingService });

    // 6. Create vector store and retrievers
    const vectorStore = await RealVectorStore.fromDocuments(docs, embeddings);
    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(docs);
    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);

    // 7. Initialize cross-encoder reranker
    reranker = new CrossEncoderReranker(RERANKER_MODEL, {
      maxCandidates: CANDIDATE_K,
    });
    await reranker.initialize();

    console.log(
      `\nBEIR ${DATASET}: ${corpusSize} docs, ${formatSampleSelection(
        allTestQueries.length,
        testQueries.length,
        "BEIR_RERANK_SAMPLE_SIZE",
        QUERY_SAMPLE_SIZE,
      )}`,
    );
    console.log(`Reranker: ${RERANKER_MODEL} (candidates=${CANDIDATE_K}, final k=${MAX_K})`);
  });

  after(() => {
    reranker?.dispose();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 1: Base vs Reranked comparison across all strategies
  // ═══════════════════════════════════════════════════════════════════

  it("should measure reranking impact across all strategies", async function (this: Mocha.Context) {
    this.timeout(0);

    // Accumulate results per strategy+reranked combination
    const results: Map<string, StrategyResult> = new Map();
    for (const strategy of ALL_STRATEGIES) {
      for (const reranked of [false, true]) {
        const key = reranked ? `${strategy}+rerank` : strategy;
        results.set(key, {
          strategy,
          reranked,
          ndcg10: [],
          mrr10: [],
          recall5: [],
          timesMs: [],
        });
      }
    }

    // Per-query NDCG@10 for win/loss analysis
    const perQueryNdcg: Map<string, number[]> = new Map();
    for (const strategy of ALL_STRATEGIES) {
      perQueryNdcg.set(strategy, []);
      perQueryNdcg.set(`${strategy}+rerank`, []);
    }

    const startAll = Date.now();

    for (let qi = 0; qi < testQueries.length; qi++) {
      const tq = testQueries[qi];

      for (const strategy of ALL_STRATEGIES) {
        // ── Base retrieval ──
        const baseStart = Date.now();
        const baseCandidates = await runStrategy(strategy, tq.text, MAX_K);
        const baseTime = Date.now() - baseStart;
        const baseIds = baseCandidates.map((r) => docId(r.document));

        const baseNdcg = ndcgAtK(baseIds, tq.qrels, MAX_K);
        const baseMrr = mrrAtK(baseIds, tq.qrels, MAX_K);
        const baseRecall = recallAtK(baseIds, tq.qrels, 5);

        const baseResult = results.get(strategy)!;
        baseResult.ndcg10.push(baseNdcg);
        baseResult.mrr10.push(baseMrr);
        baseResult.recall5.push(baseRecall);
        baseResult.timesMs.push(baseTime);
        perQueryNdcg.get(strategy)!.push(baseNdcg);

        // ── Over-fetch + rerank ──
        const rerankStart = Date.now();
        const overFetched = await runStrategy(strategy, tq.text, CANDIDATE_K);
        const reranked = await reranker.rerank(tq.text, overFetched, MAX_K);
        const rerankTime = Date.now() - rerankStart;
        const rerankIds = reranked.map((r) => docId(r.document));

        const rerankNdcg = ndcgAtK(rerankIds, tq.qrels, MAX_K);
        const rerankMrr = mrrAtK(rerankIds, tq.qrels, MAX_K);
        const rerankRecall = recallAtK(rerankIds, tq.qrels, 5);

        const rerankKey = `${strategy}+rerank`;
        const rerankResult = results.get(rerankKey)!;
        rerankResult.ndcg10.push(rerankNdcg);
        rerankResult.mrr10.push(rerankMrr);
        rerankResult.recall5.push(rerankRecall);
        rerankResult.timesMs.push(rerankTime);
        perQueryNdcg.get(rerankKey)!.push(rerankNdcg);
      }

      // Progress every 50 queries
      if ((qi + 1) % 50 === 0 || qi === testQueries.length - 1) {
        const elapsed = Date.now() - startAll;
        const rate = (qi + 1) / (elapsed / 1000);
        const remaining = (testQueries.length - qi - 1) / rate;
        console.log(
          `  Progress: ${qi + 1}/${testQueries.length} queries ` +
            `(${(elapsed / 1000).toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining)`,
        );
      }
    }

    // ── Print report ──────────────────────────────────────────────

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  CROSS-ENCODER RERANKING IMPACT");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n  Dataset: ${DATASET} (${corpusSize} docs, ${testQueries.length} queries)`);
    console.log(`  Reranker: ${RERANKER_MODEL}`);
    console.log(`  Candidate pool: ${CANDIDATE_K}, Final k: ${MAX_K}`);

    // ── Summary table ──
    console.log("\n  ┌──────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Strategy     │ Base NDCG@10 │ +Rerank      │ Δ NDCG   │");
    console.log("  ├──────────────┼──────────────┼──────────────┼──────────┤");
    for (const strategy of ALL_STRATEGIES) {
      const baseNdcg = mean(results.get(strategy)!.ndcg10);
      const rerankNdcg = mean(results.get(`${strategy}+rerank`)!.ndcg10);
      const delta = rerankNdcg - baseNdcg;
      console.log(`  │ ${strategy.padEnd(12)} │  ${fmt(baseNdcg)}    │  ${fmt(rerankNdcg)}    │ ${fmtDelta(delta)} │`);
    }
    console.log("  └──────────────┴──────────────┴──────────────┴──────────┘");

    // ── Detailed metrics table ──
    console.log("\n  Detailed Metrics:");
    console.log("  ┌────────────────┬──────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Config         │ NDCG@10      │ MRR@10       │ Recall@5     │ Time(ms) │");
    console.log("  ├────────────────┼──────────────┼──────────────┼──────────────┼──────────┤");
    for (const strategy of ALL_STRATEGIES) {
      for (const reranked of [false, true]) {
        const key = reranked ? `${strategy}+rerank` : strategy;
        const r = results.get(key)!;
        const label = key.padEnd(14);
        console.log(
          `  │ ${label} │  ${fmt(mean(r.ndcg10))}    │  ${fmt(mean(r.mrr10))}    │  ${fmt(mean(r.recall5))}    │ ${fmtMs(mean(r.timesMs))}   │`,
        );
      }
    }
    console.log("  └────────────────┴──────────────┴──────────────┴──────────────┴──────────┘");
    if (process.env.RAGNAROK_BENCHMARK_MODE === "release") {
      const measured = results.get("HYBRID+rerank")!;
      console.log(
        `RAGNAROK_METRICS beir-rerank ${JSON.stringify({
          ndcgAt10: mean(measured.ndcg10),
          mrrAt10: mean(measured.mrr10),
          recallAt5: mean(measured.recall5),
          queryP50Ms: percentile(measured.timesMs, 0.5),
          queryP95Ms: percentile(measured.timesMs, 0.95),
        })}`,
      );
    }

    // ── Win/Loss analysis ──
    console.log("\n  Per-Query Win/Loss Analysis (NDCG@10):");
    for (const strategy of ALL_STRATEGIES) {
      const baseScores = perQueryNdcg.get(strategy)!;
      const rerankScores = perQueryNdcg.get(`${strategy}+rerank`)!;
      let wins = 0,
        losses = 0,
        ties = 0;
      for (let i = 0; i < baseScores.length; i++) {
        const diff = rerankScores[i] - baseScores[i];
        if (Math.abs(diff) < 1e-9) {
          ties++;
        } else if (diff > 0) {
          wins++;
        } else {
          losses++;
        }
      }
      console.log(`  ${strategy}+rerank wins: ${wins} / loses: ${losses} / ties: ${ties}`);
    }

    // ── Stddev supplement ──
    console.log("\n  Score Distribution (NDCG@10 stddev):");
    for (const strategy of ALL_STRATEGIES) {
      const baseStd = stddev(results.get(strategy)!.ndcg10);
      const rerankStd = stddev(results.get(`${strategy}+rerank`)!.ndcg10);
      console.log(`  ${strategy.padEnd(10)} base σ=${baseStd.toFixed(3)}  rerank σ=${rerankStd.toFixed(3)}`);
    }

    expect(results.size).to.be.greaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 2: Candidate pool size sweep on HYBRID
  // ═══════════════════════════════════════════════════════════════════

  it("should sweep candidate pool sizes for HYBRID+rerank", async function (this: Mocha.Context) {
    this.timeout(0);

    const CANDIDATE_SIZES = [10, 20, 30, 50];
    const sweepResults: Map<number, { ndcg10: number[]; mrr10: number[]; recall5: number[]; timesMs: number[] }> =
      new Map();

    for (const ck of CANDIDATE_SIZES) {
      sweepResults.set(ck, { ndcg10: [], mrr10: [], recall5: [], timesMs: [] });
    }

    const startAll = Date.now();

    for (let qi = 0; qi < testQueries.length; qi++) {
      const tq = testQueries[qi];

      for (const ck of CANDIDATE_SIZES) {
        const start = Date.now();
        const candidates = await runStrategy("HYBRID", tq.text, ck);
        const reranked = await reranker.rerank(tq.text, candidates, MAX_K);
        const elapsed = Date.now() - start;
        const ids = reranked.map((r) => docId(r.document));

        const entry = sweepResults.get(ck)!;
        entry.ndcg10.push(ndcgAtK(ids, tq.qrels, MAX_K));
        entry.mrr10.push(mrrAtK(ids, tq.qrels, MAX_K));
        entry.recall5.push(recallAtK(ids, tq.qrels, 5));
        entry.timesMs.push(elapsed);
      }

      if ((qi + 1) % 50 === 0 || qi === testQueries.length - 1) {
        const elapsed = Date.now() - startAll;
        const rate = (qi + 1) / (elapsed / 1000);
        const remaining = (testQueries.length - qi - 1) / rate;
        console.log(
          `  Sweep progress: ${qi + 1}/${testQueries.length} queries ` +
            `(${(elapsed / 1000).toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining)`,
        );
      }
    }

    // ── Print sweep report ──
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  CANDIDATE POOL SIZE SWEEP (HYBRID + rerank)");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n  Final k: ${MAX_K}, Reranker: ${RERANKER_MODEL}`);

    console.log("\n  ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Candidates   │ NDCG@10      │ MRR@10       │ Recall@5     │ Time(ms) │");
    console.log("  ├──────────────┼──────────────┼──────────────┼──────────────┼──────────┤");

    for (const ck of CANDIDATE_SIZES) {
      const r = sweepResults.get(ck)!;
      console.log(
        `  │ ${String(ck).padEnd(12)} │  ${fmt(mean(r.ndcg10))}    │  ${fmt(mean(r.mrr10))}    │  ${fmt(mean(r.recall5))}    │ ${fmtMs(mean(r.timesMs))}   │`,
      );
    }
    console.log("  └──────────────┴──────────────┴──────────────┴──────────────┴──────────┘");

    // ── Optimal candidate size ──
    let bestCk = CANDIDATE_SIZES[0];
    let bestNdcg = 0;
    for (const ck of CANDIDATE_SIZES) {
      const avg = mean(sweepResults.get(ck)!.ndcg10);
      if (avg > bestNdcg) {
        bestNdcg = avg;
        bestCk = ck;
      }
    }
    console.log(`\n  Optimal candidate pool: ${bestCk} (NDCG@10 = ${bestNdcg.toFixed(3)})`);

    expect(sweepResults.size).to.be.greaterThan(0);
  });
});
