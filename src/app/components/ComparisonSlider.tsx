import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { BgConfig, PostProcessConfig } from '../types/studio';
import { DEFAULT_POST_PROCESS } from '../types/studio';

interface ComparisonSliderProps {
  originalImage: string;
  cutoutImage?: string | null;
  svgPath?: string | null;
  bgConfig: BgConfig;
  postProcess?: PostProcessConfig;
  forceShowOriginal?: boolean;
}

export const ComparisonSlider: React.FC<ComparisonSliderProps> = ({
  originalImage,
  cutoutImage,
  svgPath,
  bgConfig,
  postProcess = DEFAULT_POST_PROCESS,
  forceShowOriginal = false,
}) => {
  const [sliderPos, setSliderPos] = useState<number>(50); // 0% to 100%
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMove = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      let percentage = (x / rect.width) * 100;
      if (percentage < 0) percentage = 0;
      if (percentage > 100) percentage = 100;
      setSliderPos(percentage);
    },
    []
  );

  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging) {
        handleMove(e.clientX);
      }
    },
    [isDragging, handleMove]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (isDragging && e.touches[0]) {
        handleMove(e.touches[0].clientX);
      }
    },
    [isDragging, handleMove]
  );

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleTouchMove);
      window.addEventListener('touchend', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleTouchMove]);

  // Compute background style based on bgConfig
  const getBackgroundStyle = (): React.CSSProperties => {
    switch (bgConfig.mode) {
      case 'color':
        return { backgroundColor: bgConfig.color };
      case 'image':
        return bgConfig.customImageUrl
          ? {
              backgroundImage: `url("${bgConfig.customImageUrl}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : {};
      case 'blur':
        return {
          backgroundImage: `url("${originalImage}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: `blur(${bgConfig.blurAmount}px)`,
          transform: 'scale(1.1)', // Prevent edge whitespace on blur
        };
      case 'transparent':
      default:
        return {}; // Transparent fallback uses CSS checkerboard
    }
  };

  // Build combined filter string for post-processing
  const getCutoutFilterStyle = (): React.CSSProperties => {
    const filters: string[] = [];

    // Basic adjustments
    if (postProcess.brightness !== 100) filters.push(`brightness(${postProcess.brightness}%)`);
    if (postProcess.contrast !== 100) filters.push(`contrast(${postProcess.contrast}%)`);
    if (postProcess.saturation !== 100) filters.push(`saturate(${postProcess.saturation}%)`);

    // Preset filters
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

    // Drop shadow
    if (postProcess.shadowEnable) {
      filters.push(
        `drop-shadow(0px ${postProcess.shadowOffsetY}px ${postProcess.shadowBlur}px ${postProcess.shadowColor})`
      );
    }

    const filterString = filters.join(' ');
    const transformString = `scale(${postProcess.scale}) translate(${postProcess.positionX}%, ${postProcess.positionY}%)`;

    return {
      filter: filterString || undefined,
      transform: transformString,
      transition: isDragging ? 'none' : 'filter 0.2s ease, transform 0.2s ease',
    };
  };

  const effectivePos = forceShowOriginal ? 100 : sliderPos;

  const clipPathId = `subject-clip-path-${useId().replace(/:/g, '')}`;

  return (
    <div
      ref={containerRef}
      className={`slider-container ${bgConfig.mode === 'transparent' ? 'checkerboard' : ''}`}
      style={getBackgroundStyle()}
    >
      {/* 1. Base Layer: Removed Background Foreground Output */}
      <div className="slider-layer after-layer">
        {cutoutImage ? (
          <img
            src={cutoutImage}
            alt="Cutout Preview"
            className="full-image"
            style={getCutoutFilterStyle()}
          />
        ) : svgPath ? (
          <div className="svg-masked-wrapper" style={getCutoutFilterStyle()}>
            <svg
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              className="masked-image-svg"
              style={{ width: '100%', height: '100%' }}
            >
              <defs>
                <clipPath id={clipPathId} clipPathUnits="userSpaceOnUse">
                  <path d={svgPath} />
                </clipPath>
              </defs>
              <image
                href={originalImage}
                width="1000"
                height="1000"
                preserveAspectRatio="none"
                clipPath={`url(#${clipPathId})`}
              />
            </svg>
          </div>
        ) : (
          <img
            src={originalImage}
            alt="Cutout Preview"
            className="full-image"
            style={getCutoutFilterStyle()}
          />
        )}
      </div>

      {/* 2. Top Layer: Original Image (Clipped by slider position) */}
      <div
        className="slider-layer before-layer"
        style={{ clipPath: `inset(0 ${100 - effectivePos}% 0 0)` }}
      >
        <img src={originalImage} alt="Original Image" className="full-image" />
      </div>

      {/* 3. Slider Handle Divider */}
      <div
        className="slider-handle"
        style={{ left: `${effectivePos}%` }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleMouseDown}
      >
        <div className="slider-line" />
        <div className="slider-button">
          <ChevronLeft size={12} className="handle-arrow" />
          <ChevronRight size={12} className="handle-arrow" />
        </div>
      </div>

      {/* Badges */}
      <div className="slider-badge before-badge" style={{ opacity: effectivePos > 15 ? 1 : 0 }}>
        原圖 (Before)
      </div>
      <div className="slider-badge after-badge" style={{ opacity: effectivePos < 85 ? 1 : 0 }}>
        去背結果 (After)
      </div>
    </div>
  );
};
