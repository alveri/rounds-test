import { errorMessage, type Logger } from './logger.js';

export interface Loop {
  /** Stops scheduling ticks and waits for the current tick, if any, to finish. */
  stop(): Promise<void>;
  /** When the last tick settled, or when the loop started. A stale value means it is stuck. */
  lastTickAt(): Date;
}

/**
 * Runs `tick` every `everyMs`, measured from the end of the previous tick, so ticks never
 * overlap and a slow tick delays the next one instead of piling up. A failing tick is
 * logged and the loop keeps going.
 */
export function startLoop(name: string, everyMs: number, tick: () => Promise<void>, log: Logger): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  let lastTickAt = new Date();

  const run = async (): Promise<void> => {
    if (stopped) return;
    current = tick().catch((err: unknown) => {
      log.error({ loop: name, err: errorMessage(err) }, 'tick failed');
    });
    await current;
    current = undefined;
    lastTickAt = new Date();
    if (!stopped) timer = setTimeout(() => void run(), everyMs);
  };

  timer = setTimeout(() => void run(), 0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
    lastTickAt: () => lastTickAt,
  };
}

/** Tracks fire-and-forget tasks so callers can bound concurrency and wait for them on shutdown. */
export class TaskSet {
  private readonly running = new Set<Promise<void>>();

  get size(): number {
    return this.running.size;
  }

  /** `task` must not reject; handle its errors inside. */
  add(task: Promise<void>): void {
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.running);
  }
}
