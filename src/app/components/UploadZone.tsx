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
      setErrorMsg('Please upload a valid image file (PNG, JPG, or WEBP).');
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setErrorMsg('This file is larger than the 15 MB limit.');
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
    <section className="upload-hero atelier-upload-hero">
      <div className="atelier-hero-copy">
        <span className="hero-eyebrow atelier-eyebrow">
          <ImageIcon size={12} /> AI IMAGE STUDIO
        </span>
        <h1 className="hero-title">Keep the subject.<br />Lose the noise.</h1>
        <p className="hero-subtitle">Remove the background from portraits, products, and everyday images with precise AI-powered separation.</p>
        <div className="atelier-hero-actions">
          <button className="button primary" type="button" disabled={isLoading} onClick={() => fileInputRef.current?.click()}>
            <UploadCloud size={16} /> Upload image
          </button>
          <span className="atelier-action-note">No account required</span>
        </div>
        <div className="atelier-hero-specs" aria-label="Workflow">
          <div><strong>01</strong><span>Detect subject</span></div>
          <div><strong>02</strong><span>Remove background</span></div>
          <div><strong>03</strong><span>Export cleanly</span></div>
        </div>
      </div>

      <div className="upload-container atelier-upload-container">
        <div className="atelier-upload-heading">
          <span className="atelier-upload-icon"><ImageIcon size={19} /></span>
          <div><strong>Drop your image here</strong><span>or choose a file to begin</span></div>
        </div>
        <div className="atelier-upload-meta">PNG, JPG, WEBP <span>·</span> up to 15 MB</div>
        <div className="atelier-upload-card">
          <div
            className={`dropzone atelier-dropzone ${isDragOver ? 'drag-active' : ''} ${isLoading ? 'disabled' : ''}`}
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

            <span className="atelier-dropzone-mark"><UploadCloud size={20} /></span>
            <p className="dropzone-title">Choose a file or drop it here</p>
            <p className="dropzone-hint">Your image stays in this workspace while it is processed.</p>
          </div>
        </div>
        {errorMsg && (
          <div className="notice error row align-center">
            <AlertCircle size={18} />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>
    </section>
  );
};
