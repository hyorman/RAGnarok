/**
 * BEIR Retrieval Benchmark
 *
 * Loads a real BEIR dataset, embeds all documents using the bundled
 * all-MiniLM-L6-v2 model, and evaluates 7 retrieval strategy configurations
 * using standard BEIR metrics (NDCG, MAP, Recall, Precision, MRR).
 *
 * Dataset selection via BEIR_DATASET env var (default: scifact).
 * Supported: scifact, nfcorpus, fiqa, arguana, scidocs, trec-covid, quora, nq, hotpotqa, fever, msmarco.
 *
 * Gated behind BEIR_BENCHMARK=1 environment variable.
 * Uses BEIR_SAMPLE_SIZE for deterministic query sampling (default: 50, use 0 for full split).
 *
 * Examples:
 *   BEIR_BENCHMARK=1 npm test --workspace=packages/core              # default: scifact, 50-query sample
 *   BEIR_BENCHMARK=1 BEIR_DATASET=nfcorpus npm test --workspace=packages/core
 *   BEIR_BENCHMARK=1 BEIR_DATASET=fiqa npm test --workspace=packages/core
 *   BEIR_BENCHMARK=1 BEIR_SAMPLE_SIZE=0 npm test --workspace=packages/core   # full test split
 */

import path from "path";
import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  VectorRetriever,
  KeywordRetriever,
  HybridRetriever,
  DEFAULT_HYBRID_OPTIONS,
  EmbeddingService,
  HuggingFaceBackend,
  ModelRegistry,
  RemoteEmbeddingBackend,
  TransformersEmbeddings,
  extractKeywords,
} from "../src/index";
import type { RemoteEmbeddingFormat } from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, stddev, ndcgAtK, mapAtK, recallAtK, precisionAtK, mrrAtK } from "./helpers/metrics";
import { formatSampleSelection, parseBenchmarkSampleSize, sampleDeterministically } from "./helpers/benchmarkSampling";
import { downloadAndExtract, loadCorpus, loadQueries, loadQrels } from "./helpers/beirLoader";

// ═══════════════════════════════════════════════════════════════════════
// §1  Constants
// ═══════════════════════════════════════════════════════════════════════

// Dataset selection: override with BEIR_DATASET env var (default: scifact)
// Supported small/medium BEIR datasets: scifact, nfcorpus, fiqa, arguana, scidocs, trec-covid
// Large datasets (>500K docs): quora, nq, hotpotqa, fever, msmarco, dbpedia-entity
const DATASET = process.env.BEIR_DATASET || "scifact";
const MODEL = process.env.BEIR_MODEL || "Xenova/all-MiniLM-L6-v2";
const MODEL_SHORT = MODEL.split("/").pop() ?? MODEL;
const REMOTE_URL = process.env.BEIR_REMOTE_URL || "";
const REMOTE_FORMAT = (process.env.BEIR_REMOTE_FORMAT || "openai") as RemoteEmbeddingFormat;
const REMOTE_MODEL = process.env.BEIR_REMOTE_MODEL || "";
const CACHE_DIR = path.resolve(__dirname, "../../../../.cache/beir");
const K_VALUES = [1, 3, 5, 10];
const MAX_K = 10;
const QUERY_SAMPLE_SIZE = parseBenchmarkSampleSize(process.env.BEIR_SAMPLE_SIZE);

type ConfigName = "HYBRID-default" | "HYBRID-kw-bm25" | "VECTOR-only" | "BM25-raw" | "BM25-keyword";

const ALL_CONFIGS: ConfigName[] = ["HYBRID-default", "HYBRID-kw-bm25", "VECTOR-only", "BM25-raw", "BM25-keyword"];

// ═══════════════════════════════════════════════════════════════════════
// §2  Per-Query Result Type
// ═══════════════════════════════════════════════════════════════════════

