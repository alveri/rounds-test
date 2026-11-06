import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults: 15-minute polling and the mock LLM', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config.poll.intervalSeconds).toBe(900);
    expect(config.llm.baseUrl).toBe('http://localhost:4001/v1');
    expect(config.llm.maxAttempts).toBe(8);
    expect(config.role).toBe('all');
  });

  it('reads numbers from strings', () => {
    const config = loadConfig({ DATABASE_URL: 'x', POLL_INTERVAL_SECONDS: '15' });
    expect(config.poll.intervalSeconds).toBe(15);
  });

  it('reads the role and the backoff schedule', () => {
    const config = loadConfig({ DATABASE_URL: 'x', ROLE: 'worker', LLM_BACKOFF_SECONDS: '1,2,30' });
    expect(config.role).toBe('worker');
    expect(config.llm.backoffMs).toEqual([1000, 2000, 30_000]);
  });

  it('rejects an unknown role and a malformed backoff schedule', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', ROLE: 'cron', LLM_BACKOFF_SECONDS: '1,,2' })).toThrow(
      /ROLE[\s\S]*LLM_BACKOFF_SECONDS/,
    );
  });

  it('lists every invalid variable in one error', () => {
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '0', LLM_BASE_URL: 'not a url' })).toThrow(
      /DATABASE_URL[\s\S]*POLL_INTERVAL_SECONDS[\s\S]*LLM_BASE_URL/,
    );
  });
});
