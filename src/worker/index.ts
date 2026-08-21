/**
 * The Worker: a Hono app under /api, static assets for everything else.
 *
 * Route map (all responses JSON unless noted):
 *   GET    /api/health                      open   deploy-verification contract
 *   GET    /api/state                       open   bootstrap: agents + handshake + admin flags
 *   POST   /api/connect                     admin  start a Manyfold handshake
 *   POST   /api/connect/:id/poll            admin  poll it (2s cadence from the browser)
 *   DELETE /api/connect/:id                 admin  cancel it
 *   GET    /api/agents                      admin  connected agents (never tokens)
 *   POST   /api/agents/:agentId/verify      admin  re-run the non-billing auth probe
 *   DELETE /api/agents/:agentId             admin  disconnect + drop its conversation
 *   GET    /api/agents/:agentId/messages    admin  chat history
 *   DELETE /api/agents/:agentId/messages    admin  reset the conversation
 *   POST   /api/agents/:agentId/chat        admin  one chat turn (text/event-stream)
 *
 * "admin" routes require the x-admin-password header — but only when the
 * ADMIN_PASSWORD secret is set. Without it the app is open, which is what makes
 * zero-config deploys work; set the secret before sharing the URL.
 */

import { Hono } from 'hono';
import type { AppState } from '../shared/types';
import { HttpError, type Env } from './types';
import { ensureSchema } from './db';
import { ConfigError, safeEqual } from './crypto';
import { A2AError } from './a2a';
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  listConnectedAgents,
  pollConnect,
  startConnect,
  verifyAgent,
} from './connect';
import { getConversation, handleChatTurn, resetConversation } from './chat';
import { handleRemoveBg, type RemoveBgRequest } from './remove-bg';
import { loadAppSettings, saveAppSettings } from './settings-manager';

const SERVICE = 'cloudflare-worker-starter';

const app = new Hono<{ Bindings: Env }>();

/* ───────── middleware ───────── */

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Same-origin check on every mutation: browsers always send Origin on cross-site
// POSTs, so this shuts down CSRF without cookies or tokens.
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (!origin) {
      throw new HttpError(403, 'origin_required', 'Mutation requests must include a same-origin Origin header.');
    }
    if (origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'invalid_origin', 'Cross-origin requests are not allowed.');
    }
  }
  await next();
});

const adminPassword = (env: Env): string | null => {
  const value = (env.ADMIN_PASSWORD ?? '').trim();
  return value.length > 0 ? value : null;
};

const adminHeaderOk = (c: { env: Env; req: { header: (name: string) => string | undefined } }): boolean => {
  const required = adminPassword(c.env);
  if (!required) return true;
  return safeEqual(c.req.header('x-admin-password') ?? '', required);
};

// Everything except /api/health, /api/state, /api/remove-bg, and GET /api/r2/* image fetching needs the password (when one is set).
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isPublicR2Image = path.startsWith('/api/r2/') && path !== '/api/r2/list' && c.req.method === 'GET';
  if (
    path !== '/api/health' &&
    path !== '/api/state' &&
    path !== '/api/remove-bg' &&
    !isPublicR2Image &&
    !adminHeaderOk(c)
  ) {
    throw new HttpError(401, 'admin_password_invalid', 'This deployment requires the admin password.');
  }
  await next();
});

/* ───────── error mapping ───────── */

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  if (error instanceof ConfigError) {
    return c.json({ error: { code: 'misconfigured', message: error.message } }, 400);
  }
  if (error instanceof A2AError) {
    return error.retryable
      ? c.json({ error: { code: 'manyfold_unavailable', message: error.message } }, 502)
      : c.json({ error: { code: 'manyfold_rejected', message: error.message } }, 400);
  }
  console.error('unhandled', error);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

/* ───────── routes ───────── */

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: SERVICE, time: new Date().toISOString() }),
);

app.get('/api/state', async (c) => {
  const [session, agents] = await Promise.all([
    getConnectSession(c.env),
    listConnectedAgents(c.env),
  ]);
  const state: AppState = {
    service: SERVICE,
    adminRequired: adminPassword(c.env) !== null,
    adminOk: adminHeaderOk(c),
    connect: { session },
    agents,
  };
  return c.json(state);
});

app.post('/api/connect', async (c) => {
  const session = await startConnect(c.env, c.req.url);
  return c.json({ connect: session }, 201);
});

app.post('/api/connect/:connectId/poll', async (c) => {
  const outcome = await pollConnect(c.env, c.req.param('connectId'));
  return c.json(outcome);
});

app.delete('/api/connect/:connectId', async (c) => {
  await cancelConnect(c.env, c.req.param('connectId'));
  return c.json({ ok: true });
});

app.get('/api/agents', async (c) => c.json({ agents: await listConnectedAgents(c.env) }));

app.post('/api/agents/:agentId/verify', async (c) =>
  c.json({ agent: await verifyAgent(c.env, c.req.param('agentId')) }),
);

app.delete('/api/agents/:agentId', async (c) => {
  await disconnectAgent(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.get('/api/agents/:agentId/messages', async (c) =>
  c.json(await getConversation(c.env, c.req.param('agentId'))),
);

app.delete('/api/agents/:agentId/messages', async (c) => {
  await resetConversation(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.post('/api/agents/:agentId/chat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
  if (!body || typeof body.message !== 'string') {
    throw new HttpError(400, 'bad_request', 'Body must be JSON with a string "message".');
  }
  return handleChatTurn({
    env: c.env,
    agentId: c.req.param('agentId'),
    message: body.message,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

app.post('/api/remove-bg', async (c) => {
  const body = (await c.req.json().catch(() => null)) as RemoveBgRequest | null;
  if (!body || !body.image) {
    throw new HttpError(400, 'bad_request', 'Body must be JSON with a string property "image".');
  }
  const result = await handleRemoveBg(c.env, body);
  return c.json(result);
});

/* ───────── settings & r2 routes ───────── */

app.get('/api/settings', async (c) => {
  const settings = await loadAppSettings(c.env);
  return c.json({ settings });
});

app.post('/api/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = await saveAppSettings(c.env, body);
  return c.json({ settings: updated });
});

app.get('/api/r2/list', async (c) => {
  if (!c.env.R2_IMAGE) {
    return c.json({ items: [], enabled: false, message: 'Cloudflare R2 bucket R2_IMAGE is not bound.' });
  }
  const objects = await c.env.R2_IMAGE.list({ limit: 100 });
  const items = objects.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
    url: `/api/r2/${encodeURIComponent(obj.key)}`,
  }));
  return c.json({ items, enabled: true, truncated: objects.truncated });
});

app.get('/api/r2/:key', async (c) => {
  if (!c.env.R2_IMAGE) {
    throw new HttpError(404, 'r2_not_configured', 'Cloudflare R2 is not configured.');
  }
  const key = c.req.param('key');
  const object = await c.env.R2_IMAGE.get(key);
  if (!object) {
    throw new HttpError(404, 'not_found', 'Image not found in R2 storage.');
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(object.body, { headers });
});

app.delete('/api/r2/:key', async (c) => {
  if (!c.env.R2_IMAGE) {
    throw new HttpError(404, 'r2_not_configured', 'Cloudflare R2 is not configured.');
  }
  const key = c.req.param('key');
  await c.env.R2_IMAGE.delete(key);
  return c.json({ ok: true, key });
});

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

// Anything else that reaches the Worker is a static asset (or the SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
