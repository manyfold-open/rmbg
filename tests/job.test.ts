import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createJobTicket, outputKeyFor, redeemJobTicket } from '../src/worker/job';
import type { Env } from '../src/worker/types';
import { CUTOUT_PNG_BASE64 } from './fixtures';

/** Enough of D1 to exercise the ticket lifecycle: these tests are about state, not SQL. */
function makeDb() {
  const rows = new Map<string, { token: string; status: string; expires_at: string }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('INSERT INTO bg_jobs')) {
                const [jobId, token, status, , expiresAt] = args as string[];
                rows.set(jobId, { token, status, expires_at: expiresAt });
              } else if (sql.startsWith('UPDATE bg_jobs')) {
                const [status, jobId] = args as string[];
                const row = rows.get(jobId);
                if (row) row.status = status;
              } else if (sql.startsWith('DELETE FROM bg_jobs')) {
                for (const [id, row] of rows) {
                  if (Date.parse(row.expires_at) < Date.parse(args[0] as string)) rows.delete(id);
                }
              }
            },
            async first() {
              if (!sql.includes('FROM bg_jobs')) return null;
              const row = rows.get(args[0] as string);
              return row ? { token: row.token, status: row.status, expiresAt: row.expires_at } : null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
        async run() {},
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
    async batch() {
      return [];
    },
    async exec() {},
  } as unknown as D1Database;
  return { db, rows };
}

function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const bucket = {
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
  } as unknown as R2Bucket;
  return { bucket, store };
}

describe('job tickets', () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = makeDb().db;
    env = { DB: db } as Env;
  });

  it('accepts the issued token exactly once', async () => {
    const ticket = await createJobTicket(env, 'png');
    await expect(redeemJobTicket(env, ticket.jobId, ticket.token)).resolves.toBeUndefined();
    // A replay must not overwrite a result that was already delivered.
    await expect(redeemJobTicket(env, ticket.jobId, ticket.token)).rejects.toThrow(
      'already received its result',
    );
  });

  it('rejects a wrong token', async () => {
    const ticket = await createJobTicket(env, 'png');
    await expect(redeemJobTicket(env, ticket.jobId, 'f'.repeat(64))).rejects.toThrow(
      'Invalid or expired upload ticket',
    );
  });

  it('gives an unknown job the same error as a wrong token', async () => {
    // Identical wording on purpose: probing must not reveal whether a job exists.
    await expect(redeemJobTicket(env, 'a'.repeat(32), 'b'.repeat(64))).rejects.toThrow(
      'Invalid or expired upload ticket',
    );
  });

  it('issues 256 bits of token and a key that is not derived from the clock', async () => {
    const a = await createJobTicket(env, 'png');
    const b = await createJobTicket(env, 'png');
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.inputKey).toBe(`job_${a.jobId}_input.png`);
    expect(a.outputKey).toBe(outputKeyFor(a.jobId));
  });
});

describe('PUT /api/job/:jobId/output', () => {
  const png = Uint8Array.from(atob(CUTOUT_PNG_BASE64), (ch) => ch.charCodeAt(0));

  it('stores the upload when the ticket is valid, without an Origin header', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    // No Origin: the uploader is curl inside an agent, not a browser.
    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(store.get(outputKeyFor(ticket.jobId))?.bytes.byteLength).toBe(png.byteLength);
  });

  it('rejects an upload with no ticket', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png },
      env,
    );

    expect(res.status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('rejects a non-image content-type', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/html', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );

    expect(res.status).toBe(415);
    expect(store.size).toBe(0);
  });

  it('rejects an empty body', async () => {
    const { db } = makeDb();
    const { bucket } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: new Uint8Array(0),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it('still demands an Origin on other mutations', async () => {
    // The exemption must be scoped to this one route, not to PUT in general.
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const res = await app.request(
      '/api/settings',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(403);
  });
});
