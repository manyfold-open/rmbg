import { GoogleGenAI } from '@google/genai';
import { HttpError, type AgentCredential, type Env } from './types';
import { listConnectedAgents, credentialFor } from './connect';
import { consumeA2AStream, fetchImageAsDataUrl, type StreamSnapshot } from './a2a';
import { loadAppSettings } from './settings-manager';
import { base64ToBytes, putImageAtKey, saveImageToR2 } from './r2';
import { createJobTicket, pruneJobTickets, setJobNote, type JobTicket } from './job';

export interface RemoveBgRequest {
  /** Base64 string or data URL */
  image: string;
  /** Optional agentId if multiple Manyfold agents are connected */
  agentId?: string;
}

export interface RemoveBgResponse {
  label: string;
  image?: string;
  mimeType?: string;
  svgPath?: string;
  boundingBox?: [number, number, number, number];
  r2Key?: string;
  r2Url?: string;
  /**
   * Set only on the asynchronous agent path. Its presence is the signal to the browser
   * that there is no image in this response and it should poll `statusUrl` instead.
   */
  jobId?: string;
  statusUrl?: string;
}

const REMOVE_BG_TIMEOUT_MS = 180_000;

/**
 * How long to keep watching R2 after the A2A stream *breaks*.
 *
 * The stream is a progress channel; the upload is the delivery channel. A lost stream —
 * seen in production as "Network connection lost" after ~2 minutes — tells us nothing
 * about the upload, so keep looking before calling the job failed. Only a turn that
 * actually reached a terminal state needs no grace: the agent is instructed to reply
 * after its upload returns 200, so a *finished* turn with an empty key never uploaded.
 */
const UPLOAD_GRACE_BROKEN_MS = 60_000;
const UPLOAD_POLL_MS = 2_000;

/**
 * The same grace, once nobody is waiting on the response.
 *
 * A real turn takes about five minutes; the stream dies at 126 seconds. Off the request's
 * critical path there is no reason to give up before the ticket does, so watch almost to
 * its ten-minute expiry. This is best-effort by nature — `waitUntil` work can be evicted —
 * and nothing depends on it: the upload route is what records the result. All this buys is
 * a written reason when the result never comes.
 */
const ASYNC_UPLOAD_GRACE_MS = 6 * 60_000;
const ASYNC_UPLOAD_POLL_MS = 5_000;

/** Poll R2 for the agent's upload until it lands or the grace period runs out. */
async function waitForUpload(
  bucket: R2Bucket,
  key: string,
  graceMs: number,
  pollMs = UPLOAD_POLL_MS,
): Promise<R2ObjectBody | null> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const hit = await bucket.get(key);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Anything smaller than this is a placeholder, not a cutout. */
const MIN_CUTOUT_BYTES = 512;
const MIN_CUTOUT_EDGE = 16;

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '') || 'png';
}

