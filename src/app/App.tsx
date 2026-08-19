import { useState } from 'react';
import { Wand2, Sparkles, AlertCircle, RefreshCw, Layers } from 'lucide-react';
import { UploadZone } from './components/UploadZone';
import { ComparisonSlider, type BgConfig } from './components/ComparisonSlider';
import { BackgroundCustomizer } from './components/BackgroundCustomizer';
import { ExportToolbar } from './components/ExportToolbar';

export function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [svgPath, setSvgPath] = useState<string | null>(null);
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [bgConfig, setBgConfig] = useState<BgConfig>({
    mode: 'transparent',
    color: '#FFFFFF',
    customImageUrl: null,
    blurAmount: 10,
  });

  const handleImageSelected = async (dataUrl: string) => {
    setOriginalImage(dataUrl);
    setIsLoading(true);
    setErrorMsg(null);
    setSvgPath(null);
    setSubjectLabel(null);

    try {
      const response = await fetch('/api/remove-bg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: dataUrl }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `API Error (${response.status})`);
      }

      const data = await response.json();
      setSvgPath(data.svgPath);
      setSubjectLabel(data.label || '偵測到的目標');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Background removal error:', message);
      setErrorMsg(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setOriginalImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setErrorMsg(null);
    setIsLoading(false);
    setBgConfig({
      mode: 'transparent',
      color: '#FFFFFF',
      customImageUrl: null,
      blurAmount: 10,
    });
  };

  return (
    <div className="app-shell">
      {/* Top Brand Header */}
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">
            <Wand2 size={24} />
          </div>
          <div>
            <h1 className="brand-title">
              Auto BG Remover <span className="badge-ai"><Sparkles size={12} /> Gemini AI</span>
            </h1>
            <p className="brand-subtitle">秒速自動去除背景，高清透明 PNG 下載與自訂背景編輯</p>
          </div>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="app-main">
        {/* Step 1: Uploading State */}
        {!originalImage && (
          <UploadZone onImageSelected={handleImageSelected} isLoading={isLoading} />
        )}

        {/* Step 2: Processing / Loading Overlay */}
        {isLoading && (
          <div className="loading-card">
            <div className="spinner-wrapper">
              <RefreshCw size={40} className="spinning-icon" />
            </div>
            <h3 className="loading-title">Gemini AI 正在分析主體輪廓與去背...</h3>
            <p className="loading-sub">精確分割人像、寵物、商品與各類物件</p>
          </div>
        )}

        {/* Error Notice */}
        {errorMsg && (
          <div className="notice error row align-center error-box">
            <AlertCircle size={20} />
            <div className="error-content">
              <strong>去背處理失敗：</strong> {errorMsg}
            </div>
            <button type="button" className="button subtle" onClick={handleReset}>
              重試
            </button>
          </div>
        )}

        {/* Step 3: Editor & Comparison Preview */}
        {originalImage && !isLoading && (
          <div className="editor-grid">
            {/* Left: Interactive Before/After Comparison Slider */}
            <div className="preview-panel">
              <div className="panel-header-row">
                <span className="panel-heading">
                  <Layers size={16} /> 預設即時對比預覽
                </span>
                {subjectLabel && (
                  <span className="badge-subject">
                    已辨識：{subjectLabel}
                  </span>
                )}
              </div>

              <ComparisonSlider
                originalImage={originalImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
              />
            </div>

            {/* Right: Controls & Export Toolbar */}
            <div className="controls-panel">
              <BackgroundCustomizer config={bgConfig} onChange={setBgConfig} />

              <ExportToolbar
                originalImage={originalImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
                onReset={handleReset}
              />
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>© 2026 Image Background Remover Tool — Powered by Cloudflare Workers & Google Gemini AI</p>
      </footer>
    </div>
  );
}

export default App;
