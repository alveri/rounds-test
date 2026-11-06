import { describe, expect, it, vi } from 'vitest';
import { startLoop, TaskSet } from '../../src/lib/loop.js';

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('startLoop', () => {
  it('never overlaps ticks and survives a failing tick', async () => {
    let running = 0;
    let maxRunning = 0;
    let ticks = 0;
    const loop = startLoop(
      'test',
      1,
      async () => {
        ticks += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        if (ticks === 2) throw new Error('boom');
      },
      silent,
    );

    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(5));
    await loop.stop();

    expect(maxRunning).toBe(1);
    expect(silent.error).toHaveBeenCalledWith({ loop: 'test', err: 'boom' }, 'tick failed');
  });

  it('reports when the last tick settled, and stops advancing while a tick hangs', async () => {
    let release = () => {};
    let ticks = 0;
    const loop = startLoop(
      'test',
      1,
      () => {
        ticks += 1;
        return ticks < 3 ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve));
      },
      silent,
    );

    await vi.waitFor(() => expect(ticks).toBe(3));
    const stuckSince = loop.lastTickAt();
    await new Promise((resolve) => setImmediate(resolve));
    expect(loop.lastTickAt()).toBe(stuckSince);

    release();
    await loop.stop();
  });

  it('stop() waits for the tick in progress and schedules no more', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    let ticks = 0;
    const loop = startLoop(
      'test',
      1,
      async () => {
        ticks += 1;
        await gate; // the first tick is held open until the test releases it
        finished = true;
      },
      silent,
    );
    await vi.waitFor(() => expect(ticks).toBe(1));

    const stopped = loop.stop();
    let stopResolved = false;
    void stopped.then(() => (stopResolved = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopResolved).toBe(false); // still waiting for the tick in progress

    release();
    await stopped;
    expect(finished).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBe(1);
  });
});

describe('TaskSet', () => {
  it('counts running tasks and drains them', async () => {
    const tasks = new TaskSet();
    let done = 0;
    tasks.add(new Promise((r) => setTimeout(r, 10)).then(() => void (done += 1)));
    tasks.add(new Promise((r) => setTimeout(r, 20)).then(() => void (done += 1)));
    expect(tasks.size).toBe(2);

    await tasks.drain();
    expect(done).toBe(2);
    await vi.waitFor(() => expect(tasks.size).toBe(0));
  });
});
