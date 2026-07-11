export const DEFAULT_BENCHMARK_SAMPLE_SIZE = 50;

export function parseBenchmarkSampleSize(
  rawValue: string | undefined,
  defaultValue = DEFAULT_BENCHMARK_SAMPLE_SIZE,
): number | null {
  if (!rawValue || rawValue.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  if (parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

export function sampleDeterministically<T>(items: T[], sampleSize: number | null): T[] {
  if (sampleSize === null || items.length <= sampleSize) {
    return items;
  }

  const step = Math.max(1, Math.floor(items.length / sampleSize));
  const sampled: T[] = [];

  for (let i = 0; i < items.length && sampled.length < sampleSize; i += step) {
    sampled.push(items[i]);
  }

  return sampled;
}

export function formatSampleSelection(
  totalCount: number,
  selectedCount: number,
  envVarName: string,
  sampleSize: number | null,
): string {
  if (sampleSize === null) {
    return `using full test split (${selectedCount}/${totalCount} queries, ${envVarName}=0)`;
  }

  if (selectedCount === totalCount) {
    return `using all available queries (${selectedCount}/${totalCount}, ${envVarName}=${sampleSize})`;
  }

  return `using deterministic query sample (${selectedCount}/${totalCount}, ${envVarName}=${sampleSize})`;
}
