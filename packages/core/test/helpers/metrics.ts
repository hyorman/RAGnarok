export function mean(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr: number[]): number {
  if (arr.length <= 1) {
    return 0;
  }
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

export function median(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Normalized Discounted Cumulative Gain at k.
 * Gain: 2^rel - 1  (grade 2 → 3, grade 1 → 1, grade 0 → 0)
 */
export function ndcgAtK(retrieved: string[], qrels: Map<string, number>, k: number): number {
  const topK = retrieved.slice(0, k);

  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = qrels.get(topK[i]) ?? 0;
    const gain = Math.pow(2, rel) - 1;
    dcg += gain / Math.log2(i + 2);
  }

  // Ideal: sort all graded docs by descending relevance
  const idealGrades = Array.from(qrels.values())
    .filter((r) => r > 0)
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcg = 0;
  for (let i = 0; i < idealGrades.length; i++) {
    const gain = Math.pow(2, idealGrades[i]) - 1;
    idcg += gain / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Mean Average Precision at k.
 * Binary: grade ≥ 1 is relevant.
 */
export function mapAtK(retrieved: string[], qrels: Map<string, number>, k: number): number {
  const topK = retrieved.slice(0, k);
  const totalRelevant = Array.from(qrels.values()).filter((r) => r >= 1).length;
  if (totalRelevant === 0) {
    return 0;
  }

  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = qrels.get(topK[i]) ?? 0;
    if (rel >= 1) {
      hits++;
      sumPrecision += hits / (i + 1);
    }
  }

  return sumPrecision / totalRelevant;
}

/**
 * Recall at k.  Binary: grade ≥ 1 is relevant.
 */
export function recallAtK(retrieved: string[], qrels: Map<string, number>, k: number): number {
  const topK = retrieved.slice(0, k);
  const totalRelevant = Array.from(qrels.values()).filter((r) => r >= 1).length;
  if (totalRelevant === 0) {
    return 0;
  }

  const hits = topK.filter((id) => (qrels.get(id) ?? 0) >= 1).length;
  return hits / totalRelevant;
}

/**
 * Precision at k.  Binary: grade ≥ 1 is relevant.
 */
export function precisionAtK(retrieved: string[], qrels: Map<string, number>, k: number): number {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => (qrels.get(id) ?? 0) >= 1).length;
  return hits / k;
}

/**
 * Mean Reciprocal Rank at k.  Binary: grade ≥ 1 is relevant.
 */
export function mrrAtK(retrieved: string[], qrels: Map<string, number>, k: number): number {
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if ((qrels.get(topK[i]) ?? 0) >= 1) {
      return 1 / (i + 1);
    }
  }
  return 0;
}
