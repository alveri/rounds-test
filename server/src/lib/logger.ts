export type LogFields = Record<string, unknown>;

/** The part of pino the workers use: structured fields first, a fixed message second. */
export interface Logger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
