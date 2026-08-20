# Benchmark and regression gates

Benchmarks have two purposes: fast change detection during development and
reproducible release evidence. A release run may not silently skip missing
corpora, models, strategies, or native dependencies.

## Commands

```sh
# Deterministic repository fixture; suitable for a developer loop
npm run bench:smoke

# Acquire/verify the exact cached release inputs; network is used only for
# missing files and every resulting file/set must match the manifest
npm run bench:acquire

# Pinned local fixture + cached SciFact + cached FRAMES, all strategies.
# The artifact directory must contain exactly the core and MCP candidate tgz
# files produced by the artifact-build job.
RAGNAROK_RELEASE_ARTIFACT_DIR=/tmp/ragnarok-release-candidate npm run bench:release
```

`bench:smoke` compiles the core tests and exercises vector, hybrid, BM25, and
cross-encoder behavior on repository fixtures. It does not produce release
evidence.

`bench:release` verifies `packages/core/benchmarks/data/corpus-manifest.json` and its binding to
`packages/core/benchmarks/data/release-baseline.json`, compiles tests, enables every external
benchmark suite explicitly, rejects Mocha pending/skip output, and writes
`benchmark-results/release.json`. Before running it, CI downloads the immutable
release candidate, verifies `artifact-sha256.txt`, and points
`RAGNAROK_RELEASE_ARTIFACT_DIR` at that download. The result records each
tarball's filename, size, and SHA-256; manifest creation and verification
require those measurements to match the exact npm artifacts. CI uploads the
result as the `benchmark-results` artifact even when the gate is blocked.

The full, unsampled research runs remain manual because they can take hours:
set the relevant sample size to `0` when invoking the BEIR or FRAMES test
directly. Those exploratory results do not replace the release gate.

## Pinned inputs

The manifest records seed `1729`, ranking contract, exact embedding model
revision and digest, corpus revisions, licenses, file SHA-256 values, sample
sizes, and required strategies. The release harness expects:

```text
.cache/beir/scifact/corpus.jsonl
.cache/beir/scifact/queries.jsonl
.cache/beir/scifact/qrels/test.tsv
.cache/frames/frames-test.tsv
```

`npm run bench:acquire` obtains missing SciFact, FRAMES, and deterministic
sample-article inputs from the URLs implied by
`packages/core/benchmarks/data/corpus-manifest.json`, writes only under the ignored `.cache`
directory, and verifies every file or aggregate checksum. Then run the release
command. Never change a checksum simply to accept an unexpected download;
investigate the source revision and license first.

The embedding and cross-encoder models are repository assets. Their file
digests and upstream revisions are checked by `npm run verify:models`.

## Acceptance contract

The baseline requires quality coverage for:

- vector, hybrid, and BM25 Recall/MRR/nDCG;
- reranked Recall/MRR/nDCG;
- p50/p95 query latency, index time, peak RSS, and package-size ceilings.

Metric tests assert their numerical contract; the release result binds those
passing suites to the source commit, corpus manifest, runner environment,
limits, elapsed suite time, child-process peak RSS, isolated index time, and
exact candidate package identities and sizes. Package and platform performance
budgets are additionally enforced by the release policy and audited CI
evidence. Results from different operating systems, CPU architectures, Node
versions, model revisions, or corpora are not directly comparable.

The release subset measures and enforces SciFact retrieval quality for the
`vector`, `hybrid`, and `bm25` strategies, and SciFact/FRAMES reranker p50 and
p95 query latency. `recallAt5` and `ndcgAt5` are macro averages over the sampled
query set and `mrrAt10` is the mean reciprocal rank of the first relevant
result within the top ten.

Each required workload runs sequentially in a fresh child process: repository
retrieval fixtures, SciFact, SciFact reranking, FRAMES, FRAMES
reranking, and index construction. This prevents unrelated suites from
accumulating retired model/native generations in one process. It does not omit
combined production dependencies: each workload retains its complete runtime
stack (for example, the reranking children hold both embedding and cross-encoder
models). The enforced peak RSS is the maximum absolute lifetime peak across
every required child, never a sum, average, reset counter, or selected subset.

Each child's peak is read from Node's `process.resourceUsage().maxRSS`.
Node/libuv exposes this value in KiB on supported platforms (including
normalization of Darwin's native units), so every emitter records the workload,
raw value, `KiB` unit, platform, API source, and exact `× 1024` byte conversion.
The runner requires exactly one valid record from every declared workload and
stores the complete per-workload measurements with the maximum. The parent
harness RSS delta remains diagnostic only.

Index time uses `performance.now()` around a fresh LanceDB database
initialization, embedding of the 30-document pinned repository corpus, and
durable vector-index construction. Embedding-model initialization happens
before the timer and the evidence records that scope explicitly. The runner
rejects missing or inconsistent unit/scope metadata rather than treating a
nearby process or suite timer as equivalent evidence.

With these internal measurements present, the remaining release status depends
on their declared thresholds and the exact candidate tarballs supplied through
`RAGNAROK_RELEASE_ARTIFACT_DIR`. Missing measurements or artifacts produce
machine-readable blockers and a nonzero exit; no diagnostic substitute is
promoted to passing evidence.

## Updating a baseline

A threshold change is a reviewed product decision, not an automatic response
to a regression. First retain the reviewed CI result artifact, document why the
change is acceptable, and obtain the repository's benchmark-baseline approval
label. Record the reviewed evidence with:

```sh
npm run bench:update-baseline -- \
  --approval-label=benchmark-baseline-approved \
  --results=/absolute/path/to/release.json
```

This command copies the evidence to `packages/core/benchmarks/data/approved-result.json`; it does
not edit thresholds. Edit the baseline separately, update the manifest binding
when inputs changed, and have both the evidence and threshold diff reviewed.

## Interpreting failures

- Missing/pending/skipped means no release evidence exists.
- A checksum mismatch means the input is not the reviewed corpus.
- A quality failure is a retrieval regression until explained and approved.
- A latency/RSS/package failure must be reproduced on the baseline runner.
- A fingerprint mismatch means persisted vectors require reindexing; it is not
  a benchmark fallback.
