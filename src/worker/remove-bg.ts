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

function parseRemoveBgJson(text: string): RemoveBgResponse {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*"svgPath"[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  try {
    return JSON.parse(cleaned) as RemoveBgResponse;
  } catch {
    const sanitized = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    return JSON.parse(sanitized) as RemoveBgResponse;
  }
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

  // 1. Prioritize Manyfold Agent A2A method if a Manyfold Agent is connected
  const connectedAgents = await listConnectedAgents(env).catch(() => []);
  if (connectedAgents && connectedAgents.length > 0) {
    const selectedAgent = body.agentId
      ? connectedAgents.find((a) => a.agentId === body.agentId) || connectedAgents[0]
      : connectedAgents[0];

    try {
      const cred = await credentialFor(env, selectedAgent.agentId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);

      const messageId = `rmbg-${crypto.randomUUID()}`;

      try {
        const snapshot = await consumeA2AStream({
          cred,
          params: {
            message: {
              kind: 'message',
              role: 'user',
              messageId,
              parts: [
                {
                  kind: 'inline-data',
                  mimeType,
                  data: base64Data,
                },
                {
                  kind: 'text',
                  text: `You are Gemini 3.6 Flash with advanced high-resolution vision capabilities.
Analyze all main foreground subjects in the attached image and extract their ultra-precise boundary contour for background removal.
Utilize fine-grained bezier curve control points to tightly wrap around complex subject shapes and edges.
Return JSON ONLY with exact format:
{
  "label": "description of all main foreground subjects",
  "svgPath": "smooth closed SVG path 'd' string in 0..1000 viewBox (0 0 1000 1000). Must start with 'M', use bezier curves (C, S, Q) or fine-grained coordinates to outline the subject tightly, and close subpaths with 'Z'.",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`,
                },
              ],
            },
            configuration: { acceptedOutputModes: ['text/plain', 'application/json'] },
          },
          signal: controller.signal,
        });

        const text = snapshot.text || '';
        const result = parseRemoveBgJson(text);

        if (!result.svgPath) {
          throw new Error(`Agent "${selectedAgent.name}" returned response without a valid svgPath.`);
        }

        return {
          label: result.label || selectedAgent.name,
          svgPath: result.svgPath,
          boundingBox: result.boundingBox || [0, 0, 1000, 1000],
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error('Manyfold A2A Error:', message);
      if (!apiKey) {
        throw new HttpError(500, 'agent_error', `Manyfold Agent ("${selectedAgent.name}") 處理失敗: ${message}`);
      }
      console.warn('Falling back to direct Gemini API key after A2A failure.');
    }
  }

  // 2. Direct Gemini API Key fallback method if configured
  if (apiKey) {
    const baseUrl = env.MANYFOLD_API_BASE_URL && (typeof process !== 'undefined' ? process.env?.GOOGLE_GEMINI_BASE_URL : undefined);

    const ai = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          `You are Gemini 3.6 Flash, an expert computer vision model specializing in image segmentation and background removal.
Analyze all main foreground subjects in this image (e.g. people, pets, products, objects, items).
Extract the precise boundary contour outlining all main foreground subjects with ultra-high resolution edge accuracy, excluding background elements.
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

  throw new HttpError(
    400,
    'no_auth_method',
    '無可用的 AI 處理服務。請在 Cloudflare 設定 GEMINI_API_KEY，或在網站右上角點擊「Connect Manyfold Agent」授權您的 Agent！'
  );
}