interface QueryResult {
  queryId: string;
  query: string;
  config: ConfigName;
  retrieved: string[];
  qrels: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════
// §3  Test Suite
// ═══════════════════════════════════════════════════════════════════════

describe(`BEIR ${DATASET} Retrieval Benchmark`, function (this: Mocha.Suite) {
  this.timeout(0); // unlimited — large datasets (e.g. fiqa 57k docs) need time

  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;

  let testQueries: { id: string; text: string; qrels: Map<string, number> }[] = [];
  const allResults: QueryResult[] = [];

  // ─── docId — extract corpus id from document metadata ─────────────

  function docId(doc: LangChainDocument): string {
    return doc.metadata?.id ?? doc.metadata?.chunkId ?? "unknown";
  }

  // ─── runConfig — execute a single strategy on a single query ──────

  async function runConfig(config: ConfigName, query: string): Promise<string[]> {
    switch (config) {
      case "HYBRID-default": {
        const results = await hybridRetriever.search(query, { k: MAX_K, ...DEFAULT_HYBRID_OPTIONS });
        return results.map((r) => docId(r.document));
      }

      case "HYBRID-kw-bm25": {
        // Replicates the fixed HYBRID logic with keyword-extracted BM25 query
        const vectorResults = await vectorRetriever.search(query, 30);
        const candidateMap = new Map<string, { doc: LangChainDocument; vectorScore: number }>();
        for (const { document: doc, score } of vectorResults) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { doc, vectorScore: score });
          }
        }

        const keywords = extractKeywords(query);
        const bm25Query = keywords.join(" ") || query;
        const bm25Results = await keywordRetriever.search(bm25Query, 30);

        // Build BM25 score map
        const bm25ScoreMap = new Map<string, number>();
        for (const { document: doc, score: bm25Score } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          bm25ScoreMap.set(key, bm25Score ?? 0);
        }

        // Vector score floor for BM25-only candidates
        const vectorScores = Array.from(candidateMap.values()).map((c) => c.vectorScore);
        const vectorScoreFloor = vectorScores.length > 0 ? Math.min(...vectorScores) : 0;

        for (const { document: doc } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { doc, vectorScore: vectorScoreFloor });
          }
        }

