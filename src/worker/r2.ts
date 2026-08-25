import type { Env } from './types';

export function base64ToBytes(base64Data: string): Uint8Array {
  const clean = base64Data.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binaryString = atob(clean);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Store bytes under a caller-chosen key. saveImageToR2 invents a random key, which is
 * right for results but useless for a handoff: both sides have to know the key up front.
 */
export async function putImageAtKey(
  env: Env,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  label: string,
  /** Extra custom metadata to travel with the object, e.g. a staged input's digest. */
  metadata: Record<string, string> = {},
): Promise<{ r2Key: string; r2Url: string } | null> {
  if (!env.R2_IMAGE) {
    return null;
  }
  await env.R2_IMAGE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { label, createdAt: new Date().toISOString(), ...metadata },
  });
  return { r2Key: key, r2Url: `/api/r2/${encodeURIComponent(key)}` };
}

export async function saveImageToR2(
  env: Env,
  dataUrlOrBase64: string,
  mimeType: string,
  label: string,
): Promise<{ r2Key: string; r2Url: string } | null> {
  if (!env.R2_IMAGE) {
    return null;
  }

  try {
    let cleanBase64 = dataUrlOrBase64;
    let contentType = mimeType || 'image/png';

    if (dataUrlOrBase64.startsWith('data:')) {
      const match = dataUrlOrBase64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (match) {
        contentType = match[1];
        cleanBase64 = match[2];
      } else {
        const commaIdx = dataUrlOrBase64.indexOf(',');
        if (commaIdx !== -1) {
          cleanBase64 = dataUrlOrBase64.slice(commaIdx + 1);
        }
      }
    }

    const bytes = base64ToBytes(cleanBase64);
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
    const uuid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    const key = `rmbg_${Date.now()}_${uuid.slice(0, 8)}.${ext}`;

    await env.R2_IMAGE.put(key, bytes, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        label,
        createdAt: new Date().toISOString(),
      },
    });

    return {
      r2Key: key,
      r2Url: `/api/r2/${encodeURIComponent(key)}`,
    };
  } catch (err) {
    console.error('Failed to store image in Cloudflare R2:', err);
    return null;
  }
}
