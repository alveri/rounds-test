import { createServer, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FixtureSequence, loadFixtures } from './fixture-sequence.js';

/**
 * The listing stub runs as its own process (compose service `listing-stub`), so restarting
 * the app does not rewind the competitors' "websites" back to version 1.
 *
 *   GET /listings/:id  -> 200 Listing | 404
 *   GET /health        -> 200
 */
export function createStubServer(sequence: FixtureSequence): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { status: 'ok' });
    }
    const match = /^\/listings\/([^/]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !match?.[1]) {
      return send(res, 404, { error: 'not found' });
    }
    const id = decodeURIComponent(match[1]);
    const listing = sequence.next(id);
    if (!listing) {
      return send(res, 404, { error: `unknown competitor: ${id}` });
    }
    console.log(`[stub] ${id} -> ${listing.price} | ${listing.tagline}`);
    return send(res, 200, listing);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// CLI: `npm run stub -w server`
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PORT ?? 4002);
  // src/stub and dist/stub both sit two levels below server/.
  const fixturesPath =
    process.env.FIXTURES_PATH ??
    fileURLToPath(new URL('../../fixtures/listings.json', import.meta.url));
  const fixtures = await loadFixtures(fixturesPath);
  const server = createStubServer(new FixtureSequence(fixtures));
  server.listen(port, () => {
    console.log(`[stub] listing stub on :${port} serving ${Object.keys(fixtures).join(', ')}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
