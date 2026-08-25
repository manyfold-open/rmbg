/**
 * Running many images through background removal at once.
 *
 * The cap is the reason this file exists. A Manyfold agent accepts a limited number of
 * concurrent A2A delegations — measured at 8 — and rejects the rest at dispatch. The Worker
 * now waits for a slot and retries, but leaning on that for every image past the eighth
 * would mean most of a batch sitting in backoff. Submitting a bounded number at a time keeps
 * the queue inside what the agent will actually accept, and leaves slots free for the chat
 * view and other tabs sharing the same agent.
 *
 * Six, not eight, for that headroom. Measured: per-image time does not degrade with
 * concurrency, so there is nothing to gain by pushing right up to the ceiling.
 *
 * Keep this module free of DOM references: it is listed in `tsconfig.worker.json` so the
 * queue can be tested, and that project has no DOM lib. Browser-only helpers belong in
 * `utils/download.ts`.
 */

export const BATCH_CONCURRENCY = 6;

/** Enough for the 10–20 image batches this was built for, without inviting a 200-file drop. */
export const MAX_BATCH_SIZE = 20;

/**
 * Run `worker` over every item, at most `limit` at a time.
 *
 * Workers pull from a shared cursor rather than being handed fixed slices, so one slow image
 * cannot leave the others idle behind it. `worker` is expected to handle its own failures;
 * one that throws is caught here so a single bad image cannot abort the rest of the batch.
 */
export async function runQueue<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (err) {
        // A worker is supposed to record its own failure; reaching here means it did not,
        // and swallowing it is still better than killing the remaining images.
        console.error('Batch worker threw:', err);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner()),
  );
}

/** `photo.HEIC` -> `photo.png`, and anything without an extension just gains one. */
export function cutoutFileName(originalName: string): string {
  const base = originalName.replace(/\.[^./\\]+$/, '') || 'cutout';
  return `${base}.png`;
}
