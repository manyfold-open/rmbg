import { GoogleGenAI } from '@google/genai';
import { HttpError, type Env } from './types';

export interface RemoveBgRequest {
  /** Base64 string or data URL */
  image: string;
}

export interface RemoveBgResponse {
  label: string;
  svgPath: string;
  boundingBox: [number, number, number, number];
}

export async function handleRemoveBg(env: Env, body: RemoveBgRequest): Promise<RemoveBgResponse> {
  const apiKey = env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');
  if (!apiKey) {
    throw new HttpError(500, 'missing_api_key', 'GEMINI_API_KEY is not configured in environment variables.');
  }

  const baseUrl = env.MANYFOLD_API_BASE_URL && (typeof process !== 'undefined' ? process.env?.GOOGLE_GEMINI_BASE_URL : undefined);
  
  const ai = new GoogleGenAI({
    apiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });

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
    // Strip markdown code fences if present
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
    console.error('RemoveBg Error:', message);
    throw new HttpError(500, 'gemini_error', `Failed to process image with Gemini API: ${message}`);
  }
}
