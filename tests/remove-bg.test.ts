import { describe, expect, it } from 'vitest';
import { handleRemoveBg } from '../src/worker/remove-bg';
import type { Env } from '../src/worker/types';
import app from '../src/worker/index';

const mockDb = {
  prepare: () => ({
    bind: () => ({
      run: async () => {},
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
    run: async () => {},
    all: async () => ({ results: [] }),
    first: async () => null,
  }),
  exec: async () => {},
  batch: async () => [],
} as unknown as D1Database;

describe('remove-bg handler', () => {
  it('throws HttpError 500 when GEMINI_API_KEY is missing', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockEnv = {} as Env;
      await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' })).rejects.toThrow(
        'GEMINI_API_KEY is not configured'
      );
    } finally {
      process.env.GEMINI_API_KEY = origKey;
    }
  });

  it('throws HttpError 400 when image is missing', async () => {
    const mockEnv = { GEMINI_API_KEY: 'test-key' } as Env;
    await expect(handleRemoveBg(mockEnv, { image: '' })).rejects.toThrow(
      'Image data is required.'
    );
  });

  it('handles /api/remove-bg route 400 for bad request format', async () => {
    const res = await app.request('/api/remove-bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
      body: JSON.stringify({}),
    }, { DB: mockDb });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('bad_request');
  });
});
