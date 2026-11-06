import { type ChildProcess, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiSummaryClient } from '../../src/summary/openai-summary-client.js';
import { PermanentSummaryError, RateLimitedSummaryError } from '../../src/summary/summary-client.js';

/**
 * Runs the real OpenAI SDK client against the provided mock-llm-server.py, so the
 * compatibility claim, the timeout and the 500 handling are checked end to end.
 */
const MOCK = fileURLToPath(new URL('../../../mock-llm/mock-llm-server.py', import.meta.url));

let mock: ChildProcess;
let base: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = spawn('python3', ['-I', MOCK], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('mock LLM server did not start');
});

afterAll(() => {
  mock.kill();
});

beforeEach(async () => {
  await fetch(`${base}/control/reset`, { method: 'POST' });
});

const configure = (body: object) =>
  fetch(`${base}/control/configure`, { method: 'POST', body: JSON.stringify(body) });
const callCount = async () => ((await (await fetch(`${base}/control/stats`)).json()) as { callCount: number }).callCount;

const input = {
  competitorId: 'acme-crm',
  previous: { title: 'Acme CRM', tagline: 'Simple', price: '$39/mo', description: 'Leads.' },
  current: { title: 'Acme CRM', tagline: 'Simple', price: '$29/mo', description: 'Leads.' },
  changes: [{ field: 'price' as const, before: '$39/mo', after: '$29/mo' }],
};

const client = () => new OpenAiSummaryClient({ baseUrl: `${base}/v1`, apiKey: 'mock', model: 'mock-llm' });

describe('OpenAiSummaryClient against mock-llm-server.py', () => {
  it('returns the mock summary, which echoes the changed fields', async () => {
    const summary = await client().summarize(input, AbortSignal.timeout(5000));
    expect(summary).toMatch(/^Mock AI summary/);
    expect(summary).toContain('price: "$39/mo" -> "$29/mo"');
    expect(await callCount()).toBe(1);
  });

  it('throws on an injected 500 without retrying inside the SDK', async () => {
    await configure({ failNext: 1 });
    await expect(client().summarize(input, AbortSignal.timeout(5000))).rejects.toThrow(/500/);
    // One request was made and failed; a retrying SDK would have succeeded on its second try.
    const summary = await client().summarize(input, AbortSignal.timeout(5000));
    expect(summary).toMatch(/^Mock AI summary/);
  });

  it('gives up when the signal times out', async () => {
    await configure({ latencyMs: 3000 });
    const started = Date.now();
    await expect(client().summarize(input, AbortSignal.timeout(200))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

describe('OpenAiSummaryClient error classification', () => {
  /** The error `summarize` throws when the provider answers with this status and headers. */
  async function errorFor(status: number, headers: Record<string, string> = {}): Promise<unknown> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ error: { message: `status ${status}` } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const provider = new OpenAiSummaryClient({ baseUrl, apiKey: 'k', model: 'm' });
      return await provider.summarize(input, AbortSignal.timeout(5000)).then(
        () => undefined,
        (err: unknown) => err,
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it('calls a rejected key or request permanent', async () => {
    expect(await errorFor(401)).toBeInstanceOf(PermanentSummaryError);
    expect(await errorFor(400)).toBeInstanceOf(PermanentSummaryError);
  });

  it('reads Retry-After from a rate limit', async () => {
    const err = await errorFor(429, { 'retry-after': '120' });
    expect(err).toBeInstanceOf(RateLimitedSummaryError);
    expect((err as RateLimitedSummaryError).retryAfterMs).toBe(120_000);
  });

  it('leaves a server error and a bare 429 as ordinary retryable errors', async () => {
    for (const status of [500, 429]) {
      const err = await errorFor(status);
      expect(err).not.toBeInstanceOf(PermanentSummaryError);
      expect(err).not.toBeInstanceOf(RateLimitedSummaryError);
    }
  });
});
