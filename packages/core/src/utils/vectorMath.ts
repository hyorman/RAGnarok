/**
 * Shared vector math helpers.
 */

/**
 * Cosine similarity between two vectors.
 *
 * Returns 0 for mismatched or empty inputs and for zero-magnitude vectors —
 * callers use this for ranking, where "no similarity" is the sensible
 * degenerate value. (EmbeddingService.cosineSimilarity intentionally keeps a
 * stricter throwing contract for API consumers.)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Convert LanceDB's squared-L2 distance into the public vector-similarity
 * score.
 *
 * The production LanceDB tables use the default L2 search, whose `_distance`
 * is squared Euclidean distance. For unit-normalized embeddings it is
 * `2 - 2*cosine`, so the stable score contract is:
 *
 *   similarity = clamp(1 - distance / 2, 0, 1)
 *
 * Invalid/missing distances represent no evidence and therefore score 0. They
 * must not become a neutral-looking 0.5 result.
 */
export function lanceDistanceToSimilarity(distance: number | null | undefined): number {
  if (distance === null || distance === undefined || !Number.isFinite(distance) || distance < 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

/** Convert cosine similarity between unit vectors to LanceDB squared-L2 distance. */
export function unitCosineToLanceDistance(cosine: number): number {
  if (!Number.isFinite(cosine)) {
    return 4;
  }
  const boundedCosine = Math.max(-1, Math.min(1, cosine));
  return Math.max(0, 2 - 2 * boundedCosine);
}
