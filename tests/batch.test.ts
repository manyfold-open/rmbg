import { describe, expect, it } from 'vitest';
import { BATCH_CONCURRENCY, MAX_BATCH_SIZE, cutoutFileName, runQueue } from '../src/app/batch';
import { dispatchRetryDelay, isDispatchRejection } from '../src/worker/remove-bg';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('runQueue', () => {
  it('runs every item exactly once, in order of pickup', async () => {
    const seen: number[] = [];
    await runQueue([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never has more than `limit` items in flight', async () => {
    let inFlight = 0;
    let peak = 0;

    await runQueue(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    });

    expect(peak).toBe(3);
  });

  it('lets a fast worker take the next item instead of waiting for a slow one', async () => {
    // Two workers, three items. The first item blocks; the second must finish and pick up
    // the third rather than sit behind the block.
    const blocker = deferred();
    const started: string[] = [];

    const run = runQueue(['slow', 'quick', 'third'], 2, async (item) => {
      started.push(item);
      if (item === 'slow') await blocker.promise;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['slow', 'quick', 'third']);

    blocker.resolve();
    await run;
  });

  it('keeps going when a worker throws', async () => {
    const completed: number[] = [];
    await runQueue([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      completed.push(item);
    });
    expect(completed.sort()).toEqual([1, 3]);
  });

  it('handles an empty list without hanging', async () => {
    await expect(runQueue([], 4, async () => {})).resolves.toBeUndefined();
  });

  it('stays inside what the agent will accept', () => {
    expect(BATCH_CONCURRENCY).toBeLessThan(8);
    expect(MAX_BATCH_SIZE).toBeGreaterThanOrEqual(20);
  });
});

describe('cutoutFileName', () => {
  it('replaces the extension with .png', () => {
    expect(cutoutFileName('photo.jpg')).toBe('photo.png');
    expect(cutoutFileName('shot.HEIC')).toBe('shot.png');
  });

  it('adds an extension when there is none', () => {
    expect(cutoutFileName('photo')).toBe('photo.png');
  });

  it('keeps dots that are part of the name', () => {
    expect(cutoutFileName('v1.2.final.jpeg')).toBe('v1.2.final.png');
  });

  it('does not mistake a directory dot for an extension', () => {
    expect(cutoutFileName('album.2026/photo')).toBe('album.2026/photo.png');
  });

  it('falls back rather than producing a bare .png', () => {
    expect(cutoutFileName('.jpg')).toBe('cutout.png');
    expect(cutoutFileName('')).toBe('cutout.png');
  });
});

describe('isDispatchRejection', () => {
  it('recognises the agent turning a delegation away at dispatch', () => {
    expect(isDispatchRejection('Too many concurrent A2A delegations (8/8)')).toBe(true);
    expect(isDispatchRejection('too many concurrent delegations')).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    // These must fail fast; retrying them would just stall the batch.
    expect(isDispatchRejection('Unauthorized')).toBe(false);
    expect(isDispatchRejection('Too many requests')).toBe(false);
    expect(isDispatchRejection('agent stream ended without a result')).toBe(false);
  });
});

describe('dispatchRetryDelay', () => {
  it('backs off exponentially and then stops growing', () => {
    // random() = 1 gives the top of each jitter window, i.e. the nominal delay.
    expect(dispatchRetryDelay(0, () => 1)).toBe(2_000);
    expect(dispatchRetryDelay(1, () => 1)).toBe(4_000);
    expect(dispatchRetryDelay(2, () => 1)).toBe(8_000);
    expect(dispatchRetryDelay(10, () => 1)).toBe(30_000);
  });

  it('jitters so a batch does not re-collide on the same tick', () => {
    expect(dispatchRetryDelay(0, () => 0)).toBe(1_000);
    expect(dispatchRetryDelay(0, () => 0.5)).toBe(1_500);
  });

  it('never waits less than half a second', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(dispatchRetryDelay(attempt, () => 0)).toBeGreaterThanOrEqual(500);
    }
  });
});
