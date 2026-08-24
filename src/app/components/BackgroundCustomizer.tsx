import { useRef, useState } from 'react';
import {
  Layers,
  Palette,
  Image as ImageIcon,
  EyeOff,
  Upload,
  Sun,
  Sliders,
  Sparkles,
  RotateCcw,
  Zap,
} from 'lucide-react';
import type { BgConfig, BgMode, PostProcessConfig, PresetFilter } from '../types/studio';

interface BackgroundCustomizerProps {
  config: BgConfig;
  onChange: (newConfig: BgConfig) => void;
  postProcess: PostProcessConfig;
  onPostProcessChange: (newPP: PostProcessConfig) => void;
  onResetAll: () => void;
}

const PRESET_COLORS = [
  { name: 'Studio White', hex: '#FFFFFF' },
  { name: 'Linen', hex: '#FAF8F5' },
  { name: 'Neutral', hex: '#EFECE6' },
  { name: 'Terracotta', hex: '#C56A38' },
  { name: 'Sand', hex: '#E3D5CA' },
  { name: 'Sage', hex: '#D9E4DD' },
  { name: 'Slate', hex: '#1F1D1B' },
  { name: 'Fog Blue', hex: '#D0D7DE' },
];

const PRESET_FILTERS: { id: PresetFilter; name: string }[] = [
  { id: 'none', name: 'Normal' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'warm', name: 'Warm' },
  { id: 'cool', name: 'Cool' },
  { id: 'mono', name: 'Mono' },
];