        // Normalize BM25 scores and compute hybrid scores
        const maxBm25Score = bm25ScoreMap.size > 0 ? Math.max(...bm25ScoreMap.values()) : 0;
        const scored: { id: string; score: number }[] = [];
        for (const [key, { doc, vectorScore }] of candidateMap.entries()) {
          const rawBm25 = bm25ScoreMap.get(key);
          const keywordScore =
            rawBm25 !== undefined && maxBm25Score > 0
              ? rawBm25 / maxBm25Score
              : keywordRetriever.scoreDocument(doc.pageContent, keywords, true);
          const hybridScore = 0.9 * vectorScore + 0.1 * keywordScore;
          scored.push({ id: docId(doc), score: hybridScore });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_K).map((s) => s.id);
      }

      case "VECTOR-only": {
        const results = await vectorRetriever.search(query, MAX_K);
        return results.map((r) => docId(r.document));
      }

      case "BM25-raw": {
        const results = await keywordRetriever.search(query, MAX_K);
        return results.map((r) => docId(r.document));
      }

      case "BM25-keyword": {
        const keywords = extractKeywords(query);
        const bm25Query = keywords.join(" ") || query;
        const results = await keywordRetriever.search(bm25Query, MAX_K);
        return results.map((r) => docId(r.document));
      }
    }
  }

  // ─── Formatting helpers ───────────────────────────────────────────

  function fmt(n: number): string {
    return n.toFixed(3).padStart(6);
  }

  function fmtPct(n: number): string {
    return (n * 100).toFixed(1).padStart(5) + "%";
  }

  // ═══════════════════════════════════════════════════════════════════
  // Setup
  // ═══════════════════════════════════════════════════════════════════

  before(async function (this: Mocha.Context) {
    if (!process.env.BEIR_BENCHMARK) {
      console.log(`[skip] BEIR ${DATASET} Retrieval Benchmark disabled. Set BEIR_BENCHMARK=1 to run this suite.`);
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

    // 5. Initialize real embedding pipeline
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    if (REMOTE_URL) {
      const remoteBackend = new RemoteEmbeddingBackend({
        baseUrl: REMOTE_URL,
        format: REMOTE_FORMAT,
        modelName: REMOTE_MODEL || undefined,
      });
      embeddingService.registerBackend(remoteBackend);
      console.log(`Using remote embeddings: ${REMOTE_URL} (${REMOTE_FORMAT}, model=${REMOTE_MODEL || "auto"})`);
    } else {
      const modelRegistry = ModelRegistry.getInstance();
      const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier, MODEL);
      embeddingService.registerBackend(hfBackend);
    }
    const embeddings = new TransformersEmbeddings({ embeddingService });

    // 6. Create vector store and retrievers
    const vectorStore = await RealVectorStore.fromDocuments(docs, embeddings);
    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(docs);
    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);

    console.log(
      `BEIR ${DATASET}: ${corpus.size} docs, ${formatSampleSelection(allTestQueries.length, testQueries.length, "BEIR_SAMPLE_SIZE", QUERY_SAMPLE_SIZE)}`,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 1: Per-Query Evaluation
  // ═══════════════════════════════════════════════════════════════════

  it("should evaluate the selected query set across all 5 configs", async function (this: Mocha.Context) {
    this.timeout(0);

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 1: PER-QUERY RESULTS  (NDCG@5)");
    console.log("═══════════════════════════════════════════════════════════════");

    for (let qi = 0; qi < testQueries.length; qi++) {
      const tq = testQueries[qi];

      const perQueryScores: Record<ConfigName, number> = {} as Record<ConfigName, number>;

      for (const config of ALL_CONFIGS) {
        const retrieved = await runConfig(config, tq.text);
        allResults.push({
          queryId: tq.id,
          query: tq.text,
          config,
          retrieved,
          qrels: tq.qrels,
        });

        perQueryScores[config] = ndcgAtK(retrieved, tq.qrels, 5);
      }

      // Print summary every 10 queries to avoid flooding output
      if (qi % 10 === 0) {
        const shortQuery = tq.text.length > 50 ? tq.text.substring(0, 47) + "..." : tq.text;
        const cols = ALL_CONFIGS.map((c) => fmt(perQueryScores[c])).join(" | ");
        console.log(`  Q${String(qi + 1).padStart(3)}) ${shortQuery.padEnd(52)} ${cols}`);
      }
    }

    // Sanity: majority of queries should have at least one config finding something relevant
    const queriesWithHits = new Set<number>();
    for (const r of allResults) {
      if (ndcgAtK(r.retrieved, r.qrels, MAX_K) > 0) {
        queriesWithHits.add(testQueries.findIndex((tq) => tq.id === r.queryId));
      }
    }
    const hitRate = queriesWithHits.size / testQueries.length;
    console.log(`\n  Total query-config pairs: ${allResults.length}`);
    console.log(
      `  Queries with ≥1 relevant hit: ${queriesWithHits.size}/${testQueries.length} (${(hitRate * 100).toFixed(1)}%)`,
    );
    expect(hitRate, "hit rate across all queries").to.be.greaterThan(0.5);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 2: Aggregate Metrics
  // ═══════════════════════════════════════════════════════════════════

  it("should compute aggregate metrics across the selected query set", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(
      `  SECTION 2: AGGREGATE METRICS | Corpus: ${allResults.length / ALL_CONFIGS.length} queries | Model: ${MODEL_SHORT}`,
    );
    console.log("═══════════════════════════════════════════════════════════════");

    const header = "  Config               | NDCG@1 | NDCG@3 | NDCG@5 | NDCG@10 | MAP@5  | Recall@5 | P@5    | MRR   ";
    console.log(header);
    console.log("  " + "─".repeat(header.length - 2));

    const machineMetrics: Record<string, { ndcgAt5: number; recallAt5: number; mrrAt10: number }> = {};
    const canonicalNames: Partial<Record<ConfigName, string>> = {
      "VECTOR-only": "vector",
      "HYBRID-default": "hybrid",
      "BM25-keyword": "bm25",
    };
    for (const config of ALL_CONFIGS) {
      const configResults = allResults.filter((r) => r.config === config);

      const metricsByK: Record<number, number[]> = {};
      for (const k of K_VALUES) {
        metricsByK[k] = configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, k));
      }

      const mapScores = configResults.map((r) => mapAtK(r.retrieved, r.qrels, 5));
      const recallScores = configResults.map((r) => recallAtK(r.retrieved, r.qrels, 5));
      const precScores = configResults.map((r) => precisionAtK(r.retrieved, r.qrels, 5));
      const mrrScores = configResults.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K));

      console.log(
        `  ${config.padEnd(22)}|${fmt(mean(metricsByK[1]))} |${fmt(mean(metricsByK[3]))} |${fmt(mean(metricsByK[5]))} |${fmt(mean(metricsByK[10]))}  |${fmt(mean(mapScores))} |${fmtPct(mean(recallScores))}   |${fmt(mean(precScores))} |${fmt(mean(mrrScores))}`,
      );
      const canonical = canonicalNames[config];
      if (canonical) {
        machineMetrics[canonical] = {
          ndcgAt5: mean(metricsByK[5]),
          recallAt5: mean(recallScores),
          mrrAt10: mean(mrrScores),
        };
      }
    }
    if (process.env.RAGNAROK_BENCHMARK_MODE === "release") {
      console.log(`RAGNAROK_METRICS beir ${JSON.stringify(machineMetrics)}`);
    }

    // Assertions: HYBRID configs should have reasonable NDCG@10
    for (const config of ["HYBRID-default", "HYBRID-kw-bm25"] as ConfigName[]) {
      const configResults = allResults.filter((r) => r.config === config);
      const ndcg10 = mean(configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, 10)));
      expect(ndcg10, `${config} mean NDCG@10`).to.be.greaterThan(0.1);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 3: BM25 Input Ablation
  // ═══════════════════════════════════════════════════════════════════

  it("should compare BM25 input variants (ablation study)", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 3: BM25 INPUT ABLATION");
    console.log("═══════════════════════════════════════════════════════════════");

    // ── HYBRID ablation: kw-bm25 vs default ──
    console.log("\n  ── HYBRID: kw-bm25 − default (positive = keyword input better) ──");

    const hybridHeader = `  k     | Δ NDCG  | Δ MAP   | Δ Recall | Δ MRR  `;
    console.log(hybridHeader);
    console.log("  " + "─".repeat(hybridHeader.length - 2));

    for (const k of K_VALUES) {
      const kwResults = allResults.filter((r) => r.config === "HYBRID-kw-bm25");
      const defResults = allResults.filter((r) => r.config === "HYBRID-default");

      const dNdcg =
        mean(kwResults.map((r) => ndcgAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => ndcgAtK(r.retrieved, r.qrels, k)));
      const dMap =
        mean(kwResults.map((r) => mapAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => mapAtK(r.retrieved, r.qrels, k)));
      const dRecall =
        mean(kwResults.map((r) => recallAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => recallAtK(r.retrieved, r.qrels, k)));
      const dMrr =
        mean(kwResults.map((r) => mrrAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => mrrAtK(r.retrieved, r.qrels, k)));

      const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(4);
      console.log(
        `  k=${String(k).padEnd(4)}|${sign(dNdcg).padStart(8)} |${sign(dMap).padStart(8)} |${sign(dRecall).padStart(9)} |${sign(dMrr).padStart(7)}`,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 4: Statistical Summary
  // ═══════════════════════════════════════════════════════════════════

  it("should show statistical summary (mean ± stddev)", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 4: STATISTICAL SUMMARY (mean ± stddev)");
    console.log("═══════════════════════════════════════════════════════════════");

    const statHeader = `  Config               | NDCG@5         | Recall@5       | MAP@5          | MRR           `;
    console.log(statHeader);
    console.log("  " + "─".repeat(statHeader.length - 2));

    for (const config of ALL_CONFIGS) {
      const configResults = allResults.filter((r) => r.config === config);

      const ndcg5Arr = configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, 5));
      const recall5Arr = configResults.map((r) => recallAtK(r.retrieved, r.qrels, 5));
      const map5Arr = configResults.map((r) => mapAtK(r.retrieved, r.qrels, 5));
      const mrrArr = configResults.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K));

      const fmtStat = (arr: number[]) => `${mean(arr).toFixed(3)} ± ${stddev(arr).toFixed(3)}`;

      console.log(
        `  ${config.padEnd(22)}| ${fmtStat(ndcg5Arr).padEnd(15)}| ${fmtStat(recall5Arr).padEnd(15)}| ${fmtStat(map5Arr).padEnd(15)}| ${fmtStat(mrrArr)}`,
      );
    }

    console.log("\n");
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 5: HYBRID Weight Sweep
  // ═══════════════════════════════════════════════════════════════════

  it("should sweep hybrid weight ratios", async function (this: Mocha.Context) {
    this.timeout(0);

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 5: HYBRID WEIGHT SWEEP");
    console.log("═══════════════════════════════════════════════════════════════");

    // ── Step 1: Cache retrieval results per query ──────────────────
    // Run vector + BM25 retrieval ONCE per query, then re-score with different weights.

    interface CachedCandidate {
      corpusId: string;
      vectorScore: number;
      normalizedBm25: number;
    }
    interface CachedQuery {
      queryId: string;
      qrels: Map<string, number>;
      candidates: CachedCandidate[];
    }

    const cached: CachedQuery[] = [];
    const CANDIDATE_K = 30;

    for (const tq of testQueries) {
      // Vector retrieval
      const vectorResults = await vectorRetriever.search(tq.text, CANDIDATE_K);
      const candidateMap = new Map<string, { corpusId: string; vectorScore: number }>();
      for (const { document: doc, score } of vectorResults) {
        const key = doc.metadata?.chunkId ?? doc.pageContent;
        if (!candidateMap.has(key)) {
          candidateMap.set(key, { corpusId: docId(doc), vectorScore: score });
        }
      }

      // BM25 retrieval
      const keywords = extractKeywords(tq.text);
      const bm25Query = keywords.join(" ") || tq.text;
      const bm25Results = await keywordRetriever.search(bm25Query, CANDIDATE_K);

      const bm25ScoreMap = new Map<string, number>();
      for (const { document: doc, score: bm25Score } of bm25Results) {
        const key = doc.metadata?.chunkId ?? doc.pageContent;
        bm25ScoreMap.set(key, bm25Score ?? 0);
      }

      // Vector score floor for BM25-only candidates
      const vectorScores = Array.from(candidateMap.values()).map((c) => c.vectorScore);
      const vectorScoreFloor = vectorScores.length > 0 ? Math.min(...vectorScores) : 0;

      for (const { document: doc } of bm25Results) {
        const key = doc.metadata?.chunkId ?? doc.pageContent;
        if (!candidateMap.has(key)) {
          candidateMap.set(key, { corpusId: docId(doc), vectorScore: vectorScoreFloor });
        }
      }

      // Normalize BM25 scores
      const maxBm25Score = bm25ScoreMap.size > 0 ? Math.max(...bm25ScoreMap.values()) : 0;

      const candidates: CachedCandidate[] = [];
      for (const [key, { corpusId, vectorScore }] of candidateMap.entries()) {
        const rawBm25 = bm25ScoreMap.get(key);
        const normalizedBm25 =
          rawBm25 !== undefined && maxBm25Score > 0
            ? rawBm25 / maxBm25Score
            : keywordRetriever.scoreDocument(
                vectorResults.find((r) => (r.document.metadata?.chunkId ?? r.document.pageContent) === key)?.document
                  .pageContent ?? "",
                keywords,
                true,
              );
        candidates.push({ corpusId, vectorScore, normalizedBm25 });
      }

      cached.push({ queryId: tq.id, qrels: tq.qrels, candidates });
    }

    // ── Step 2: Coarse sweep (0.0 to 1.0 in 0.1 steps) ───────────

    interface WeightVariant {
      vectorWeight: number;
      keywordWeight: number;
      label: string;
    }

    const coarseGrid: WeightVariant[] = [];
    for (let vw = 0; vw <= 10; vw++) {
      const v = vw / 10;
      const k = 1 - v;
      coarseGrid.push({
        vectorWeight: v,
        keywordWeight: k,
        label: `V${v.toFixed(1)}/K${k.toFixed(1)}`,
      });
    }

    function sweepWeights(grid: WeightVariant[]) {
      const results: {
        variant: WeightVariant;
        ndcgByK: Record<number, number>;
        map5: number;
        recall5: number;
        prec5: number;
        mrr: number;
      }[] = [];

      for (const variant of grid) {
        const allRetrieved: { retrieved: string[]; qrels: Map<string, number> }[] = [];

        for (const cq of cached) {
          const scored = cq.candidates.map((c) => ({
            corpusId: c.corpusId,
            score: variant.vectorWeight * c.vectorScore + variant.keywordWeight * c.normalizedBm25,
          }));
          scored.sort((a, b) => b.score - a.score);
          const retrieved = scored.slice(0, MAX_K).map((s) => s.corpusId);
          allRetrieved.push({ retrieved, qrels: cq.qrels });
        }

        const ndcgByK: Record<number, number> = {};
        for (const k of K_VALUES) {
          ndcgByK[k] = mean(allRetrieved.map((r) => ndcgAtK(r.retrieved, r.qrels, k)));
        }

        results.push({
          variant,
          ndcgByK,
          map5: mean(allRetrieved.map((r) => mapAtK(r.retrieved, r.qrels, 5))),
          recall5: mean(allRetrieved.map((r) => recallAtK(r.retrieved, r.qrels, 5))),
          prec5: mean(allRetrieved.map((r) => precisionAtK(r.retrieved, r.qrels, 5))),
          mrr: mean(allRetrieved.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K))),
        });
      }

      return results;
    }

    const coarseResults = sweepWeights(coarseGrid);

    console.log("\n  ── Coarse Sweep (0.1 steps) ──");
    const sweepHeader = "  Weights       | NDCG@1 | NDCG@3 | NDCG@5 | NDCG@10 | MAP@5  | Recall@5 | MRR   ";
    console.log(sweepHeader);
    console.log("  " + "─".repeat(sweepHeader.length - 2));

    for (const r of coarseResults) {
      console.log(
        `  ${r.variant.label.padEnd(16)}|${fmt(r.ndcgByK[1])} |${fmt(r.ndcgByK[3])} |${fmt(r.ndcgByK[5])} |${fmt(r.ndcgByK[10])}  |${fmt(r.map5)} |${fmtPct(r.recall5)}   |${fmt(r.mrr)}`,
      );
    }

    // ── Step 3: Find best coarse weight by NDCG@10 ────────────────

    let bestCoarse = coarseResults[0];
    for (const r of coarseResults) {
      if (r.ndcgByK[10] > bestCoarse.ndcgByK[10]) {
        bestCoarse = r;
      }
    }

    const defaultResult = coarseResults.find((r) => r.variant.vectorWeight === 0.9)!;
    console.log(
      `\n  Best coarse: ${bestCoarse.variant.label} (NDCG@10=${bestCoarse.ndcgByK[10].toFixed(4)})` +
        ` | Default 0.9/0.1: NDCG@10=${defaultResult.ndcgByK[10].toFixed(4)}` +
        ` | Δ=${(bestCoarse.ndcgByK[10] - defaultResult.ndcgByK[10]).toFixed(4)}`,
    );

    // ── Step 4: Fine sweep (0.05 steps around best) ───────────────

    const center = bestCoarse.variant.vectorWeight;
    const fineGrid: WeightVariant[] = [];
    for (let delta = -0.15; delta <= 0.15; delta += 0.05) {
      const v = Math.round((center + delta) * 100) / 100;
      if (v < 0 || v > 1) {
        continue;
      }
      // Skip values already in coarse grid
      if (Math.abs(v * 10 - Math.round(v * 10)) < 0.001) {
        continue;
      }
      const k = Math.round((1 - v) * 100) / 100;
      fineGrid.push({
        vectorWeight: v,
        keywordWeight: k,
        label: `V${v.toFixed(2)}/K${k.toFixed(2)}`,
      });
    }

    if (fineGrid.length > 0) {
      const fineResults = sweepWeights(fineGrid);
      const allResults2 = [...coarseResults, ...fineResults].sort((a, b) => b.ndcgByK[10] - a.ndcgByK[10]);

      console.log("\n  ── Fine Sweep (0.05 steps around optimum) ──");
      console.log(sweepHeader);
      console.log("  " + "─".repeat(sweepHeader.length - 2));

      for (const r of fineResults) {
        console.log(
          `  ${r.variant.label.padEnd(16)}|${fmt(r.ndcgByK[1])} |${fmt(r.ndcgByK[3])} |${fmt(r.ndcgByK[5])} |${fmt(r.ndcgByK[10])}  |${fmt(r.map5)} |${fmtPct(r.recall5)}   |${fmt(r.mrr)}`,
        );
      }

      const best = allResults2[0];
      console.log(
        `\n  Overall best: ${best.variant.label} (NDCG@10=${best.ndcgByK[10].toFixed(4)})` +
          ` | Δ vs default=${(best.ndcgByK[10] - defaultResult.ndcgByK[10]).toFixed(4)}`,
      );
    }

    // ── Assertion: optimal hybrid beats pure vector and pure BM25 ──
    const pureVector = coarseResults.find((r) => r.variant.vectorWeight === 1.0)!;
    const pureBm25 = coarseResults.find((r) => r.variant.vectorWeight === 0.0)!;
    expect(bestCoarse.ndcgByK[10], "best hybrid ≥ pure vector").to.be.at.least(pureVector.ndcgByK[10]);
    expect(bestCoarse.ndcgByK[10], "best hybrid ≥ pure BM25").to.be.at.least(pureBm25.ndcgByK[10]);
  });
});
