import type { Listing } from '../domain/listing.js';

/**
 * Where the poller gets a competitor's current listing.
 *
 * Calls are NOT idempotent: the stub advances a per-id counter on every call, as a real
 * website changes over time. Only the poller calls this, exactly once per claimed competitor.
 */
export interface ListingSource {
  fetch(competitorId: string, signal?: AbortSignal): Promise<Listing>;
}

/** Any failure to get a valid listing. The message is stored as the competitor's last poll error. */
export class ListingSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ListingSourceError';
  }
}

export class ListingNotFoundError extends ListingSourceError {
  constructor(competitorId: string) {
    super(`listing source does not know competitor "${competitorId}"`);
    this.name = 'ListingNotFoundError';
  }
}
