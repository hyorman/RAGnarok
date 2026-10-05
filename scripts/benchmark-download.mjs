// Corpus downloads for the release benchmarks. Wikipedia and the corpus hosts throttle shared CI
// addresses, so a 429 or a 5xx is retried after the wait the server asks for; any other failure is final.

// Wikimedia's User-Agent policy asks every client to say who it is and how to reach it.
export const BENCHMARK_USER_AGENT = "RAGnarok-release-benchmark/0.4 (https://github.com/hyorman/RAGnarok)";

const sleepFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRetryableStatus = (status) => status === 429 || status >= 500;

// Retry-After is either a whole number of seconds or an HTTP date in IMF-fixdate form, the one a server
// must send (a date already past waits zero). Anything else falls back to exponential backoff, so a
// malformed value cannot stall or spin the loop; V8's Date.parse alone would read "1.5" as a 2001 date.
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
function retryAfterMs(header, now) {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  return Math.max(0, Date.parse(value) - now());
}

/**
 * Fetch `url` and return its body as a Buffer. HTTP 429, any 5xx status and network errors are retried
 * until `attempts` tries have been made; the wait honours Retry-After and otherwise backs off from one
 * second, doubling, and never exceeds `maxDelayMs`. Any other non-OK status throws at once. Each attempt
 * gets its own `timeoutMs`.
 */
export async function downloadWithRetry(
  url,
  {
    fetchImpl = fetch,
    sleep = sleepFor,
    attempts = 6,
    maxDelayMs = 60_000,
    timeoutMs = 120_000,
    now = Date.now,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    let response;
    let failure;
    try {
      response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": BENCHMARK_USER_AGENT },
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failure = error;
    }

    let reason;
    if (failure !== undefined) {
      reason = `failed: ${failure instanceof Error ? failure.message : String(failure)}`;
    } else {
      reason = `returned ${response.status}`;
      // A response that is not read leaves its socket open until it is garbage collected.
      await response.body?.cancel().catch(() => {});
      if (!isRetryableStatus(response.status)) throw new Error(`Benchmark download ${url} ${reason}`);
    }
    if (attempt >= attempts) {
      const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
      throw new Error(`Benchmark download ${url} ${reason} after ${tries}`, { cause: failure });
    }

    const requested = failure === undefined ? retryAfterMs(response.headers.get("retry-after"), now) : undefined;
    const delay = Math.min(requested ?? 1000 * 2 ** (attempt - 1), maxDelayMs);
    onRetry?.({ url, reason, attempt, attempts, delayMs: delay });
    await sleep(delay);
  }
}
