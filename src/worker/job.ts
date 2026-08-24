/**
 * Job tickets: how a text-only agent hands an image back.
 *
 * The service agent's card declares `defaultOutputModes: ["text/plain"]` and a single
 * `general-chat` skill. It cannot attach a file artifact, and a full-size PNG is far too
 * large to spell out as base64 in a chat reply. So the image never travels over A2A at all:
 *
 *   worker  --> R2 (input)              public GET /api/r2/:key, the agent downloads it
 *   agent   --> Gemini 3.6              the actual background removal
 *   agent   --> PUT /api/job/:id/output the agent uploads the cutout straight to R2
 *   worker  <-- R2 (output)             read back once the agent's turn ends
 *
 * A2A carries only instructions and the agent's prose. That is exactly what a text-only
 * agent is good at, and it is why this indirection exists rather than a bigger prompt.
 *
 * The upload route is reachable without the admin password — the agent has no password —
 * so the ticket is the only thing guarding it: 256 bits of randomness, one job, one use,
 * ten minutes. Nothing here is derived from the request, so a caller cannot guess a ticket
 * by knowing when a job ran.
 */

import { safeEqual } from './crypto';
import { now } from './db';
import { HttpError, type Env } from './types';

/** Long enough to outlive a slow agent turn, short enough that a leaked ticket is stale. */
const TICKET_TTL_MS = 10 * 60 * 1000;

/** An agent that uploads more than this is not returning a cutout of a web upload. */
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export interface JobTicket {
  jobId: string;
  token: string;
  inputKey: string;
  outputKey: string;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function outputKeyFor(jobId: string): string {
  return `job_${jobId}_output.png`;
}

export async function createJobTicket(env: Env, extension: string): Promise<JobTicket> {
  const jobId = crypto.randomUUID().replace(/-/g, '');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();

  await env.DB.prepare(
    'INSERT INTO bg_jobs (job_id, token, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(jobId, token, 'pending', now(), expiresAt)
    .run();

  return {
    jobId,
    token,
    inputKey: `job_${jobId}_input.${extension}`,
    outputKey: outputKeyFor(jobId),
  };
}

/**
 * Authorize an upload. Throws rather than returning a boolean so that every rejection
 * reaches the client as the same shaped error, and so a caller cannot forget to check.
 */
export async function redeemJobTicket(env: Env, jobId: string, presented: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT token, status, expires_at AS expiresAt FROM bg_jobs WHERE job_id = ?',
  )
    .bind(jobId)
    .first<{ token: string; status: string; expiresAt: string }>();

  // Same error for "no such job" and "wrong token": a probe learns nothing either way.
  if (!row || !safeEqual(presented, row.token)) {
    throw new HttpError(403, 'job_token_invalid', 'Invalid or expired upload ticket.');
  }
  if (row.status !== 'pending') {
    throw new HttpError(409, 'job_already_uploaded', 'This job already received its result.');
  }
  if (Date.parse(row.expiresAt) < Date.now()) {
    throw new HttpError(403, 'job_token_invalid', 'Invalid or expired upload ticket.');
  }

  await env.DB.prepare('UPDATE bg_jobs SET status = ? WHERE job_id = ?')
    .bind('uploaded', jobId)
    .run();
}

/** Best-effort cleanup of expired tickets. Failure here must never fail a request. */
export async function pruneJobTickets(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM bg_jobs WHERE expires_at < ?')
    .bind(new Date(Date.now() - TICKET_TTL_MS).toISOString())
    .run()
    .catch(() => undefined);
}
