/** A plain JSON-style object: not null, not an array. Narrows parsed, untrusted input one level at a time. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A number that is neither NaN nor infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
