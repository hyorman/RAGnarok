import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "benchmarks/corpus-manifest.json");
const baselinePath = path.join(root, "benchmarks/release-baseline.json");
const manifestContents = await readFile(manifestPath);
const manifest = JSON.parse(manifestContents);
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");
const releaseArtifactDir = path.resolve(root, process.env.RAGNAROK_RELEASE_ARTIFACT_DIR ?? ".");

if (baseline.corpusManifestSha256 !== sha256(manifestContents)) {
  throw new Error("Benchmark baseline is not bound to the current corpus manifest");
}
for (const strategy of ["vector", "hybrid", "ensemble", "bm25", "graph", "graph_hybrid", "rerank"]) {
  if (!manifest.config.strategies.includes(strategy) || !baseline.minimums[strategy]) {
    throw new Error(`Release benchmark contract is missing strategy ${strategy}`);
  }
}

const corpusChecks = [
  ["packages/core/test/helpers/evalCorpus.ts", manifest.corpora[0].sha256],
  [".cache/beir/scifact/corpus.jsonl", manifest.corpora[1].files["corpus.jsonl"]],
  [".cache/beir/scifact/queries.jsonl", manifest.corpora[1].files["queries.jsonl"]],
  [".cache/beir/scifact/qrels/test.tsv", manifest.corpora[1].files["qrels/test.tsv"]],
  [".cache/frames/frames-test.tsv", manifest.corpora[2].sha256],
  [
    "packages/core/test/helpers/releaseGraphFixture.ts",
    manifest.corpora.find((corpus) => corpus.id === "ragnarok-graph-release-v1")?.sha256,
  ],
];
for (const [relative, expected] of corpusChecks) {
  if (typeof expected !== "string") {
    throw new Error(`Pinned release corpus has no manifest digest: ${relative}`);
  }
  let contents;
  try {
    contents = await readFile(path.join(root, relative));
  } catch {
    throw new Error(
      `Pinned release corpus is missing: ${relative}. See docs/BENCHMARKS.md for acquisition and checksum verification.`,
    );
  }
  if (sha256(contents) !== expected) throw new Error(`Pinned release corpus checksum mismatch: ${relative}`);
}

const framesLines = (await readFile(path.join(root, ".cache/frames/frames-test.tsv"), "utf8"))
  .split(/\r?\n/)
  .slice(1)
  .filter((line) => line.trim());