/** Chunked because String.fromCharCode(...bytes) blows the stack on a real image. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The instruction the agent receives. The image also rides along as an A2A FilePart so the
 * agent can *see* it, but seeing it is not enough: it reported it cannot materialise those
 * bytes onto its filesystem, and its card only allows text back. So the real work is done
 * against URLs, and the prompt spells out the commands rather than describing them.
 *
 * STEP 2 asks for a flat colour background rather than transparency on purpose. Asked for
 * transparency directly, the model painted a grey-and-white checkerboard — the *picture* of
 * transparency — as opaque RGB pixels, because an image generator has no alpha channel to
 * write to. A uniform colour is something it can actually produce, and turning one colour
 * into alpha is arithmetic the agent can do exactly.
 *
 * Which colour is chosen dynamically per image (STEP 1.5), not fixed to magenta. A subject
 * that is itself close to the key colour (a pink toy against magenta, say) doesn't fail
 * cleanly: every pixel near that hue picks up partial alpha from the plain distance-to-key
 * formula, and un-mixing then bleeds key colour into it, leaving a visible tinted fringe
 * around the subject — this happened in production 2026-08-24 on a pink plush toy. Picking
 * whichever candidate colour is farthest from every colour actually present in *this* photo,
 * instead of asking the agent to eyeball "is this subject magenta-ish", removes most of that
 * failure mode instead of relying on a judgement call.
 *
 * That alone was not enough. The alpha ramp in STEP 3 used to saturate to fully-opaque at a
 * *fixed* key-distance (a hardcoded threshold and slope), regardless of how close the actual
 * subject colours were to the key. Reproduced locally: pixels still mostly background-coloured
 * — a soft anti-aliased edge only ~25% blended toward the subject — got misread as 100% subject
 * and left completely uncorrected, baking a solid ring of raw key colour permanently into the
 * output right at the silhouette. That is a *worse* artefact than a diffuse fringe: it is a
 * crisp, fully-opaque coloured outline, matching exactly what showed up in production. The fix
 * is to scale the ramp to the actual key-to-subject distance for this image (STEP 1.5's
 * `mindist`) instead of a constant tuned for nothing in particular.
 *
 * STEP 1.5 hands its answer to STEP 3 through /tmp/key.json rather than through the agent.
 * The earlier version printed the numbers and asked the agent to paste them into placeholders
 * in STEP 3's script; measured over 12 production runs on 2026-08-25, it substituted magenta
 * instead of the computed colour in about a third of them, leaving stray key-coloured pixels
 * along the silhouette. More warnings did not help — the prompt already said not to. Removing
 * the transcription entirely does, and the remaining hand-carried value (STEP 2's request to
 * the image model) is now guarded: STEP 3 measures how much of the frame actually keyed out
 * and refuses to write an output when STEP 2's colour disagrees with the file, which would
 * otherwise produce a fully-opaque image that passes `assertUsableCutoutBytes` — that check
 * reads the PNG colour type, so an RGBA image whose alpha is 255 everywhere looks valid to it.
 */
