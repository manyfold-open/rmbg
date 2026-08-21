import { useState } from 'react';
import { Download, RotateCcw, Check } from 'lucide-react';
import type { BgConfig } from './ComparisonSlider';

interface ExportToolbarProps {
  originalImage: string;
  cutoutImage?: string | null;
  svgPath: string | null;
  bgConfig: BgConfig;
  onReset: () => void;
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  originalImage,
  cutoutImage,
  svgPath,
  bgConfig,
  onReset,
}) => {
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [downloadSuccess, setDownloadSuccess] = useState<boolean>(false);

  const handleDownload = async () => {
    setIsExporting(true);
    setDownloadSuccess(false);

    try {
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

      // 1. Render Background depending on bgConfig
      if (bgConfig.mode === 'color') {
        ctx.fillStyle = bgConfig.color;
        ctx.fillRect(0, 0, width, height);
      } else if (bgConfig.mode === 'image' && bgConfig.customImageUrl) {
        const bgImg = new Image();
        bgImg.crossOrigin = 'anonymous';
        bgImg.src = bgConfig.customImageUrl;
        await new Promise<void>((res) => {
          bgImg.onload = () => res();
          bgImg.onerror = () => res(); // fallback gracefully
        });
        ctx.drawImage(bgImg, 0, 0, width, height);
      } else if (bgConfig.mode === 'blur') {
        ctx.save();
        ctx.filter = `blur(${bgConfig.blurAmount}px)`;
        ctx.drawImage(img, -10, -10, width + 20, height + 20);
        ctx.restore();
      }

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
        ctx.save();
        const path2D = new Path2D(svgPath);

        // Scale path2D from 0..1000 to canvas width & height
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
        ctx.restore();
      } else {
        ctx.drawImage(img, 0, 0, width, height);
      }

      // 3. Trigger Download
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `removed-bg-${Date.now()}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3000);
    } catch (err) {
      console.error('Export failed:', err);
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
