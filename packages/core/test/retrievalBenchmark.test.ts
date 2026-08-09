/**
 * BEIR-Style Retrieval Benchmark
 *
 * Comprehensive benchmark comparing HYBRID, VECTOR, and BM25 retrieval
 * strategies with multiple BM25 input variants. Uses graded relevance judgments (BEIR qrels)
 * across 34 queries in 7 categories to compute NDCG, MAP, Recall, Precision, and MRR.
 *
 * Uses REAL transformer embeddings (all-MiniLM-L6-v2, 384-dim) for the vector
 * retrieval arm.
 */

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
  TransformersEmbeddings,
  extractKeywords,
} from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, stddev, ndcgAtK, mapAtK, recallAtK, precisionAtK, mrrAtK } from "./helpers/metrics";
import { EVAL_CORPUS as CORPUS } from "./helpers/evalCorpus";

// ═══════════════════════════════════════════════════════════════════════
// §2  Helpers
// ═══════════════════════════════════════════════════════════════════════

function docId(doc: LangChainDocument): string {
  return doc.metadata?.id ?? doc.metadata?.chunkId ?? "unknown";
}

// ═══════════════════════════════════════════════════════════════════════
// §3  Query Set — 34 queries, 7 categories, graded relevance
// ═══════════════════════════════════════════════════════════════════════

type QueryCategory = "factoid" | "natural-language" | "paraphrase" | "multi-hop" | "ambiguous" | "short" | "long";

interface BenchmarkQuery {
  query: string;
  category: QueryCategory;
  /** BEIR-style qrels: docId → relevance grade (0, 1, or 2). Unlisted docs are grade 0. */
  qrels: Record<string, number>;
}

