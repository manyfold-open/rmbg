/**
 * Compress and scale down an image data URL for AI vision processing if necessary.
 * Preserves transparency/alpha channel for PNG and WebP images, and allows up to 2048px dimensions.
 */
export async function compressImageForAI(dataUrl: string, maxDim = 2048, quality = 0.92): Promise<string> {
  // If it's reasonably small (< 1.5MB) or SVG, return directly
  if (dataUrl.length < 1500 * 1024 || dataUrl.startsWith('data:image/svg+xml')) {
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

      if (width <= maxDim && height <= maxDim && dataUrl.length < 2500 * 1024) {
        return resolve(dataUrl);
      }

      // Compute scaled dimensions preserving aspect ratio
      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);

      ctx.drawImage(img, 0, 0, width, height);
      if (preserveAlpha) {
        resolve(canvas.toDataURL('image/png'));
      } else {
        resolve(canvas.toDataURL('image/jpeg', quality));
      }
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


