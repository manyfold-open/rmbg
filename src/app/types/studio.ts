export type BgMode = 'transparent' | 'color' | 'image' | 'blur';

export interface BgConfig {
  mode: BgMode;
  color: string;
  customImageUrl: string | null;
  blurAmount: number;
}

export type PresetFilter = 'none' | 'vintage' | 'warm' | 'cool' | 'mono';

export interface PostProcessConfig {
  brightness: number;     // 50% ~ 150%, default 100
  contrast: number;       // 50% ~ 150%, default 100
  saturation: number;     // 0% ~ 200%, default 100
  shadowEnable: boolean;
  shadowBlur: number;     // 0 ~ 50px, default 16
  shadowOffsetY: number;  // 0 ~ 40px, default 10
  shadowColor: string;    // default 'rgba(0, 0, 0, 0.25)'
  scale: number;          // 0.5 ~ 1.5, default 1.0
  positionX: number;      // -50% ~ 50%, default 0
  positionY: number;      // -50% ~ 50%, default 0
  presetFilter: PresetFilter;
}

export const DEFAULT_POST_PROCESS: PostProcessConfig = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  shadowEnable: false,
  shadowBlur: 16,
  shadowOffsetY: 10,
  shadowColor: 'rgba(0, 0, 0, 0.25)',
  scale: 1.0,
  positionX: 0,
  positionY: 0,
  presetFilter: 'none',
};

export interface HistoryItem {
  id: string;
  originalImage: string;
  cutoutImage: string | null;
  svgPath?: string | null;
  subjectLabel: string | null;
  timestamp: number;
}

export interface ToastMessage {
  id: string;
  text: string;
  type?: 'info' | 'success' | 'warning';
}

/** An image picked for upload, before anything has been done to it. */
export interface SelectedImage {
  name: string;
  dataUrl: string;
}

export type BatchItemStatus = 'queued' | 'processing' | 'done' | 'failed';

/** One image's progress through a batch run. */
export interface BatchItem {
  id: string;
  name: string;
  originalImage: string;
  status: BatchItemStatus;
  /** The agent's own words while it works — a batch runs for minutes. */
  progress: string | null;
  cutoutImage: string | null;
  subjectLabel: string | null;
  error: string | null;
}
