// The soak's budget helpers, apart from scripts/shutdown-soak.mjs so the release static tests can import
// them: this file defines constants and functions and does nothing on import.

export const SOAK_ITERATIONS = 20;
export const ITERATION_TIMEOUT_MS = 45_000;
// The CI step allows 15 minutes. Giving up at 12 lets this script's own message, which names the
// iteration, report a stall instead of the runner's kill.
export const SOAK_BUDGET_MS = 12 * 60_000;

/** The next iteration's timeout: 45 s, or whatever the soak's budget still allows. */
export function iterationTimeoutMs(startedAt, now, iteration) {
  const remaining = SOAK_BUDGET_MS - (now - startedAt);
  if (remaining <= 0) {
    throw new Error(
      `shutdown soak exceeded its ${SOAK_BUDGET_MS / 60_000}-minute budget before iteration ${iteration}`,
    );
  }
  return Math.min(ITERATION_TIMEOUT_MS, remaining);
}
