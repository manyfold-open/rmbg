import { useState, useRef } from 'react';
import { UploadCloud, Image as ImageIcon, AlertCircle } from 'lucide-react';
import { MAX_BATCH_SIZE } from '../batch';
import type { SelectedImage } from '../types/studio';

const MAX_FILE_BYTES = 15 * 1024 * 1024;

interface UploadZoneProps {
  onImagesSelected: (images: SelectedImage[]) => void;
  isLoading: boolean;
}

const readAsDataUrl = (file: File) =>
  new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

export const UploadZone: React.FC<UploadZoneProps> = ({ onImagesSelected, isLoading }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Take everything droppable, keep what is usable, and say what was dropped and why —
   * silently ignoring eleven of twenty files would look like the app had simply lost them.
   */
  const processFiles = async (fileList: FileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const rejected: string[] = [];
    const usable = files.filter((file) => {
      if (!file.type.startsWith('image/')) {
        rejected.push(`${file.name} is not an image`);
        return false;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} is over the 15 MB limit`);
        return false;
      }
      return true;
    });

    const accepted = usable.slice(0, MAX_BATCH_SIZE);
    if (usable.length > MAX_BATCH_SIZE) {
      rejected.push(`only the first ${MAX_BATCH_SIZE} images were taken`);
    }

    setErrorMsg(rejected.length > 0 ? `Skipped: ${rejected.join('; ')}.` : null);
    if (accepted.length === 0) return;

    const images = await Promise.all(
      accepted.map(async (file) => {
        const dataUrl = await readAsDataUrl(file);
        return dataUrl ? { name: file.name, dataUrl } : null;
      }),
    );

    const loaded = images.filter((image): image is SelectedImage => image !== null);
    if (loaded.length < accepted.length) {
      setErrorMsg(`${accepted.length - loaded.length} file(s) could not be read.`);
    }
    if (loaded.length > 0) onImagesSelected(loaded);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isLoading) return;

    if (e.dataTransfer.files?.length) {
      void processFiles(e.dataTransfer.files);
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
    if (e.target.files?.length) {
      void processFiles(e.target.files);
    }
    // Let the same selection be picked again after a reset.
    e.target.value = '';
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
            <UploadCloud size={16} /> Upload images
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
          <div><strong>Drop your images here</strong><span>one, or up to {MAX_BATCH_SIZE} at once</span></div>
        </div>
        <div className="atelier-upload-meta">PNG, JPG, WEBP <span>·</span> up to 15 MB each</div>
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
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={isLoading}
            />

            <span className="atelier-dropzone-mark"><UploadCloud size={20} /></span>
            <p className="dropzone-title">Choose files or drop them here</p>
            <p className="dropzone-hint">Drop several and they run as a batch. Your images stay in this workspace while they are processed.</p>
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
