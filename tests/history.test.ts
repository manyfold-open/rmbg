import { describe, expect, it } from 'vitest';
import { HISTORY_TTL_MS, appendHistoryItem, filterFreshHistory } from '../src/app/history';
import type { HistoryItem } from '../src/app/types/studio';

const makeItem = (id: string, timestamp: number): HistoryItem => ({
  id,
  originalImage: `original-${id}`,
  cutoutImage: `cutout-${id}`,
  subjectLabel: id,
  timestamp,
});

describe('session history retention', () => {
  it('keeps every fresh record and removes records older than 24 hours', () => {
    const now = 2_000_000;
    const fresh = makeItem('fresh', now - HISTORY_TTL_MS + 1);
    const old = makeItem('old', now - HISTORY_TTL_MS - 1);

    expect(filterFreshHistory([old, fresh], now)).toEqual([fresh]);
  });

  it('sorts newest first without deduplicating matching source images', () => {
    const now = 2_000_000;
    const first = makeItem('first', now - 100);
    const second = { ...makeItem('second', now), originalImage: first.originalImage };

    expect(appendHistoryItem([first], second, now)).toEqual([second, first]);
  });
});
