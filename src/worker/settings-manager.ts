import type { Env } from './types';
import type { AppSettings } from '../shared/types';
import { getSetting, setSetting } from './db';

export const DEFAULT_SETTINGS: AppSettings = {
  bgRemoveModel: 'gemini-3.6-flash',
  bgRemoveMode: 'auto',
  geminiSystemPrompt:
    'You are Gemini 3.6 Flash, an expert computer vision model specializing in image segmentation and background removal. Analyze all main foreground subjects in this image (e.g. people, pets, products, objects, items). Extract the precise boundary contour outlining all main foreground subjects with ultra-high resolution edge accuracy, excluding background elements.',
  r2Enabled: true,
  r2BucketName: 'rmbg-images',
  maxImageResolution: 2048,
};

export async function loadAppSettings(env: Env): Promise<AppSettings> {
  try {
    const [model, mode, prompt, r2Enabled, r2BucketName, maxRes] = await Promise.all([
      getSetting(env, 'setting:bg_remove_model'),
      getSetting(env, 'setting:bg_remove_mode'),
      getSetting(env, 'setting:gemini_system_prompt'),
      getSetting(env, 'setting:r2_enabled'),
      getSetting(env, 'setting:r2_bucket_name'),
      getSetting(env, 'setting:max_image_resolution'),
    ]);

    return {
      bgRemoveModel: model || DEFAULT_SETTINGS.bgRemoveModel,
      bgRemoveMode: (mode as AppSettings['bgRemoveMode']) || DEFAULT_SETTINGS.bgRemoveMode,
      geminiSystemPrompt: prompt || DEFAULT_SETTINGS.geminiSystemPrompt,
      r2Enabled: r2Enabled !== null ? r2Enabled === 'true' : DEFAULT_SETTINGS.r2Enabled,
      r2BucketName: r2BucketName || DEFAULT_SETTINGS.r2BucketName,
      maxImageResolution: maxRes ? parseInt(maxRes, 10) : DEFAULT_SETTINGS.maxImageResolution,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveAppSettings(env: Env, updates: Partial<AppSettings>): Promise<AppSettings> {
  const promises: Promise<void>[] = [];

  if (updates.bgRemoveModel !== undefined) {
    promises.push(setSetting(env, 'setting:bg_remove_model', updates.bgRemoveModel));
  }
  if (updates.bgRemoveMode !== undefined) {
    promises.push(setSetting(env, 'setting:bg_remove_mode', updates.bgRemoveMode));
  }
  if (updates.geminiSystemPrompt !== undefined) {
    promises.push(setSetting(env, 'setting:gemini_system_prompt', updates.geminiSystemPrompt));
  }
  if (updates.r2Enabled !== undefined) {
    promises.push(setSetting(env, 'setting:r2_enabled', String(updates.r2Enabled)));
  }
  if (updates.r2BucketName !== undefined) {
    promises.push(setSetting(env, 'setting:r2_bucket_name', updates.r2BucketName));
  }
  if (updates.maxImageResolution !== undefined) {
    promises.push(setSetting(env, 'setting:max_image_resolution', String(updates.maxImageResolution)));
  }

  await Promise.all(promises);
  return loadAppSettings(env);
}
