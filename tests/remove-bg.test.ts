import { describe, expect, it, vi } from 'vitest';
import { assertUsableCutout, handleRemoveBg, pngDimensions } from '../src/worker/remove-bg';
import type { Env } from '../src/worker/types';
import app from '../src/worker/index';
import * as connectModule from '../src/worker/connect';
import * as a2aModule from '../src/worker/a2a';
import { CUTOUT_PNG_BASE64, PLACEHOLDER_1X1_BASE64 } from './fixtures';

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

/**
 * The agent path now hands the image over through R2, so a bucket is part of the fixture
 * rather than an optional extra. `seed` pre-loads what the agent is pretending to upload.
 */
function makeR2(seed: Record<string, { bytes: Uint8Array; contentType: string }> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    bucket: {
      async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
        store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType ?? 'image/png' });
      },
      async get(key: string) {
        const hit = store.get(key);
        if (!hit) return null;
        return {
          arrayBuffer: async () => hit.bytes.buffer,
          httpMetadata: { contentType: hit.contentType },
        };
      },
    } as unknown as R2Bucket,
  };
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

describe('remove-bg handler', () => {
  it('throws HttpError 400 when no auth method or GEMINI_API_KEY is available', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockEnv = { DB: mockDb } as Env;
      await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
        '無可用的 AI 處理服務'
      );
    } finally {
      process.env.GEMINI_API_KEY = origKey;
    }
  });

  it('throws HttpError 400 when image is missing', async () => {
    const mockEnv = { GEMINI_API_KEY: 'test-key', DB: mockDb } as Env;
    await expect(handleRemoveBg(mockEnv, { image: '' }, 'https://test.local')).rejects.toThrow(
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

  it('returns image artifact directly when connected Manyfold agent returns an image', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        rpcUrl: 'https://api.manyfold.ai/rpc',
        expiresAt: null,
        verified: true,
        warning: null,
        connectedAt: '2026-08-21T00:00:00Z',
      },
    ]);
    vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
      rpcUrl: 'https://api.manyfold.ai/rpc',
      token: 'test-token',
      label: 'Test Agent',
    });
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      text: 'Here is your background removal',
      progressText: '',
      terminal: true,
      final: true,
      diagnostics: {
        events: 1,
        lastKind: 'status-update',
        state: 'completed',
        taskId: 't1',
        contextId: 'c1',
        imageMimeType: 'image/png',
        imageLength: 100,
        imageArtifact: true,
        final: true,
      },
      image: {
        mimeType: 'image/png',
        data: `data:image/png;base64,${CUTOUT_PNG_BASE64}`,
      },
    });

    // Nothing uploaded to R2, so this exercises the fallback: a data URL scraped out of
    // the agent's plain-text reply.
    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local');
    expect(res.image).toBeDefined();
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.label).toBe('Test Agent');
  });

  it('throws diagnostic error when connected agent returns text without an image artifact', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        rpcUrl: 'https://api.manyfold.ai/rpc',
        expiresAt: null,
        verified: true,
        warning: null,
        connectedAt: '2026-08-21T00:00:00Z',
      },
    ]);
    vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
      rpcUrl: 'https://api.manyfold.ai/rpc',
      token: 'test-token',
      label: 'Test Agent',
    });
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      text: 'Sorry, I cannot process this image.',
      progressText: '',
      terminal: true,
      final: true,
      diagnostics: {
        events: 1,
        lastKind: 'status-update',
        state: 'completed',
        taskId: 't1',
        contextId: 'c1',
        imageMimeType: null,
        imageLength: 0,
        imageArtifact: false,
        final: true,
      },
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    // The agent's own words are the only diagnosis available, so they must survive.
    await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
      'Sorry, I cannot process this image.'
    );
  });

  it('prefers the R2 upload over anything in the agent reply', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        rpcUrl: 'https://api.manyfold.ai/rpc',
        expiresAt: null,
        verified: true,
        warning: null,
        connectedAt: '2026-08-21T00:00:00Z',
      },
    ]);
    vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
      rpcUrl: 'https://api.manyfold.ai/rpc',
      token: 'test-token',
      label: 'Test Agent',
    });

    const r2 = makeR2();
    // The agent uploads during its turn, so by the time the stream resolves the object is
    // already there. Simulate that by writing it from inside the mocked call.
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      const key = [...r2.store.keys()].find((k) => k.endsWith('_input.png'))!;
      const jobId = key.slice('job_'.length, -'_input.png'.length);
      await r2.bucket.put(`job_${jobId}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return {
        taskId: 't1',
        contextId: 'c1',
        state: 'completed',
        text: 'DONE',
        progressText: '',
        terminal: true,
        final: true,
        diagnostics: {
          events: 1,
          lastKind: 'status-update',
          state: 'completed',
          taskId: 't1',
          contextId: 'c1',
          imageMimeType: null,
          imageLength: 0,
          imageArtifact: false,
          final: true,
        },
      };
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local');

    expect(res.label).toBe('Test Agent');
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.r2Key).toMatch(/^job_[a-f0-9]{32}_output\.png$/);
  });

  it('still returns the cutout when the A2A stream dies after the upload', async () => {
    // Production, 2026-08-24: the stream died with "Network connection lost" after ~2min
    // and the whole job was reported failed. But the upload rides on its own HTTPS
    // request — losing the stream says nothing about whether the result arrived.
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        rpcUrl: 'https://api.manyfold.ai/rpc',
        expiresAt: null,
        verified: true,
        warning: null,
        connectedAt: '2026-08-21T00:00:00Z',
      },
    ]);
    vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
      rpcUrl: 'https://api.manyfold.ai/rpc',
      token: 'test-token',
      label: 'Test Agent',
    });

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      const key = [...r2.store.keys()].find((k) => k.endsWith('_input.png'))!;
      const jobId = key.slice('job_'.length, -'_input.png'.length);
      await r2.bucket.put(`job_${jobId}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      throw new Error('Network connection lost.');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local');

    expect(res.r2Key).toMatch(/^job_[a-f0-9]{32}_output\.png$/);
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
  });

  it('rejects a placeholder even when it arrived through the upload', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        rpcUrl: 'https://api.manyfold.ai/rpc',
        expiresAt: null,
        verified: true,
        warning: null,
        connectedAt: '2026-08-21T00:00:00Z',
      },
    ]);
    vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
      rpcUrl: 'https://api.manyfold.ai/rpc',
      token: 'test-token',
      label: 'Test Agent',
    });

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      const key = [...r2.store.keys()].find((k) => k.endsWith('_input.png'))!;
      const jobId = key.slice('job_'.length, -'_input.png'.length);
      await r2.bucket.put(`job_${jobId}_output.png`, bytesOf(PLACEHOLDER_1X1_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return {
        taskId: 't1',
        contextId: 'c1',
        state: 'completed',
        text: 'DONE',
        progressText: '',
        terminal: true,
        final: true,
        diagnostics: {
          events: 1,
          lastKind: 'status-update',
          state: 'completed',
          taskId: 't1',
          contextId: 'c1',
          imageMimeType: null,
          imageLength: 0,
          imageArtifact: false,
          final: true,
        },
      };
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    await expect(
      handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local'),
    ).rejects.toThrow('回傳了佔位圖');
  });
});

