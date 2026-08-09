/**
 * FRAMES Cross-Encoder Reranking Benchmark
 *
 * Uses the Google FRAMES dataset (824 multi-hop QA questions with ground-truth
 * Wikipedia articles) to measure the impact of cross-encoder reranking on
 * multi-hop retrieval quality.
 *
 * Compares 3 base retrieval strategies (VECTOR, HYBRID, BM25-keyword)
 * with and without reranking, plus a candidate-pool sweep for HYBRID.
 *
 * Gated behind FRAMES_RERANK_BENCHMARK=1 environment variable.
 * Uses FRAMES_RERANK_SAMPLE_SIZE for deterministic question sampling
 * (default: 50, use 0 for full split).
 *
 * Examples:
 *   FRAMES_RERANK_BENCHMARK=1 npm test --workspace=packages/core
 *   FRAMES_RERANK_BENCHMARK=1 FRAMES_RERANK_SAMPLE_SIZE=100 npm test --workspace=packages/core
 *   FRAMES_RERANK_BENCHMARK=1 FRAMES_RERANK_SAMPLE_SIZE=0 npm test --workspace=packages/core
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
  extractKeywords,
} from "../src/index";
import type { ScoredDocument } from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, stddev, percentile, ndcgAtK, mrrAtK, recallAtK } from "./helpers/metrics";
import { formatSampleSelection, parseBenchmarkSampleSize } from "./helpers/benchmarkSampling";
import { FramesEntry } from "./helpers/framesLoader";
import { prepareFramesBenchmarkCorpus } from "./helpers/framesBenchmarkCorpus";

const SAMPLE_SIZE = parseBenchmarkSampleSize(process.env.FRAMES_RERANK_SAMPLE_SIZE);
const MODEL = process.env.BEIR_MODEL || "Xenova/all-MiniLM-L6-v2";
const MODEL_SHORT = MODEL.replace(/^Xenova\//, "");
const RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const CACHE_DIR = path.resolve(__dirname, "../../../../.cache/frames");
const ARTICLE_CACHE_DIR = path.join(CACHE_DIR, "articles");
const MAX_K = 10;
const CANDIDATE_K = 30;

type StrategyName = "VECTOR" | "HYBRID" | "BM25-keyword";

interface StrategyResult {
  strategy: StrategyName;
  reranked: boolean;
  ndcg5: number[];
  mrr10: number[];
  recall5: number[];
  timesMs: number[];
}

describe("FRAMES Multi-Hop Reranking Benchmark", function (this: Mocha.Suite) {
  this.timeout(1800000);

  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;
  let reranker: CrossEncoderReranker;

  let sampledEntries: FramesEntry[] = [];
  let entryQrels: Map<number, Map<string, number>> = new Map();

  function docId(doc: LangChainDocument): string {
    return doc.metadata?.id ?? doc.metadata?.source ?? "unknown";
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
      case "BM25-keyword": {
        const keywords = extractKeywords(query);
        const bm25Query = keywords.join(" ") || query;
        const results = await keywordRetriever.search(bm25Query, k);
        return results.map((r) => ({ document: r.document, score: r.score ?? 0 }));
      }
    }
  }

  before(async function (this: Mocha.Context) {
    if (!process.env.FRAMES_RERANK_BENCHMARK) {
      console.log(
        `[skip] FRAMES Multi-Hop Reranking Benchmark disabled. Set FRAMES_RERANK_BENCHMARK=1 to run this suite.`,
      );
      this.skip();
      return;
    }

    this.timeout(1800000);

    const prepared = await prepareFramesBenchmarkCorpus({
      cacheDir: CACHE_DIR,
      articleCacheDir: ARTICLE_CACHE_DIR,
      sampleSize: SAMPLE_SIZE,
      sampleEnvVarName: "FRAMES_RERANK_SAMPLE_SIZE",
    });

    sampledEntries = prepared.sampledEntries;
    entryQrels = prepared.entryQrels;

    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier, MODEL);
    embeddingService.registerBackend(hfBackend);
    const embeddings = new TransformersEmbeddings({ embeddingService });

    const vectorStore = await RealVectorStore.fromDocuments(prepared.docs, embeddings);
    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(prepared.docs);
    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);

    reranker = new CrossEncoderReranker(RERANKER_MODEL, {
      maxCandidates: CANDIDATE_K,
    });
    await reranker.initialize();

    console.log(
      `FRAMES rerank: ${prepared.docs.length} docs indexed, ${formatSampleSelection(
        prepared.eligibleEntriesCount,
        sampledEntries.length,
        "FRAMES_RERANK_SAMPLE_SIZE",
        SAMPLE_SIZE,
      )}`,
    );
    console.log(`Model: ${MODEL_SHORT}, Reranker: ${RERANKER_MODEL} (candidates=${CANDIDATE_K}, final k=${MAX_K})`);
  });

  after(() => {
    reranker?.dispose();
  });

  it("should measure reranking impact across all strategies", async function (this: Mocha.Context) {
    this.timeout(1800000);

    const strategies: StrategyName[] = ["VECTOR", "HYBRID", "BM25-keyword"];
    const results: Map<string, StrategyResult> = new Map();
    for (const strategy of strategies) {
      for (const reranked of [false, true]) {
        const key = reranked ? `${strategy}+rerank` : strategy;
        results.set(key, {
          strategy,
          reranked,
          ndcg5: [],
          mrr10: [],
          recall5: [],
          timesMs: [],
        });
      }
    }

    const perQueryNdcg: Map<string, number[]> = new Map();
    for (const strategy of strategies) {
      perQueryNdcg.set(strategy, []);
      perQueryNdcg.set(`${strategy}+rerank`, []);
    }

    const startAll = Date.now();

    for (let qi = 0; qi < sampledEntries.length; qi++) {
      const entry = sampledEntries[qi];
      const qrels = entryQrels.get(entry.id) ?? new Map<string, number>();

      for (const strategy of strategies) {
        const baseStart = Date.now();
        const baseCandidates = await runStrategy(strategy, entry.prompt, MAX_K);
        const baseTime = Date.now() - baseStart;
        const baseIds = baseCandidates.map((r) => docId(r.document));

        const baseNdcg = ndcgAtK(baseIds, qrels, 5);
        const baseMrr = mrrAtK(baseIds, qrels, MAX_K);
        const baseRecall = recallAtK(baseIds, qrels, 5);

        const baseResult = results.get(strategy)!;
        baseResult.ndcg5.push(baseNdcg);
        baseResult.mrr10.push(baseMrr);
        baseResult.recall5.push(baseRecall);
        baseResult.timesMs.push(baseTime);
        perQueryNdcg.get(strategy)!.push(baseNdcg);

        const rerankStart = Date.now();
        const overFetched = await runStrategy(strategy, entry.prompt, CANDIDATE_K);
        const reranked = await reranker.rerank(entry.prompt, overFetched, MAX_K);
        const rerankTime = Date.now() - rerankStart;
        const rerankIds = reranked.map((r) => docId(r.document));

        const rerankNdcg = ndcgAtK(rerankIds, qrels, 5);
        const rerankMrr = mrrAtK(rerankIds, qrels, MAX_K);
        const rerankRecall = recallAtK(rerankIds, qrels, 5);

        const rerankKey = `${strategy}+rerank`;
        const rerankResult = results.get(rerankKey)!;
        rerankResult.ndcg5.push(rerankNdcg);
        rerankResult.mrr10.push(rerankMrr);
        rerankResult.recall5.push(rerankRecall);
        rerankResult.timesMs.push(rerankTime);
        perQueryNdcg.get(rerankKey)!.push(rerankNdcg);
      }

      if ((qi + 1) % 25 === 0 || qi === sampledEntries.length - 1) {
        const elapsed = Date.now() - startAll;
        const rate = (qi + 1) / (elapsed / 1000);
        const remaining = rate > 0 ? (sampledEntries.length - qi - 1) / rate : 0;
        console.log(
          `  Progress: ${qi + 1}/${sampledEntries.length} queries ` +
            `(${(elapsed / 1000).toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining)`,
        );
      }
    }

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  FRAMES CROSS-ENCODER RERANKING IMPACT");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n  Queries: ${sampledEntries.length} | Model: ${MODEL_SHORT}`);
    console.log(`  Reranker: ${RERANKER_MODEL}`);
    console.log(`  Candidate pool: ${CANDIDATE_K}, Final k: ${MAX_K}`);

    console.log("\n  ┌────────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Strategy       │ Base NDCG@5  │ +Rerank      │ Δ NDCG   │");
    console.log("  ├────────────────┼──────────────┼──────────────┼──────────┤");
    for (const strategy of strategies) {
      const baseNdcg = mean(results.get(strategy)!.ndcg5);
      const rerankNdcg = mean(results.get(`${strategy}+rerank`)!.ndcg5);
      const delta = rerankNdcg - baseNdcg;
      console.log(`  │ ${strategy.padEnd(14)} │  ${fmt(baseNdcg)}    │  ${fmt(rerankNdcg)}    │ ${fmtDelta(delta)} │`);
    }
    console.log("  └────────────────┴──────────────┴──────────────┴──────────┘");

    console.log("\n  Detailed Metrics:");
    console.log("  ┌────────────────────┬──────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Config             │ NDCG@5       │ MRR@10       │ Recall@5     │ Time(ms) │");
    console.log("  ├────────────────────┼──────────────┼──────────────┼──────────────┼──────────┤");
    for (const strategy of strategies) {
      for (const reranked of [false, true]) {
        const key = reranked ? `${strategy}+rerank` : strategy;
        const r = results.get(key)!;
        const label = key.padEnd(18);
        console.log(
          `  │ ${label} │  ${fmt(mean(r.ndcg5))}    │  ${fmt(mean(r.mrr10))}    │  ${fmt(mean(r.recall5))}    │ ${fmtMs(mean(r.timesMs))}   │`,
        );
      }
    }
    console.log("  └────────────────────┴──────────────┴──────────────┴──────────────┴──────────┘");
    if (process.env.RAGNAROK_BENCHMARK_MODE === "release") {
      const measured = results.get("HYBRID+rerank")!;
      console.log(
        `RAGNAROK_METRICS frames-rerank ${JSON.stringify({
          ndcgAt5: mean(measured.ndcg5),
          mrrAt10: mean(measured.mrr10),
          recallAt5: mean(measured.recall5),
          queryP50Ms: percentile(measured.timesMs, 0.5),
          queryP95Ms: percentile(measured.timesMs, 0.95),
        })}`,
      );
    }

    console.log("\n  Per-Query Win/Loss Analysis (NDCG@5):");
    for (const strategy of strategies) {
      const baseScores = perQueryNdcg.get(strategy)!;
      const rerankScores = perQueryNdcg.get(`${strategy}+rerank`)!;
      let wins = 0;
      let losses = 0;
      let ties = 0;
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

    console.log("\n  Score Distribution (NDCG@5 stddev):");
    for (const strategy of strategies) {
      const baseStd = stddev(results.get(strategy)!.ndcg5);
      const rerankStd = stddev(results.get(`${strategy}+rerank`)!.ndcg5);
      console.log(`  ${strategy.padEnd(12)} base σ=${baseStd.toFixed(3)}  rerank σ=${rerankStd.toFixed(3)}`);
    }

    expect(results.size).to.be.greaterThan(0);
  });

  it("should sweep candidate pool sizes for HYBRID+rerank", async function (this: Mocha.Context) {
    this.timeout(1800000);

    const CANDIDATE_SIZES = [10, 20, 30, 50];
    const sweepResults: Map<number, { ndcg5: number[]; mrr10: number[]; recall5: number[]; timesMs: number[] }> =
      new Map();

    for (const ck of CANDIDATE_SIZES) {
      sweepResults.set(ck, { ndcg5: [], mrr10: [], recall5: [], timesMs: [] });
    }

    const startAll = Date.now();

    for (let qi = 0; qi < sampledEntries.length; qi++) {
      const entry = sampledEntries[qi];
      const qrels = entryQrels.get(entry.id) ?? new Map<string, number>();

      for (const ck of CANDIDATE_SIZES) {
        const start = Date.now();
        const candidates = await runStrategy("HYBRID", entry.prompt, ck);
        const reranked = await reranker.rerank(entry.prompt, candidates, MAX_K);
        const elapsed = Date.now() - start;
        const ids = reranked.map((r) => docId(r.document));

        const result = sweepResults.get(ck)!;
        result.ndcg5.push(ndcgAtK(ids, qrels, 5));
        result.mrr10.push(mrrAtK(ids, qrels, MAX_K));
        result.recall5.push(recallAtK(ids, qrels, 5));
        result.timesMs.push(elapsed);
      }

      if ((qi + 1) % 25 === 0 || qi === sampledEntries.length - 1) {
        const elapsed = Date.now() - startAll;
        const rate = (qi + 1) / (elapsed / 1000);
        const remaining = rate > 0 ? (sampledEntries.length - qi - 1) / rate : 0;
        console.log(
          `  Sweep progress: ${qi + 1}/${sampledEntries.length} queries ` +
            `(${(elapsed / 1000).toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining)`,
        );
      }
    }

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  FRAMES CANDIDATE POOL SIZE SWEEP (HYBRID + rerank)");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n  Final k: ${MAX_K}, Reranker: ${RERANKER_MODEL}`);

    console.log("\n  ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────┐");
    console.log("  │ Candidates   │ NDCG@5       │ MRR@10       │ Recall@5     │ Time(ms) │");
    console.log("  ├──────────────┼──────────────┼──────────────┼──────────────┼──────────┤");
    for (const ck of CANDIDATE_SIZES) {
      const r = sweepResults.get(ck)!;
      console.log(
        `  │ ${String(ck).padEnd(12)} │  ${fmt(mean(r.ndcg5))}    │  ${fmt(mean(r.mrr10))}    │  ${fmt(mean(r.recall5))}    │ ${fmtMs(mean(r.timesMs))}   │`,
      );
    }
    console.log("  └──────────────┴──────────────┴──────────────┴──────────────┴──────────┘");

    expect(sweepResults.size).to.equal(CANDIDATE_SIZES.length);
  });
});
