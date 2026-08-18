/**
 * Mocha root-hook plugin that records the full lifetime peak RSS of one
 * isolated release-benchmark workload.
 *
 * The release runner loads this file into every required child process and
 * takes the maximum across all children. No workload is omitted and no
 * in-process counter is reset.
 */
export const mochaHooks = {
  afterAll(): void {
    if (process.env.RAGNAROK_BENCHMARK_MODE !== "release") {
      return;
    }
    const childId = process.env.RAGNAROK_BENCHMARK_CHILD_ID;
    if (!childId || !/^[a-z0-9-]+$/.test(childId)) {
      throw new Error("Release benchmark child is missing a valid workload identifier");
    }
    // Node/libuv reports maxRSS in KiB on supported platforms, including
    // normalization of Darwin's native byte-valued ru_maxrss.
    const rawKiB = process.resourceUsage().maxRSS;
    if (!Number.isFinite(rawKiB) || rawKiB <= 0) {
      throw new Error(`Release benchmark child ${childId} did not produce a finite peak RSS`);
    }
    console.log(
      `RAGNAROK_CHILD_METRICS ${childId} ${JSON.stringify({
        peakRssBytes: rawKiB * 1024,
        raw: rawKiB,
        rawUnit: "KiB",
        source: "process.resourceUsage().maxRSS",
        platform: `${process.platform}-${process.arch}`,
      })}`,
    );
  },
};