function agentInstructions(inputUrl: string, uploadUrl: string, token: string, model: string): string {
  return `Remove the background from an image. Do the work with shell commands — do not answer from the attached preview alone.

STEP 1 — download the image:
  curl -sS -o /tmp/input.png '${inputUrl}'

STEP 1.5 — pick a background colour that is nothing like this subject:

  python3 - <<'EOF'
from PIL import Image
import numpy as np, json
img = np.array(Image.open('/tmp/input.png').convert('RGB')).reshape(-1, 3).astype(np.float32)
if len(img) > 20000:
    img = img[np.linspace(0, len(img) - 1, 20000).astype(int)]
candidates = {
    'magenta': (255, 0, 255),
    'green': (0, 255, 0),
    'cyan': (0, 255, 255),
    'yellow': (255, 255, 0),
    'blue': (0, 0, 255),
    'red': (255, 0, 0),
}
scores = {name: np.abs(img - np.array(rgb, dtype=np.float32)).sum(axis=1).min()
          for name, rgb in candidates.items()}
name = max(scores, key=scores.get)
r, g, b = candidates[name]
json.dump({'name': name, 'rgb': [r, g, b], 'mindist': float(scores[name])},
          open('/tmp/key.json', 'w'))
print(f'KEY {name} rgb=({r},{g},{b}) mindist={scores[name]:.0f}')
EOF

That prints one line, e.g. \`KEY cyan rgb=(0,255,255) mindist=142\`, and saves the same values
to /tmp/key.json. STEP 3 reads that file, so you never retype these numbers anywhere.

The one place the colour still passes through you by hand is STEP 2's request to the image
model, and the two must agree: STEP 3 keys out whatever /tmp/key.json says, so asking the model
for a different colour than this printed leaves nothing for it to key and the whole image comes
back opaque. Use the name this line printed and nothing else — do not default to magenta,
which is the specific mistake that keeps happening. If mindist is under 100, this subject spans
most of the colour wheel and no candidate is fully safe; proceed with the printed colour anyway,
but after STEP 3 look at /tmp/output.png's edges and say so honestly in your reply if you can
see a colour fringe, instead of uploading it silently.

STEP 2 — use ${model} to replace the background with the flat colour STEP 1.5 chose.

First re-read the colour rather than recalling it:
  cat /tmp/key.json

Then send /tmp/input.png to ${model} and ask for the same image with every background pixel
replaced by that solid colour, at exactly the RGB triple in that file. Save its output as
/tmp/gen.png.

  - Do NOT ask for transparency, and do NOT accept a grey-and-white checkerboard. A
    checkerboard is a drawing of transparency, not transparency, and it will be rejected.
  - The background must be one flat colour: no gradient, no shadow, no vignette, no texture.
  - Keep the subject's own pixels: colours, texture, hair, fur, edge detail, proportions.
    Do not restyle, recolour, crop or recompose the subject.

STEP 3 — turn that flat colour into a real alpha channel, at the original size:

  python3 - <<'EOF'
from PIL import Image
import numpy as np, json, sys
k = json.load(open('/tmp/key.json'))
key = np.array(k['rgb'], dtype=np.float32)
mindist = k['mindist']
src = Image.open('/tmp/input.png').convert('RGB')
gen = Image.open('/tmp/gen.png').convert('RGB').resize(src.size, Image.LANCZOS)
rgb = np.array(gen).astype(np.float32)
dist = np.abs(rgb - key).sum(axis=2)
lo, hi = 20.0, max(mindist, 21.0)
alpha = np.clip((dist - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
# Semi-transparent edge pixels are an anti-aliased blend of subject and key colour.
# Un-mix the key colour back out so the edge doesn't carry a colour fringe.
a = (alpha.astype(np.float32) / 255.0)[..., None]
decontam = np.clip((rgb - key * (1 - a)) / np.clip(a, 1e-3, 1), 0, 255)
rgb_out = np.where(alpha[..., None] < 255, decontam, rgb).astype(np.uint8)
clear = float((alpha < 10).mean())
print(f'CHECK key={k["name"]} transparent={clear*100:.1f}%')
if clear < 0.01 or clear > 0.99:
    sys.exit(f'KEY MISMATCH: only {clear*100:.1f}% keyed out, so STEP 2 did not paint the '
             f'background {k["name"]}. Redo STEP 2 with {k["name"]}. Do not upload this.')
Image.fromarray(np.dstack([rgb_out, alpha]), 'RGBA').save('/tmp/output.png')
EOF

That script is complete as written — run it verbatim. It reads the key colour and mindist from
/tmp/key.json, so there is nothing to fill in and nothing to retype. Do not edit the numbers,
do not paste a key colour in by hand, and do not hardcode a different mindist no matter how the
image looks: mindist sets how wide the alpha ramp is, and a ramp too narrow for this image is
exactly what used to bake a solid ring of raw background colour into the silhouette.

It prints a CHECK line and refuses to write /tmp/output.png if almost nothing or almost
everything was keyed out. That failure means STEP 2's background does not match /tmp/key.json —
the usual cause is asking the model for magenta when STEP 1.5 chose something else. Go back to
STEP 2, ask again using the colour named in the CHECK line, and rerun this script. Do not
upload a file this script rejected, and do not work around it by changing the key.

If PIL or numpy is unavailable, the equivalent with ImageMagick is:
  KEY=$(python3 -c "import json;print(json.load(open('/tmp/key.json'))['name'])")
  convert /tmp/gen.png -resize "$(identify -format '%wx%h!' /tmp/input.png)" \\
    -fuzz 20% -transparent "$KEY" /tmp/output.png
(ImageMagick knows all six candidate colour names directly, and json is in the standard library
even when PIL is missing, so there is nothing to type in by hand here either)
If neither tool exists, do not improvise and do not upload — say so in your reply instead.

STEP 4 — upload the result:
  curl -sS -X PUT --data-binary @/tmp/output.png \\
    -H 'content-type: image/png' \\
    -H 'x-job-token: ${token}' \\
    '${uploadUrl}'

A 200 response means the upload succeeded. Then reply with the single word DONE.

The upload is how the result gets back — your reply text is not the delivery channel, so do
not paste base64 into it. If any step fails, reply with plain text saying exactly which
command failed and what it printed. An honest failure is useful; a placeholder image, a 1x1
PNG, a checkerboard, or the input returned unchanged is worse than nothing and will be
rejected.`;
}

