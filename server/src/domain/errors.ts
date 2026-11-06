/** A business rule said no. The HTTP layer maps these to status codes in one place. */
export class DomainError extends Error {}

export class AlreadyTrackedError extends DomainError {
  constructor(competitorId: string) {
    super(`competitor "${competitorId}" is already tracked`);
    this.name = 'AlreadyTrackedError';
  }
}

export class NotTrackedError extends DomainError {
  constructor(competitorId: string) {
    super(`competitor "${competitorId}" is not tracked`);
    this.name = 'NotTrackedError';
  }
}
