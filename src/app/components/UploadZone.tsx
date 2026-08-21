import { useState, useRef } from 'react';
import { UploadCloud, Image as ImageIcon, Sparkles, AlertCircle, Play } from 'lucide-react';

interface UploadZoneProps {
  onImageSelected: (dataUrl: string) => void;
  isLoading: boolean;
}

interface SampleItem {
  id: string;
  name: string;
  category: 'Portrait' | 'Pet' | 'Product' | 'Object' | 'Fashion' | 'Art';
  categoryLabel: string;
  icon: string;
  svg: string;
}

// Built-in high visual sample images generated using SVG data URLs
const SAMPLE_IMAGES: SampleItem[] = [
  {
    id: 'portrait-1',
    name: '人像攝影',
    category: 'Portrait',
    categoryLabel: '人像',
    icon: '👤',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3a7bd5"/>
          <stop offset="100%" stop-color="#3a6073"/>
        </linearGradient>
      </defs>
      <rect width="400" height="400" fill="url(#bg1)"/>
      <circle cx="200" cy="150" r="65" fill="#FFE0BD"/>
      <path d="M 160 140 A 8 8 0 1 1 176 140 A 8 8 0 1 1 160 140 Z" fill="#333"/>
      <path d="M 224 140 A 8 8 0 1 1 240 140 A 8 8 0 1 1 224 140 Z" fill="#333"/>
      <path d="M 185 185 Q 200 200 215 185" stroke="#D35400" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M 140 340 C 140 230, 260 230, 260 340 Z" fill="#E74C3C"/>
      <path d="M 135 140 C 135 80, 265 80, 265 140 C 265 110, 135 110, 135 140" fill="#2C3E50"/>
    </svg>`
  },
  {
    id: 'pet-1',
    name: '可愛貓咪',
    category: 'Pet',
    categoryLabel: '寵物',
    icon: '🐱',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#F1F2F6"/>
      <rect width="400" height="260" fill="#FFEAA7"/>
      <path d="M 130 350 C 130 200, 270 200, 270 350 Z" fill="#E67E22"/>
      <circle cx="200" cy="180" r="70" fill="#E67E22"/>
      <polygon points="140,140 160,80 180,130" fill="#D35400"/>
      <polygon points="220,130 240,80 260,140" fill="#D35400"/>
      <ellipse cx="175" cy="170" rx="10" ry="14" fill="#2ECC71"/>
      <ellipse cx="225" cy="170" rx="10" ry="14" fill="#2ECC71"/>
      <polygon points="195,190 205,190 200,196" fill="#E74C3C"/>
      <path d="M 190 202 Q 200 212 210 202" stroke="#333" stroke-width="3" fill="none"/>
    </svg>`
  },
  {
    id: 'product-1',
    name: '咖啡拿鐵',
    category: 'Product',
    categoryLabel: '商品',
    icon: '☕',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#74B9FF"/>
      <rect y="260" width="400" height="140" fill="#D63031"/>
      <path d="M 130 180 L 145 300 C 145 315, 255 315, 255 300 L 270 180 Z" fill="#FFFFFF"/>
      <ellipse cx="200" cy="180" rx="70" ry="15" fill="#6D4C41"/>
      <ellipse cx="200" cy="180" rx="45" ry="9" fill="#D7CCC8"/>
      <path d="M 265 200 C 310 200, 310 270, 255 270" stroke="#FFFFFF" stroke-width="16" fill="none" stroke-linecap="round"/>
    </svg>`
  },
  {
    id: 'object-1',
    name: '復古相機',
    category: 'Object',
    categoryLabel: '物件',
    icon: '📷',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#F8EFBA"/>
      <rect x="90" y="150" width="220" height="140" rx="16" fill="#2C3A47"/>
      <rect x="90" y="150" width="220" height="40" fill="#CAD3C8"/>
      <circle cx="200" cy="220" r="50" fill="#1B1464"/>
      <circle cx="200" cy="220" r="38" fill="#00A8FF"/>
      <circle cx="185" cy="205" r="10" fill="#FFFFFF" opacity="0.6"/>
      <rect x="120" y="130" width="30" height="20" rx="4" fill="#E74C3C"/>
    </svg>`
  },
  {
    id: 'fashion-1',
    name: '高級墨鏡',
    category: 'Fashion',
    categoryLabel: '時尚',
    icon: '🕶️',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#E3D5CA"/>
      <path d="M 80 180 Q 150 140 200 180 Q 250 140 320 180 L 300 240 Q 250 260 200 220 Q 150 260 100 240 Z" fill="#1C1917"/>
      <path d="M 95 185 C 130 160 180 170 185 220 C 140 235 110 220 95 185 Z" fill="#C56A38" opacity="0.8"/>
      <path d="M 215 220 C 220 170 270 160 305 185 C 290 220 260 235 215 220 Z" fill="#C56A38" opacity="0.8"/>
      <line x1="60" y1="180" x2="90" y2="180" stroke="#1C1917" stroke-width="8"/>
      <line x1="310" y1="180" x2="340" y2="180" stroke="#1C1917" stroke-width="8"/>
    </svg>`
  },
  {
    id: 'art-1',
    name: '雕塑典藏',
    category: 'Art',
    categoryLabel: '藝術',
    icon: '🗿',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#D9E4DD"/>
      <path d="M 160 320 L 170 120 C 170 90, 230 90, 230 120 L 240 320 Z" fill="#78716C"/>
      <circle cx="200" cy="110" r="45" fill="#A8A29E"/>
      <rect x="150" y="320" width="100" height="40" rx="6" fill="#1C1917"/>
    </svg>`
  }
];

