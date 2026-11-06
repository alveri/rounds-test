import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * none    - nothing to summarise (first snapshot, or identical to the previous one)
 * pending - changed; waiting for the summary worker (also the worker's queue)
 * ready   - summary written
 * failed  - gave up after LLM_MAX_ATTEMPTS; the snapshot itself is intact
 */
export const summaryStatus = pgEnum('summary_status', ['none', 'pending', 'ready', 'failed']);
export type SummaryStatus = (typeof summaryStatus.enumValues)[number];

export const competitors = pgTable(
  'competitors',
  {
    id: text('id').primaryKey(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** The poll schedule. Claiming moves it one interval ahead; "Check now" moves it back to now. */
    nextPollAt: tstz('next_poll_at').notNull().defaultNow(),
    /** Set while a poll is in flight, so nothing that moves the schedule can start a second one. */
    pollLeaseUntil: tstz('poll_lease_until'),
    lastPolledAt: tstz('last_polled_at'),
    lastPollError: text('last_poll_error'),
  },
  (t) => [index('competitors_due_idx').on(t.nextPollAt)],
);

export const snapshots = pgTable(
  'snapshots',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    competitorId: text('competitor_id')
      .notNull()
      .references(() => competitors.id, { onDelete: 'cascade' }),
    previousId: bigint('previous_id', { mode: 'number' }).references(
      (): AnyPgColumn => snapshots.id,
      { onDelete: 'set null' },
    ),
    fetchedAt: tstz('fetched_at').notNull(),

    title: text('title').notNull(),
    tagline: text('tagline').notNull(),
    price: text('price').notNull(),
    description: text('description').notNull(),
    /** sha256 of the four normalised listing fields; equality means "no change". */
    contentHash: text('content_hash').notNull(),
    changed: boolean('changed').notNull(),

    summary: text('summary'),
    summaryStatus: summaryStatus('summary_status').notNull().default('none'),
    summaryAttempts: integer('summary_attempts').notNull().default(0),
    summaryNextAttemptAt: tstz('summary_next_attempt_at'),
    summaryError: text('summary_error'),
  },
  (t) => [
    index('snapshots_timeline_idx').on(t.competitorId, t.id.desc()),
    // ON DELETE SET NULL looks up referencing rows for every deleted snapshot. Without this
    // index, removing a competitor scans the whole table once per snapshot in its history.
    index('snapshots_previous_idx').on(t.previousId),
    index('snapshots_pending_idx')
      .on(t.summaryNextAttemptAt)
      .where(sql`${t.summaryStatus} = 'pending'`),
    // Keeps requeueing and the failed-summaries metric cheap as the history grows.
    index('snapshots_failed_idx')
      .on(t.id)
      .where(sql`${t.summaryStatus} = 'failed'`),
  ],
);

export type CompetitorRow = typeof competitors.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type NewSnapshotRow = typeof snapshots.$inferInsert;
