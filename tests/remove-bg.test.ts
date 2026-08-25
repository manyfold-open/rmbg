import { describe, expect, it, vi } from 'vitest';
import {
  assertUsableCutout,
  handleRemoveBg,
  pngDimensions,
  workDirFor,
} from '../src/worker/remove-bg';
import { INPUT_DIGEST_METADATA, sha256Hex } from '../src/worker/job';
import type { Env } from '../src/worker/types';
import app from '../src/worker/index';
import * as connectModule from '../src/worker/connect';
import * as a2aModule from '../src/worker/a2a';
import { CUTOUT_PNG_BASE64, PLACEHOLDER_1X1_BASE64, makeJobDb } from './fixtures';

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
interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

function makeR2(seed: Record<string, StoredObject> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    bucket: {
      async put(
        key: string,
        bytes: Uint8Array,
        opts?: {
          httpMetadata?: { contentType?: string };
          customMetadata?: Record<string, string>;
        },
      ) {
        store.set(key, {
          bytes,
          contentType: opts?.httpMetadata?.contentType ?? 'image/png',
          metadata: opts?.customMetadata,
        });
      },
      async get(key: string) {
        const hit = store.get(key);
        if (!hit) return null;
        return {
          arrayBuffer: async () => hit.bytes.buffer,
          httpMetadata: { contentType: hit.contentType },
        };
      },
      async head(key: string) {
        const hit = store.get(key);
        return hit ? { size: hit.bytes.byteLength } : null;
      },
    } as unknown as R2Bucket,
  };
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

/** One connected, authorized agent — the precondition for every A2A-path test below. */
function mockAgent(name = 'Test Agent') {
  vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
    {
      agentId: 'agent-1',
      name,
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
    label: name,
  });
}

/** A finished A2A turn. `image` is the artifact-in-the-reply path, which R2 supersedes. */
function snapshotOf(text: string, image?: a2aModule.ImageArtifact): a2aModule.StreamSnapshot {
  return {
    taskId: 't1',
    contextId: 'c1',
    state: 'completed',
    text,
    progressText: '',
    terminal: true,
    final: true,
    diagnostics: {
      events: 1,
      lastKind: 'status-update',
      state: 'completed',
      taskId: 't1',
      contextId: 'c1',
      imageMimeType: image?.mimeType ?? null,
      imageLength: image ? image.data.length : 0,
      imageArtifact: Boolean(image),
      final: true,
    },
    ...(image ? { image } : {}),
  };
}

/** The job id of the input the handler just staged in R2. */
const stagedJobId = (store: Map<string, unknown>): string => {
  const key = [...store.keys()].find((k) => k.endsWith('_input.png'))!;
  return key.slice('job_'.length, -'_input.png'.length);
};