const CATEGORIES = ['All', 'Portrait', 'Pet', 'Product', 'Object', 'Fashion', 'Art'] as const;

function svgToDataUrl(svgString: string): string {
  const encoded = encodeURIComponent(svgString);
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

export const UploadZone: React.FC<UploadZoneProps> = ({ onImageSelected, isLoading }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMsg('請上傳有效的圖片檔案 (PNG, JPG, WEBP)。');
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setErrorMsg('檔案大小超過限制 (最大 15MB)。');
      return;
    }

    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        onImageSelected(e.target.result as string);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isLoading) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isLoading) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const filteredSamples = selectedCategory === 'All'
    ? SAMPLE_IMAGES
    : SAMPLE_IMAGES.filter((s) => s.category === selectedCategory);

  return (
    <div className="upload-container">
      {/* Studio Header Bar */}
      <div className="atelier-section-header">
        <div className="header-meta">
          <span className="atelier-label">ATELIER STUDIO</span>
          <h2 className="atelier-heading">Library</h2>
        </div>
      </div>

      {/* Main Studio Upload Hero Card */}
      <div
        className={`dropzone ${isDragOver ? 'drag-active' : ''} ${isLoading ? 'disabled' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !isLoading && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png, image/jpeg, image/webp"
          style={{ display: 'none' }}
          onChange={handleFileChange}
          disabled={isLoading}
        />

        <div className="dropzone-icon">
          <UploadCloud size={32} className="pulse-icon" />
        </div>

        <h3 className="dropzone-title">拖曳圖片到此處，或點擊選擇檔案</h3>
        <p className="dropzone-hint">支援 PNG, JPG, WEBP 高清格式（最大 15MB）</p>

        <button className="button primary select-btn" type="button" disabled={isLoading}>
          <ImageIcon size={16} />
          上傳圖片
        </button>
      </div>

      {errorMsg && (
        <div className="notice error row align-center">
          <AlertCircle size={18} />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Atelier Collection Grid Section */}
      <div className="samples-section">
        <div className="samples-header">
          <div className="samples-title-group">
            <span className="atelier-label">ATELIER COLLECTION</span>
            <h3 className="samples-subtitle">快速嘗試範例與素材集</h3>
          </div>
          <Sparkles size={16} className="sparkle-icon" />
        </div>

        {/* Category Filter Pills */}
        <div className="category-pills">
          {CATEGORIES.map((cat) => {
            const labelMap: Record<string, string> = {
              All: '全部 All',
              Portrait: '人像 Portrait',
              Pet: '寵物 Pet',
              Product: '商品 Product',
              Object: '物件 Object',
              Fashion: '時尚 Fashion',
              Art: '藝術 Art',
            };
            return (
              <button
                key={cat}
                type="button"
                className={`category-pill ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {labelMap[cat] || cat}
              </button>
            );
          })}
        </div>

        <div className="samples-grid">
          {/* Preset Sample Cards with Atelier style tags & hover overlays */}
          {filteredSamples.map((sample) => (
            <button
              key={sample.id}
              type="button"
              className="sample-card"
              onClick={() => onImageSelected(svgToDataUrl(sample.svg))}
              disabled={isLoading}
            >
              <div
                className="sample-thumb"
                style={{
                  backgroundImage: `url("${svgToDataUrl(sample.svg)}")`,
                }}
              >
                <span className="edited-badge">✦ EDITED</span>

                {/* Hover Quick Action Overlay */}
                <div className="sample-hover-overlay">
                  <span className="overlay-btn">
                    <Play size={12} fill="currentColor" /> ✦ 嘗試 AI 去背
                  </span>
                </div>
              </div>
              <div className="sample-card-body">
                <span className="sample-name">
                  {sample.icon} {sample.name}
                </span>
                <span className="sample-meta">{sample.category} • Atelier Studio</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
