import { useState } from 'react';
import { Download, RotateCcw, Check, Layers } from 'lucide-react';
import type { BgConfig, PostProcessConfig } from '../types/studio';
import { DEFAULT_POST_PROCESS } from '../types/studio';

interface ExportToolbarProps {
  originalImage: string;
  cutoutImage?: string | null;
  svgPath?: string | null;
  bgConfig: BgConfig;
  postProcess?: PostProcessConfig;
  onReset: () => void;
  onShowToast?: (text: string, type?: 'info' | 'success' | 'warning') => void;
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  originalImage,
  cutoutImage,
  svgPath,
  bgConfig,
  postProcess = DEFAULT_POST_PROCESS,
  onReset,
  onShowToast,
}) => {
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [downloadSuccess, setDownloadSuccess] = useState<boolean>(false);

  const generateCanvasDataUrl = async (overrideBg?: BgConfig): Promise<string> => {
    const activeBg = overrideBg || bgConfig;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = originalImage;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for canvas export'));
    });

    const width = img.naturalWidth || 800;
    const height = img.naturalHeight || 800;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Canvas context not available');
    }

    // 1. Render Background depending on activeBg
    if (activeBg.mode === 'color') {
      ctx.fillStyle = activeBg.color;
      ctx.fillRect(0, 0, width, height);
    } else if (activeBg.mode === 'image' && activeBg.customImageUrl) {
      const bgImg = new Image();
      bgImg.crossOrigin = 'anonymous';
      bgImg.src = activeBg.customImageUrl;
      await new Promise<void>((res) => {
        bgImg.onload = () => res();
        bgImg.onerror = () => res();
      });
      ctx.drawImage(bgImg, 0, 0, width, height);
    } else if (activeBg.mode === 'blur') {
      ctx.save();
      ctx.filter = `blur(${activeBg.blurAmount}px)`;
      ctx.drawImage(img, -10, -10, width + 20, height + 20);
      ctx.restore();
    }

    // Build filter string for post processing
    const filters: string[] = [];
    if (postProcess.brightness !== 100) filters.push(`brightness(${postProcess.brightness}%)`);
    if (postProcess.contrast !== 100) filters.push(`contrast(${postProcess.contrast}%)`);
    if (postProcess.saturation !== 100) filters.push(`saturate(${postProcess.saturation}%)`);

    switch (postProcess.presetFilter) {
      case 'vintage':
        filters.push('sepia(35%) contrast(110%)');
        break;
      case 'warm':
        filters.push('sepia(20%) saturate(120%)');
        break;
      case 'cool':
        filters.push('hue-rotate(15deg) saturate(110%)');
        break;
      case 'mono':
        filters.push('grayscale(100%)');
        break;
      case 'none':
      default:
        break;
    }

    if (postProcess.shadowEnable) {
      const scaleOffsetY = postProcess.shadowOffsetY * (height / 600);
      const scaleBlur = postProcess.shadowBlur * (width / 600);
      filters.push(
        `drop-shadow(0px ${scaleOffsetY}px ${scaleBlur}px ${postProcess.shadowColor})`
      );
    }

    ctx.save();
    if (filters.length > 0) {
      ctx.filter = filters.join(' ');
    }

    // Apply scale & position transform
    const centerX = width / 2;
    const centerY = height / 2;
    const offsetX = (postProcess.positionX / 100) * width;
    const offsetY = (postProcess.positionY / 100) * height;

    ctx.translate(centerX + offsetX, centerY + offsetY);
    ctx.scale(postProcess.scale, postProcess.scale);
    ctx.translate(-centerX, -centerY);

    // 2. Render Cutout Foreground Subject
    if (cutoutImage) {
      const cutoutImg = new Image();
      cutoutImg.crossOrigin = 'anonymous';
      cutoutImg.src = cutoutImage;
      await new Promise<void>((res) => {
        cutoutImg.onload = () => res();
        cutoutImg.onerror = () => res();
      });
      ctx.drawImage(cutoutImg, 0, 0, width, height);
    } else if (svgPath) {
      const path2D = new Path2D(svgPath);
      const scaleX = width / 1000;
      const scaleY = height / 1000;

      const transformCanvas = document.createElement('canvas');
      transformCanvas.width = width;
      transformCanvas.height = height;
      const tCtx = transformCanvas.getContext('2d');

      if (tCtx) {
        tCtx.scale(scaleX, scaleY);
        tCtx.fill(path2D);
        tCtx.globalCompositeOperation = 'source-in';
        tCtx.setTransform(1, 0, 0, 1, 0, 0);
        tCtx.drawImage(img, 0, 0, width, height);
        ctx.drawImage(transformCanvas, 0, 0);
      } else {
        ctx.drawImage(img, 0, 0, width, height);
      }
    } else {
      ctx.drawImage(img, 0, 0, width, height);
    }

    ctx.restore();
    return canvas.toDataURL('image/png');
  };

  const handleDownload = async () => {
    setIsExporting(true);
    setDownloadSuccess(false);

    try {
      const dataUrl = await generateCanvasDataUrl();
      const link = document.createElement('a');
      link.download = `atelier-cutout-${Date.now()}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setDownloadSuccess(true);
      if (onShowToast) onShowToast('✦ 高清 PNG 圖片已成功下載！', 'success');
      setTimeout(() => setDownloadSuccess(false), 3000);
    } catch (err) {
      console.error('Export failed:', err);
      if (onShowToast) onShowToast('匯出失敗，請稍後重試。', 'warning');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportBundle = async () => {
    setIsExporting(true);
    try {
      // Export 1: Transparent
      const transparentUrl = await generateCanvasDataUrl({
        mode: 'transparent',
        color: '#FFFFFF',
        customImageUrl: null,
        blurAmount: 10,
      });
      const link1 = document.createElement('a');
      link1.download = `atelier-transparent-${Date.now()}.png`;
      link1.href = transparentUrl;
      document.body.appendChild(link1);
      link1.click();
      document.body.removeChild(link1);

      // Export 2: Studio White
      const whiteUrl = await generateCanvasDataUrl({
        mode: 'color',
        color: '#FFFFFF',
        customImageUrl: null,
        blurAmount: 10,
      });
      const link2 = document.createElement('a');
      link2.download = `atelier-white-${Date.now()}.png`;
      link2.href = whiteUrl;
      document.body.appendChild(link2);
      link2.click();
      document.body.removeChild(link2);

      if (onShowToast) onShowToast('✦ 多版本套組（透明 + 純白）已全部匯出！', 'success');
    } catch (err) {
      console.error('Bundle export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="export-toolbar">
      <button
        type="button"
        className="button subtle reset-btn"
        onClick={onReset}
      >
        <RotateCcw size={18} />
        重新上傳
      </button>

      <button
        type="button"
        className="button subtle bundle-btn"
        onClick={handleExportBundle}
        disabled={isExporting}
        title="一次下載透明 PNG + 純白底 PNG"
      >
        <Layers size={16} />
        打包全套組
      </button>

      <button
        type="button"
        className={`button primary export-btn ${downloadSuccess ? 'success' : ''}`}
        onClick={handleDownload}
        disabled={isExporting}
      >
        {downloadSuccess ? (
          <>
            <Check size={18} />
            下載成功！
          </>
        ) : (
          <>
            <Download size={18} />
            {isExporting ? '處理中...' : '下載高清 PNG 圖片'}
          </>
        )}
      </button>
    </div>
  );
};
