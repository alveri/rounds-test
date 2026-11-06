import type { FieldChange, Listing } from '../domain/listing.js';

export interface SummaryInput {
  competitorId: string;
  previous: Listing;
  current: Listing;
  /** Precomputed so the prompt can lead with exactly what changed. Never empty. */
  changes: FieldChange[];
}

/**
 * The only seam between the system and an LLM. `summarizeOnce` is its only caller.
 * Implementations must honour `signal` and must not retry on their own: retries, backoff
 * and the attempt budget belong to the service, where they are visible and bounded.
 * Any error other than the two below is treated as worth retrying.
 */
export interface SummaryClient {
  summarize(input: SummaryInput, signal: AbortSignal): Promise<string>;
}

/** Retrying cannot help (bad key, bad request), so the attempt budget is not spent on it. */
export class PermanentSummaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentSummaryError';
  }
}

/** The provider said when to come back. */
export class RateLimitedSummaryError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RateLimitedSummaryError';
  }
}
