import { describe, expect, it } from 'vitest';
import { ApiError, isWorthRefetching, nextSnapshotCursor, type Snapshot, SNAPSHOTS_PAGE_SIZE } from '../src/api';

describe('isWorthRefetching', () => {
  it('stops only for a competitor that is not tracked', () => {
    expect(isWorthRefetching(new ApiError(404, 'not tracked'))).toBe(false);
  });

  it('keeps going through a transient server error or network failure', () => {
    expect(isWorthRefetching(null)).toBe(true);
    expect(isWorthRefetching(new ApiError(500, 'internal server error'))).toBe(true);
    expect(isWorthRefetching(new ApiError(503, 'unavailable'))).toBe(true);
    expect(isWorthRefetching(new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('nextSnapshotCursor', () => {
  const page = (size: number) =>
    Array.from({ length: size }, (_, i) => ({ id: 1000 - i })) as Snapshot[];

  it('continues from the oldest snapshot of a full page', () => {
    expect(nextSnapshotCursor(page(SNAPSHOTS_PAGE_SIZE))).toBe(1000 - SNAPSHOTS_PAGE_SIZE + 1);
  });

  it('ends on a short page', () => {
    expect(nextSnapshotCursor(page(SNAPSHOTS_PAGE_SIZE - 1))).toBeUndefined();
    expect(nextSnapshotCursor([])).toBeUndefined();
  });
});