describe('remove-bg handler', () => {
  it('throws HttpError 400 when no auth method or GEMINI_API_KEY is available', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockEnv = { DB: mockDb } as Env;
      await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
        'No AI processing service is available'
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
    mockAgent();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('Here is your background removal', {
        mimeType: 'image/png',
        data: `data:image/png;base64,${CUTOUT_PNG_BASE64}`,
      }),
    );

    // Nothing uploaded to R2, so this exercises the fallback: a data URL scraped out of
    // the agent's plain-text reply.
    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local');
    expect(res.image).toBeDefined();
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.label).toBe('Test Agent');
  });

  it('throws diagnostic error when connected agent returns text without an image artifact', async () => {
    mockAgent();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('Sorry, I cannot process this image.'),
    );

    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    // The agent's own words are the only diagnosis available, so they must survive.
    await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
      'Sorry, I cannot process this image.'
    );
  });

  it('prefers the R2 upload over anything in the agent reply', async () => {
    mockAgent();

    const r2 = makeR2();
    // The agent uploads during its turn, so by the time the stream resolves the object is
    // already there. Simulate that by writing it from inside the mocked call.
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
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
    mockAgent();

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      throw new Error('Network connection lost.');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local');

    expect(res.r2Key).toMatch(/^job_[a-f0-9]{32}_output\.png$/);
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
  });

  /**
   * The agent runs every delegation in one sandbox with one /tmp. When the instructions named
   * fixed paths, a batch of six had six turns writing /tmp/input.png, /tmp/gen.png and
   * /tmp/output.png, and turns uploaded each other's pictures under their own job tokens —
   * a valid cutout of the wrong subject, which no downstream check can catch. These assert
   * the two properties that make that impossible and unnecessary respectively.
   */
  describe('the instructions sent to the agent', () => {
    /** Run one agent-path removal and hand back the prompt text it dispatched. */
    async function capturePrompt(): Promise<{ prompt: string; jobId: string }> {
      mockAgent();
      const r2 = makeR2();
      let prompt = '';
      vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async (options) => {
        const message = (options.params as { message: { parts: { text?: string }[] } }).message;
        prompt = message.parts[0].text ?? '';
        await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
          httpMetadata: { contentType: 'image/png' },
        });
        return snapshotOf('DONE');
      });

      const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
      await handleRemoveBg(
        mockEnv,
        { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
        'https://test.local',
      );
      return { prompt, jobId: stagedJobId(r2.store) };
    }

    it('names a working directory belonging to this job and no shared /tmp file', async () => {
      const { prompt, jobId } = await capturePrompt();

      expect(prompt).toContain(workDirFor(jobId));
      expect(workDirFor(jobId)).toBe(`/tmp/rmbg-${jobId}`);
      // Every /tmp path must be under this job's directory. `find /tmp -maxdepth 1` is the
      // one bare mention and has no trailing slash, so it is not matched here.
      expect(prompt.match(/\/tmp\/(?!rmbg-)/g)).toBeNull();
    });

    it('keeps the original pixels inside the silhouette', async () => {
      // gemini-3.1-flash-image answers 1024x1024 whatever it is given, and redraws the
      // subject rather than returning it. Taking the opaque interior from the generated
      // frame meant shipping that redrawing upscaled to the input's size — measured 2x on a
      // real 2048x2048 job, and every cutout came back soft.
      const { prompt } = await capturePrompt();

      expect(prompt).toContain('np.array(src, dtype=np.float32)).astype(np.uint8)');
      expect(prompt).not.toContain('decontam, rgb)');
    });

    it('asks for a digest of the file the agent actually processed', async () => {
      const { prompt } = await capturePrompt();
      expect(prompt).toContain('x-input-sha256');
      expect(prompt).toContain('sha256sum');
    });
  });

  it('records the staged input digest so the upload can be checked against it', async () => {
    mockAgent();
    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    await handleRemoveBg(
      mockEnv,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
    );

    const input = r2.store.get(`job_${stagedJobId(r2.store)}_input.png`)!;
    expect(input.metadata?.[INPUT_DIGEST_METADATA]).toBe(await sha256Hex(bytesOf(CUTOUT_PNG_BASE64)));
  });

  it('rejects a placeholder even when it arrived through the upload', async () => {
    mockAgent();

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(PLACEHOLDER_1X1_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    await expect(
      handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local'),
    ).rejects.toThrow('returned a placeholder');
  });
});

/**
 * The asynchronous path, which exists because the synchronous one could not work: the
 * agent needs about five minutes and the A2A stream dies at 126 seconds, so the browser
 * timed out on results that had already been produced and stored.
 */
