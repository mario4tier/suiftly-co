export type StatsTimeRange = '24h' | '7d' | '30d';

/**
 * Build the full set of UTC-aligned buckets covering the selected range.
 * Backend returns only non-empty buckets; we pad on the client so every chart
 * spans the full range with "latest on the right" (array index = time position).
 */
export function expectedBuckets(range: StatsTimeRange): string[] {
  const nowMs = Date.now();
  const bucketSizeMs = range === '24h' ? 3600_000 : 86400_000;
  const bucketCount = range === '24h' ? 24 : range === '7d' ? 7 : 30;
  const endBucketMs = Math.floor(nowMs / bucketSizeMs) * bucketSizeMs;
  const out: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    out.push(new Date(endBucketMs - i * bucketSizeMs).toISOString());
  }
  return out;
}

/**
 * Pad a sparse time series so every expected bucket exists, in order. Missing
 * points are filled via `zeroFor(bucket)`. Latest bucket is last so it renders
 * on the right edge.
 */
export function padTimeSeries<T extends { bucket: string | Date }>(
  data: T[] | undefined,
  range: StatsTimeRange,
  zeroFor: (bucket: string) => T
): T[] {
  const expected = expectedBuckets(range);
  const byBucket = new Map<string, T>();
  for (const p of data ?? []) {
    const iso = typeof p.bucket === 'string'
      ? new Date(p.bucket).toISOString()
      : p.bucket.toISOString();
    byBucket.set(iso, p);
  }
  return expected.map(iso => byBucket.get(iso) ?? zeroFor(iso));
}
