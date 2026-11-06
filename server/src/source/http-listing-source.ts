import { type Listing, listingSchema } from '../domain/listing.js';
import { type ListingSource, ListingNotFoundError, ListingSourceError } from './listing-source.js';

export interface HttpListingSourceOptions {
  baseUrl: string;
  timeoutMs: number;
}

/** A listing is a few KB. Anything far above that is not a listing and must not fill the memory. */
export const MAX_LISTING_BYTES = 256 * 1024;

/** Fetches `GET {baseUrl}/listings/:id`, with a hard timeout and a validated body. */
export class HttpListingSource implements ListingSource {
  constructor(private readonly options: HttpListingSourceOptions) {}

  async fetch(competitorId: string, signal?: AbortSignal): Promise<Listing> {
    const url = new URL(`listings/${encodeURIComponent(competitorId)}`, withSlash(this.options.baseUrl));
    const timeout = AbortSignal.timeout(this.options.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      if (timeout.aborted) {
        throw new ListingSourceError(`listing source timed out after ${this.options.timeoutMs} ms`, {
          cause: err,
        });
      }
      throw new ListingSourceError(`listing source unreachable: ${describe(err)}`, { cause: err });
    }

    if (response.status === 404) {
      await response.body?.cancel();
      throw new ListingNotFoundError(competitorId);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ListingSourceError(`listing source responded ${response.status}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(await readLimited(response, MAX_LISTING_BYTES));
    } catch (err) {
      if (err instanceof ListingSourceError) throw err;
      if (timeout.aborted) {
        throw new ListingSourceError(`listing source timed out after ${this.options.timeoutMs} ms`, {
          cause: err,
        });
      }
      throw new ListingSourceError('listing source returned invalid JSON', { cause: err });
    }
    const parsed = listingSchema.safeParse(body);
    if (!parsed.success) {
      throw new ListingSourceError(`listing source returned an invalid listing: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ListingSourceError(`listing source response is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}
