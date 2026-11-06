import type { Db } from '../db/client.js';
import { hashListing, normalizeListing } from '../domain/listing.js';
import type { Clock } from '../lib/clock.js';
import { errorMessage } from '../lib/logger.js';
import { recordPollError } from '../repositories/competitors.js';
import { type AppendResult, appendSnapshot } from '../repositories/snapshots.js';
import type { ListingSource } from '../source/listing-source.js';

export type PollOutcome =
  | Exclude<AppendResult, { kind: 'gone' }>
  | { kind: 'error'; message: string }
  /** The competitor was deleted while its listing was being fetched. */
  | { kind: 'gone' };

export interface PollDeps {
  db: Db;
  source: ListingSource;
  clock: Clock;
}

/**
 * Fetches one competitor's listing and stores it as a new snapshot.
 *
 * The network call happens before any transaction is opened. Nothing here calls the LLM,
 * so the snapshot is durable before any LLM call can fail or hang.
 */
export async function pollOnce(deps: PollDeps, competitorId: string): Promise<PollOutcome> {
  const { db, source, clock } = deps;

  let fetched;
  try {
    fetched = normalizeListing(await source.fetch(competitorId));
  } catch (err) {
    const message = errorMessage(err);
    await recordPollError(db, competitorId, message, clock());
    return { kind: 'error', message };
  }

  return appendSnapshot(db, competitorId, fetched, hashListing(fetched), clock());
}
