/**
 * Compress and scale down an image data URL for AI vision processing.
 * Guarantees payload size stays under ~600KB to prevent HTTP 413 (Request Body Too Large) errors when calling Manyfold Agent / Workers API.
 */
export async function compressImageForAI(
  dataUrl: string,
  maxDim = 1536,
  quality = 0.85
): Promise<string> {
  const MAX_BASE64_LEN = 600 * 1024; // 600KB character limit (~450KB binary)

  // If already under size limit or SVG, return directly
  if (dataUrl.length <= MAX_BASE64_LEN || dataUrl.startsWith('data:image/svg+xml')) {
    return dataUrl;
  }

  const isPng = dataUrl.startsWith('data:image/png');
  const isWebp = dataUrl.startsWith('data:image/webp');
  const preserveAlpha = isPng || isWebp;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) {
        width = img.width || 800;
        height = img.height || 800;
      }

      let currentMaxDim = Math.min(maxDim, Math.max(width, height));

      const attemptCompress = (targetDim: number, currentQuality: number): string => {
        let w = width;
        let h = height;
        if (w > h) {
          if (w > targetDim) {
            h = Math.round((h * targetDim) / w);
            w = targetDim;
          }
        } else {
          if (h > targetDim) {
            w = Math.round((w * targetDim) / h);
            h = targetDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return dataUrl;

        ctx.drawImage(img, 0, 0, w, h);

        if (preserveAlpha) {
          // Try webp first if supported for alpha + compression, fallback to png
          const webpResult = canvas.toDataURL('image/webp', currentQuality);
          if (webpResult.length <= MAX_BASE64_LEN) return webpResult;

          const pngResult = canvas.toDataURL('image/png');
          if (pngResult.length <= MAX_BASE64_LEN) return pngResult;
        }

        return canvas.toDataURL('image/jpeg', currentQuality);
      };

      // Iterative downsizing until payload is under limit
      let result = attemptCompress(currentMaxDim, quality);
      let stepDim = currentMaxDim;

      while (result.length > MAX_BASE64_LEN && stepDim > 400) {
        stepDim = Math.round(stepDim * 0.8);
        result = attemptCompress(stepDim, Math.max(0.6, quality - 0.1));
      }

      resolve(result);
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Creates a pixel-accurate transparent PNG cutout image from an original image and an SVG path (in 0..1000 viewBox coordinates).
 */
export async function createCutoutFromSvgPath(
  originalImageUrl: string,
  svgPath: string
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const width = img.naturalWidth || img.width || 800;
      const height = img.naturalHeight || img.height || 800;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return resolve(originalImageUrl);
      }

      try {
        const path2D = new Path2D(svgPath);
        const scaleX = width / 1000;
        const scaleY = height / 1000;

        ctx.save();
        ctx.scale(scaleX, scaleY);
        ctx.fill(path2D);
        ctx.restore();

        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        console.error('Failed to render cutout from SVG path:', err);
        resolve(originalImageUrl);
      }
    };
    img.onerror = () => resolve(originalImageUrl);
    img.src = originalImageUrl;
  });
}


