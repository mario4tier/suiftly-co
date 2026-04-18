/**
 * React Query `refetchInterval` with activity-aware backoff: polls every
 * 60s normally, relaxes to 10m once no data has changed for 1h. Pair with
 * `refetchOnWindowFocus: true` so tab-returns still update immediately.
 */

const ACTIVE_POLL_MS = 60_000;
const IDLE_POLL_MS = 10 * 60_000;
const IDLE_THRESHOLD_MS = 60 * 60_000;

export function liveRefetchInterval(query: { state: { dataUpdatedAt: number } }): number {
  return Date.now() - query.state.dataUpdatedAt > IDLE_THRESHOLD_MS
    ? IDLE_POLL_MS
    : ACTIVE_POLL_MS;
}
