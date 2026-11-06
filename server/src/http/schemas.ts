import { z } from 'zod';

/**
 * Competitor ids end up in URLs and in requests to the listing source, so they are kept
 * to lowercase slugs: `acme-crm`, `north-analytics`.
 */
export const competitorId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    'id must be 1-64 characters: lowercase letters, digits and dashes, not starting with a dash',
  );

export const competitorParams = z.object({ id: competitorId });

export const createCompetitorBody = z.object({ id: competitorId });

export const MAX_SNAPSHOTS_PAGE = 500;
export const DEFAULT_SNAPSHOTS_PAGE = 200;

export const snapshotsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_SNAPSHOTS_PAGE).default(DEFAULT_SNAPSHOTS_PAGE),
  /** Cursor: return snapshots older than this snapshot id. */
  before: z.coerce.number().int().positive().optional(),
});

export const competitorDto = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastPolledAt: z.string().nullable(),
  lastPollError: z.string().nullable(),
});
export type CompetitorDto = z.infer<typeof competitorDto>;

/** The contract shape from the assignment, plus `id`, `summaryStatus` and `initial`. */
export const snapshotDto = z.object({
  id: z.number(),
  fetchedAt: z.string(),
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
  changed: z.boolean(),
  /** null if unchanged, pending or failed; summaryStatus tells which. */
  summary: z.string().nullable(),
  summaryStatus: z.enum(['none', 'pending', 'ready', 'failed']),
  /** First snapshot of this competitor: nothing to compare with. */
  initial: z.boolean(),
});
export type SnapshotDto = z.infer<typeof snapshotDto>;

export const pollScheduledDto = z.object({ id: z.string(), status: z.string() });
export const requeuedDto = z.object({ requeued: z.number() });
