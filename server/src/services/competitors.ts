import type { Db } from '../db/client.js';
import type { CompetitorRow, SnapshotRow } from '../db/schema.js';
import { AlreadyTrackedError, NotTrackedError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import * as repo from '../repositories/competitors.js';
import { listSnapshots } from '../repositories/snapshots.js';

/** What a user can do with tracked competitors. Throws domain errors; knows nothing of HTTP. */
export class CompetitorService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  list(): Promise<CompetitorRow[]> {
    return repo.listCompetitors(this.db);
  }

  async track(id: string): Promise<CompetitorRow> {
    const row = await repo.insertCompetitor(this.db, id);
    if (!row) throw new AlreadyTrackedError(id);
    return row;
  }

  /** Removes the competitor and its history. Adding the id again starts a fresh history. */
  async remove(id: string): Promise<void> {
    if (!(await repo.deleteCompetitor(this.db, id))) throw new NotTrackedError(id);
  }

  async requestPoll(id: string): Promise<void> {
    if (!(await repo.requestPoll(this.db, id, this.clock()))) throw new NotTrackedError(id);
  }

  async timeline(id: string, page: { limit: number; before?: number | undefined }): Promise<SnapshotRow[]> {
    if (!(await repo.competitorExists(this.db, id))) throw new NotTrackedError(id);
    return listSnapshots(this.db, id, page);
  }
}
