// Types mirror server/src/http/dto.ts. Kept here rather than in a shared package:
// it is ~20 lines, and the HTTP contract is the real boundary between the two.

export type SummaryStatus = 'none' | 'pending' | 'ready' | 'failed';

export interface Competitor {
  id: string;
  createdAt: string;
  lastPolledAt: string | null;
  lastPollError: string | null;
}

export interface Snapshot {
  id: number;
  fetchedAt: string;
  title: string;
  tagline: string;
  price: string;
  description: string;
  changed: boolean;
  summary: string | null;
  summaryStatus: SummaryStatus;
  initial: boolean;
}

/** A non-2xx response, carrying the status and the server's `error` message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A competitor that is not tracked will not come back on its own; anything else might. */
export function isWorthRefetching(error: unknown): boolean {
  return !(error instanceof ApiError && error.status === 404);
}

export const SNAPSHOTS_PAGE_SIZE = 50;

/** The cursor for the page after `page`, or undefined when it was the last one. */
export function nextSnapshotCursor(page: Snapshot[]): number | undefined {
  return page.length < SNAPSHOTS_PAGE_SIZE ? undefined : page.at(-1)?.id;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const api = {
  listCompetitors: () => request<Competitor[]>('/api/competitors'),
  addCompetitor: (id: string) =>
    request<Competitor>('/api/competitors', { method: 'POST', body: JSON.stringify({ id }) }),
  removeCompetitor: (id: string) =>
    request<void>(`/api/competitors/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listSnapshots: (id: string, before?: number) => {
    const query = new URLSearchParams({ limit: String(SNAPSHOTS_PAGE_SIZE) });
    if (before !== undefined) query.set('before', String(before));
    return request<Snapshot[]>(`/api/competitors/${encodeURIComponent(id)}/snapshots?${query}`);
  },
  pollNow: (id: string) => request<unknown>(`/api/competitors/${encodeURIComponent(id)}/poll`, { method: 'POST' }),
};