describe('remove-bg, asynchronously', () => {
  /** Stands in for executionCtx.waitUntil, keeping the scheduled work awaitable. */
  function makeWaitUntil() {
    const scheduled: Promise<unknown>[] = [];
    return {
      scheduled,
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(promise);
      },
      settle: () => Promise.all(scheduled),
    };
  }

  it('answers with a job id instead of an image, without waiting for the turn', async () => {
    mockAgent();
    const r2 = makeR2();
    const { db } = makeJobDb();
    const ctx = makeWaitUntil();

    // The turn never finishes. That must not stop the response: this promise is only
    // resolved after the assertions below have already run.
    let endTurn: () => void = () => {};
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(
      () => new Promise((resolve) => { endTurn = () => resolve(snapshotOf('DONE')); }),
    );

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );

    expect(res.jobId).toMatch(/^[a-f0-9]{32}$/);
    expect(res.statusUrl).toBe(`/api/job/${res.jobId}/status`);
    expect(res.image).toBeUndefined();
    // The input is staged before the response, so the agent can already download it.
    expect(r2.store.has(`job_${res.jobId}_input.png`)).toBe(true);
    expect(ctx.scheduled).toHaveLength(1);

    endTurn();
    await ctx.settle();
  });

  it('says what it is waiting for while the job runs', async () => {
    mockAgent('Cutout Bot');
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );

    // A note exists from the moment the job is handed over — a poller that sees nothing
    // cannot tell "queued" from "lost".
    expect(notes.get(res.jobId!)).toMatchObject({ kind: 'progress' });
    expect(notes.get(res.jobId!)?.note).toContain('Cutout Bot');

    await ctx.settle();
    expect(notes.get(res.jobId!)).toMatchObject({ kind: 'done' });
  });

  it("records the agent's own words when the turn ends with no result", async () => {
    // The failure used to travel back in the HTTP response. Nothing is waiting on that
    // response any more, so if this is not written down the browser polls forever.
    mockAgent();
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('python3: No module named PIL'),
    );

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );
    await ctx.settle();

    const note = notes.get(res.jobId!);
    expect(note?.kind).toBe('failed');
    expect(note?.note).toContain('python3: No module named PIL');
  });

  it('keeps waiting, rather than failing, when only the stream breaks', async () => {
    // Proven in production: the stream drops at ~2 minutes and the agent uploads anyway.
    // A broken stream is therefore progress, not a verdict — the note must not say failed.
    mockAgent();
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      // Upload first, so the (zero-length) wait that follows finds it immediately.
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      throw new Error('Network connection lost.');
    });

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );
    await ctx.settle();

    expect(notes.get(res.jobId!)?.kind).toBe('done');
  });

  it('treats a stream that merely stops as still running, and finishes when the upload lands', async () => {
    // consumeA2AStream returns a non-terminal snapshot when the SSE body ends without a
    // final event. That is the same situation as a thrown connection error — the agent is
    // still working, we just stopped hearing about it — so it must get the same grace,
    // not be read as "the turn finished and never uploaded".
    vi.useFakeTimers();
    try {
      mockAgent();
      const r2 = makeR2();
      const { db, notes } = makeJobDb();
      const ctx = makeWaitUntil();
      vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
        ...snapshotOf('still working'),
        state: 'working',
        terminal: false,
        final: false,
      });

      const res = await handleRemoveBg(
        { DB: db, R2_IMAGE: r2.bucket } as Env,
        { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
        'https://test.local',
        ctx.waitUntil,
      );
      const settled = ctx.settle();

      // A minute later, with nothing in R2 yet, the job is still open rather than failed.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notes.get(res.jobId!)).toMatchObject({ kind: 'progress' });
      expect(notes.get(res.jobId!)?.note).toContain('working');

      await r2.bucket.put(`job_${res.jobId}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;

      expect(notes.get(res.jobId!)).toMatchObject({ kind: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers POST /api/remove-bg with 202 and a pollable job', async () => {
    mockAgent();
    const r2 = makeR2();
    const { db } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const res = await app.request(
      '/api/remove-bg',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }),
      },
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { waitUntil: ctx.waitUntil, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; statusUrl: string; image?: string };
    expect(body.jobId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.image).toBeUndefined();

    await ctx.settle();

    // And the job the browser was handed now reports a readable result.
    const status = await app.request(
      body.statusUrl,
      {},
      { DB: db, R2_IMAGE: r2.bucket } as Env,
    );
    const statusBody = (await status.json()) as { output: { key: string } | null };
    expect(statusBody.output?.key).toBe(`job_${body.jobId}_output.png`);
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
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('returned a placeholder');
  });

  it('reports the placeholder dimensions so the cause is visible', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('1x1');
  });

  it('rejects a payload too small to be a cutout regardless of format', () => {
    expect(() => assertUsableCutout(btoa('tiny'), 'rmbg')).toThrow('returned a placeholder');
  });

  it('rejects data that is not valid base64', () => {
    expect(() => assertUsableCutout('!!!not base64!!!', 'rmbg')).toThrow('could not be decoded');
  });

  it('accepts a real cutout', () => {
    expect(() => assertUsableCutout(pngOf(96, 96), 'rmbg')).not.toThrow();
  });

  it('rejects an opaque RGB PNG, however large and detailed', () => {
    // Production, 2026-08-24: asked for transparency, the image model returned an 848 KB
    // colour-type-2 PNG with a checkerboard *painted* into it. Big, sharp, and not a cutout.
    expect(() => assertUsableCutout(pngOf(1264, 842, 2), 'rmbg')).toThrow('without an alpha channel');
  });

  it('rejects greyscale without alpha and accepts greyscale with it', () => {
    expect(() => assertUsableCutout(pngOf(96, 96, 0), 'rmbg')).toThrow('without an alpha channel');
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
