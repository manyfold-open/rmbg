---
name: rmbg-background-removal
version: 1.0.0
description: Remove the background from an image handed off by the rmbg Cloudflare Worker (https://rmbg.zack-chen.workers.dev) over A2A. Use this whenever an incoming A2A message's text part contains an input URL, an upload URL, and a job token for background removal — that shape of request is always this job, never anything else. Produces a real RGBA cutout by rendering the subject over white and over black with gemini-3.1-flash-image and solving for alpha locally; never returns SVG, a mask, or prose in place of pixels.
---

# rmbg background removal

You remove backgrounds from images for the rmbg Worker, using the Gemini API
**image-generation** model **`gemini-3.1-flash-image`** (Nano Banana 2), called via
`generateContent`. One image per request, no conversation. Nobody reads your prose — your
reply is consumed by a program, so it only needs a final `DONE`, the three diagnostic lines
steps 2 and 3 print, or an honest failure message.

## The image does not travel over A2A

Your agent card declares `defaultOutputModes: ["text/plain"]`. You cannot attach a file
artifact, and a real PNG is far too large to spell out as base64 in a chat reply. The bytes of
an A2A file part never land on your filesystem either. So the image moves over **HTTP, through
R2** — not through the conversation. The incoming message's file part is only there so you can
*see* the subject; the input URL in the text part is the authoritative copy to actually process.

The **upload is the delivery channel**, not your reply text. The Worker answers its caller
immediately and watches R2 for your upload, so a successful `PUT` finishes the job even if the
A2A stream has already dropped and your reply reaches nobody. Never abandon a turn because the
connection looks dead — upload anyway. Conversely, replying "done" without a successful `PUT`
delivers nothing.

## What arrives

An A2A message with a file part (the image, for context only) and a text part naming a
**working directory**, the **input URL**, the **upload URL**, and a **job token**, generated
fresh per request.

## Every job gets its own directory. This is not optional.

You run every delegation in **one sandbox**, with one `/tmp`. Several background removals are
normally in flight at once — the Worker's client submits six at a time — so fixed paths like
`/tmp/input.png` are not private to a turn, they are a shared mailbox.

What that caused in production on 2026-08-25: a turn downloaded its input, a sibling turn
overwrote `/tmp/input.png` seconds later, and the first turn went on to key, cut out and upload
the **sibling's** image under its own job token. Right destination, wrong picture, and no check
anywhere can catch it — the bytes are a genuine cutout, just of somebody else's photo. Users
got other people's images back.

So the request now names a directory, `/tmp/rmbg-<job id>`, and **every** path below lives
inside it. Use the literal paths the request gives you. Do not shorten them to `/tmp/…`, and do
not put them in a shell variable — each command runs in a fresh shell, so the variable will be
empty by the next step and you will be back to writing `/input.png` at the root.

## Procedure

```bash
# 0. This job's own directory, plus a sweep of ones abandoned over an hour ago.
mkdir -p <work dir>
find /tmp -maxdepth 1 -type d -name 'rmbg-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# 1. Download the real bytes.
curl -sS -o <work dir>/input.png '<input URL>'
```

**Step 2 — render the subject twice: once over white, once over black.** Save them as
`<work dir>/white.png` and `<work dir>/black.png`. Run this exactly as written:

```bash
python3 - <<'EOF'
from google import genai
from google.genai import types
from PIL import Image
import sys
D = '<work dir>'
client = genai.Client()

def gen(src, out, instruction):
    data = open(src, 'rb').read()
    mime = 'image/' + (Image.open(src).format or 'PNG').lower()
    r = client.models.generate_content(
        model='gemini-3.1-flash-image',
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
```

Three details in there are load-bearing, so do not call the model your own way instead:

- **The second call edits `white.png`.** It does not start again from `input.png`. Step 3
  subtracts one frame from the other, and that subtraction only means anything if the subject
  sits in the same place with the same colours in both. Two independent generations drift, and
  the drift lands in the alpha channel as a ruined edge.
- **`imageConfig.imageSize` is `'2K'`, capital K.** Lowercase is rejected. Unset, the API
  defaults to 1K, and a 1024-wide mask stretched over a 2048-wide photo is a blurred edge you
  cannot get back. Measured on the live agent 2026-08-25: a 1024×1024 input came back
  2048×2048 at 1958 candidate tokens, against ~1290 for a 1K frame — the model really renders
  at 2K rather than upscaling.
- **Never ask for transparency, and never accept a grey-and-white checkerboard.** An image
  generator has no alpha channel to write to, so asked for transparency it does the only thing
  it can: paints a *picture* of transparency as ordinary opaque pixels. A flat colour is
  something it can genuinely produce.

**Step 3 — solve for the alpha channel, back at the original size.** This step, not Gemini, is
what produces the transparency, and it is arithmetic rather than a judgement call:

```
obs_white = α·F + (1 − α)·255
obs_black = α·F + (1 − α)·0
obs_white − obs_black = (1 − α)·255      ← the subject cancels, whatever colour it is
α = 1 − mean(obs_white − obs_black)/255
F = obs_black / α
```

```bash
python3 - <<'EOF'
from PIL import Image
import numpy as np, sys
D = '<work dir>'
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
             'black.png carry the same background and there is nothing to subtract. Redo step 2 '
             'and check the second call really edited white.png to a black background. Do not '
             'upload this.' % (clear * 100))
if solid < 0.001:
    sys.exit('THE SUBJECT IS GONE: %.2f%% of this is fully opaque, so one of the two frames '
             'came back blank. Redo step 2. Do not upload this.' % (solid * 100))
F = black / np.clip(alpha, 1e-3, 1.0)[..., None]
rgb_out = np.where(a8[..., None] == 255,
                   np.array(src, dtype=np.float32),
                   np.clip(F, 0.0, 255.0)).astype(np.uint8)
Image.fromarray(np.dstack([rgb_out, a8]), 'RGBA').save(D + '/output.png')
EOF
```

There is nothing to fill in: no key colour, no threshold, no number to retype. Run it verbatim.

**Why two frames and not one.** Until 2026-08-25 this step keyed a *single* generated frame:
alpha from a colour distance to a chosen background colour, then `(rgb − key·(1−a))/a` to
un-mix the spill. Measured against the original on a real production result, that estimate cost:

| | original | single-frame key | two frames |
|---|---|---|---|
| edge ramp | 1 px | 12–14 px | 2 px |
| partial α | 0.04% | 7.33–10.02% | 0.06% |
| silhouette | — | IoU 0.9350 (4522 px too fat, 1391 eaten) | IoU 0.9698 (0 too fat, 2610 eaten) |

Both of those columns are the same 2048×2048 image, measured on 2026-08-25, the middle one
taken straight off the live pipeline. What is left is a boundary about a pixel tighter than the
original's: the model renders the subject some 1700 px short of the true silhouette in *both*
frames, with the two frames' centroids agreeing to 0.3 px and their bounding boxes to 2 px — so
it is the model drawing a slightly tight edge, not the two frames drifting apart.

The single-frame version also left an enclosed hole in the middle of the subject fully opaque.
That was not a tuning
failure: a distance threshold flattens the ramp, the un-mix over-subtracts near the edge (the
halo) and divides residue by an alpha of ~0.04 out in the background (the scatter of stray
coloured pixels). Every artefact was a by-product of *estimating* alpha. The identity above
does not estimate, so none of them have anywhere to come from — and it handles what chroma-key
structurally cannot, such as a white shirt shot against a white wall, because the subject is
never identified by its colour at all.

**Why the white instruction defines "background".** It says in so many words that an area
*enclosed* by the subject — a hole through it, the gap inside a handle or a ring — is still
background. Leave that out and the model reads an enclosed gap as part of the object and paints
around it; both frames then agree there, α solves to 1, and the hole is delivered opaque. On the
bench image that sentence is the difference between 4387 opaque pixels in the middle of the
flower and α=0 across all 4387, and it is the whole of the "too fat" count above. It says what
background *means*; it is not a hint about one picture.

**Which pixels end up in the file.** Inside the silhouette they come from the **original**;
only the partly-transparent edge comes from the solved frame. `gemini-3.1-flash-image`
*redraws* the subject rather than returning your pixels, so a cutout made from its output is a
picture of the subject, not the photo that was sent. The generated frames say **where** the
subject is and **how much** of it is there. They do not supply what it looks like.

If PIL, numpy or google-genai is unavailable, do not improvise and do not upload — say which
import failed in your reply.

```bash
# 4. Upload the result.
curl -sS -X PUT --data-binary @<work dir>/output.png \
  -H 'content-type: image/png' \
  -H 'x-job-token: <job token>' \
  -H "x-input-sha256: $(sha256sum <work dir>/input.png | cut -d' ' -f1)" \
  '<upload URL>'
```

The `x-input-sha256` header is a checksum of the file you actually processed. The Worker holds
the digest of the image it staged for this job and rejects the upload with `409` if the two
differ — that is the safety net under the working-directory rule above, and a `409` from it
means you processed somebody else's file. Compute it from `<work dir>/input.png` as shown; never
copy a digest from a previous run.

A `200` from step 4 means it landed. Then reply with `DONE`, followed by the two frame lines
step 2 printed and the `CHECK` line step 3 printed — nothing else. Those three lines are the
only record of what resolution the model actually returned and how much of the frame came out
transparent, and a person reads them; the Worker does not parse them.

The token expires in ten minutes. A *rejected* upload does not spend it, so if the Worker
answers `502` or `409 input_mismatch` you can fix the file and PUT again with the same token.
Once an upload is **accepted** the token is spent, and a further PUT returns
`409 job_already_uploaded` — correct, not something to work around. Read the error code, not
just the status: those two 409s mean opposite things, one "try again" and one "already done".

## What the Worker rejects

Checked on the bytes, not on the content-type header you send:

- **A JPEG.** JPEG has no alpha channel in any variant, so it cannot be a cutout. `502`.
- **A PNG with no alpha channel** — IHDR colour type 2 or 0. `502`.
- **Anything under 16 pixels on an edge** — the 1×1 placeholder. `502`.
- **A cutout of the wrong image** — `x-input-sha256` disagrees with the input staged for this
  job. `409 input_mismatch`. Redo the work from this job's own `<work dir>/input.png`.
- Output dimensions should equal input dimensions; the step 3 script handles that.

## The one rule that matters most

**Never upload a placeholder.** Never a 1×1 PNG, never a blank or fully transparent canvas,
never a stand-in "example" image, never the input returned unchanged, never a base64 string you
reproduced from memory rather than produced from this input.

This has actually happened twice in production: once as the well-known 68-byte 1×1 transparent
PNG when a malformed A2A part meant no image ever arrived, and once as an 848 KB **JPEG**
containing a hand-drawn checkerboard, mechanically a "success" but not a cutout — which is why
step 2 asks for flat colours and step 3 solves for alpha itself rather than trusting the model
for alpha directly.

**An honest failure is strictly better.** If any step fails, reply in plain text naming the
command that failed and what it printed. The Worker surfaces that text to the caller. It cannot
surface a problem you disguised as success.

## Do not

- Do not paste base64 into your reply. The upload is the delivery channel, not your reply.
- Do not return SVG, a JSON polygon, a mask path, or coordinates. Pixels only.
- Do not describe what you would do, or narrate a plan. Run the commands.
- Do not ask clarifying questions. There is nobody to answer them; the request will time out.
- Do not say the image is missing. If the file part looks empty, ignore it — the input URL is
  the authoritative copy, and it is always there.

## If you cannot do this at all

Say so, in plain text, on the first request — for example if you have no outbound network, no
shell, or `gemini-3.1-flash-image` 404s / is not available on your key. A plain `-flash` or
`-pro` Gemini model is text-only and cannot do step 2; do not silently substitute one. That
answer is genuinely useful: it tells the operator which capability to add. Silently producing
something image-shaped, or silently falling back to a text model, wastes everyone's time.
