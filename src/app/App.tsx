import { useState, useEffect } from 'react';
import { Sparkles, AlertCircle, RefreshCw, Layers, Link as LinkIcon, X } from 'lucide-react';
import { UploadZone } from './components/UploadZone';
import { ComparisonSlider, type BgConfig } from './components/ComparisonSlider';
import { BackgroundCustomizer } from './components/BackgroundCustomizer';
import { ExportToolbar } from './components/ExportToolbar';
import ConnectPanel from './components/ConnectPanel';
import AgentPicker from './components/AgentPicker';
import type { ConnectedAgent } from '../shared/types';
import { api } from './api';

import { compressImageForAI, removeBackgroundLocal } from './utils/image';

export function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [cutoutImage, setCutoutImage] = useState<string | null>(null);
  const [svgPath, setSvgPath] = useState<string | null>(null);
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Manyfold Agents state
  const [agents, setAgents] = useState<ConnectedAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);

  const [bgConfig, setBgConfig] = useState<BgConfig>({
    mode: 'transparent',
    color: '#FFFFFF',
    customImageUrl: null,
    blurAmount: 10,
  });

  const fetchAgents = async () => {
    try {
      const res = await api<{ agents: ConnectedAgent[] }>('/api/agents');
      setAgents(res.agents || []);
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

  const handleImageSelected = async (dataUrl: string) => {
    setOriginalImage(dataUrl);
    setIsLoading(true);
    setErrorMsg(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);

    try {
      // 1. Initiate pixel-perfect client-side neural net background removal
      const localTask = removeBackgroundLocal(dataUrl)
        .then((url) => {
          setCutoutImage(url);
          return url;
        })
        .catch((err) => {
          console.warn('Local background removal warning:', err);
          return null;
        });

      // 2. Initiate AI vision analysis & label detection
      const apiTask = (async () => {
        const compressedImage = await compressImageForAI(dataUrl, 1024, 0.85);
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

        if (response.ok) {
          const data = await response.json();
          setSvgPath(data.svgPath);
          setSubjectLabel(data.label || '辨識成功');
          return data;
        }
        return null;
      })().catch((err) => {
        console.warn('AI Vision API warning:', err);
        return null;
      });

      const [localRes, apiRes] = await Promise.all([localTask, apiTask]);

      if (!localRes && !apiRes) {
        throw new Error('去背處理失敗：無法生成透明背景圖片。');
      }
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
  };

  return (
    <div className="app-shell">
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

        {/* Manyfold Connect Button & Agent Picker */}
        <div className="header-actions">
          {agents.length > 0 ? (
            <div className="agent-selector-row">
              <span className="small muted">Agent:</span>
              <AgentPicker
                agents={agents}
                selectedId={selectedAgentId}
                onSelect={(id) => setSelectedAgentId(id)}
              />
              <button
                type="button"
                className="button subtle"
                onClick={() => setShowConnectModal(true)}
              >
                <LinkIcon size={14} /> 管理
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button subtle"
              onClick={() => setShowConnectModal(true)}
            >
              <LinkIcon size={16} />
              Connect Manyfold Agent
            </button>
          )}
        </div>
      </header>

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Connect Manyfold Agent</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowConnectModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="small muted">
              直接登入授權您的 Manyfold AI Agent，無需自行設定 GEMINI_API_KEY 即可使用去背服務。
            </p>
            <ConnectPanel
              initialSession={null}
              onConnected={async () => {
                await fetchAgents();
                setShowConnectModal(false);
              }}
            />
          </div>
        </div>
      )}

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
                {subjectLabel && (
                  <span className="badge-subject">
                    已辨識：{subjectLabel}
                  </span>
                )}
              </div>

              <ComparisonSlider
                originalImage={originalImage}
                cutoutImage={cutoutImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
              />
            </div>

            {/* Right: Controls & Export Toolbar */}
            <div className="controls-panel">
              <BackgroundCustomizer config={bgConfig} onChange={setBgConfig} />

              <ExportToolbar
                originalImage={originalImage}
                cutoutImage={cutoutImage}
                svgPath={svgPath}
                bgConfig={bgConfig}
                onReset={handleReset}
              />
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>© 2026 Image Background Remover Tool — Powered by Cloudflare Workers & Manyfold AI</p>
      </footer>
    </div>
  );
}

export default App;