const eligibleFrameLinks = [];
for (const line of framesLines) {
  const columns = line.split("\t");
  try {
    const links = JSON.parse((columns[15] ?? "").replace(/'/g, '"')).filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    if (links.length > 0) eligibleFrameLinks.push(links);
  } catch {
    // The benchmark loader treats malformed link fields as ineligible too.
  }
}
const frameStep = Math.max(1, Math.floor(eligibleFrameLinks.length / manifest.config.framesSampleSize));
const sampledFrameLinks = [];
for (
  let index = 0;
  index < eligibleFrameLinks.length && sampledFrameLinks.length < manifest.config.framesSampleSize;
  index += frameStep
) {
  sampledFrameLinks.push(eligibleFrameLinks[index]);
}
const frameUrls = [...new Set(sampledFrameLinks.flat())];
const articleDigests = [];
for (const rawUrl of frameUrls) {
  let normalized = rawUrl.trim();
  if (!normalized.startsWith("http")) normalized = `https://${normalized}`;
  normalized = normalized.replace("//en.m.wikipedia.org/", "//en.wikipedia.org/");
  const titleMatch = normalized.match(/\/wiki\/(.+)$/);
  if (!titleMatch) continue;
  const title = decodeURIComponent(titleMatch[1]);
  const filename = `${title.replace(/[/\\?%*:|"<>]/g, "_")}.json`;
  const relative = `articles/${filename}`;
  let contents;
  try {
    contents = await readFile(path.join(root, ".cache/frames", relative));
  } catch {
    throw new Error(`Pinned release article is missing: .cache/frames/${relative}`);
  }
  articleDigests.push([relative, sha256(contents)]);
}
articleDigests.sort(([left], [right]) => left.localeCompare(right));
const articleSetSha256 = sha256(`${articleDigests.map((row) => row.join("\0")).join("\n")}\n`);
const framesManifest = manifest.corpora.find((corpus) => corpus.id === "google-frames-test");
if (
  articleDigests.length !== framesManifest.sampleArticleCount ||
  articleSetSha256 !== framesManifest.sampleArticlesSha256
) {
  throw new Error("Pinned FRAMES release article set is incomplete or has a checksum mismatch");
}

execFileSync("npm", ["run", "compile:tests", "--workspace=@ragnarok/core"], { cwd: root, stdio: "inherit" });
const benchmarkWorkloads = [
  {
    id: "retrieval-fixture",
    files: ["dist-test/test/retrievalBenchmark.test.js", "dist-test/test/vectorRetriever.test.js"],
  },
  {
    id: "graph",
    files: [
      "dist-test/test/graphRetriever.test.js",
      "dist-test/test/graphHybridRetriever.test.js",
      "dist-test/test/releaseGraphBenchmark.test.js",
    ],
  },
  { id: "beir", files: ["dist-test/test/beirBenchmark.test.js"] },
  { id: "beir-rerank", files: ["dist-test/test/rerankBenchmark.test.js"] },
  { id: "frames", files: ["dist-test/test/framesBenchmark.test.js"] },
  { id: "frames-rerank", files: ["dist-test/test/framesRerankBenchmark.test.js"] },
  { id: "index-construction", files: ["dist-test/test/releasePerformanceBenchmark.test.js"] },
];
const started = performance.now();
const beforeRss = process.memoryUsage().rss;
const measuredQuality = {};
const childPeakMeasurements = [];
for (const workload of benchmarkWorkloads) {
  const result = spawnSync(
    path.join(root, "node_modules/.bin/mocha"),
    [
      "--no-config",
      "--require",
      "dist-test/test/setup.js",
      "--require",
      "dist-test/test/releaseChildMetricsHook.js",
      "--reporter",
      "spec",
      "--timeout",
      "0",
      ...workload.files,
    ],
    {
      cwd: path.join(root, "packages/core"),
      encoding: "utf8",
      env: {
        ...process.env,
        RAGNAROK_BENCHMARK_MODE: "release",
        RAGNAROK_BENCHMARK_CHILD_ID: workload.id,
        BEIR_BENCHMARK: "1",
        BEIR_RERANK_BENCHMARK: "1",
        FRAMES_BENCHMARK: "1",
        FRAMES_RERANK_BENCHMARK: "1",
        BEIR_SAMPLE_SIZE: String(manifest.config.beirSampleSize),
        BEIR_RERANK_SAMPLE_SIZE: String(manifest.config.rerankSampleSize),
        FRAMES_SAMPLE_SIZE: String(manifest.config.framesSampleSize),
        FRAMES_RERANK_SAMPLE_SIZE: String(manifest.config.rerankSampleSize),
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`Release benchmark workload ${workload.id} exited ${result.status ?? result.signal}`);
  }
  if (/\b(?:pending|skipped)\b|\[skip\]/i.test(result.stdout ?? "")) {
    throw new Error(`Release benchmark workload ${workload.id} emitted a skip/pending marker`);
  }
  for (const match of (result.stdout ?? "").matchAll(/^RAGNAROK_METRICS ([\w-]+) (.+)$/gm)) {
    if (measuredQuality[match[1]]) {
      throw new Error(`Release benchmark emitted duplicate machine metrics for ${match[1]}`);
    }
    measuredQuality[match[1]] = JSON.parse(match[2]);
  }
  const rssMatches = [...(result.stdout ?? "").matchAll(/^RAGNAROK_CHILD_METRICS ([\w-]+) (.+)$/gm)];
  if (rssMatches.length !== 1 || rssMatches[0][1] !== workload.id) {
    throw new Error(`Release benchmark workload ${workload.id} did not emit exactly one matching peak-RSS record`);
  }
  const measurement = JSON.parse(rssMatches[0][2]);
  const validMeasurement =
    Number.isFinite(measurement.peakRssBytes) &&
    Number.isFinite(measurement.raw) &&
    measurement.raw > 0 &&
    measurement.rawUnit === "KiB" &&
    measurement.source === "process.resourceUsage().maxRSS" &&
    measurement.platform === `${process.platform}-${process.arch}` &&
    measurement.peakRssBytes === measurement.raw * 1024;
  if (!validMeasurement) {
    throw new Error(`Release benchmark workload ${workload.id} emitted invalid peak-RSS provenance`);
  }
  childPeakMeasurements.push({ workload: workload.id, ...measurement });
}
const peakChildMeasurement = childPeakMeasurements.reduce((peak, measurement) =>
  measurement.peakRssBytes > peak.peakRssBytes ? measurement : peak,
);
measuredQuality.performance = {
  ...(measuredQuality.performance ?? {}),
  childPeakRssBytes: peakChildMeasurement.peakRssBytes,
  childPeakRssRaw: peakChildMeasurement.raw,
  childPeakRssRawUnit: peakChildMeasurement.rawUnit,
  childPeakRssSource: peakChildMeasurement.source,
  childPeakRssPlatform: peakChildMeasurement.platform,
  childPeakRssWorkload: peakChildMeasurement.workload,
};
for (const required of ["beir", "beir-rerank", "frames-rerank"]) {
  if (!measuredQuality[required]) throw new Error(`Release benchmark omitted machine metrics for ${required}`);
}
for (const strategy of ["vector", "hybrid", "ensemble", "bm25"]) {
  for (const [metric, minimum] of Object.entries(baseline.minimums[strategy])) {
    const actual = measuredQuality.beir[strategy]?.[metric];
    if (!Number.isFinite(actual) || actual < minimum) {
      throw new Error(`${strategy}.${metric} ${actual} is below release minimum ${minimum}`);
    }
  }
}
for (const [metric, minimum] of Object.entries(baseline.minimums.rerank)) {
  const actual = measuredQuality["beir-rerank"][metric];
  if (!Number.isFinite(actual) || actual < minimum) {
    throw new Error(`rerank.${metric} ${actual} is below release minimum ${minimum}`);
  }
}
for (const suite of ["beir-rerank", "frames-rerank"]) {
  for (const metric of ["queryP50Ms", "queryP95Ms"]) {
    const actual = measuredQuality[suite][metric];
    const maximum = baseline.maximums[metric];
    if (!Number.isFinite(actual) || actual > maximum) {
      throw new Error(`${suite}.${metric} ${actual} exceeds release maximum ${maximum}`);
    }
  }
}

const blockers = [];
for (const strategy of ["graph", "graph_hybrid"]) {
  const metrics = measuredQuality[strategy];
  if (!metrics) {
    blockers.push({
      code: "missing_graph_aggregate",
      measure: strategy,
      message: `No aggregate machine metrics were emitted for ${strategy}`,
    });
    continue;
  }
  for (const [metric, minimum] of Object.entries(baseline.minimums[strategy])) {
    const actual = metrics[metric];
    if (!Number.isFinite(actual)) {
      blockers.push({
        code: "missing_graph_metric",
        measure: `${strategy}.${metric}`,
        message: `No finite value was emitted for ${strategy}.${metric}`,
      });
    } else if (actual < minimum) {
      throw new Error(`${strategy}.${metric} ${actual} is below release minimum ${minimum}`);
    }
  }
}

const emittedPerformance = measuredQuality.performance ?? {};
const childPeakRssBytes = emittedPerformance.childPeakRssBytes;
const indexTimeMs = emittedPerformance.indexTimeMs;
const childPeakRssValid =
  Number.isFinite(childPeakRssBytes) &&
  Number.isFinite(emittedPerformance.childPeakRssRaw) &&
  emittedPerformance.childPeakRssRaw > 0 &&
  emittedPerformance.childPeakRssRawUnit === "KiB" &&
  emittedPerformance.childPeakRssSource === "process.resourceUsage().maxRSS" &&
  emittedPerformance.childPeakRssPlatform === `${process.platform}-${process.arch}` &&
  benchmarkWorkloads.some((workload) => workload.id === emittedPerformance.childPeakRssWorkload) &&
  childPeakMeasurements.length === benchmarkWorkloads.length &&
  childPeakRssBytes === emittedPerformance.childPeakRssRaw * 1024;
if (!childPeakRssValid) {
  blockers.push({
    code: "missing_child_peak_rss",
    measure: "performance.childPeakRssBytes",
    message: "The benchmark child did not emit a finite, unit-normalized process.resourceUsage().maxRSS measurement",
  });
} else if (childPeakRssBytes > baseline.maximums.childPeakRssBytes) {
  throw new Error(
    `childPeakRssBytes ${childPeakRssBytes} exceeds release maximum ${baseline.maximums.childPeakRssBytes}`,
  );
}
const indexTimeValid =
  Number.isFinite(indexTimeMs) &&
  indexTimeMs > 0 &&
  emittedPerformance.indexTimeScope ===
    "model-ready database initialization, corpus embedding, and durable vector-index construction" &&
  emittedPerformance.indexModelInitializationIncluded === false &&
  emittedPerformance.indexMeasurementClock === "performance.now" &&
  Number.isInteger(emittedPerformance.indexDocumentCount) &&
  emittedPerformance.indexDocumentCount > 0;
if (!indexTimeValid) {
  blockers.push({
    code: "missing_index_time",
    measure: "performance.indexTimeMs",
    message: "The benchmark did not emit a finite isolated index-construction measurement with scope evidence",
  });
} else if (indexTimeMs > baseline.maximums.indexTimeMs) {
  throw new Error(`indexTimeMs ${indexTimeMs} exceeds release maximum ${baseline.maximums.indexTimeMs}`);
}

const packageSizes = {};
const packageArtifacts = [];
let releaseArtifactNames;
try {
  releaseArtifactNames = await readdir(releaseArtifactDir);
} catch {
  throw new Error(`Release artifact directory is missing or unreadable: ${releaseArtifactDir}`);
}
const tarballNames = releaseArtifactNames.filter((item) => item.endsWith(".tgz"));
if (tarballNames.length !== 2) {
  blockers.push({
    code: "missing_exact_package_measurement",
    measure: "packageArtifacts",
    message: `Expected exactly two release tarballs, found ${tarballNames.length}`,
  });
}
for (const [name, pattern] of [
  ["coreTarballBytes", /^ragnarok-core-.*\.tgz$/],
  ["mcpTarballBytes", /^ragnarok-mcp-server-.*\.tgz$/],
]) {
  const files = tarballNames.filter((item) => pattern.test(item));
  if (files.length !== 1) {
    packageSizes[name] = null;
    blockers.push({
      code: "missing_exact_package_measurement",
      measure: `packageSizes.${name}`,
      message: `Expected exactly one matching package artifact, found ${files.length}`,
    });
    continue;
  }
  const artifactPath = path.join(releaseArtifactDir, files[0]);
  const contents = await readFile(artifactPath);
  packageSizes[name] = (await stat(artifactPath)).size;
  packageArtifacts.push({
    filename: files[0],
    sha256: sha256(contents),
    size: packageSizes[name],
    measurement: name,
  });
  if (packageSizes[name] > baseline.maximums[name]) {
    throw new Error(`${name} ${packageSizes[name]} exceeds release maximum ${baseline.maximums[name]}`);
  }
}
const graphMeasured = ["graph", "graph_hybrid"].every((strategy) =>
  Object.keys(baseline.minimums[strategy]).every((metric) => Number.isFinite(measuredQuality[strategy]?.[metric])),
);
const output = {
  schemaVersion: 1,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  corpusManifestSha256: sha256(manifestContents),
  rankingContract: manifest.rankingContract,
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  strategies: manifest.config.strategies,
  qualityContract: baseline.minimums,
  measuredQuality,
  graphContractEvidence: {
    measured: graphMeasured,
    reason: graphMeasured
      ? undefined
      : "Named deterministic graph tests are not a substitute for the declared aggregate graph release metrics.",
  },
  performance: {
    suiteTimeMs: Math.round(performance.now() - started),
    harnessRssDeltaBytes: Math.max(0, process.memoryUsage().rss - beforeRss),
    measuredQueryLatency: {
      beirRerank: {
        p50Ms: measuredQuality["beir-rerank"].queryP50Ms,
        p95Ms: measuredQuality["beir-rerank"].queryP95Ms,
      },
      framesRerank: {
        p50Ms: measuredQuality["frames-rerank"].queryP50Ms,
        p95Ms: measuredQuality["frames-rerank"].queryP95Ms,
      },
    },
    childPeakRssMeasured: childPeakRssValid,
    childPeakRssBytes: childPeakRssValid ? childPeakRssBytes : null,
    childPeakRssEvidence: childPeakRssValid
      ? {
          raw: emittedPerformance.childPeakRssRaw,
          rawUnit: emittedPerformance.childPeakRssRawUnit,
          source: emittedPerformance.childPeakRssSource,
          platform: emittedPerformance.childPeakRssPlatform,
          peakWorkload: emittedPerformance.childPeakRssWorkload,
          conversionToBytes: "raw KiB × 1024",
          aggregation: "maximum full-lifetime peak across every required isolated workload child",
          workloadMeasurements: childPeakMeasurements,
        }
      : null,
    indexTimeMeasured: indexTimeValid,
    indexTimeMs: indexTimeValid ? indexTimeMs : null,
    indexTimeEvidence: indexTimeValid
      ? {
          scope: emittedPerformance.indexTimeScope,
          modelInitializationIncluded: emittedPerformance.indexModelInitializationIncluded,
          clock: emittedPerformance.indexMeasurementClock,
          documentCount: emittedPerformance.indexDocumentCount,
        }
      : null,
    requiredMetrics: [
      "Recall@5",
      "MRR@10",
      "nDCG@5",
      "entityRecall@5",
      "chunkRecall@5",
      "fallbackAccuracy",
      "explanationCoverage",
    ],
    limits: baseline.maximums,
  },
  packageSizes,
  packageArtifacts,
  blockers,
  status: blockers.length === 0 ? "passed" : "blocked",
};
const outputPath = path.resolve(root, process.env.RAGNAROK_BENCHMARK_RESULTS ?? "benchmark-results/release.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Release benchmark evidence written to ${outputPath}`);
if (blockers.length > 0) {
  console.error(`Release benchmark blocked by ${blockers.length} missing required measurement(s)`);
  process.exitCode = 1;
}
