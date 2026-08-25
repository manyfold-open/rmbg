import { GoogleGenAI } from '@google/genai';
import { HttpError, type AgentCredential, type Env } from './types';
import { listConnectedAgents, credentialFor } from './connect';
import { consumeA2AStream, fetchImageAsDataUrl, type StreamSnapshot } from './a2a';
import { loadAppSettings } from './settings-manager';
import { base64ToBytes, putImageAtKey, saveImageToR2 } from './r2';
import {
  INPUT_DIGEST_METADATA,
  createJobTicket,
  pruneJobTickets,
  setJobNote,
  sha256Hex,
  type JobTicket,
} from './job';

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

/**
 * An agent accepts a limited number of concurrent A2A delegations — measured at 8. Past that
 * the platform rejects the *dispatch* in well under a second:
 *
 *   RPC error -32603: too many concurrent A2A delegations (8/8); retry when one finishes
 *
 * That is categorically different from the stream drops this file otherwise defends against.
 * A dropped stream means the turn is running and we stopped hearing about it, so waiting is
 * right. A rejected dispatch means the turn *never started*: no upload is coming, and waiting
 * for one burns the ticket's whole ten-minute TTL showing a spinner. It is also the most
 * retryable error here — a slot frees as soon as any sibling turn ends.
 *
 * Batch submissions hit this on every run by construction, so the job waits for a slot and
 * only fails once waiting is hopeless.
 */
const DISPATCH_RETRY_BASE_MS = 2_000;
const DISPATCH_RETRY_MAX_MS = 30_000;
const DISPATCH_RETRY_WINDOW_MS = 5 * 60_000;

/** True for a dispatch rejection, which is retryable, not for a stream that died mid-turn. */
export function isDispatchRejection(message: string): boolean {
  return /too many concurrent\b.*\bdelegations/i.test(message);
}

