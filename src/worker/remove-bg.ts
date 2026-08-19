import { GoogleGenAI } from '@google/genai';
import { HttpError, type Env } from './types';
import { listConnectedAgents, credentialFor } from './connect';
import { consumeA2AStream } from './a2a';

export interface RemoveBgRequest {
  /** Base64 string or data URL */
  image: string;
  /** Optional agentId if multiple Manyfold agents are connected */
  agentId?: string;
}

export interface RemoveBgResponse {
  label: string;
  svgPath: string;
  boundingBox: [number, number, number, number];
}

export async function handleRemoveBg(env: Env, body: RemoveBgRequest): Promise<RemoveBgResponse> {
  if (!body.image) {
    throw new HttpError(400, 'missing_image', 'Image data is required.');
  }

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

  // 1. Direct Gemini API Key method if configured
  if (apiKey) {
    const baseUrl = env.MANYFOLD_API_BASE_URL && (typeof process !== 'undefined' ? process.env?.GOOGLE_GEMINI_BASE_URL : undefined);

    const ai = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          `You are an expert computer vision model specializing in image segmentation and background removal.
Analyze the main subject in this image (e.g., person, pet, product, vehicle, object).
Extract the precise boundary contour of the main subject.
Return a JSON object with the following schema:
{
  "label": "short description of the subject",
  "svgPath": "smooth SVG path 'd' attribute string outlining the subject tightly in normalized coordinates (viewBox 0 0 1000 1000). Use bezier curves (C, S, Q) and line segments (L) so the contour fits smoothly around the subject.",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`,
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const text = response.text || '';
      const cleanJson = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const result = JSON.parse(cleanJson) as RemoveBgResponse;

      if (!result.svgPath) {
        throw new Error('Gemini API did not return a valid SVG path mask.');
      }

      return {
        label: result.label || 'Subject',
        svgPath: result.svgPath,
        boundingBox: result.boundingBox || [0, 0, 1000, 1000],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('RemoveBg Gemini Error:', message);
      throw new HttpError(500, 'gemini_error', `Failed to process image with Gemini API: ${message}`);
    }
  }

  // 2. Manyfold Agent A2A fallback method if a Manyfold Agent is connected
  try {
    const connectedAgents = await listConnectedAgents(env);
    if (connectedAgents && connectedAgents.length > 0) {
      const selectedAgent = body.agentId
        ? connectedAgents.find((a) => a.agentId === body.agentId) || connectedAgents[0]
        : connectedAgents[0];

      const cred = await credentialFor(env, selectedAgent.agentId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);

      try {
        const snapshot = await consumeA2AStream({
          cred,
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'inline-data',
                  mimeType,
                  data: base64Data,
                },
                {
                  kind: 'text',
                  text: `Analyze the main subject in this image and extract its precise boundary contour.
Return JSON ONLY:
{
  "label": "short description of subject",
  "svgPath": "smooth SVG path 'd' string in 0..1000 viewBox (0 0 1000 1000)",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`,
                },
              ],
            },
          },
          signal: controller.signal,
        });

        const text = snapshot.text || '';
        const cleanJson = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        const result = JSON.parse(cleanJson) as RemoveBgResponse;

        if (!result.svgPath) {
          throw new Error('Manyfold Agent did not return a valid SVG path mask.');
        }

        return {
          label: result.label || selectedAgent.name,
          svgPath: result.svgPath,
          boundingBox: result.boundingBox || [0, 0, 1000, 1000],
        };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    console.error('Manyfold A2A Error:', err);
  }

  throw new HttpError(
    400,
    'no_auth_method',
    '無可用的 AI 處理服務。請在 Cloudflare 設定 GEMINI_API_KEY，或在網站右上角點擊「Connect Manyfold Agent」授權您的 Agent！'
  );
}