const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  // ── factoid (5) ──
  { query: "Python web frameworks Django Flask", category: "factoid", qrels: { "py-web": 2, "py-intro": 1 } },
  { query: "Rust memory safety ownership", category: "factoid", qrels: { "rust-intro": 2 } },
  { query: "PostgreSQL SQL database", category: "factoid", qrels: { "db-sql": 2, "db-nosql": 1 } },
  { query: "Docker containers", category: "factoid", qrels: { "docker-intro": 2, "k8s-intro": 1 } },
  { query: "React JavaScript library", category: "factoid", qrels: { "js-react": 2, "js-intro": 1 } },

  // ── natural-language (5) ──
  {
    query: "How does async programming work in Python?",
    category: "natural-language",
    qrels: { "py-async": 2, "py-intro": 1 },
  },
  {
    query: "What testing frameworks are available for JavaScript?",
    category: "natural-language",
    qrels: { "js-testing": 2, "py-testing": 1 },
  },
  {
    query: "What is the difference between REST and GraphQL APIs?",
    category: "natural-language",
    qrels: { "api-rest": 2, "api-graphql": 2 },
  },
  {
    query: "Why is Rust considered memory safe?",
    category: "natural-language",
    qrels: { "rust-intro": 2 },
  },
  {
    query: "How do vector embeddings enable semantic search?",
    category: "natural-language",
    qrels: { "ml-embeddings": 2, "db-vector": 1 },
  },

  // ── paraphrase (5) ──
  {
    query: "containerized application deployment",
    category: "paraphrase",
    qrels: { "docker-intro": 2, "k8s-intro": 2 },
  },
  {
    query: "securing web applications against attacks",
    category: "paraphrase",
    qrels: { "sec-web": 2, "sec-auth": 1 },
  },
  {
    query: "speeding up database queries",
    category: "paraphrase",
    qrels: { "perf-optimization": 2, "db-sql": 1, "perf-caching": 1 },
  },
  {
    query: "representing text as numbers for search",
    category: "paraphrase",
    qrels: { "ml-embeddings": 2, "db-vector": 1 },
  },
  {
    query: "automating software build and release",
    category: "paraphrase",
    qrels: { "cicd-intro": 2, "docker-intro": 1 },
  },

  // ── multi-hop (5) ──
  {
    query: "SQL vs NoSQL databases and when to use each",
    category: "multi-hop",
    qrels: { "db-sql": 2, "db-nosql": 2 },
  },
  {
    query: "CI/CD pipelines with Docker and Kubernetes",
    category: "multi-hop",
    qrels: { "cicd-intro": 2, "docker-intro": 2, "k8s-intro": 1 },
  },
  {
    query: "Python machine learning with neural networks",
    category: "multi-hop",
    qrels: { "py-ml": 2, "ml-deep": 2, "ml-basics": 1 },
  },
  {
    query: "JavaScript server-side and client-side frameworks",
    category: "multi-hop",
    qrels: { "js-node": 2, "js-react": 2, "js-intro": 1 },
  },
  {
    query: "async programming across Python and Rust",
    category: "multi-hop",
    qrels: { "py-async": 2, "rust-async": 2 },
  },

  // ── ambiguous (5) ──
  { query: "testing frameworks", category: "ambiguous", qrels: { "py-testing": 2, "js-testing": 2 } },
  {
    query: "web frameworks",
    category: "ambiguous",
    qrels: { "py-web": 2, "js-react": 1, "rust-web": 1, "js-node": 1 },
  },
  {
    query: "performance optimization",
    category: "ambiguous",
    qrels: { "perf-optimization": 2, "perf-caching": 2, "db-sql": 1 },
  },
  { query: "authentication security", category: "ambiguous", qrels: { "sec-auth": 2, "sec-web": 1 } },
  {
    query: "machine learning applications",
    category: "ambiguous",
    qrels: { "ml-basics": 2, "py-ml": 1, "ml-nlp": 1, "ml-deep": 1 },
  },

  // ── short (4) ──
  { query: "Docker", category: "short", qrels: { "docker-intro": 2, "k8s-intro": 1 } },
  { query: "embeddings", category: "short", qrels: { "ml-embeddings": 2, "db-vector": 1 } },
  { query: "async", category: "short", qrels: { "py-async": 2, "rust-async": 2 } },
  { query: "security", category: "short", qrels: { "sec-web": 2, "sec-auth": 2 } },

  // ── long (5) ──
  {
    query: "I need to understand how to build a web application using Python and deploy it with containers",
    category: "long",
    qrels: { "py-web": 2, "docker-intro": 2, "py-intro": 1, "k8s-intro": 1 },
  },
  {
    query: "How can I set up automated testing and continuous deployment for a JavaScript project",
    category: "long",
    qrels: { "js-testing": 2, "cicd-intro": 2, "js-node": 1 },
  },
  {
    query: "What are the best practices for securing REST APIs with OAuth and preventing SQL injection",
    category: "long",
    qrels: { "sec-auth": 2, "sec-web": 2, "api-rest": 1 },
  },
  {
    query: "Explain the relationship between vector embeddings similarity search and retrieval augmented generation",
    category: "long",
    qrels: { "ml-embeddings": 2, "db-vector": 2, "ml-nlp": 1 },
  },
  {
    query:
      "Compare the async programming models in modern systems languages like Rust with scripting languages like Python",
    category: "long",
    qrels: { "rust-async": 2, "py-async": 2, "rust-intro": 1, "py-intro": 1 },
  },
];

const ALL_CATEGORIES: QueryCategory[] = [
  "factoid",
  "natural-language",
  "paraphrase",
  "multi-hop",
  "ambiguous",
  "short",
  "long",
];

// ═══════════════════════════════════════════════════════════════════════
// §4  Strategy Configurations
// ═══════════════════════════════════════════════════════════════════════

type ConfigName = "HYBRID-default" | "HYBRID-kw-bm25" | "VECTOR-only" | "BM25-raw" | "BM25-keyword";

// ═══════════════════════════════════════════════════════════════════════
// §5  Per-Query Result Type
// ═══════════════════════════════════════════════════════════════════════

