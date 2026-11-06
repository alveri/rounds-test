import type { CompetitorRow, SnapshotRow } from '../db/schema.js';
import type { CompetitorDto, SnapshotDto } from './schemas.js';

export type { CompetitorDto, SnapshotDto } from './schemas.js';

export function toSnapshotDto(row: SnapshotRow): SnapshotDto {
  return {
    id: row.id,
    fetchedAt: row.fetchedAt.toISOString(),
    title: row.title,
    tagline: row.tagline,
    price: row.price,
    description: row.description,
    changed: row.changed,
    summary: row.summaryStatus === 'ready' ? row.summary : null,
    summaryStatus: row.summaryStatus,
    initial: row.previousId === null,
  };
}

export function toCompetitorDto(row: CompetitorRow): CompetitorDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastPollError: row.lastPollError,
  };
}
