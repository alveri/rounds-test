import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF_MS, retryDelayMs } from '../../src/domain/retry-policy.js';

const noJitter = () => 0;

describe('retryDelayMs', () => {
  it('walks the schedule and repeats its last value', () => {
    const backoff = [1000, 2000];
    expect([1, 2, 3, 9].map((attempt) => retryDelayMs(attempt, backoff, noJitter))).toEqual([1000, 2000, 2000, 2000]);
  });

  it('adds at most 20% jitter', () => {
    expect(retryDelayMs(1, [1000], () => 0.5)).toBe(1100);
    expect(retryDelayMs(1, [1000], () => 1)).toBe(1200);
  });

  it('honours Retry-After when it is longer, up to the longest backoff', () => {
    const backoff = [1000, 5000];
    expect(retryDelayMs(1, backoff, noJitter, 3000)).toBe(3000);
    expect(retryDelayMs(1, backoff, noJitter, 500)).toBe(1000);
    expect(retryDelayMs(1, backoff, noJitter, 86_400_000)).toBe(5000);
  });

  it('rides out an outage of more than two hours with the default budget of 8 attempts', () => {
    const total = [1, 2, 3, 4, 5, 6, 7].reduce((sum, attempt) => sum + retryDelayMs(attempt, DEFAULT_BACKOFF_MS, noJitter), 0);
    expect(total).toBeGreaterThan(2 * 3_600_000);
  });
});
