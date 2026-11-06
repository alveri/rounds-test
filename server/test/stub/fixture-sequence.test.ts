import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureSequence, loadFixtures } from '../../src/stub/fixture-sequence.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/listings.json', import.meta.url));

describe('FixtureSequence over the provided fixtures', () => {
  it('serves versions 1, 2, 3, 4 and then keeps repeating 4', async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const sequence = new FixtureSequence(fixtures);
    const versions = fixtures['acme-crm'];
    expect(versions).toHaveLength(4);

    const served = Array.from({ length: 6 }, () => sequence.next('acme-crm'));

    expect(served).toEqual([
      versions?.[0],
      versions?.[1],
      versions?.[2],
      versions?.[3],
      versions?.[3],
      versions?.[3],
    ]);
  });

  it('keeps a separate counter per competitor', async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const sequence = new FixtureSequence(fixtures);

    sequence.next('acme-crm');
    sequence.next('acme-crm');

    expect(sequence.next('ferry-pay')).toEqual(fixtures['ferry-pay']?.[0]);
    expect(sequence.next('acme-crm')).toEqual(fixtures['acme-crm']?.[2]);
  });

  it('returns undefined for an unknown id, including inherited object keys', () => {
    const sequence = new FixtureSequence({});
    expect(sequence.next('does-not-exist')).toBeUndefined();
    expect(sequence.next('constructor')).toBeUndefined();
  });
});
