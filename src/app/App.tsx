import { useState, useEffect, useCallback } from 'react';
import { Sparkles, AlertCircle, RefreshCw, Layers, Keyboard } from 'lucide-react';
import { UploadZone } from './components/UploadZone';
import { ComparisonSlider } from './components/ComparisonSlider';
import { BackgroundCustomizer } from './components/BackgroundCustomizer';
import { ExportToolbar } from './components/ExportToolbar';
import { HistoryDrawer } from './components/HistoryDrawer';
import { ToastContainer } from './components/Toast';
import type { ConnectedAgent } from '../shared/types';
import type { BgConfig, PostProcessConfig, HistoryItem, ToastMessage } from './types/studio';
import { DEFAULT_POST_PROCESS } from './types/studio';
import { api } from './api';

import { compressImageForAI, createCutoutFromSvgPath } from './utils/image';

const STORAGE_KEY_HISTORY = 'rmbg_atelier_history';

export function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [cutoutImage, setCutoutImage] = useState<string | null>(null);
  const [svgPath, setSvgPath] = useState<string | null>(null);
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Background Manyfold Agents state for A2A delegation
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const fetchAgents = async () => {
    try {
      const res = await api<{ agents: ConnectedAgent[] }>('/api/agents');
      if (res.agents && res.agents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(res.agents[0].agentId);
      }
    } catch {
      // Ignore initial agent fetch error if unauthenticated/unsupported
    }
  };

  useEffect(() => {
    void fetchAgents();
  }, []);

  // Studio customizer state
  const [bgConfig, setBgConfig] = useState<BgConfig>({
    mode: 'transparent',
    color: '#FFFFFF',
    customImageUrl: null,
    blurAmount: 10,
  });

  const [postProcess, setPostProcess] = useState<PostProcessConfig>(DEFAULT_POST_PROCESS);

  // History & Toast State
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_HISTORY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [forceShowOriginal, setForceShowOriginal] = useState<boolean>(false);

  const showToast = useCallback((text: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, text, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const saveToHistory = (item: Omit<HistoryItem, 'id' | 'timestamp'>) => {
    const newItem: HistoryItem = {
      ...item,
      id: `hist-${Date.now()}`,
      timestamp: Date.now(),
    };
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.originalImage !== item.originalImage);
      const updated = [newItem, ...filtered].slice(0, 8); // Keep last 8 items
      try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(updated));
      } catch {
        // Fallback gracefully if quota exceeded
      }
      return updated;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(STORAGE_KEY_HISTORY);
    } catch {}
    showToast('歷史紀錄已全部清除', 'info');
  };

  const handleImageSelected = async (dataUrl: string) => {
    setOriginalImage(dataUrl);
    setIsLoading(true);
    setErrorMsg(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setPostProcess(DEFAULT_POST_PROCESS);

    try {
      // 1. Compress image payload preserving alpha channel for AI vision processing under 600KB payload limit
      const compressedImage = await compressImageForAI(dataUrl, 1536, 0.85);

      // 2. Call background removal API powered by Manyfold Agent / Gemini 3.6 Flash
      const response = await fetch('/api/remove-bg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: compressedImage,
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errDetail = errorData.error?.message || errorData.message || `HTTP ${response.status}`;
        throw new Error(`去背處理失敗 (${errDetail})`);
      }

      const data = (await response.json()) as {
        label?: string;
        image?: string;
        svgPath?: string;
      };

      if (!data.image && !data.svgPath) {
        throw new Error('去背處理失敗：未收到 Agent 去背圖片結果。');
      }

      const extractedLabel = data.label || '辨識成功';
      setSubjectLabel(extractedLabel);

      if (data.image) {
        // Native image background removal from Agent
        setCutoutImage(data.image);
        setSvgPath(null);

        saveToHistory({
          originalImage: dataUrl,
          cutoutImage: data.image,
          svgPath: null,
          subjectLabel: extractedLabel,
        });
      } else if (data.svgPath) {
        // Legacy SVG path fallback
        const extractedSvgPath = data.svgPath;
        setSvgPath(extractedSvgPath);
        const generatedCutout = await createCutoutFromSvgPath(dataUrl, extractedSvgPath);
        setCutoutImage(generatedCutout);

        saveToHistory({
          originalImage: dataUrl,
          cutoutImage: generatedCutout,
          svgPath: extractedSvgPath,
          subjectLabel: extractedLabel,
        });
      }

      showToast(`✦ AI 去背與主體辨識完成 (${extractedLabel})`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Background removal error:', message);
      setErrorMsg(message);
      showToast(message, 'warning');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setOriginalImage(null);
    setCutoutImage(null);
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
    setPostProcess(DEFAULT_POST_PROCESS);
  };

  const handleRestoreHistoryItem = (item: HistoryItem) => {
    setOriginalImage(item.originalImage);
    setCutoutImage(item.cutoutImage);
    setSvgPath(item.svgPath ?? null);
    setSubjectLabel(item.subjectLabel);
    setPostProcess(DEFAULT_POST_PROCESS);
    showToast(`已載入歷史項目：${item.subjectLabel || '去背圖片'}`, 'info');
  };

  // Keyboard Shortcuts Listener (Space: Hold to compare, Ctrl+Z: Reset)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.code === 'Space' && originalImage) {
        e.preventDefault();
        setForceShowOriginal(true);
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && originalImage) {
        e.preventDefault();
        handleReset();
        showToast('已重置畫布與設定', 'info');
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setForceShowOriginal(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [originalImage, showToast]);

  return (
    <div className="app-shell">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Top Brand Header */}
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">
            <span>A</span>
          </div>
          <div className="brand-text-group">
            <span className="brand-tag">ATELIER STUDIO</span>
            <h1 className="brand-title">
              Photo Editing & BG Remover <span className="badge-ai"><Sparkles size={12} /> AI Powered</span>
            </h1>
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
            <h3 className="loading-title">AI 正在分析主體輪廓與去背...</h3>
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
                <div className="panel-badges">
                  {subjectLabel && (
                    <span className="badge-subject">
                      已辨識：{subjectLabel}
                    </span>
                  )}
                  <span className="badge-hint">
                    <Keyboard size={12} /> 長按 Space 查看原圖
                  </span>
                </div>
              </div>

              <ComparisonSlider
                originalImage={originalImage}
                cutoutImage={cutoutImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
                postProcess={postProcess}
                forceShowOriginal={forceShowOriginal}
              />
            </div>

            {/* Right: Controls & Export Toolbar */}
            <div className="controls-panel">
              <BackgroundCustomizer
                config={bgConfig}
                onChange={setBgConfig}
                postProcess={postProcess}
                onPostProcessChange={setPostProcess}
                onResetAll={() => {
                  setPostProcess(DEFAULT_POST_PROCESS);
                  showToast('已重置後處理與調色', 'info');
                }}
              />

              <ExportToolbar
                originalImage={originalImage}
                cutoutImage={cutoutImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
                postProcess={postProcess}
                onReset={handleReset}
                onShowToast={showToast}
              />
            </div>
          </div>
        )}

        {/* Session History Drawer */}
        <HistoryDrawer
          history={history}
          onSelect={handleRestoreHistoryItem}
          onClear={clearHistory}
        />
      </main>

      <footer className="app-footer">
        <p>© 2026 Image Background Remover Tool — Powered by Cloudflare Workers & Manyfold AI</p>
      </footer>
    </div>
  );
}

export default App;
