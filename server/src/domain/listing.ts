import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The four tracked fields of a competitor's public listing. It is third-party text that is
 * stored on every poll and billed in the LLM prompt, so a listing over these limits is
 * rejected as a poll error.
 */
export const listingSchema = z.object({
  title: z.string().max(500),
  tagline: z.string().max(1_000),
  price: z.string().max(500),
  description: z.string().max(20_000),
});

export type Listing = z.infer<typeof listingSchema>;

export const LISTING_FIELDS = ['title', 'tagline', 'price', 'description'] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Trims surrounding whitespace so a stray space or newline is not reported as a change. */
export function normalizeListing(listing: Listing): Listing {
  return {
    title: listing.title.trim(),
    tagline: listing.tagline.trim(),
    price: listing.price.trim(),
    description: listing.description.trim(),
  };
}

/**
 * Fingerprint of a normalised listing. Two snapshots are "the same" exactly when their
 * hashes match, so deciding whether to pay for an LLM call is free and deterministic.
 * The fields go in a fixed-order array, so key order and field boundaries cannot collide.
 */
export function hashListing(listing: Listing): string {
  const fields = LISTING_FIELDS.map((field) => listing[field]);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export type SnapshotKind = 'initial' | 'unchanged' | 'changed';

/** Compares a new fetch with the latest stored snapshot, if there is one. */
export function classifySnapshot(previousHash: string | undefined, hash: string): SnapshotKind {
  if (previousHash === undefined) return 'initial';
  return previousHash === hash ? 'unchanged' : 'changed';
}

export interface FieldChange {
  field: ListingField;
  before: string;
  after: string;
}

/** Fields that differ between two listings, in a stable order. */
export function diffListings(before: Listing, after: Listing): FieldChange[] {
  return LISTING_FIELDS.filter((field) => before[field] !== after[field]).map((field) => ({
    field,
    before: before[field],
    after: after[field],
  }));
}
