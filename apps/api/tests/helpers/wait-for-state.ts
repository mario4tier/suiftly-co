/**
 * Polling helpers for assertions that race the GM async billing pipeline.
 *
 * The GM mutation→commit pipeline is fire-and-forget from the tRPC layer:
 * a tRPC mutation returns once the request is queued, but the actual
 * billing-record / customer-row / invoice update happens on the next GM
 * tick. A test that reads DB state immediately after the mutation can
 * race that tick and see pre-update values — intermittently.
 *
 * Wrap the read+assert in `waitForState`. It re-runs the fetcher on a
 * tight interval until the predicate holds, or fails with a "stuck"
 * error after the timeout — which is the actionable signal that the
 * pipeline really is stuck (not just slow).
 *
 * Default timeout is generous (10s) so transient slowness doesn't
 * surface as flake; the failure message describes what state was
 * expected vs last seen, so debugging doesn't require rerunning.
 */
import { vi } from 'vitest';

export interface WaitForStateOptions {
  /** Total time to keep retrying before failing. Default: 10_000 ms. */
  timeout?: number;
  /** Delay between successive fetches. Default: 100 ms. */
  interval?: number;
}

/**
 * Repeatedly call `fetcher` until `predicate(value)` returns true, then
 * return the value. If timeout elapses first, throws an error containing
 * the description plus the last value seen — making "stuck" failures
 * self-describing.
 */
export async function waitForState<T>(
  fetcher: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  options: WaitForStateOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 100;

  let lastSeen: T | undefined;
  try {
    return await vi.waitFor(
      async () => {
        lastSeen = await fetcher();
        if (!predicate(lastSeen)) {
          throw new Error(`predicate not yet satisfied`);
        }
        return lastSeen;
      },
      { timeout, interval },
    );
  } catch (err) {
    const lastSeenStr = (() => {
      try {
        return JSON.stringify(lastSeen);
      } catch {
        return String(lastSeen);
      }
    })();
    throw new Error(
      `stuck waiting for: ${description} (after ${timeout}ms). ` +
      `Last value seen: ${lastSeenStr}. ` +
      `Original error: ${(err as Error).message}`,
    );
  }
}

/**
 * Convenience: wait until a single value returned by `fetcher` equals
 * `expected` (deep equal via `JSON.stringify` for primitives + objects).
 * For more flexible matching, use `waitForState` directly with a custom
 * predicate.
 */
export async function waitForValue<T>(
  fetcher: () => Promise<T>,
  expected: T,
  description: string,
  options?: WaitForStateOptions,
): Promise<T> {
  return waitForState(
    fetcher,
    (v) => JSON.stringify(v) === JSON.stringify(expected),
    `${description} == ${JSON.stringify(expected)}`,
    options,
  );
}
