/**
 * One image, from data URL to cutout.
 *
 * Extracted from App so the single-image studio flow and the batch queue run exactly the
 * same code. They previously could not: the whole sequence — compress, POST, branch on
 * whether the response is a 202 job or an inline result, poll, convert — lived inside a
 * React handler that also drove component state, so a second caller would have had to
 * duplicate it and drift.
 */

import { compressImageForAI, createCutoutFromSvgPath } from './utils/image';
import { waitForJobResult } from './jobs';

export interface RemovalResult {
  /** The finished cutout as a data URL, whatever path produced it. */
  cutout: string;
  label: string;
  svgPath: string | null;
}

export interface RemovalOptions {
  agentId?: string | null;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

interface RemoveBgApiResponse {
  label?: string;
  image?: string;
  svgPath?: string;
  r2Key?: string;
  r2Url?: string;
  jobId?: string;
  statusUrl?: string;
}

export async function removeBackground(
  dataUrl: string,
  { agentId, onProgress, signal }: RemovalOptions = {},
): Promise<RemovalResult> {
  const compressed = await compressImageForAI(dataUrl, 1536, 0.85);

  const response = await fetch('/api/remove-bg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: compressed, ...(agentId ? { agentId } : {}) }),
    signal,
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      message?: string;
    };
    const detail = errorData.error?.message || errorData.message || `HTTP ${response.status}`;
    throw new Error(`Background removal failed (${detail})`);
  }

  const data = (await response.json()) as RemoveBgApiResponse;

  // A jobId means 202: the agent's turn runs in the Worker's waitUntil and the cutout
  // appears in R2 minutes from now. Nothing else in this response is a result.
  if (data.jobId && data.statusUrl) {
    const label = data.label || 'Manyfold Agent';
    onProgress?.(`Handed to ${label}. Waiting for the result…`);
    const { dataUrl: cutout } = await waitForJobResult(data.statusUrl, (message) =>
      onProgress?.(message),
    );
    return { cutout, label, svgPath: null };
  }

  if (!data.image && !data.svgPath) {
    throw new Error('Background removal failed: no cutout image was returned.');
  }

  const label = data.label || 'Subject detected';

  if (data.image) {
    return { cutout: data.image, label, svgPath: null };
  }

  // Legacy SVG path fallback: the cutout has to be rasterised against the original here.
  const svgPath = data.svgPath!;
  return { cutout: await createCutoutFromSvgPath(dataUrl, svgPath), label, svgPath };
}