/** PNG dimensions straight out of the IHDR chunk. Null for anything that is not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 26) return null;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Can this PNG express transparency at all?
 *
 * IHDR byte 25 is the colour type: 6 = RGBA, 4 = grey+alpha, 3 = palette (transparent only
 * if a tRNS chunk is present), 2 = RGB, 0 = greyscale. Types 0 and 2 have nowhere to store
 * alpha, so a "cutout" in one of them is opaque by construction.
 *
 * This is not pedantry about file formats. Asked for a transparent background, the image
 * model returned an opaque RGB PNG with a grey-and-white checkerboard painted into it, and
 * every other check passed it: right magic bytes, sensible dimensions, 848 KB of real
 * detail. Colour type is what tells the two apart.
 */
export function pngHasAlpha(bytes: Uint8Array): boolean | null {
  if (!pngDimensions(bytes)) return null;
  const colorType = bytes[25];
  if (colorType === 6 || colorType === 4) return true;
  if (colorType === 3) {
    // Look for a tRNS chunk in the header region rather than walking every chunk: it is
    // required to appear before the first IDAT.
    const head = bytes.subarray(0, Math.min(bytes.length, 4096));
    for (let i = 0; i + 3 < head.length; i++) {
      if (head[i] === 0x74 && head[i + 1] === 0x52 && head[i + 2] === 0x4e && head[i + 3] === 0x53) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * An agent that never received the image still has to answer something, and in practice
 * it answers with a 1x1 transparent PNG. That used to sail through as a success: saved to
 * R2, HTTP 200, an invisible "result" for the user. Catch it here instead.
 */
/** JPEG has no alpha channel in any variant, so a JPEG cutout is a contradiction. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function assertUsableCutout(base64Data: string, agentName: string): void {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64Data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new HttpError(
      502,
      'agent_bad_image',
      `Manyfold Agent ("${agentName}") returned image data that could not be decoded.`,
    );
  }
  assertUsableCutoutBytes(bytes, agentName);
}

export function assertUsableCutoutBytes(bytes: Uint8Array, agentName: string): void {
  // Check the container before the contents. The first real cutout the agent uploaded was
  // 848 KB of genuine detail — and a JPEG, sent with content-type image/png. Every
  // size-and-dimension test passed it, because the problem was not the picture.
  if (isJpeg(bytes)) {
    throw new HttpError(
      502,
      'agent_opaque_image',
      `Manyfold Agent ("${agentName}") returned a JPEG. JPEG has no alpha channel and cannot be a cutout, ` +
        `so return a PNG (RGBA).`,
    );
  }

  // Dimensions are the real signal. Byte length is only a fallback for formats we cannot
  // measure — a flat-colour cutout compresses far below any sane byte threshold, so
  // applying both tests at once would reject perfectly good images.
  const dimensions = pngDimensions(bytes);
  const degenerate = dimensions
    ? dimensions.width < MIN_CUTOUT_EDGE || dimensions.height < MIN_CUTOUT_EDGE
    : bytes.length < MIN_CUTOUT_BYTES;

  if (degenerate) {
    const detail = dimensions ? `${dimensions.width}x${dimensions.height}` : `${bytes.length} bytes`;
    throw new HttpError(
      502,
      'agent_placeholder_image',
      `Manyfold Agent ("${agentName}") returned a placeholder instead of a cutout (${detail}). ` +
        `The Agent may not have received the image or may be unable to output an image.`,
    );
  }

  if (pngHasAlpha(bytes) === false) {
    throw new HttpError(
      502,
      'agent_opaque_image',
      `Manyfold Agent ("${agentName}") returned a PNG without an alpha channel, so it is not a cutout. ` +
        `A common failure is drawing a checkerboard instead of true transparency.`,
    );
  }
}

function parseRemoveBgJson(text: string): { label?: string; svgPath?: string; boundingBox?: [number, number, number, number] } {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*"svgPath"[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const sanitized = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    return JSON.parse(sanitized);
  }
}

/** Everything one delegated background removal needs, once the input is already staged. */
interface AgentJob {
  env: Env;
  cred: AgentCredential;
  agentName: string;
  ticket: JobTicket;
  inputUrl: string;
  uploadUrl: string;
  mimeType: string;
  model: string;
  r2Enabled: boolean;
  production: boolean;
}

/**
 * Run the agent's turn and collect its result.
 *
 * Called two ways: awaited, for the legacy synchronous response, and from `waitUntil`,
 * where the browser has already been given a job id and polls for the outcome. The only
 * difference is how long it is willing to wait — and that in the second case the return
 * value is dropped, so every conclusion it reaches is also written to the job's note.
 */
async function runAgentJob(job: AgentJob, graceMs: number, pollMs?: number): Promise<RemoveBgResponse> {
  const { env, cred, agentName, ticket } = job;
  const bucket = env.R2_IMAGE!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);

  try {
    let snapshot: StreamSnapshot | null = null;
    let streamError: string | null = null;

    try {
      snapshot = await consumeA2AStream({
        cred,
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: `rmbg-${crypto.randomUUID()}`,
            // No A2A FilePart here. The agent cannot read bytes off one anyway — the
            // text prompt's STEP 1 has it curl the full image from inputUrl, which is
            // the only path that actually feeds the pixels into processing. Inlining
            // the image as base64 in this JSON-RPC body too was pure duplication, and
            // for large originals (megapixel photos run ~4MB+ of base64) it pushed the
            // request over the agent endpoint's body-size limit: a straight HTTP 413
            // that left the job stuck pending until the ticket's 10-minute TTL expired.
            parts: [
              {
                kind: 'text',
                text: agentInstructions(job.inputUrl, job.uploadUrl, ticket.token, job.model),
              },
            ],
          },
          configuration: {
            acceptedOutputModes: [
              'image/png',
              'image/jpeg',
              'image/webp',
              'text/plain',
              'application/json',
            ],
          },
        },
        signal: controller.signal,
      });
    } catch (streamErr: unknown) {
      // Do not give up here. The agent's upload travels over plain HTTPS and is
      // completely independent of this stream, so a dropped stream is not evidence
      // that the job failed — only that we stopped hearing about it.
      streamError = streamErr instanceof Error ? streamErr.message : String(streamErr);
      console.error('Manyfold A2A stream error:', streamError);
      await setJobNote(
        env,
        ticket.jobId,
        'progress',
        `The Agent connection was interrupted (${streamError}), but the Agent is still running. Waiting for its upload.`,
      );
    }

    // Only a *terminal* snapshot means the turn is over. A stream can also just stop —
    // consumeA2AStream returns what it accumulated when the body ends without a final
    // event — and that is the same situation as a thrown connection error: the agent is
    // still working, we simply stopped hearing about it. Give both the full grace period.
    if (snapshot && !snapshot.terminal) {
      await setJobNote(
        env,
        ticket.jobId,
        'progress',
        `The Agent stopped reporting at "${snapshot.state}" but the job is still active. Waiting for its upload.`,
      );
    }

    // The upload is the expected channel, so look there before anything else.
    const finished = snapshot?.terminal === true;
    const uploaded = await waitForUpload(bucket, ticket.outputKey, finished ? 0 : graceMs, pollMs);
    if (uploaded) {
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      const finalMime = uploaded.httpMetadata?.contentType || 'image/png';
      const cutoutBase64 = bytesToBase64(bytes);
      assertUsableCutout(cutoutBase64, agentName);

      await setJobNote(env, ticket.jobId, 'done', snapshot?.text || 'Background removal complete.');
      void pruneJobTickets(env);
      return {
        label: agentName,
        image: `data:${finalMime};base64,${cutoutBase64}`,
        mimeType: finalMime,
        r2Key: ticket.outputKey,
        r2Url: `/api/r2/${encodeURIComponent(ticket.outputKey)}`,
      };
    }

    if (snapshot?.image) {
      let cutoutDataUrl: string;
      let finalMime = snapshot.image.mimeType || 'image/png';

      if (/^https?:\/\//i.test(snapshot.image.data)) {
        const fetched = await fetchImageAsDataUrl(snapshot.image.data, {
          cred,
          production: job.production,
        });
        cutoutDataUrl = fetched.dataUrl;
        finalMime = fetched.mimeType || finalMime;
      } else if (snapshot.image.data.startsWith('data:')) {
        cutoutDataUrl = snapshot.image.data;
      } else {
        cutoutDataUrl = `data:${finalMime};base64,${snapshot.image.data}`;
      }

      // Verify before it reaches R2 — a placeholder must not become a stored "result".
      assertUsableCutout(cutoutDataUrl.slice(cutoutDataUrl.indexOf(',') + 1), agentName);

      let r2Info: { r2Key: string; r2Url: string } | null = null;
      if (job.r2Enabled) {
        r2Info = await saveImageToR2(env, cutoutDataUrl, finalMime, agentName);
      }

      await setJobNote(env, ticket.jobId, 'done', snapshot.text || 'Background removal complete.');
      return {
        label: agentName,
        image: cutoutDataUrl,
        mimeType: finalMime,
        r2Key: r2Info?.r2Key,
        r2Url: r2Info?.r2Url,
      };
    }

    // Nothing in R2 and nothing scrapeable from the reply. Whatever the agent last
    // said is the only diagnosis available, so pass it through verbatim rather than
    // replacing it with a generic message. Name the job too: its output key is
    // readable at /api/r2/ if the upload turns up late.
    throw new HttpError(
      500,
      'agent_no_image',
      `Manyfold Agent ("${agentName}") did not upload the result to ${job.uploadUrl}. ` +
        (streamError ? `Connection issue: ${streamError}. ` : '') +
        `Agent response: ${snapshot?.text || '(no text response)'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRemoveBg(
  env: Env,
  body: RemoveBgRequest,
  origin: string,
  /**
   * Cloudflare's `executionCtx.waitUntil`. Given one, the agent path answers 202 with a
   * job id and runs the turn on borrowed time; without one it blocks, which is what the
   * tests and any non-request caller still expect.
   */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<RemoveBgResponse> {
  if (!body.image) {
    throw new HttpError(400, 'missing_image', 'Image data is required.');
  }

  const settings = await loadAppSettings(env);

  // Parse mime type and clean base64 data
  let mimeType = 'image/jpeg';
  let base64Data = body.image;

  if (body.image.startsWith('data:')) {
    const match = body.image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    } else {
      const commaIdx = body.image.indexOf(',');
      if (commaIdx !== -1) {
        base64Data = body.image.slice(commaIdx + 1);
      }
    }
  }

  const apiKey = env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');

  // 1. Prioritize Manyfold Agent A2A method if configured/allowed & connected
  if (settings.bgRemoveMode !== 'gemini_only') {
    const connectedAgents = await listConnectedAgents(env).catch(() => []);
    if (connectedAgents && connectedAgents.length > 0) {
      const selectedAgent = body.agentId
        ? connectedAgents.find((a) => a.agentId === body.agentId) || connectedAgents[0]
        : connectedAgents[0];

      try {
        const cred = await credentialFor(env, selectedAgent.agentId);

        if (!env.R2_IMAGE) {
          throw new HttpError(
            500,
            'r2_required',
            'R2 bucket R2_IMAGE is not bound. This path requires R2 because the Agent returns the image through storage.',
          );
        }

        // Hand the input over as a URL. The agent can download that; it cannot get at the
        // bytes of a FilePart, and it cannot send bytes back at all.
        const ticket = await createJobTicket(env, extensionFor(mimeType));
        await putImageAtKey(
          env,
          ticket.inputKey,
          base64ToBytes(base64Data),
          mimeType,
          `input for ${selectedAgent.name}`,
        );
        const job: AgentJob = {
          env,
          cred,
          agentName: selectedAgent.name,
          ticket,
          inputUrl: `${origin}/api/r2/${encodeURIComponent(ticket.inputKey)}`,
          uploadUrl: `${origin}/api/job/${ticket.jobId}/output`,
          mimeType,
          // Fixed, not settings.bgRemoveModel: only an -image model can do the chroma-key
          // step the agent runs (see GEMINI.md). bgRemoveModel picks the text model for the
          // legacy direct-API SVG-path fallback below, which is a different job entirely.
          model: 'gemini-3.1-flash-image',
          r2Enabled: settings.r2Enabled,
          production: env.ENVIRONMENT === 'production',
        };

        if (waitUntil) {
          // A turn takes about five minutes and the A2A stream dies at 126 seconds, so
          // waiting here means the browser never sees a result that was produced anyway.
          // Hand back the job id instead and let the upload route record the outcome.
          await setJobNote(
            env,
            ticket.jobId,
            'progress',
            `Image handed to Manyfold Agent ("${selectedAgent.name}"). Waiting for the cutout upload.`,
          );
          waitUntil(
            runAgentJob(job, ASYNC_UPLOAD_GRACE_MS, ASYNC_UPLOAD_POLL_MS).catch(
              async (err: unknown) => {
                // Nobody is left to throw to. The note is the only way this reaches the
                // user, so it has to be written even when the failure is our own bug.
                const message = err instanceof Error ? err.message : String(err);
                console.error('Manyfold A2A background job failed:', message);
                await setJobNote(env, ticket.jobId, 'failed', message);
              },
            ),
          );
          return {
            label: selectedAgent.name,
            jobId: ticket.jobId,
            statusUrl: `/api/job/${ticket.jobId}/status`,
          };
        }

        return await runAgentJob(job, UPLOAD_GRACE_BROKEN_MS);
      } catch (err: unknown) {
        if (err instanceof HttpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Manyfold A2A Error:', message);
        if (!apiKey || settings.bgRemoveMode === 'agent_only') {
          throw new HttpError(500, 'agent_error', `Manyfold Agent ("${selectedAgent.name}") failed: ${message}`);
        }
        console.warn('Falling back to direct Gemini API key legacy path after A2A failure.');
      }
    }
  }

  // 2. Direct Gemini API Key legacy fallback method if configured
  if (apiKey) {
    const baseUrl = env.MANYFOLD_API_BASE_URL && (typeof process !== 'undefined' ? process.env?.GOOGLE_GEMINI_BASE_URL : undefined);

    const ai = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });

    try {
      const modelName = settings.bgRemoveModel || 'gemini-3.6-flash';
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          settings.geminiSystemPrompt + `
Return a JSON object with the following schema:
{
  "label": "short description of all main foreground subjects",
  "svgPath": "smooth closed SVG path 'd' attribute string outlining all main subjects tightly in normalized coordinates (viewBox 0 0 1000 1000). Start with 'M', use bezier curves (C, S, Q) and line segments (L), and close every subpath with 'Z'. Coordinates must span 0 to 1000 where (0,0) is top-left and (1000,1000) is bottom-right.",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`,
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const text = response.text || '';
      const result = parseRemoveBgJson(text);

      if (!result.svgPath) {
        throw new Error('Gemini API did not return a valid SVG path mask.');
      }

      const label = result.label || 'Subject';

      return {
        label,
        svgPath: result.svgPath,
        boundingBox: result.boundingBox || [0, 0, 1000, 1000],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('RemoveBg Gemini Error:', message);
      throw new HttpError(500, 'gemini_error', `Failed to process image with Gemini API: ${message}`);
    }
  }

  throw new HttpError(
    400,
    'no_auth_method',
    'No AI processing service is available. Configure GEMINI_API_KEY in Cloudflare or connect a Manyfold Agent in Settings.'
  );
}