describe('assertUsableCutout', () => {
  const PLACEHOLDER_1X1 = PLACEHOLDER_1X1_BASE64;

  /**
   * A PNG header of the given size, big enough to clear both thresholds. colorType is the
   * IHDR byte that decides whether alpha is even representable: 6 = RGBA, 2 = plain RGB.
   */
  const pngOf = (width: number, height: number, colorType = 6): string => {
    const ihdr = new Uint8Array(26);
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(ihdr.buffer).setUint32(16, width);
    new DataView(ihdr.buffer).setUint32(20, height);
    ihdr[24] = 8; // bit depth
    ihdr[25] = colorType;
    const padded = new Uint8Array(2048);
    padded.set(ihdr, 0);
    let binary = '';
    for (const byte of padded) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  it('rejects the 1x1 placeholder an image-blind agent returns', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('回傳了佔位圖');
  });

  it('reports the placeholder dimensions so the cause is visible', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('1x1');
  });

  it('rejects a payload too small to be a cutout regardless of format', () => {
    expect(() => assertUsableCutout(btoa('tiny'), 'rmbg')).toThrow('回傳了佔位圖');
  });

  it('rejects data that is not valid base64', () => {
    expect(() => assertUsableCutout('!!!not base64!!!', 'rmbg')).toThrow('無法解碼');
  });

  it('accepts a real cutout', () => {
    expect(() => assertUsableCutout(pngOf(96, 96), 'rmbg')).not.toThrow();
  });

  it('rejects an opaque RGB PNG, however large and detailed', () => {
    // Production, 2026-08-24: asked for transparency, the image model returned an 848 KB
    // colour-type-2 PNG with a checkerboard *painted* into it. Big, sharp, and not a cutout.
    expect(() => assertUsableCutout(pngOf(1264, 842, 2), 'rmbg')).toThrow('沒有透明通道');
  });

  it('rejects greyscale without alpha and accepts greyscale with it', () => {
    expect(() => assertUsableCutout(pngOf(96, 96, 0), 'rmbg')).toThrow('沒有透明通道');
    expect(() => assertUsableCutout(pngOf(96, 96, 4), 'rmbg')).not.toThrow();
  });

  it('leaves non-PNG payloads to the size check alone', () => {
    // pngHasAlpha returns null for anything it cannot parse, which must not become a reject.
    const notPng = btoa('x'.repeat(2048));
    expect(() => assertUsableCutout(notPng, 'rmbg')).not.toThrow();
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    const bytes = Uint8Array.from(atob(PLACEHOLDER_1X1), (c) => c.charCodeAt(0));
    expect(pngDimensions(bytes)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for anything that is not a PNG', () => {
    expect(pngDimensions(new Uint8Array(64))).toBeNull();
  });
});
