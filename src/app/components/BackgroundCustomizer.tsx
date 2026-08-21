import { useRef } from 'react';
import { Layers, Palette, Image as ImageIcon, EyeOff, Upload } from 'lucide-react';
import type { BgConfig, BgMode } from './ComparisonSlider';

interface BackgroundCustomizerProps {
  config: BgConfig;
  onChange: (newConfig: BgConfig) => void;
}

const PRESET_COLORS = [
  { name: '純白 Studio', hex: '#FFFFFF' },
  { name: '亞麻暖色 Linen', hex: '#FAF8F5' },
  { name: '柔灰霧質 Neutral', hex: '#EFECE6' },
  { name: '赤陶琥珀 Terracotta', hex: '#C56A38' },
  { name: '暖砂大地 Sand', hex: '#E3D5CA' },
  { name: '鼠尾草綠 Sage', hex: '#D9E4DD' },
  { name: '深炭黑色 Slate', hex: '#1F1D1B' },
  { name: '莫蘭迪藍 Fog Blue', hex: '#D0D7DE' },
];

export const BackgroundCustomizer: React.FC<BackgroundCustomizerProps> = ({ config, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setMode = (mode: BgMode) => {
    onChange({ ...config, mode });
  };

  const setColor = (color: string) => {
    onChange({ ...config, mode: 'color', color });
  };

  const handleCustomImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onChange({
            ...config,
            mode: 'image',
            customImageUrl: event.target.result as string,
          });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="bg-customizer-panel">
      <h3 className="panel-title">
        <Layers size={18} />
        背景更換與編輯
      </h3>

      {/* Mode Selector Tabs */}
      <div className="bg-mode-tabs">
        <button
          type="button"
          className={`bg-tab ${config.mode === 'transparent' ? 'active' : ''}`}
          onClick={() => setMode('transparent')}
        >
          <EyeOff size={16} />
          透明背景
        </button>

        <button
          type="button"
          className={`bg-tab ${config.mode === 'color' ? 'active' : ''}`}
          onClick={() => setMode('color')}
        >
          <Palette size={16} />
          純色背景
        </button>

        <button
          type="button"
          className={`bg-tab ${config.mode === 'image' ? 'active' : ''}`}
          onClick={() => setMode('image')}
        >
          <ImageIcon size={16} />
          自訂圖片
        </button>

        <button
          type="button"
          className={`bg-tab ${config.mode === 'blur' ? 'active' : ''}`}
          onClick={() => setMode('blur')}
        >
          <Layers size={16} />
          原圖模糊
        </button>
      </div>

      {/* Mode 1: Transparent */}
      {config.mode === 'transparent' && (
        <div className="bg-option-box">
          <p className="small muted">預設透明 PNG 輸出，適合電商商品圖、大頭貼與設計素材。</p>
        </div>
      )}

      {/* Mode 2: Solid Color */}
      {config.mode === 'color' && (
        <div className="bg-option-box">
          <label className="small-label">常用預設色庫：</label>
          <div className="color-swatches">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={`color-swatch ${config.color.toUpperCase() === c.hex.toUpperCase() ? 'selected' : ''}`}
                style={{ backgroundColor: c.hex }}
                title={c.name}
                onClick={() => setColor(c.hex)}
              />
            ))}

            {/* Custom Color Picker Input */}
            <div className="custom-color-picker" title="自訂顏色">
              <input
                type="color"
                value={config.color}
                onChange={(e) => setColor(e.target.value)}
              />
              <span className="picker-label">+</span>
            </div>
          </div>
        </div>
      )}

      {/* Mode 3: Custom Background Image */}
      {config.mode === 'image' && (
        <div className="bg-option-box">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleCustomImageUpload}
          />

          <button
            type="button"
            className="button subtle upload-bg-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} />
            {config.customImageUrl ? '重新上傳背景圖片' : '選擇自訂背景圖'}
          </button>

          {config.customImageUrl && (
            <div className="bg-preview-row">
              <div
                className="bg-thumb"
                style={{ backgroundImage: `url("${config.customImageUrl}")` }}
              />
              <span className="small muted">已載入自訂背景</span>
            </div>
          )}
        </div>
      )}

      {/* Mode 4: Blur Original Background */}
      {config.mode === 'blur' && (
        <div className="bg-option-box">
          <label className="small-label">原背景模糊強度：{config.blurAmount}px</label>
          <input
            type="range"
            min="2"
            max="30"
            value={config.blurAmount}
            onChange={(e) => onChange({ ...config, blurAmount: Number(e.target.value) })}
            className="blur-slider"
          />
        </div>
      )}
    </div>
  );
};