interface QueryResult {
  queryIndex: number;
  query: string;
  category: QueryCategory;
  config: ConfigName;
  retrieved: string[];
  qrels: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════
// §6  Test Suite
// ═══════════════════════════════════════════════════════════════════════

describe("BEIR-Style Retrieval Benchmark", function (this: Mocha.Suite) {
  this.timeout(120000);

  const K_VALUES = [1, 3, 5, 10];
  const MAX_K = 10;

  // Shared retriever instances
  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;

  const allResults: QueryResult[] = [];
  const ALL_CONFIGS: ConfigName[] = ["HYBRID-default", "HYBRID-kw-bm25", "VECTOR-only", "BM25-raw", "BM25-keyword"];

  // ─── runConfig — execute a single strategy on a single query ──────

  async function runConfig(config: ConfigName, query: string): Promise<string[]> {
    switch (config) {
      // ── HYBRID-default ──
      case "HYBRID-default": {
        const results = await hybridRetriever.search(query, { k: MAX_K, ...DEFAULT_HYBRID_OPTIONS });
        return results.map((r) => docId(r.document));
      }

      // ── HYBRID-kw-bm25: manual replication with fixed HYBRID logic ──
      case "HYBRID-kw-bm25": {
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

      // ── VECTOR-only ──
      case "VECTOR-only": {
        const results = await vectorRetriever.search(query, MAX_K);
        return results.map((r) => docId(r.document));
      }

      // ── BM25-raw ──
      case "BM25-raw": {
        const results = await keywordRetriever.search(query, MAX_K);
        return results.map((r) => docId(r.document));
      }

      // ── BM25-keyword ──
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
    this.timeout(120000);

    // Initialize real embedding pipeline (all-MiniLM-L6-v2, 384-dim)
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier);
    embeddingService.registerBackend(hfBackend);
    const embeddings = new TransformersEmbeddings({ embeddingService });

    const docs = CORPUS.map(
      (d) =>
        new LangChainDocument({
          pageContent: d.content,
          metadata: { ...d.metadata, id: d.id },
        }),
    );

    // Create vector store with real 384-dim embeddings
    const vectorStore = await RealVectorStore.fromDocuments(docs, embeddings);

    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(docs);
    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 1: Per-Query Evaluation
  // ═══════════════════════════════════════════════════════════════════

  before(async function (this: Mocha.Context) {
    this.timeout(120000);

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 1: PER-QUERY RESULTS  (NDCG@5)");
    console.log("═══════════════════════════════════════════════════════════════");

    for (let qi = 0; qi < BENCHMARK_QUERIES.length; qi++) {
      const bq = BENCHMARK_QUERIES[qi];
      const qrelsMap = new Map(Object.entries(bq.qrels));

      const perQueryScores: Record<ConfigName, number> = {} as Record<ConfigName, number>;

      for (const config of ALL_CONFIGS) {
        const retrieved = await runConfig(config, bq.query);
        allResults.push({
          queryIndex: qi,
          query: bq.query,
          category: bq.category,
          config,
          retrieved,
          qrels: qrelsMap,
        });

        perQueryScores[config] = ndcgAtK(retrieved, qrelsMap, 5);
      }

      // Print per-query row
      const shortQuery = bq.query.length > 50 ? bq.query.substring(0, 47) + "..." : bq.query;
      const cols = ALL_CONFIGS.map((c) => fmt(perQueryScores[c])).join(" | ");
      console.log(`  Q${String(qi + 1).padStart(2)}) [${bq.category.padEnd(16)}] ${shortQuery.padEnd(52)} ${cols}`);
    }

    console.log(`\n  Total query-config pairs: ${allResults.length}`);
  });

  it("should retrieve relevant docs for all queries", function () {
    for (let qi = 0; qi < BENCHMARK_QUERIES.length; qi++) {
      const _bq = BENCHMARK_QUERIES[qi];
      const anyGood = ALL_CONFIGS.some((c) => {
        const result = allResults.find((r) => r.queryIndex === qi && r.config === c);
        return result && ndcgAtK(result.retrieved, result.qrels, 5) > 0;
      });
      expect(anyGood, `Q${qi + 1}: no config found any relevant doc`).to.be.true;
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 2: Aggregate Metrics
  // ═══════════════════════════════════════════════════════════════════

  it("should compute aggregate metrics across all queries", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 2: AGGREGATE METRICS (mean across 34 queries)");
    console.log("═══════════════════════════════════════════════════════════════");

    // Header
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

    // Assertions: HYBRID configs should have reasonable NDCG@5
    for (const config of ["HYBRID-default", "HYBRID-kw-bm25"] as ConfigName[]) {
      const configResults = allResults.filter((r) => r.config === config);
      const ndcg5 = mean(configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, 5)));
      expect(ndcg5, `${config} mean NDCG@5`).to.be.greaterThan(0.2);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 3: Per-Category Breakdown
  // ═══════════════════════════════════════════════════════════════════

  it("should show per-category performance", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 3: PER-CATEGORY BREAKDOWN (NDCG@5, MAP@5, Recall@5)");
    console.log("═══════════════════════════════════════════════════════════════");

    for (const category of ALL_CATEGORIES) {
      const catResults = allResults.filter((r) => r.category === category);
      if (catResults.length === 0) {
        continue;
      }

      const numQueries = catResults.length / ALL_CONFIGS.length;
      console.log(`\n  ── ${category.toUpperCase()} (${numQueries} queries) ──`);

      const catHeader = `  Config               | NDCG@5 | MAP@5  | Recall@5`;
      console.log(catHeader);
      console.log("  " + "─".repeat(catHeader.length - 2));

      let bestConfig: ConfigName = ALL_CONFIGS[0];
      let bestNdcg = -1;

      for (const config of ALL_CONFIGS) {
        const configCat = catResults.filter((r) => r.config === config);
        const ndcg5 = mean(configCat.map((r) => ndcgAtK(r.retrieved, r.qrels, 5)));
        const map5 = mean(configCat.map((r) => mapAtK(r.retrieved, r.qrels, 5)));
        const recall5 = mean(configCat.map((r) => recallAtK(r.retrieved, r.qrels, 5)));

        console.log(`  ${config.padEnd(22)}|${fmt(ndcg5)} |${fmt(map5)} |${fmtPct(recall5)}`);

        if (ndcg5 > bestNdcg) {
          bestNdcg = ndcg5;
          bestConfig = config;
        }
      }

      console.log(`  → Winner: ${bestConfig} (NDCG@5 = ${bestNdcg.toFixed(3)})`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 4: BM25 Input Ablation
  // ═══════════════════════════════════════════════════════════════════

  it("should compare BM25 input variants (ablation study)", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 4: BM25 INPUT ABLATION");
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

    // Per-category delta at k=5
    console.log("\n  Per-category ΔNDCG@5 (HYBRID kw-bm25 − default):");
    for (const category of ALL_CATEGORIES) {
      const kw = allResults.filter((r) => r.config === "HYBRID-kw-bm25" && r.category === category);
      const def = allResults.filter((r) => r.config === "HYBRID-default" && r.category === category);
      if (kw.length === 0) {
        continue;
      }
      const delta =
        mean(kw.map((r) => ndcgAtK(r.retrieved, r.qrels, 5))) - mean(def.map((r) => ndcgAtK(r.retrieved, r.qrels, 5)));
      const sign = delta >= 0 ? "+" : "";
      console.log(`    ${category.padEnd(18)} ${sign}${delta.toFixed(4)}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Section 5: Statistical Summary
  // ═══════════════════════════════════════════════════════════════════

  it("should show statistical summary (mean ± stddev)", function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SECTION 5: STATISTICAL SUMMARY (mean ± stddev)");
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
});
