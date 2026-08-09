/**
 * FRAMES Retrieval Benchmark
 *
 * Uses the Google FRAMES dataset (824 multi-hop QA questions with ground-truth
 * Wikipedia articles) to evaluate retrieval strategies on multi-hop reasoning.
 *
 * For each sampled question the referenced Wikipedia article summaries are
 * fetched, indexed, and then retrieved using 4 strategy configurations.
 * Metrics: NDCG, Recall, MRR — computed per-query and aggregated, including
 * breakdowns by reasoning type (Numerical, Tabular, Temporal, etc.).
 *
 * Gated behind FRAMES_BENCHMARK=1 environment variable.
 * Uses FRAMES_SAMPLE_SIZE for deterministic question sampling (default: 50, use 0 for full split).
 *
 * Examples:
 *   FRAMES_BENCHMARK=1 npm test --workspace=packages/core
 *   FRAMES_BENCHMARK=1 FRAMES_SAMPLE_SIZE=100 npm test --workspace=packages/core
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
  TransformersEmbeddings,
  extractKeywords,
} from "../src/index";
import { RealVectorStore, mockConfig, mockNotifier } from "./helpers/realVectorStore";
import { mean, median, ndcgAtK, recallAtK, mrrAtK } from "./helpers/metrics";
import { FramesEntry } from "./helpers/framesLoader";
import { parseBenchmarkSampleSize } from "./helpers/benchmarkSampling";
import { prepareFramesBenchmarkCorpus } from "./helpers/framesBenchmarkCorpus";

// ═══════════════════════════════════════════════════════════════════════
// §1  Constants
// ═══════════════════════════════════════════════════════════════════════

const SAMPLE_SIZE = parseBenchmarkSampleSize(process.env.FRAMES_SAMPLE_SIZE);
const MODEL = process.env.BEIR_MODEL || "Xenova/all-MiniLM-L6-v2";
const MODEL_SHORT = MODEL.replace(/^Xenova\//, "");
const CACHE_DIR = path.resolve(__dirname, "../../../../.cache/frames");
const ARTICLE_CACHE_DIR = path.join(CACHE_DIR, "articles");
const _K_VALUES = [1, 3, 5, 10];
const MAX_K = 10;

type ConfigName = "HYBRID-default" | "VECTOR-only" | "BM25-keyword";

const ALL_CONFIGS: ConfigName[] = ["HYBRID-default", "VECTOR-only", "BM25-keyword"];

// ═══════════════════════════════════════════════════════════════════════
// §2  Per-Query Result Type
// ═══════════════════════════════════════════════════════════════════════

interface QueryResult {
  entryId: number;
  query: string;
  config: ConfigName;
  retrieved: string[];
  qrels: Map<string, number>;
  reasoningTypes: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// §3  Test Suite
// ═══════════════════════════════════════════════════════════════════════

describe("FRAMES Multi-Hop Retrieval Benchmark", function (this: Mocha.Suite) {
  this.timeout(1800000); // 30 minutes for full suite

  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;

  let sampledEntries: FramesEntry[] = [];
  let entryQrels: Map<number, Map<string, number>> = new Map();
  const allResults: QueryResult[] = [];

  // ─── docId — extract document id from metadata ────────────────────

  function _docId(doc: LangChainDocument): string {
    return doc.metadata?.id ?? doc.metadata?.source ?? "unknown";
  }

  // ─── runConfig — execute a single strategy on a single query ──────

  async function runConfig(config: ConfigName, query: string): Promise<string[]> {
    switch (config) {
      case "HYBRID-default": {
        const results = await hybridRetriever.search(query, { k: MAX_K, ...DEFAULT_HYBRID_OPTIONS });
        return results.map((r) => r.document.metadata?.id ?? "unknown");
      }
      case "VECTOR-only": {
        const results = await vectorRetriever.search(query, MAX_K);
        return results.map((r) => r.document.metadata?.id ?? "unknown");
      }
      case "BM25-keyword": {
        const keywords = extractKeywords(query);
        const bm25Query = keywords.join(" ") || query;
        const results = await keywordRetriever.search(bm25Query, MAX_K);
        return results.map((r) => r.document.metadata?.id ?? "unknown");
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
    if (!process.env.FRAMES_BENCHMARK) {
      console.log(`[skip] FRAMES Multi-Hop Retrieval Benchmark disabled. Set FRAMES_BENCHMARK=1 to run this suite.`);
      this.skip();
      return;
    }

    this.timeout(1800000);

    const prepared = await prepareFramesBenchmarkCorpus({
      cacheDir: CACHE_DIR,
      articleCacheDir: ARTICLE_CACHE_DIR,
      sampleSize: SAMPLE_SIZE,
      sampleEnvVarName: "FRAMES_SAMPLE_SIZE",
    });
    sampledEntries = prepared.sampledEntries;
    entryQrels = prepared.entryQrels;
    const docs = prepared.docs;

    // 7. Initialize embedding pipeline
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier, MODEL);
    embeddingService.registerBackend(hfBackend);
    const embeddings = new TransformersEmbeddings({ embeddingService });

    // 8. Create vector store and retrievers
    const vectorStore = await RealVectorStore.fromDocuments(docs, embeddings);
    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(docs);
    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);

    console.log(`FRAMES: ${docs.length} docs indexed, ${sampledEntries.length} queries ready`);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Per-Config Tests
  // ═══════════════════════════════════════════════════════════════════

  for (const config of ALL_CONFIGS) {
    it(`should evaluate ${config}`, async function (this: Mocha.Context) {
      this.timeout(600000);

      console.log(`\n  ── ${config} ──`);

      const configResults: QueryResult[] = [];

      for (let qi = 0; qi < sampledEntries.length; qi++) {
        const entry = sampledEntries[qi];
        const qrels = entryQrels.get(entry.id) ?? new Map<string, number>();
        const retrieved = await runConfig(config, entry.prompt);

        const result: QueryResult = {
          entryId: entry.id,
          query: entry.prompt,
          config,
          retrieved,
          qrels,
          reasoningTypes: entry.reasoningTypes,
        };

        allResults.push(result);
        configResults.push(result);

        if (qi % 10 === 0) {
          const shortQuery = entry.prompt.length > 50 ? entry.prompt.substring(0, 47) + "..." : entry.prompt;
          const r5 = recallAtK(retrieved, qrels, 5);
          console.log(`    Q${String(qi + 1).padStart(3)}) ${shortQuery.padEnd(52)} Recall@5=${fmtPct(r5)}`);
        }
      }

      // ── Aggregate metrics ──
      const ndcg5Arr = configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, 5));
      const recall5Arr = configResults.map((r) => recallAtK(r.retrieved, r.qrels, 5));
      const mrr10Arr = configResults.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K));

      console.log(
        `\n    Aggregate: NDCG@5=${fmt(mean(ndcg5Arr))} | Recall@5=${fmtPct(mean(recall5Arr))} | MRR@10=${fmt(mean(mrr10Arr))}`,
      );
      console.log(
        `    Median:    NDCG@5=${fmt(median(ndcg5Arr))} | Recall@5=${fmtPct(median(recall5Arr))} | MRR@10=${fmt(median(mrr10Arr))}`,
      );

      // ── Per-reasoning-type breakdown ──
      const typeMap = new Map<string, QueryResult[]>();
      for (const r of configResults) {
        for (const rtype of r.reasoningTypes) {
          if (!typeMap.has(rtype)) {
            typeMap.set(rtype, []);
          }
          typeMap.get(rtype)!.push(r);
        }
      }

      if (typeMap.size > 0) {
        console.log(`\n    Per reasoning type:`);
        const typeHeader = `      Type                    | N   | NDCG@5 | Recall@5 | MRR@10`;
        console.log(typeHeader);
        console.log("      " + "─".repeat(typeHeader.length - 6));

        for (const [rtype, results] of Array.from(typeMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
          const tNdcg5 = mean(results.map((r) => ndcgAtK(r.retrieved, r.qrels, 5)));
          const tRecall5 = mean(results.map((r) => recallAtK(r.retrieved, r.qrels, 5)));
          const tMrr10 = mean(results.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K)));
          console.log(
            `      ${rtype.padEnd(26)}| ${String(results.length).padStart(3)} |${fmt(tNdcg5)} |${fmtPct(tRecall5)}   |${fmt(tMrr10)}`,
          );
        }
      }

      // Sanity assertion — FRAMES retrieval over summaries is hard
      expect(mean(recall5Arr), `${config} mean Recall@5`).to.be.greaterThan(0);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════

  after(function () {
    if (allResults.length === 0) {
      return;
    }

    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  FRAMES SUMMARY | ${sampledEntries.length} queries | Model: ${MODEL_SHORT}`);
    console.log("═══════════════════════════════════════════════════════════════");

    const header = "  Config               | NDCG@5 | Recall@5 | MRR@10 | Best Q  | Worst Q ";
    console.log(header);
    console.log("  " + "─".repeat(header.length - 2));

    for (const config of ALL_CONFIGS) {
      const configResults = allResults.filter((r) => r.config === config);
      if (configResults.length === 0) {
        continue;
      }

      const ndcg5Arr = configResults.map((r) => ndcgAtK(r.retrieved, r.qrels, 5));
      const recall5Arr = configResults.map((r) => recallAtK(r.retrieved, r.qrels, 5));
      const mrr10Arr = configResults.map((r) => mrrAtK(r.retrieved, r.qrels, MAX_K));

      // Find best/worst queries by NDCG@5
      let bestIdx = 0;
      let worstIdx = 0;
      for (let i = 1; i < ndcg5Arr.length; i++) {
        if (ndcg5Arr[i] > ndcg5Arr[bestIdx]) {
          bestIdx = i;
        }
        if (ndcg5Arr[i] < ndcg5Arr[worstIdx]) {
          worstIdx = i;
        }
      }

      console.log(
        `  ${config.padEnd(22)}|${fmt(mean(ndcg5Arr))} |${fmtPct(mean(recall5Arr))}   |${fmt(mean(mrr10Arr))} | Q${String(bestIdx + 1).padStart(3)}   | Q${String(worstIdx + 1).padStart(3)}`,
      );
    }

    // ── Cross-config per-reasoning-type summary ──
    const allTypes = new Set<string>();
    for (const r of allResults) {
      for (const t of r.reasoningTypes) {
        allTypes.add(t);
      }
    }

    if (allTypes.size > 0) {
      console.log("\n  ── Recall@5 by Reasoning Type ──");
      const typeHeader = "  Type                    | " + ALL_CONFIGS.map((c) => c.padEnd(10)).join(" | ");
      console.log(typeHeader);
      console.log("  " + "─".repeat(typeHeader.length - 2));

      for (const rtype of Array.from(allTypes).sort()) {
        const cols = ALL_CONFIGS.map((config) => {
          const results = allResults.filter((r) => r.config === config && r.reasoningTypes.includes(rtype));
          if (results.length === 0) {
            return "   N/A   ";
          }
          return fmtPct(mean(results.map((r) => recallAtK(r.retrieved, r.qrels, 5)))).padEnd(10);
        }).join(" | ");
        console.log(`  ${rtype.padEnd(26)}| ${cols}`);
      }
    }

    console.log("\n");
  });
});
