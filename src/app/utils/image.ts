/**
 * Compress and scale down an image data URL for AI vision processing.
 * Limits max dimension (e.g. 1024px) keeping aspect ratio, and exports JPEG.
 * Reduces multi-megabyte payloads down to ~100KB-300KB, preventing HTTP 413 payload limits.
 */
export async function compressImageForAI(dataUrl: string, maxDim = 1024, quality = 0.85): Promise<string> {
  // If it's small enough or SVG, return directly
  if (dataUrl.length < 300 * 1024 || dataUrl.startsWith('data:image/svg+xml')) {
    return dataUrl;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) {
        width = img.width || 800;
        height = img.height || 800;
      }

      if (width <= maxDim && height <= maxDim && dataUrl.length < 500 * 1024) {
        return resolve(dataUrl);
      }

      // Compute scaled dimensions preserving ratio
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
      resolve(canvas.toDataURL('image/jpeg', quality));
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
