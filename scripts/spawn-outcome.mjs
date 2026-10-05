/**
 * How a spawnSync child ended, for an error message: a spawnSync timeout, a child that could not
 * start, a signal, or an exit status. `timeoutMs` is the timeout the caller passed to spawnSync.
 */
export function spawnOutcome(result, timeoutMs) {
  if (result.error?.code === "ETIMEDOUT") return `timed out after ${timeoutMs} ms`;
  if (result.error) return `could not start: ${result.error.message}`;
  if (result.signal) return `killed by ${result.signal}`;
  return `exit ${result.status}`;
}
