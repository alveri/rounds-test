import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type Listing, listingSchema } from '../domain/listing.js';

const fixturesSchema = z.record(z.string(), z.array(listingSchema).min(1));
export type Fixtures = z.infer<typeof fixturesSchema>;

export async function loadFixtures(path: string): Promise<Fixtures> {
  return fixturesSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * Stand-in for a competitor's website. Each call for an id returns the next canned
 * version and advances that id's counter; once the versions run out it keeps
 * returning the last one. Unknown ids return undefined and advance nothing.
 */
export class FixtureSequence {
  private readonly served = new Map<string, number>();

  constructor(private readonly fixtures: Fixtures) {}

  next(id: string): Listing | undefined {
    const versions = Object.hasOwn(this.fixtures, id) ? this.fixtures[id] : undefined;
    if (!versions) return undefined;
    const count = this.served.get(id) ?? 0;
    this.served.set(id, count + 1);
    return versions.at(Math.min(count, versions.length - 1));
  }
}
