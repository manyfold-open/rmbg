/**
 * Waiting for an asynchronous background-removal job.
 *
 * POST /api/remove-bg used to hold the connection open for the whole agent turn. It could
 * not: the turn takes about five minutes and the A2A stream the Worker depends on drops at
 * 126 seconds, so the browser was guaranteed to time out on work that had in fact
 * succeeded — the cutout was sitting in R2, unreachable. Now that route answers 202 with a
 * job id and the result is collected here instead.
 *
 * What the poller trusts, in order:
 *
 *   1. `output` — the result is in R2. This is written by the upload route itself, so it is
 *      true even when the Worker's own view of the job died with its stream.
 *   2. `note.kind === 'failed'` — the turn ended without a result. Stop and show why.
 *   3. `note.kind === 'progress'` — something worth saying, but not a verdict. Keep waiting.
 *
 * A lost stream produces a note while the upload is still in flight, which is exactly why
 * the result is checked before the note and why only `failed` ends the wait.
 */

const POLL_INTERVAL_MS = 2_500;

/** Beyond the ten-minute ticket nothing can still arrive, so stop a little short of it. */
const POLL_TIMEOUT_MS = 9 * 60_000;

export interface JobNote {
  kind: 'progress' | 'failed' | 'done';
  note: string;
  updatedAt: string;
}

export interface JobStatus {
  status: 'pending' | 'fetched' | 'uploaded' | string;
  createdAt: string;
  expiresAt: string;
  output: { key: string; size: number } | null;
  note: JobNote | null;
}

/** Plain-language progress for a status word that means nothing to whoever uploaded. */
export function describeJobStatus(status: JobStatus): string {
  if (status.note && status.note.kind !== 'done') return status.note.note;
  if (status.status === 'fetched') return 'Agent 已取得原圖,正在去背…';
  return 'Agent 已收到工作,正在準備…';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read an R2 object back as a data URL.
 *
 * The rest of the studio — history in localStorage, canvas export, the comparison slider —
 * is written against data URLs. Converting once here keeps the asynchronous path from
 * leaking a different representation into all of it.
 */
export async function fetchAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`無法讀取去背結果 (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('無法讀取去背結果的內容。'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Poll a job until its cutout exists, then return it as a data URL.
 *
 * `onProgress` is called on every poll so the UI can show the agent's own words rather
 * than a spinner that says nothing for five minutes.
 */
export async function waitForJobResult(
  statusUrl: string,
  onProgress?: (message: string, status: JobStatus) => void,
): Promise<{ dataUrl: string; key: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastNote: string | null = null;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);

    let status: JobStatus | null = null;
    try {
      const response = await fetch(statusUrl);
      if (response.ok) {
        status = (await response.json()) as JobStatus;
      } else if (response.status === 404) {
        throw new Error('去背工作已不存在(可能已逾時被清除)。');
      }
    } catch (err) {
      // A single failed poll is not a failed job — the result lands in R2 through a
      // completely separate request. Only the deadline below ends the wait.
      if (err instanceof Error && err.message.includes('去背工作已不存在')) throw err;
    }

    if (status) {
      if (status.output) {
        return {
          dataUrl: await fetchAsDataUrl(`/api/r2/${encodeURIComponent(status.output.key)}`),
          key: status.output.key,
        };
      }
      if (status.note?.kind === 'failed') {
        throw new Error(status.note.note);
      }
      onProgress?.(describeJobStatus(status), status);
      lastNote = status.note?.note ?? lastNote;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        lastNote
          ? `等待 Agent 去背結果逾時。Agent 最後的訊息:${lastNote}`
          : '等待 Agent 去背結果逾時,Agent 沒有回報任何進度。',
      );
    }
  }
}