/** Exponential backoff with jitter, so sibling jobs do not all retry on the same tick. */
export function dispatchRetryDelay(attempt: number, random = Math.random): number {
  const capped = Math.min(DISPATCH_RETRY_BASE_MS * 2 ** attempt, DISPATCH_RETRY_MAX_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
}

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
 * The scratch directory this job owns on the agent's filesystem.
 *
 * Every path in the instructions is absolute and job-specific, because the agent runs *all*
 * of its delegations in one sandbox. Verified 2026-08-25 by probing it directly: a single
 * hostname, a single `/tmp`, and after a batch of a dozen images exactly one `/tmp/input.png`,
 * one `/tmp/gen.png` and one `/tmp/output.png` left behind. The client submits six at a time,
 * so six turns were writing those same three paths.
 *
 * The failure that produced was not a crash. A turn would download its own input, have it
 * overwritten by a sibling mid-turn, then key, cut out and upload the *sibling's* picture
 * under its own job token: right destination, wrong image. Nothing downstream can catch it —
 * the bytes are a perfectly valid cutout, just of something else — which is why the fix has
 * to be that two turns never name the same file.
 *
 * A shell variable would not do. Each command here is run as its own tool call with a fresh
 * shell, so anything exported in one is gone by the next. The path has to be a literal, and
 * this is where it is baked in.
 */
export function workDirFor(jobId: string): string {
  return `/tmp/rmbg-${jobId}`;
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
 * It asks for that flat colour *twice*, white and then black, because one frame is not enough
 * to recover alpha — it can only be guessed at. Every version of this pipeline up to
 * 2026-08-25 keyed a single frame: alpha from a colour distance to the background, then
 * `(rgb - key*(1-a))/a` to un-mix the spill. Measured against the original on a real
 * production result, that estimate cost the following:
 *
 *              original    single-frame key    two frames
 *   edge ramp     1 px           12-14 px          2 px
 *   partial α    0.04%        7.33-10.02%         0.06%
 *   silhouette      —          IoU 0.9350        IoU 0.9698
 *                             4522 too fat        0 too fat
 *                             1391 eaten       2610 eaten
 *
 * (Both columns measured on the same 2048x2048 image on 2026-08-25, the middle one straight
 * off the deployed Worker. What remains is a ~1 px tight boundary: the model renders the
 * subject about 1700 px short of the original's own silhouette in *both* frames, with
 * centroids agreeing to 0.3 px and bounding boxes to 2 px — so it is the model drawing a
 * slightly tighter edge, not the two frames drifting apart.)
 *
 * and it left an enclosed hole in the middle of the subject fully opaque. None of that was a
 * tuning failure. A distance-to-key threshold flattens the ramp, the un-mix over-subtracts
 * near the edge (the halo) and divides residue by an alpha of ~0.04 out in the background
 * (the confetti of stray coloured pixels). Every artefact was a by-product of estimating.
 *
 * Two frames make it arithmetic instead. With the same subject composited over white and over
 * black, `obs_white - obs_black = (1 - α)·255` for any subject colour whatsoever, so
 * `α = 1 - mean(obs_white - obs_black)/255` and `F = obs_black / α`. That is an identity, not
 * an estimate: no key colour means no spill and no colour fringe, a continuous α means hair,
 * fur, glass and soft edges survive as the fractional values they really are, and no threshold
 * means there is no residue to clean up afterwards. It also handles what chroma-key
 * structurally cannot — a white shirt shot against a white wall — because the subject is never
 * identified by its colour at all.
 *
 * The second call must *edit* the white frame rather than regenerate from the input: the
 * identity holds only where the subject pixels are the same in both frames. Two independent
 * generations drift, and the drift lands in α.
 *
 * The white instruction spells out that an area *enclosed* by the subject is still background.
 * Without that sentence the model reads an enclosed gap as part of the object and paints
 * around it, so both frames agree there and α comes out 1 — which is exactly how the hole in
 * the middle of the bench image survived as 4387 fully opaque pixels, and the whole of the
 * "4505 px too fat" above. Adding it took that region to α=0 across all 4387 pixels and the
 * too-fat count to zero. It is a statement about what background *means*, not a hint about
 * any particular picture.
 *
 * Both calls set `imageConfig.imageSize = '2K'` (capital K; lowercase is rejected). Left
 * unset, the API defaults to 1K and the mask arrives at 1024x1024 to be LANCZOS-stretched to
 * a 2048x2048 input — half the measured edge width was that stretch. Verified on the live
 * agent 2026-08-25: a 1024x1024 input came back 2048x2048 at 1958 candidate tokens against
 * ~1290 for a 1K frame, so the model honours it rather than upscaling a 1K render.
 *
 * Finally, STEP 3 takes the *interior* of the cutout from the original photo and only the
 * partially-transparent edge from the solved frame. It used to take every pixel from the
 * generated frame, with the original consulted for nothing but its dimensions, and every
 * pixel of it was the model's redrawing of the subject rather than the subject. The edge
 * still comes from the solved frame because an anti-aliased boundary is a blend of subject
 * and background that the original cannot supply.
 */
function agentInstructions(
  workDir: string,
  inputUrl: string,
  uploadUrl: string,
  token: string,
  model: string,
): string {
  return `Remove the background from an image. Do the work with shell commands — do not answer from the attached preview alone.

Every path below is inside ${workDir}, which belongs to this job alone. Other background
removals are running in the same sandbox at the same time, writing files of their own. Use
these exact paths and do not shorten them to a bare name directly under /tmp: a shared name
makes two jobs overwrite each other's images, and each one then uploads the other's picture.

STEP 0 — create this job's working directory:
  mkdir -p ${workDir}
  find /tmp -maxdepth 1 -type d -name 'rmbg-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

STEP 1 — download the image:
  curl -sS -o ${workDir}/input.png '${inputUrl}'

If you hold a background-removal skill that has you pick a key colour and chroma-key it out of
one generated frame, ignore it for this job: the steps below replace that procedure outright.
There is no key colour here, nothing to choose, and nothing to type in by hand.

STEP 2 — render this subject twice, once over white and once over black. Run this verbatim:

  python3 - <<'EOF'
from google import genai
from google.genai import types
from PIL import Image
import sys
D = '${workDir}'
client = genai.Client()

def gen(src, out, instruction):
    data = open(src, 'rb').read()
    mime = 'image/' + (Image.open(src).format or 'PNG').lower()
    r = client.models.generate_content(
        model='${model}',
        contents=[types.Part.from_bytes(data=data, mime_type=mime), instruction],
        config=types.GenerateContentConfig(
            image_config=types.ImageConfig(image_size='2K'),
        ),
    )
    blob = None
    for p in r.candidates[0].content.parts:
        inline = getattr(p, 'inline_data', None)
        if inline and inline.data:
            blob = inline.data
            break
    if blob is None:
        sys.exit('NO IMAGE for ' + out + ' :: ' + str(r.candidates[0].finish_reason))
    open(out, 'wb').write(blob)
    print('%s %s tokens=%s' % (out.rsplit('/', 1)[-1], Image.open(out).size,
                               r.usage_metadata.candidates_token_count))

WHITE = ("Replace the entire background with solid pure white, RGB exactly 255,255,255. "
         "The background is everything that is not the subject, and that includes any area "
         "fully enclosed by the subject: a hole through it, a gap between its parts, the "
         "space inside a handle, a loop or a ring. If the backdrop is visible through it, it "
         "is background and it must come out white too. "
         "One flat colour: no gradient, no shadow, no reflection, no vignette, no texture. "
         "Keep the subject pixel-for-pixel identical: same position, same size, same framing, "
         "same colours, same lighting, same edge detail. Change only the background.")
BLACK = ("Keep this image exactly as it is and change only the background colour: every pixel "
         "that is currently pure white background becomes solid pure black, RGB exactly 0,0,0. "
         "Do not move, resize, recolour, relight or redraw the subject - every subject pixel "
         "must stay exactly where it is and keep its exact colour. Only the background changes.")

gen(D + '/input.png', D + '/white.png', WHITE)
gen(D + '/white.png', D + '/black.png', BLACK)
EOF

Three things about that script are load-bearing, so run it as written rather than calling the
model your own way:

  - The second call edits ${workDir}/white.png. It does NOT start again from input.png. STEP 3
    subtracts one frame from the other, and that subtraction only means anything if the subject
    is in the same place with the same colours in both. Two independent generations drift, and
    the drift lands in the alpha channel as a ruined edge.
  - imageConfig.imageSize is '2K', capital K. Lowercase is rejected. Left unset the API gives
    you 1K, and a 1024-wide mask stretched over a 2048-wide photo is a blurred edge you cannot
    get back.
  - Do NOT ask for transparency, and do NOT accept a grey-and-white checkerboard. A
    checkerboard is a drawing of transparency, not transparency, and it will be rejected.

It prints one line per frame, e.g. \`white.png (2048, 2048) tokens=1958\`. Include both lines in
your final reply.

STEP 3 — solve for the alpha channel, at the original size:

  python3 - <<'EOF'
from PIL import Image
import numpy as np, sys
D = '${workDir}'
src = Image.open(D + '/input.png').convert('RGB')

def frame(name):
    im = Image.open(D + '/' + name).convert('RGB')
    if abs(im.size[0] / im.size[1] - src.size[0] / src.size[1]) > 0.01:
        print('WARNING %s is %s but the input is %s, so the model changed the shape of the '
              'frame and the mask has to be stretched to fit.' % (name, im.size, src.size))
    if im.size != src.size:
        im = im.resize(src.size, Image.LANCZOS)
    return np.array(im).astype(np.float32)

white, black = frame('white.png'), frame('black.png')
# The same subject over two known backgrounds is two equations in one unknown:
#   obs_white = alpha * F + (1 - alpha) * 255
#   obs_black = alpha * F + (1 - alpha) * 0
# Subtracting cancels the subject entirely, whatever colour it is:
#   obs_white - obs_black = (1 - alpha) * 255
d = np.clip((white - black).mean(axis=2), 0.0, 255.0)
alpha = 1.0 - d / 255.0
# Two model calls never return byte-identical subject pixels, so d wobbles a few counts either
# side of zero across solid parts of the subject. Snap only those last few counts at each end;
# every fractional alpha in between is the identity above and is left exactly as solved.
alpha[d <= 8.0] = 1.0
alpha[d >= 247.0] = 0.0
a8 = np.round(alpha * 255).astype(np.uint8)
clear = float((a8 == 0).mean())
solid = float((a8 == 255).mean())
print('CHECK transparent=%.2f%% partial=%.2f%% opaque=%.2f%%'
      % (clear * 100, (1 - clear - solid) * 100, solid * 100))
if clear < 0.01:
    sys.exit('THE TWO FRAMES MATCH: only %.2f%% of this came out transparent, so white.png and '
             'black.png carry the same background and there is nothing to subtract. Redo STEP 2 '
             'and check the second call really edited white.png to a black background. Do not '
             'upload this.' % (clear * 100))
if solid < 0.001:
    sys.exit('THE SUBJECT IS GONE: %.2f%% of this is fully opaque, so one of the two frames '
             'came back blank. Redo STEP 2. Do not upload this.' % (solid * 100))
# Un-premultiply: obs_black is alpha * F, so the subject's own colour is obs_black / alpha.
# Fully-opaque pixels are taken from the ORIGINAL instead — the model redraws the subject, and
# its redrawing is not the photograph the user sent. Only the partly-transparent edge comes
# from the solved frame, because an anti-aliased boundary is a blend of subject and background
# that the original cannot supply.
F = black / np.clip(alpha, 1e-3, 1.0)[..., None]
rgb_out = np.where(a8[..., None] == 255,
                   np.array(src, dtype=np.float32),
                   np.clip(F, 0.0, 255.0)).astype(np.uint8)
Image.fromarray(np.dstack([rgb_out, a8]), 'RGBA').save(D + '/output.png')
EOF

That script is complete as written. There is no threshold to tune, no key colour to fill in and
no number to retype — it reads the two frames STEP 2 wrote and solves for alpha directly. Do not
edit it, and in particular do not replace the subtraction with a colour comparison against one
frame: estimating alpha from a colour distance is exactly the method this replaced, and it cost
a 13-pixel blurred edge, a coloured halo and a scatter of stray background pixels.

Do not "improve" it by taking the colour channels from the generated frames instead of src
either. Keeping the original's own pixels inside the silhouette is why the result is sharp; the
generated frames are there to say *where* the subject is and how much of it is there, not to
redraw it.

Print the CHECK line in your reply. If either sys.exit fires, the two frames do not carry
different backgrounds — go back to STEP 2, run it again, and do not upload a file this script
refused to write.

If PIL, numpy or google-genai is unavailable, do not improvise and do not upload — say which
import failed in your reply instead.

STEP 4 — upload the result:
  curl -sS -X PUT --data-binary @${workDir}/output.png \\
    -H 'content-type: image/png' \\
    -H 'x-job-token: ${token}' \\
    -H "x-input-sha256: $(sha256sum ${workDir}/input.png | cut -d' ' -f1)" \\
    '${uploadUrl}'

That last header is a checksum of the file you actually processed. The Worker compares it with
the image it staged for this job and rejects the upload if they differ, which is how a mixed-up
input gets caught instead of being delivered to the wrong person. Compute it from
${workDir}/input.png as shown — do not copy a checksum from anywhere else.

A 200 response means the upload succeeded. Then reply with DONE, followed by the two frame
lines STEP 2 printed and the CHECK line STEP 3 printed — nothing else. Those three lines are
the only record of what resolution the model actually returned and how much of the frame came
out transparent, and they are read by a person, not parsed by the Worker.

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
  // Re-created per dispatch attempt: a rejected dispatch consumed none of the turn's budget,
  // so the timeout should start when a turn actually starts.
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);

  try {
    let snapshot: StreamSnapshot | null = null;
    let streamError: string | null = null;
    const dispatchDeadline = Date.now() + Math.min(graceMs, DISPATCH_RETRY_WINDOW_MS);

    // Built once and reused across dispatch retries. Holding the messageId steady is
    // deliberate: a retry that reaches a platform which deduplicates by messageId resolves
    // to the original task rather than billing a second turn.
    const params = {
      message: {
        kind: 'message' as const,
        role: 'user' as const,
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
            kind: 'text' as const,
            text: agentInstructions(
              workDirFor(ticket.jobId),
              job.inputUrl,
              job.uploadUrl,
              ticket.token,
              job.model,
            ),
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
    };

    for (let attempt = 0; ; attempt++) {
      try {
        snapshot = await consumeA2AStream({ cred, params, signal: controller.signal });
        break;
      } catch (streamErr: unknown) {
        const message = streamErr instanceof Error ? streamErr.message : String(streamErr);

        if (isDispatchRejection(message)) {
          // Out of patience with the turn never dispatched: no upload can arrive, so say so
          // now instead of holding the browser until the ticket expires.
          if (Date.now() >= dispatchDeadline) {
            await setJobNote(
              env,
              ticket.jobId,
              'failed',
              `The Agent stayed at capacity for too long, so this image was never started. ${message}`,
            );
            throw new HttpError(
              503,
              'agent_busy',
              `Manyfold Agent ("${agentName}") is at capacity: ${message}`,
            );
          }

          // Nothing started, so there is nothing to wait for and everything to gain by
          // asking again once a sibling turn frees a slot.
          const delay = dispatchRetryDelay(attempt);
          console.warn(`Manyfold A2A dispatch rejected, retrying in ${delay}ms:`, message);
          await setJobNote(
            env,
            ticket.jobId,
            'progress',
            `The Agent is at capacity. Waiting for a free slot, then retrying (attempt ${attempt + 2}).`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          clearTimeout(timer);
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);
          continue;
        }

        // Do not give up here. The agent's upload travels over plain HTTPS and is
        // completely independent of this stream, so a dropped stream is not evidence
        // that the job failed — only that we stopped hearing about it.
        streamError = message;
        console.error('Manyfold A2A stream error:', streamError);
        await setJobNote(
          env,
          ticket.jobId,
          'progress',
          `The Agent connection was interrupted (${streamError}), but the Agent is still running. Waiting for its upload.`,
        );
        break;
      }
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
        const inputBytes = base64ToBytes(base64Data);
        await putImageAtKey(
          env,
          ticket.inputKey,
          inputBytes,
          mimeType,
          `input for ${selectedAgent.name}`,
          // Travels with the object so the upload route can tell a cutout of *this* image
          // apart from a cutout of whatever a sibling job happened to leave lying around.
          { [INPUT_DIGEST_METADATA]: await sha256Hex(inputBytes) },
        );
        const job: AgentJob = {
          env,
          cred,
          agentName: selectedAgent.name,
          ticket,
          inputUrl: `${origin}/api/r2/${encodeURIComponent(ticket.inputKey)}`,
          uploadUrl: `${origin}/api/job/${ticket.jobId}/output`,
          mimeType,
          // Fixed, not settings.bgRemoveModel: only an -image model can render the white and
          // black frames STEP 2 needs (see GEMINI.md). bgRemoveModel picks the text model for
          // the legacy direct-API SVG-path fallback below, which is a different job entirely.
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
