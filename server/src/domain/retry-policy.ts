/** Pause before attempt 2, attempt 3, ...; the last value repeats. Rides out an hours-long outage. */
export const DEFAULT_BACKOFF_MS = [5, 20, 80, 320, 1280, 3600].map((seconds) => seconds * 1000);

/** Up to this share is added at random, so rows that failed together do not retry together. */
const JITTER = 0.2;

/**
 * How long to wait after failed attempt number `attempt`. A provider's Retry-After is
 * honoured, but never beyond the longest backoff: the row must not vanish for days.
 */
export function retryDelayMs(
  attempt: number,
  backoffMs: readonly number[],
  random: () => number,
  retryAfterMs = 0,
): number {
  const base = backoffMs.at(Math.min(attempt - 1, backoffMs.length - 1)) ?? 0;
  const longest = Math.max(0, ...backoffMs);
  return Math.max(base + base * JITTER * random(), Math.min(retryAfterMs, longest));
}