export const BackgroundCustomizer: React.FC<BackgroundCustomizerProps> = ({
  config,
  onChange,
  postProcess,
  onPostProcessChange,
  onResetAll,
}) => {
  const [activeTab, setActiveTab] = useState<'bg' | 'effects' | 'color'>('bg');
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

  const updatePP = (partial: Partial<PostProcessConfig>) => {
    onPostProcessChange({ ...postProcess, ...partial });
  };

  return (
    <div className="bg-customizer-panel">
      <div className="panel-header-row">
        <h3 className="panel-title">
          <Layers size={18} />
          Studio controls
        </h3>
        <button
          type="button"
          className="button subtle reset-subtle-btn"
          onClick={onResetAll}
          title="Reset all adjustments"
        >
          <RotateCcw size={14} /> Reset
        </button>
      </div>

      {/* Main Control Sub-Tabs */}
      <div className="sub-panel-tabs">
        <button
          type="button"
          className={`sub-tab ${activeTab === 'bg' ? 'active' : ''}`}
          onClick={() => setActiveTab('bg')}
        >
          <Layers size={14} /> Background
        </button>
        <button
          type="button"
          className={`sub-tab ${activeTab === 'effects' ? 'active' : ''}`}
          onClick={() => setActiveTab('effects')}
        >
          <Sun size={14} /> Shadow & position
        </button>
        <button
          type="button"
          className={`sub-tab ${activeTab === 'color' ? 'active' : ''}`}
          onClick={() => setActiveTab('color')}
        >
          <Sliders size={14} /> Color
        </button>
      </div>

      {/* TAB 1: Background Canvas */}
      {activeTab === 'bg' && (
        <>
          <div className="bg-mode-tabs">
            <button
              type="button"
              className={`bg-tab ${config.mode === 'transparent' ? 'active' : ''}`}
              onClick={() => setMode('transparent')}
            >
              <EyeOff size={16} />
              Transparent
            </button>

            <button
              type="button"
              className={`bg-tab ${config.mode === 'color' ? 'active' : ''}`}
              onClick={() => setMode('color')}
            >
              <Palette size={16} />
              Solid color
            </button>

            <button
              type="button"
              className={`bg-tab ${config.mode === 'image' ? 'active' : ''}`}
              onClick={() => setMode('image')}
            >
              <ImageIcon size={16} />
              Custom image
            </button>

            <button
              type="button"
              className={`bg-tab ${config.mode === 'blur' ? 'active' : ''}`}
              onClick={() => setMode('blur')}
            >
              <Zap size={16} />
              Blur original
            </button>
          </div>

          {config.mode === 'transparent' && (
            <div className="bg-option-box">
              <p className="small muted">Transparent PNG output for product images, avatars, and design assets.</p>
            </div>
          )}

          {config.mode === 'color' && (
            <div className="bg-option-box">
              <label className="small-label">Studio palette</label>
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

                <div className="custom-color-picker" title="Custom color">
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
                {config.customImageUrl ? 'Replace background image' : 'Choose background image'}
              </button>
            </div>
          )}

          {config.mode === 'blur' && (
            <div className="bg-option-box">
              <div className="slider-control">
                <div className="slider-label-row">
                  <span className="small-label">Background blur</span>
                  <span className="slider-val">{config.blurAmount}px</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="30"
                  value={config.blurAmount}
                  onChange={(e) =>
                    onChange({ ...config, blurAmount: Number(e.target.value) })
                  }
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* TAB 2: Drop Shadow & Position Controls */}
      {activeTab === 'effects' && (
        <div className="bg-option-box">
          {/* Shadow Toggle */}
          <div className="toggle-row">
            <span className="small-label font-bold">Drop shadow</span>
            <button
              type="button"
              className={`toggle-switch ${postProcess.shadowEnable ? 'active' : ''}`}
              onClick={() => updatePP({ shadowEnable: !postProcess.shadowEnable })}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          {postProcess.shadowEnable && (
            <div className="nested-controls">
              <div className="slider-control">
                <div className="slider-label-row">
                  <span className="small-label">Shadow blur</span>
                  <span className="slider-val">{postProcess.shadowBlur}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={postProcess.shadowBlur}
                  onChange={(e) => updatePP({ shadowBlur: Number(e.target.value) })}
                />
              </div>

              <div className="slider-control">
                <div className="slider-label-row">
                  <span className="small-label">Shadow offset</span>
                  <span className="slider-val">{postProcess.shadowOffsetY}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="40"
                  value={postProcess.shadowOffsetY}
                  onChange={(e) => updatePP({ shadowOffsetY: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          <hr className="divider" />

          {/* Scale & Position */}
          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Subject scale</span>
              <span className="slider-val">{Math.round(postProcess.scale * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.05"
              value={postProcess.scale}
              onChange={(e) => updatePP({ scale: Number(e.target.value) })}
            />
          </div>

          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Horizontal offset</span>
              <span className="slider-val">{postProcess.positionX}%</span>
            </div>
            <input
              type="range"
              min="-40"
              max="40"
              value={postProcess.positionX}
              onChange={(e) => updatePP({ positionX: Number(e.target.value) })}
            />
          </div>

          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Vertical offset</span>
              <span className="slider-val">{postProcess.positionY}%</span>
            </div>
            <input
              type="range"
              min="-40"
              max="40"
              value={postProcess.positionY}
              onChange={(e) => updatePP({ positionY: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

      {/* TAB 3: Color Grading & Preset Filters */}
      {activeTab === 'color' && (
        <div className="bg-option-box">
          <label className="small-label">Filter presets</label>
          <div className="filter-presets-grid">
            {PRESET_FILTERS.map((pf) => (
              <button
                key={pf.id}
                type="button"
                className={`filter-preset-card ${postProcess.presetFilter === pf.id ? 'active' : ''}`}
                onClick={() => updatePP({ presetFilter: pf.id })}
              >
                <Sparkles size={12} /> {pf.name}
              </button>
            ))}
          </div>

          <hr className="divider" />

          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Brightness</span>
              <span className="slider-val">{postProcess.brightness}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="150"
              value={postProcess.brightness}
              onChange={(e) => updatePP({ brightness: Number(e.target.value) })}
            />
          </div>

          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Contrast</span>
              <span className="slider-val">{postProcess.contrast}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="150"
              value={postProcess.contrast}
              onChange={(e) => updatePP({ contrast: Number(e.target.value) })}
            />
          </div>

          <div className="slider-control">
            <div className="slider-label-row">
              <span className="small-label">Saturation</span>
              <span className="slider-val">{postProcess.saturation}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="200"
              value={postProcess.saturation}
              onChange={(e) => updatePP({ saturation: Number(e.target.value) })}
            />
          </div>
        </div>
      )}
    </div>
  );
};
