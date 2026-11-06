import { describe, expect, it } from 'vitest';
import {
  classifySnapshot,
  diffListings,
  hashListing,
  type Listing,
  listingSchema,
  normalizeListing,
} from '../../src/domain/listing.js';

const base: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
};

describe('hashListing', () => {
  it('is equal for equal listings and different when any field changes', () => {
    expect(hashListing(base)).toBe(hashListing({ ...base }));
    expect(hashListing({ ...base, price: '$39/mo' })).not.toBe(hashListing(base));
    expect(hashListing({ ...base, description: `${base.description} Now with AI.` })).not.toBe(
      hashListing(base),
    );
  });

  it('cannot be fooled by moving text across a field boundary', () => {
    const a = { ...base, title: 'Acme', tagline: 'CRM' };
    const b = { ...base, title: 'Acme CRM', tagline: '' };
    expect(hashListing(a)).not.toBe(hashListing(b));
  });

  it('ignores surrounding whitespace once normalised', () => {
    const padded = { ...base, price: ' $29/mo\n' };
    expect(hashListing(normalizeListing(padded))).toBe(hashListing(base));
  });
});

describe('diffListings', () => {
  it('lists only the changed fields, in field order', () => {
    const after = { ...base, tagline: 'The CRM small teams love', price: '$39/mo' };
    expect(diffListings(base, after)).toEqual([
      { field: 'tagline', before: 'Simple CRM for small teams', after: 'The CRM small teams love' },
      { field: 'price', before: '$29/mo', after: '$39/mo' },
    ]);
    expect(diffListings(base, base)).toEqual([]);
  });
});

describe('classifySnapshot', () => {
  it('tells the first, the same and a different snapshot apart', () => {
    expect(classifySnapshot(undefined, 'a')).toBe('initial');
    expect(classifySnapshot('a', 'a')).toBe('unchanged');
    expect(classifySnapshot('a', 'b')).toBe('changed');
  });
});

describe('listingSchema', () => {
  it('rejects a field over its limit', () => {
    expect(listingSchema.safeParse(base).success).toBe(true);
    expect(listingSchema.safeParse({ ...base, description: 'x'.repeat(20_001) }).success).toBe(false);
  });
});
