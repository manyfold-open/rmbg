import { useState, useRef } from 'react';
import { UploadCloud, Image as ImageIcon, AlertCircle } from 'lucide-react';

interface UploadZoneProps {
  onImageSelected: (dataUrl: string) => void;
  isLoading: boolean;
}

export const UploadZone: React.FC<UploadZoneProps> = ({ onImageSelected, isLoading }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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

  return (
    <div className="upload-container">
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
    </div>
  );
};
