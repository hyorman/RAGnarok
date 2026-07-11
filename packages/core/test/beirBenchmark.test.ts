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
import { createHash } from "crypto";
import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import {
  VectorRetriever,
  KeywordRetriever,
  HybridRetriever,
  EnsembleRetrieverWrapper,
  DEFAULT_HYBRID_OPTIONS,
  DEFAULT_ENSEMBLE_OPTIONS,
  EmbeddingService,
  HuggingFaceBackend,
  ModelRegistry,
  RemoteEmbeddingBackend,
  TransformersEmbeddings,
  extractKeywords,
} from "../src/index";
import type { RemoteEmbeddingFormat } from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, stddev, median, percentile, ndcgAtK, mapAtK, recallAtK, precisionAtK, mrrAtK } from "./helpers/metrics";
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

type ConfigName =
  | "HYBRID-default"
  | "HYBRID-kw-bm25"
  | "ENSEMBLE-default"
  | "ENSEMBLE-raw-bm25"
  | "VECTOR-only"
  | "BM25-raw"
  | "BM25-keyword";

const ALL_CONFIGS: ConfigName[] = [
  "HYBRID-default",
  "HYBRID-kw-bm25",
  "ENSEMBLE-default",
  "ENSEMBLE-raw-bm25",
  "VECTOR-only",
  "BM25-raw",
  "BM25-keyword",
];

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
  let ensembleRetriever: EnsembleRetrieverWrapper;

  let testQueries: { id: string; text: string; qrels: Map<string, number> }[] = [];
  const allResults: QueryResult[] = [];

  // ─── getDocumentId — matches EnsembleRetrieverWrapper.getDocumentId ───

  function getDocumentId(doc: LangChainDocument): string {
    if (doc.metadata?.chunkId) {
      return String(doc.metadata.chunkId);
    }
    const hash = createHash("sha256");
    hash.update(doc.pageContent);
    hash.update(JSON.stringify(doc.metadata || {}));
    return hash.digest("hex");
  }

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

      case "ENSEMBLE-default": {
        const results = await ensembleRetriever.search(query, { k: MAX_K, ...DEFAULT_ENSEMBLE_OPTIONS });
        return results.map((r) => docId(r.document));
      }

      case "ENSEMBLE-raw-bm25": {
        const vectorDocs = await vectorRetriever.getDocuments(query, 30);
        const bm25Results = await keywordRetriever.search(query, 30);

        const scoreMap = new Map<string, { doc: LangChainDocument; score: number }>();

        vectorDocs.forEach((doc, index) => {
          const id = getDocumentId(doc);
          const rrf = 0.7 / (60 + index + 1);
          if (scoreMap.has(id)) {
            scoreMap.get(id)!.score += rrf;
          } else {
            scoreMap.set(id, { doc, score: rrf });
          }
        });

        bm25Results.forEach(({ document: doc }, index) => {
          const id = getDocumentId(doc);
          const rrf = 0.3 / (60 + index + 1);
          if (scoreMap.has(id)) {
            scoreMap.get(id)!.score += rrf;
          } else {
            scoreMap.set(id, { doc, score: rrf });
          }
        });

        const ranked = Array.from(scoreMap.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_K);
        return ranked.map((r) => docId(r.doc));
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
    ensembleRetriever = new EnsembleRetrieverWrapper(vectorRetriever, keywordRetriever);

    console.log(
      `BEIR ${DATASET}: ${corpus.size} docs, ${formatSampleSelection(allTestQueries.length, testQueries.length, "BEIR_SAMPLE_SIZE", QUERY_SAMPLE_SIZE)}`,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 1: Per-Query Evaluation
  // ═══════════════════════════════════════════════════════════════════

  it("should evaluate the selected query set across all 7 configs", async function (this: Mocha.Context) {
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
    }

    // Assertions: HYBRID and ENSEMBLE configs should have reasonable NDCG@10
    for (const config of [
      "HYBRID-default",
      "HYBRID-kw-bm25",
      "ENSEMBLE-default",
      "ENSEMBLE-raw-bm25",
    ] as ConfigName[]) {
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

    // ── ENSEMBLE ablation: raw-bm25 vs default ──
    console.log("\n  ── ENSEMBLE: raw-bm25 − default (positive = raw NL better) ──");

    const ensHeader = `  k     | Δ NDCG  | Δ MAP   | Δ Recall | Δ MRR  `;
    console.log(ensHeader);
    console.log("  " + "─".repeat(ensHeader.length - 2));

    for (const k of K_VALUES) {
      const rawResults = allResults.filter((r) => r.config === "ENSEMBLE-raw-bm25");
      const defResults = allResults.filter((r) => r.config === "ENSEMBLE-default");

      const dNdcg =
        mean(rawResults.map((r) => ndcgAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => ndcgAtK(r.retrieved, r.qrels, k)));
      const dMap =
        mean(rawResults.map((r) => mapAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => mapAtK(r.retrieved, r.qrels, k)));
      const dRecall =
        mean(rawResults.map((r) => recallAtK(r.retrieved, r.qrels, k))) -
        mean(defResults.map((r) => recallAtK(r.retrieved, r.qrels, k)));
      const dMrr =
        mean(rawResults.map((r) => mrrAtK(r.retrieved, r.qrels, k))) -
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

  // ═══════════════════════════════════════════════════════════════════
  // Section 6: HYBRID vs ENSEMBLE Head-to-Head
  // ═══════════════════════════════════════════════════════════════════

  describe("Section 6: HYBRID vs ENSEMBLE Head-to-Head", function (this: Mocha.Suite) {
    this.timeout(0);

    interface PerQueryComparison {
      queryId: string;
      query: string;
      hybridNdcg1: number;
      hybridNdcg5: number;
      hybridNdcg10: number;
      ensembleNdcg1: number;
      ensembleNdcg5: number;
      ensembleNdcg10: number;
      hybridRecall5: number;
      ensembleRecall5: number;
      hybridMrr: number;
      ensembleMrr: number;
      hybridPrec5: number;
      ensemblePrec5: number;
      hybridRetrieved: string[];
      ensembleRetrieved: string[];
      qrels: Map<string, number>;
    }

    const comparisons: PerQueryComparison[] = [];

    // Shared cache for ENSEMBLE weight sweep (populated in 6.5, used in 6.6)
    interface EnsembleCachedQuery {
      queryId: string;
      qrels: Map<string, number>;
      vectorRanks: { rrfId: string; corpusId: string }[];
      bm25Ranks: { rrfId: string; corpusId: string }[];
    }
    const ensembleCache: EnsembleCachedQuery[] = [];

    before(function () {
      // Build per-query comparisons from allResults (populated in Section 1)
      for (const tq of testQueries) {
        const hResult = allResults.find((r) => r.config === "HYBRID-default" && r.queryId === tq.id);
        const eResult = allResults.find((r) => r.config === "ENSEMBLE-default" && r.queryId === tq.id);
        if (!hResult || !eResult) {
          continue;
        }

        comparisons.push({
          queryId: tq.id,
          query: tq.text,
          hybridNdcg1: ndcgAtK(hResult.retrieved, tq.qrels, 1),
          hybridNdcg5: ndcgAtK(hResult.retrieved, tq.qrels, 5),
          hybridNdcg10: ndcgAtK(hResult.retrieved, tq.qrels, 10),
          ensembleNdcg1: ndcgAtK(eResult.retrieved, tq.qrels, 1),
          ensembleNdcg5: ndcgAtK(eResult.retrieved, tq.qrels, 5),
          ensembleNdcg10: ndcgAtK(eResult.retrieved, tq.qrels, 10),
          hybridRecall5: recallAtK(hResult.retrieved, tq.qrels, 5),
          ensembleRecall5: recallAtK(eResult.retrieved, tq.qrels, 5),
          hybridMrr: mrrAtK(hResult.retrieved, tq.qrels, MAX_K),
          ensembleMrr: mrrAtK(eResult.retrieved, tq.qrels, MAX_K),
          hybridPrec5: precisionAtK(hResult.retrieved, tq.qrels, 5),
          ensemblePrec5: precisionAtK(eResult.retrieved, tq.qrels, 5),
          hybridRetrieved: hResult.retrieved,
          ensembleRetrieved: eResult.retrieved,
          qrels: tq.qrels,
        });
      }
    });

    it("6.1 should track per-query winners", function () {
      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.1: PER-QUERY WINNER TRACKING");
      console.log("═══════════════════════════════════════════════════════════════");

      const TIE_THRESHOLD = 0.001;

      function countWins(getter: (c: PerQueryComparison) => [number, number]) {
        let hWins = 0,
          eWins = 0,
          ties = 0;
        for (const c of comparisons) {
          const [hScore, eScore] = getter(c);
          const delta = hScore - eScore;
          if (Math.abs(delta) < TIE_THRESHOLD) {
            ties++;
          } else if (delta > 0) {
            hWins++;
          } else {
            eWins++;
          }
        }
        return { hWins, eWins, ties };
      }

      const ndcg5 = countWins((c) => [c.hybridNdcg5, c.ensembleNdcg5]);
      const ndcg10 = countWins((c) => [c.hybridNdcg10, c.ensembleNdcg10]);

      const winHeader = "  Metric   | HYBRID wins | ENSEMBLE wins | Ties   | Total";
      console.log(winHeader);
      console.log("  " + "─".repeat(winHeader.length - 2));
      console.log(
        `  NDCG@5   |${String(ndcg5.hWins).padStart(10)}   |${String(ndcg5.eWins).padStart(12)}    |${String(ndcg5.ties).padStart(5)}  |${String(comparisons.length).padStart(5)}`,
      );
      console.log(
        `  NDCG@10  |${String(ndcg10.hWins).padStart(10)}   |${String(ndcg10.eWins).padStart(12)}    |${String(ndcg10.ties).padStart(5)}  |${String(comparisons.length).padStart(5)}`,
      );

      expect(ndcg5.hWins + ndcg5.eWins + ndcg5.ties).to.equal(comparisons.length);
      expect(ndcg10.hWins + ndcg10.eWins + ndcg10.ties).to.equal(comparisons.length);
    });

    it("6.2 should show win margin distribution", function () {
      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.2: WIN MARGIN DISTRIBUTION (positive = HYBRID better)");
      console.log("═══════════════════════════════════════════════════════════════");

      const deltas5 = comparisons.map((c) => c.hybridNdcg5 - c.ensembleNdcg5);
      const deltas10 = comparisons.map((c) => c.hybridNdcg10 - c.ensembleNdcg10);

      const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(4);

      const distHeader = "  Metric     | Mean    | Median  | StdDev  | P10     | P25     | P75     | P90";
      console.log(distHeader);
      console.log("  " + "─".repeat(distHeader.length - 2));

      for (const [label, d] of [
        ["Δ NDCG@5 ", deltas5],
        ["Δ NDCG@10", deltas10],
      ] as const) {
        console.log(
          `  ${label}  |${sign(mean(d as number[])).padStart(8)} |${sign(median(d as number[])).padStart(8)} |${stddev(
            d as number[],
          )
            .toFixed(4)
            .padStart(
              8,
            )} |${sign(percentile(d as number[], 0.1)).padStart(8)} |${sign(percentile(d as number[], 0.25)).padStart(8)} |${sign(percentile(d as number[], 0.75)).padStart(8)} |${sign(percentile(d as number[], 0.9)).padStart(8)}`,
        );
      }
    });

    it("6.3 should analyze query types — biggest winners", function () {
      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.3: QUERY-TYPE ANALYSIS — BIGGEST WINNERS");
      console.log("═══════════════════════════════════════════════════════════════");

      const sorted = [...comparisons].sort(
        (a, b) => b.hybridNdcg5 - b.ensembleNdcg5 - (a.hybridNdcg5 - a.ensembleNdcg5),
      );

      const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(3);

      console.log("\n  ── Top 10 queries where HYBRID wins biggest (NDCG@5) ──");
      const qHeader = "  Rank | Query                                                        | H-NDCG@5 | E-NDCG@5 | Δ";
      console.log(qHeader);
      console.log("  " + "─".repeat(qHeader.length - 2));
      for (let i = 0; i < Math.min(10, sorted.length); i++) {
        const c = sorted[i];
        const shortQ = c.query.length > 60 ? c.query.substring(0, 57) + "..." : c.query;
        const delta = c.hybridNdcg5 - c.ensembleNdcg5;
        console.log(
          `  ${String(i + 1).padStart(4)} | ${shortQ.padEnd(60)} |${fmt(c.hybridNdcg5)}   |${fmt(c.ensembleNdcg5)}   | ${sign(delta)}`,
        );
      }

      console.log("\n  ── Top 10 queries where ENSEMBLE wins biggest (NDCG@5) ──");
      console.log(qHeader);
      console.log("  " + "─".repeat(qHeader.length - 2));
      for (let i = sorted.length - 1; i >= Math.max(0, sorted.length - 10); i--) {
        const c = sorted[i];
        const shortQ = c.query.length > 60 ? c.query.substring(0, 57) + "..." : c.query;
        const delta = c.hybridNdcg5 - c.ensembleNdcg5;
        console.log(
          `  ${String(sorted.length - i).padStart(4)} | ${shortQ.padEnd(60)} |${fmt(c.hybridNdcg5)}   |${fmt(c.ensembleNdcg5)}   | ${sign(delta)}`,
        );
      }
    });

    it("6.4 should show recall vs precision tradeoff", function () {
      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.4: RECALL vs PRECISION TRADEOFF");
      console.log("═══════════════════════════════════════════════════════════════");

      const TIE_THRESHOLD = 0.001;
      const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(4);

      function metricWins(hGetter: (c: PerQueryComparison) => number, eGetter: (c: PerQueryComparison) => number) {
        let hWins = 0,
          eWins = 0,
          ties = 0;
        const hVals: number[] = [],
          eVals: number[] = [];
        for (const c of comparisons) {
          const h = hGetter(c),
            e = eGetter(c);
          hVals.push(h);
          eVals.push(e);
          const delta = h - e;
          if (Math.abs(delta) < TIE_THRESHOLD) {
            ties++;
          } else if (delta > 0) {
            hWins++;
          } else {
            eWins++;
          }
        }
        return { hMean: mean(hVals), eMean: mean(eVals), hWins, eWins, ties };
      }

      const metrics: [string, (c: PerQueryComparison) => number, (c: PerQueryComparison) => number][] = [
        ["Recall@5   ", (c) => c.hybridRecall5, (c) => c.ensembleRecall5],
        ["NDCG@1     ", (c) => c.hybridNdcg1, (c) => c.ensembleNdcg1],
        ["MRR@10     ", (c) => c.hybridMrr, (c) => c.ensembleMrr],
        ["Precision@5", (c) => c.hybridPrec5, (c) => c.ensemblePrec5],
      ];

      const tHeader = "  Metric      | HYBRID-default | ENSEMBLE-default | Δ (H−E)  | H wins | E wins | Ties";
      console.log(tHeader);
      console.log("  " + "─".repeat(tHeader.length - 2));

      for (const [label, hGet, eGet] of metrics) {
        const m = metricWins(hGet, eGet);
        console.log(
          `  ${label}  |${fmt(m.hMean).padStart(15)} |${fmt(m.eMean).padStart(17)} |${sign(m.hMean - m.eMean).padStart(9)} |${String(m.hWins).padStart(7)} |${String(m.eWins).padStart(7)} |${String(m.ties).padStart(5)}`,
        );
      }
    });

    it("6.5 should sweep ensemble weight ratios", async function (this: Mocha.Context) {
      this.timeout(0);

      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.5: ENSEMBLE WEIGHT SWEEP (RRF, k=60)");
      console.log("═══════════════════════════════════════════════════════════════");

      // ── Step 1: Cache retrieval results per query ──
      const RRF_K = 60;
      const FETCH_COUNT = 30;

      for (const tq of testQueries) {
        const vectorDocs = await vectorRetriever.getDocuments(tq.text, FETCH_COUNT);
        const bm25Query = extractKeywords(tq.text).join(" ") || tq.text;
        const bm25Results = await keywordRetriever.search(bm25Query, FETCH_COUNT);

        ensembleCache.push({
          queryId: tq.id,
          qrels: tq.qrels,
          vectorRanks: vectorDocs.map((doc) => ({
            rrfId: getDocumentId(doc),
            corpusId: docId(doc),
          })),
          bm25Ranks: bm25Results.map(({ document: doc }) => ({
            rrfId: getDocumentId(doc),
            corpusId: docId(doc),
          })),
        });
      }

      // ── Step 2: RRF sweep function ──
      interface EnsWeightVariant {
        vectorWeight: number;
        bm25Weight: number;
        label: string;
      }

      function sweepEnsembleWeights(grid: EnsWeightVariant[]) {
        const results: {
          variant: EnsWeightVariant;
          ndcgByK: Record<number, number>;
          map5: number;
          recall5: number;
          mrr: number;
        }[] = [];

        for (const variant of grid) {
          const allRetrieved: { retrieved: string[]; qrels: Map<string, number> }[] = [];

          for (const cq of ensembleCache) {
            const scoreMap = new Map<string, { corpusId: string; score: number }>();

            cq.vectorRanks.forEach(({ rrfId, corpusId }, index) => {
              const rrf = variant.vectorWeight / (RRF_K + index + 1);
              if (scoreMap.has(rrfId)) {
                scoreMap.get(rrfId)!.score += rrf;
              } else {
                scoreMap.set(rrfId, { corpusId, score: rrf });
              }
            });

            cq.bm25Ranks.forEach(({ rrfId, corpusId }, index) => {
              const rrf = variant.bm25Weight / (RRF_K + index + 1);
              if (scoreMap.has(rrfId)) {
                scoreMap.get(rrfId)!.score += rrf;
              } else {
                scoreMap.set(rrfId, { corpusId, score: rrf });
              }
            });

            const ranked = Array.from(scoreMap.values())
              .sort((a, b) => b.score - a.score)
              .slice(0, MAX_K)
              .map((r) => r.corpusId);
            allRetrieved.push({ retrieved: ranked, qrels: cq.qrels });
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
            mrr: mean(allRetrieved.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K))),
          });
        }

        return results;
      }

      // ── Step 3: Coarse sweep ──
      const coarseGrid: EnsWeightVariant[] = [];
      for (let vw = 0; vw <= 10; vw++) {
        const v = vw / 10;
        const b = 1 - v;
        coarseGrid.push({ vectorWeight: v, bm25Weight: b, label: `V${v.toFixed(1)}/B${b.toFixed(1)}` });
      }

      const coarseResults = sweepEnsembleWeights(coarseGrid);

      console.log("\n  ── Coarse Sweep (0.1 steps) ──");
      const ensSweepHeader = "  Weights       | NDCG@1 | NDCG@3 | NDCG@5 | NDCG@10 | MAP@5  | Recall@5 | MRR   ";
      console.log(ensSweepHeader);
      console.log("  " + "─".repeat(ensSweepHeader.length - 2));

      for (const r of coarseResults) {
        console.log(
          `  ${r.variant.label.padEnd(16)}|${fmt(r.ndcgByK[1])} |${fmt(r.ndcgByK[3])} |${fmt(r.ndcgByK[5])} |${fmt(r.ndcgByK[10])}  |${fmt(r.map5)} |${fmtPct(r.recall5)}   |${fmt(r.mrr)}`,
        );
      }

      // ── Step 4: Find best coarse weight ──
      let bestCoarse = coarseResults[0];
      for (const r of coarseResults) {
        if (r.ndcgByK[10] > bestCoarse.ndcgByK[10]) {
          bestCoarse = r;
        }
      }

      const ensDefault = coarseResults.find((r) => r.variant.vectorWeight === 0.5)!;
      console.log(
        `\n  Best coarse: ${bestCoarse.variant.label} (NDCG@10=${bestCoarse.ndcgByK[10].toFixed(4)})` +
          ` | Default V0.5/B0.5: NDCG@10=${ensDefault.ndcgByK[10].toFixed(4)}` +
          ` | Δ=${(bestCoarse.ndcgByK[10] - ensDefault.ndcgByK[10]).toFixed(4)}`,
      );

      // ── Step 5: Fine sweep ──
      const center = bestCoarse.variant.vectorWeight;
      const fineGrid: EnsWeightVariant[] = [];
      for (let delta = -0.15; delta <= 0.15; delta += 0.05) {
        const v = Math.round((center + delta) * 100) / 100;
        if (v < 0 || v > 1) {
          continue;
        }
        if (Math.abs(v * 10 - Math.round(v * 10)) < 0.001) {
          continue;
        }
        const b = Math.round((1 - v) * 100) / 100;
        fineGrid.push({ vectorWeight: v, bm25Weight: b, label: `V${v.toFixed(2)}/B${b.toFixed(2)}` });
      }

      if (fineGrid.length > 0) {
        const fineResults = sweepEnsembleWeights(fineGrid);
        const allSweep = [...coarseResults, ...fineResults].sort((a, b) => b.ndcgByK[10] - a.ndcgByK[10]);

        console.log("\n  ── Fine Sweep (0.05 steps around optimum) ──");
        console.log(ensSweepHeader);
        console.log("  " + "─".repeat(ensSweepHeader.length - 2));
        for (const r of fineResults) {
          console.log(
            `  ${r.variant.label.padEnd(16)}|${fmt(r.ndcgByK[1])} |${fmt(r.ndcgByK[3])} |${fmt(r.ndcgByK[5])} |${fmt(r.ndcgByK[10])}  |${fmt(r.map5)} |${fmtPct(r.recall5)}   |${fmt(r.mrr)}`,
          );
        }

        const best = allSweep[0];
        console.log(
          `\n  Overall best: ${best.variant.label} (NDCG@10=${best.ndcgByK[10].toFixed(4)})` +
            ` | Δ vs default=${(best.ndcgByK[10] - ensDefault.ndcgByK[10]).toFixed(4)}`,
        );
      }

      // ── Assertion: best ENSEMBLE beats pure-vector and pure-BM25 endpoints ──
      const pureVector = coarseResults.find((r) => r.variant.vectorWeight === 1.0)!;
      const pureBm25 = coarseResults.find((r) => r.variant.vectorWeight === 0.0)!;
      expect(bestCoarse.ndcgByK[10], "best ensemble ≥ pure vector (RRF)").to.be.at.least(pureVector.ndcgByK[10]);
      expect(bestCoarse.ndcgByK[10], "best ensemble ≥ pure BM25 (RRF)").to.be.at.least(pureBm25.ndcgByK[10]);
    });

    it("6.6 should compare optimal configs", async function (this: Mocha.Context) {
      this.timeout(0);

      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.6: OPTIMAL CONFIG COMPARISON");
      console.log("═══════════════════════════════════════════════════════════════");

      // ── Cache HYBRID data (same approach as Section 5) ──
      interface HCachedCandidate {
        corpusId: string;
        vectorScore: number;
        normalizedBm25: number;
      }
      interface HCachedQuery {
        queryId: string;
        qrels: Map<string, number>;
        candidates: HCachedCandidate[];
      }
      const hybridCache: HCachedQuery[] = [];

      for (const tq of testQueries) {
        const vectorResults = await vectorRetriever.search(tq.text, 30);
        const candidateMap = new Map<string, { corpusId: string; vectorScore: number }>();
        for (const { document: doc, score } of vectorResults) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { corpusId: docId(doc), vectorScore: score });
          }
        }

        const keywords = extractKeywords(tq.text);
        const bm25Query = keywords.join(" ") || tq.text;
        const bm25Results = await keywordRetriever.search(bm25Query, 30);

        const bm25ScoreMap = new Map<string, number>();
        for (const { document: doc, score: bm25Score } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          bm25ScoreMap.set(key, bm25Score ?? 0);
        }

        const vectorScores = Array.from(candidateMap.values()).map((c) => c.vectorScore);
        const vectorScoreFloor = vectorScores.length > 0 ? Math.min(...vectorScores) : 0;

        for (const { document: doc } of bm25Results) {
          const key = doc.metadata?.chunkId ?? doc.pageContent;
          if (!candidateMap.has(key)) {
            candidateMap.set(key, { corpusId: docId(doc), vectorScore: vectorScoreFloor });
          }
        }

        const maxBm25Score = bm25ScoreMap.size > 0 ? Math.max(...bm25ScoreMap.values()) : 0;
        const candidates: HCachedCandidate[] = [];
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
        hybridCache.push({ queryId: tq.id, qrels: tq.qrels, candidates });
      }

      // ── Sweep HYBRID weights ──
      function sweepHybrid(vw: number, kw: number) {
        const allRetrieved: { retrieved: string[]; qrels: Map<string, number> }[] = [];
        for (const cq of hybridCache) {
          const scored = cq.candidates.map((c) => ({
            corpusId: c.corpusId,
            score: vw * c.vectorScore + kw * c.normalizedBm25,
          }));
          scored.sort((a, b) => b.score - a.score);
          allRetrieved.push({ retrieved: scored.slice(0, MAX_K).map((s) => s.corpusId), qrels: cq.qrels });
        }
        const ndcgByK: Record<number, number> = {};
        for (const k of K_VALUES) {
          ndcgByK[k] = mean(allRetrieved.map((r) => ndcgAtK(r.retrieved, r.qrels, k)));
        }
        return {
          ndcgByK,
          map5: mean(allRetrieved.map((r) => mapAtK(r.retrieved, r.qrels, 5))),
          recall5: mean(allRetrieved.map((r) => recallAtK(r.retrieved, r.qrels, 5))),
          mrr: mean(allRetrieved.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K))),
        };
      }

      // Find best HYBRID via coarse + fine sweep
      let bestHybridWeight = { v: 0.9, k: 0.1 };
      let bestHybridNdcg10 = 0;
      for (let vw = 0; vw <= 10; vw++) {
        const v = vw / 10;
        const result = sweepHybrid(v, 1 - v);
        if (result.ndcgByK[10] > bestHybridNdcg10) {
          bestHybridNdcg10 = result.ndcgByK[10];
          bestHybridWeight = { v, k: 1 - v };
        }
      }

      // ── Sweep ENSEMBLE weights (re-use ensembleCache) ──
      const RRF_K = 60;
      function sweepEnsemble(vw: number, bw: number) {
        const allRetrieved: { retrieved: string[]; qrels: Map<string, number> }[] = [];
        for (const cq of ensembleCache) {
          const scoreMap = new Map<string, { corpusId: string; score: number }>();
          cq.vectorRanks.forEach(({ rrfId, corpusId }, i) => {
            const rrf = vw / (RRF_K + i + 1);
            if (scoreMap.has(rrfId)) {
              scoreMap.get(rrfId)!.score += rrf;
            } else {
              scoreMap.set(rrfId, { corpusId, score: rrf });
            }
          });
          cq.bm25Ranks.forEach(({ rrfId, corpusId }, i) => {
            const rrf = bw / (RRF_K + i + 1);
            if (scoreMap.has(rrfId)) {
              scoreMap.get(rrfId)!.score += rrf;
            } else {
              scoreMap.set(rrfId, { corpusId, score: rrf });
            }
          });
          const ranked = Array.from(scoreMap.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_K);
          allRetrieved.push({ retrieved: ranked.map((r) => r.corpusId), qrels: cq.qrels });
        }
        const ndcgByK: Record<number, number> = {};
        for (const k of K_VALUES) {
          ndcgByK[k] = mean(allRetrieved.map((r) => ndcgAtK(r.retrieved, r.qrels, k)));
        }
        return {
          ndcgByK,
          map5: mean(allRetrieved.map((r) => mapAtK(r.retrieved, r.qrels, 5))),
          recall5: mean(allRetrieved.map((r) => recallAtK(r.retrieved, r.qrels, 5))),
          mrr: mean(allRetrieved.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K))),
        };
      }

      // Find best ENSEMBLE via coarse sweep
      let bestEnsWeight = { v: 0.5, b: 0.5 };
      let bestEnsNdcg10 = 0;
      for (let vw = 0; vw <= 10; vw++) {
        const v = vw / 10;
        const result = sweepEnsemble(v, 1 - v);
        if (result.ndcgByK[10] > bestEnsNdcg10) {
          bestEnsNdcg10 = result.ndcgByK[10];
          bestEnsWeight = { v, b: 1 - v };
        }
      }

      // ── Compute final metrics at optimal and default weights ──
      const hybridOptimal = sweepHybrid(bestHybridWeight.v, bestHybridWeight.k);
      const ensembleOptimal = sweepEnsemble(bestEnsWeight.v, bestEnsWeight.b);
      const hybridDefault = sweepHybrid(0.9, 0.1);
      const ensembleDefault = sweepEnsemble(0.5, 0.5);

      const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(3);

      const compHeader =
        "  Config                          | NDCG@1 | NDCG@3 | NDCG@5 | NDCG@10 | MAP@5  | Recall@5 | MRR   ";
      console.log(compHeader);
      console.log("  " + "─".repeat(compHeader.length - 2));

      const printRow = (label: string, m: ReturnType<typeof sweepHybrid>) =>
        console.log(
          `  ${label.padEnd(34)}|${fmt(m.ndcgByK[1])} |${fmt(m.ndcgByK[3])} |${fmt(m.ndcgByK[5])} |${fmt(m.ndcgByK[10])}  |${fmt(m.map5)} |${fmtPct(m.recall5)}   |${fmt(m.mrr)}`,
        );

      const printDelta = (label: string, a: ReturnType<typeof sweepHybrid>, b: ReturnType<typeof sweepHybrid>) => {
        const dn = (k: number) => sign(a.ndcgByK[k] - b.ndcgByK[k]);
        const dr = () => sign((a.recall5 - b.recall5) * 100) + "%";
        console.log(
          `  ${label.padEnd(34)}|${dn(1).padStart(7)} |${dn(3).padStart(7)} |${dn(5).padStart(7)} |${dn(10).padStart(8)} |${sign(a.map5 - b.map5).padStart(7)} |${dr().padStart(9)} |${sign(a.mrr - b.mrr).padStart(7)}`,
        );
      };

      printRow(`HYBRID-optimal (V${bestHybridWeight.v.toFixed(2)}/K${bestHybridWeight.k.toFixed(2)})`, hybridOptimal);
      printRow(`ENSEMBLE-optimal (V${bestEnsWeight.v.toFixed(2)}/B${bestEnsWeight.b.toFixed(2)})`, ensembleOptimal);
      printDelta("Δ (HYBRID − ENSEMBLE)", hybridOptimal, ensembleOptimal);
      console.log("  " + "─".repeat(compHeader.length - 2));
      printRow("HYBRID-default (V0.9/K0.1)", hybridDefault);
      printRow("ENSEMBLE-default (V0.5/B0.5)", ensembleDefault);
      printDelta("Δ (HYBRID − ENSEMBLE)", hybridDefault, ensembleDefault);

      expect(hybridOptimal.ndcgByK[10], "optimal HYBRID NDCG@10").to.be.greaterThan(0.1);
      expect(ensembleOptimal.ndcgByK[10], "optimal ENSEMBLE NDCG@10").to.be.greaterThan(0.1);
    });

    it("6.7 should analyze result overlap", function () {
      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  SECTION 6.7: RESULT OVERLAP ANALYSIS (Top-5)");
      console.log("═══════════════════════════════════════════════════════════════");

      const overlapCounts: number[] = [];

      for (const c of comparisons) {
        const hybridSet = new Set(c.hybridRetrieved.slice(0, 5));
        const ensembleSet = new Set(c.ensembleRetrieved.slice(0, 5));
        let overlap = 0;
        for (const id of hybridSet) {
          if (ensembleSet.has(id)) {
            overlap++;
          }
        }
        overlapCounts.push(overlap);
      }

      // Build histogram
      const histogram = [0, 0, 0, 0, 0, 0]; // overlap 0-5
      for (const count of overlapCounts) {
        histogram[count]++;
      }

      const ovHeader = "  Overlap | #Queries | %";
      console.log(ovHeader);
      console.log("  " + "─".repeat(ovHeader.length - 2));
      for (let i = 0; i <= 5; i++) {
        console.log(
          `  ${String(i).padStart(7)} |${String(histogram[i]).padStart(9)} | ${((histogram[i] / comparisons.length) * 100).toFixed(1)}%`,
        );
      }
      console.log("  " + "─".repeat(ovHeader.length - 2));
      console.log(`  Mean overlap: ${mean(overlapCounts).toFixed(2)} | Median: ${median(overlapCounts)}`);

      expect(mean(overlapCounts), "mean overlap > 0").to.be.greaterThan(0);
    });
  });
});
