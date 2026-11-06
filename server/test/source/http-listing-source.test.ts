import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Listing } from '../../src/domain/listing.js';
import { HttpListingSource, MAX_LISTING_BYTES } from '../../src/source/http-listing-source.js';
import { ListingNotFoundError, ListingSourceError } from '../../src/source/listing-source.js';
import { FixtureSequence } from '../../src/stub/fixture-sequence.js';
import { createStubServer } from '../../src/stub/server.js';

const v1: Listing = { title: 'Acme CRM', tagline: 'Simple', price: '$29/mo', description: 'One.' };
const v2: Listing = { ...v1, price: '$39/mo' };

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(s: Server): Promise<string> {
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('HttpListingSource against the stub server', () => {
  it('returns the next version on every call', async () => {
    const baseUrl = await listen(createStubServer(new FixtureSequence({ 'acme-crm': [v1, v2] })));
    const source = new HttpListingSource({ baseUrl, timeoutMs: 1000 });

    expect(await source.fetch('acme-crm')).toEqual(v1);
    expect(await source.fetch('acme-crm')).toEqual(v2);
    expect(await source.fetch('acme-crm')).toEqual(v2);
  });

  it('turns 404 into ListingNotFoundError', async () => {
    const baseUrl = await listen(createStubServer(new FixtureSequence({})));
    const source = new HttpListingSource({ baseUrl, timeoutMs: 1000 });

    await expect(source.fetch('does-not-exist')).rejects.toBeInstanceOf(ListingNotFoundError);
  });
});

describe('HttpListingSource failure modes', () => {
  it('gives up after the timeout instead of hanging', async () => {
    const baseUrl = await listen(createServer(() => {})); // accepts, never answers
    const source = new HttpListingSource({ baseUrl, timeoutMs: 100 });

    const started = Date.now();
    await expect(source.fetch('acme-crm')).rejects.toThrow(/timed out after 100 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects a body that is not a listing', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ title: 'Acme CRM' }));
      }),
    );
    const source = new HttpListingSource({ baseUrl, timeoutMs: 1000 });

    await expect(source.fetch('acme-crm')).rejects.toThrow(/invalid listing/);
  });

  it('gives up on a response larger than any listing, without reading all of it', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...v1, description: 'x'.repeat(MAX_LISTING_BYTES) }));
      }),
    );
    const source = new HttpListingSource({ baseUrl, timeoutMs: 1000 });

    await expect(source.fetch('acme-crm')).rejects.toThrow(/larger than/);
  });

  it('rejects a listing with a field over its limit', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...v1, price: 'x'.repeat(501) }));
      }),
    );
    const source = new HttpListingSource({ baseUrl, timeoutMs: 1000 });

    await expect(source.fetch('acme-crm')).rejects.toThrow(/invalid listing/);
  });

  it('reports server errors and unreachable hosts as ListingSourceError', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(500);
        res.end();
      }),
    );
    await expect(
      new HttpListingSource({ baseUrl, timeoutMs: 1000 }).fetch('acme-crm'),
    ).rejects.toThrow(/responded 500/);

    await expect(
      new HttpListingSource({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }).fetch('acme-crm'),
    ).rejects.toBeInstanceOf(ListingSourceError);
  });
});
