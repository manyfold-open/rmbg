import { useState, useRef, useCallback, useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';

export type BgMode = 'transparent' | 'color' | 'image' | 'blur';

export interface BgConfig {
  mode: BgMode;
  color: string;
  customImageUrl: string | null;
  blurAmount: number;
}

interface ComparisonSliderProps {
  originalImage: string;
  svgPath: string | null;
  bgConfig: BgConfig;
}

export const ComparisonSlider: React.FC<ComparisonSliderProps> = ({
  originalImage,
  svgPath,
  bgConfig,
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

  return (
    <div
      ref={containerRef}
      className={`slider-container ${bgConfig.mode === 'transparent' ? 'checkerboard' : ''}`}
      style={getBackgroundStyle()}
    >
      {/* 1. Base Layer: Removed Background Foreground Output */}
      <div className="slider-layer after-layer">
        {svgPath ? (
          <div className="svg-masked-wrapper">
            <svg
              viewBox="0 0 1000 1000"
              preserveAspectRatio="xMidYMid meet"
              className="masked-image-svg"
              style={{ width: '100%', height: '100%' }}
            >
              <defs>
                <clipPath id="subject-clip-path" clipPathUnits="userSpaceOnUse">
                  <path d={svgPath} />
                </clipPath>
              </defs>
              <image
                href={originalImage}
                width="1000"
                height="1000"
                preserveAspectRatio="none"
                clipPath="url(#subject-clip-path)"
              />
            </svg>
          </div>
        ) : (
          <img src={originalImage} alt="Cutout Preview" className="full-image" />
        )}
      </div>

      {/* 2. Top Layer: Original Image (Clipped by slider position) */}
      <div
        className="slider-layer before-layer"
        style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
      >
        <img src={originalImage} alt="Original Image" className="full-image" />
      </div>

      {/* 3. Slider Handle Divider */}
      <div
        className="slider-handle"
        style={{ left: `${sliderPos}%` }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleMouseDown}
      >
        <div className="slider-line" />
        <div className="slider-button">
          <SlidersHorizontal size={16} />
        </div>
      </div>

      {/* Badges */}
      <div className="slider-badge before-badge" style={{ opacity: sliderPos > 15 ? 1 : 0 }}>
        原圖 (Before)
      </div>
      <div className="slider-badge after-badge" style={{ opacity: sliderPos < 85 ? 1 : 0 }}>
        去背結果 (After)
      </div>
    </div>
  );
};
