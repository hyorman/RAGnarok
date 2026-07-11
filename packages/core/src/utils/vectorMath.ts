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
