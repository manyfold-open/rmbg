import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, RefreshCw, Layers, Keyboard, Settings, Image as ImageIcon } from 'lucide-react';
import { UploadZone } from './components/UploadZone';
import { BatchGrid } from './components/BatchGrid';
import { ComparisonSlider } from './components/ComparisonSlider';
import { BackgroundCustomizer } from './components/BackgroundCustomizer';
import { ExportToolbar } from './components/ExportToolbar';
import { HistoryDrawer } from './components/HistoryDrawer';
import SettingsView from './components/SettingsView';
import { ToastContainer } from './components/Toast';
import type { AppState } from '../shared/types';
import type {
  BatchItem,
  BgConfig,
  HistoryItem,
  PostProcessConfig,
  SelectedImage,
  ToastMessage,
} from './types/studio';
import { DEFAULT_POST_PROCESS } from './types/studio';
import { api } from './api';
import { addHistoryItem, clearHistoryStore, createHistoryId, loadHistory } from './history';
import { removeBackground } from './remove';
import { BATCH_CONCURRENCY, cutoutFileName, runQueue } from './batch';
import { downloadDataUrl } from './utils/download';

export function App() {
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname);
  const [appState, setAppState] = useState<AppState | null>(null);

  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [cutoutImage, setCutoutImage] = useState<string | null>(null);
  const [svgPath, setSvgPath] = useState<string | null>(null);
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  /** What the agent is doing right now. An agent turn runs for minutes — say something. */
  const [progressHint, setProgressHint] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Batch state. Empty means the app is in its ordinary one-image-at-a-time mode.
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState<boolean>(false);

  // Background Manyfold Agents state for A2A delegation
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const fetchState = async () => {
    try {
      const res = await api<AppState>('/api/state');
      setAppState(res);
      if (res.agents && res.agents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(res.agents[0].agentId);
      }
    } catch {
      // Ignore initial state fetch error if unauthenticated
    }
  };

  useEffect(() => {
    void fetchState();
  }, []);

  // Listen to browser forward/back popstate
  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  // Studio customizer state
  const [bgConfig, setBgConfig] = useState<BgConfig>({
    mode: 'transparent',
    color: '#FFFFFF',
    customImageUrl: null,
    blurAmount: 10,
  });

  const [postProcess, setPostProcess] = useState<PostProcessConfig>(DEFAULT_POST_PROCESS);

  // History & Toast State
  const [history, setHistory] = useState<HistoryItem[]>([]);

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

  useEffect(() => {
    let disposed = false;

    const refreshHistory = async () => {
      try {
        const items = await loadHistory();
        if (!disposed) setHistory(items);
      } catch (err) {
        console.error('Session history load failed:', err);
        if (!disposed) showToast('Session history could not be loaded.', 'warning');
      }
    };

    void refreshHistory();
    const cleanupTimer = window.setInterval(() => void refreshHistory(), 60_000);

    return () => {
      disposed = true;
      window.clearInterval(cleanupTimer);
    };
  }, [showToast]);

  const historyChain = useRef<Promise<void>>(Promise.resolve());

  /**
   * Writes are serialised because a batch lands several images at once, and the
   * localStorage fallback in `history.ts` is a read-modify-write that would drop entries
   * if two of them overlapped.
   */
  const saveToHistory = (item: Omit<HistoryItem, 'id' | 'timestamp'>): Promise<void> => {
    const next = historyChain.current.then(async () => {
      const newItem: HistoryItem = {
        ...item,
        id: createHistoryId(),
        timestamp: Date.now(),
      };

      try {
        const updated = await addHistoryItem(newItem);
        setHistory(updated);
      } catch (err) {
        console.error('Session history save failed:', err);
        showToast('This result could not be saved to Session history.', 'warning');
      }
    });

    historyChain.current = next;
    return next;
  };

  const clearHistory = async () => {
    try {
      await clearHistoryStore();
      setHistory([]);
      showToast('All history has been cleared', 'info');
    } catch (err) {
      console.error('Session history clear failed:', err);
      showToast('Session history could not be cleared.', 'warning');
    }
  };

  /** The one-image studio flow: the result takes over the canvas. */
  const runSingleImage = async (dataUrl: string) => {
    setOriginalImage(dataUrl);
    setIsLoading(true);
    setErrorMsg(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setProgressHint(null);
    setPostProcess(DEFAULT_POST_PROCESS);

    try {
      const result = await removeBackground(dataUrl, {
        agentId: selectedAgentId,
        onProgress: setProgressHint,
      });

      setSubjectLabel(result.label);
      setCutoutImage(result.cutout);
      setSvgPath(result.svgPath);

      await saveToHistory({
        originalImage: dataUrl,
        cutoutImage: result.cutout,
        svgPath: result.svgPath,
        subjectLabel: result.label,
      });

      showToast(`✦ Background removed (${result.label})`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Background removal error:', message);
      setErrorMsg(message);
      showToast(message, 'warning');
    } finally {
      setIsLoading(false);
      setProgressHint(null);
    }
  };

  const updateBatchItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setBatchItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /**
   * Run these items through the queue. Used both for a fresh batch and for retrying the
   * failures out of one, so the retry path cannot drift from the original.
   */
  const runBatchItems = async (targets: BatchItem[]) => {
    setIsBatchRunning(true);
    let succeeded = 0;
    let failed = 0;

    try {
      await runQueue(targets, BATCH_CONCURRENCY, async (target) => {
        updateBatchItem(target.id, {
          status: 'processing',
          progress: 'Handing to the agent…',
          error: null,
        });

        try {
          const result = await removeBackground(target.originalImage, {
            agentId: selectedAgentId,
            onProgress: (message) => updateBatchItem(target.id, { progress: message }),
          });

          updateBatchItem(target.id, {
            status: 'done',
            progress: null,
            cutoutImage: result.cutout,
            subjectLabel: result.label,
            error: null,
          });
          succeeded += 1;

          await saveToHistory({
            originalImage: target.originalImage,
            cutoutImage: result.cutout,
            svgPath: result.svgPath,
            subjectLabel: result.label,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Background removal error (${target.name}):`, message);
          updateBatchItem(target.id, { status: 'failed', progress: null, error: message });
          failed += 1;
        }
      });
    } finally {
      setIsBatchRunning(false);
    }

    if (failed === 0) {
      showToast(`✦ ${succeeded} image${succeeded === 1 ? '' : 's'} ready`, 'success');
    } else {
      showToast(`${succeeded} ready, ${failed} failed — retry the failures from their cards.`, 'warning');
    }
  };

  const handleImagesSelected = async (images: SelectedImage[]) => {
    if (images.length === 0) return;

    // One image is the studio, not a batch — a grid of one would be a worse editor.
    if (images.length === 1) {
      await runSingleImage(images[0].dataUrl);
      return;
    }

    const batchId = Date.now();
    const items: BatchItem[] = images.map((image, index) => ({
      id: `batch-${batchId}-${index}`,
      name: image.name,
      originalImage: image.dataUrl,
      status: 'queued',
      progress: null,
      cutoutImage: null,
      subjectLabel: null,
      error: null,
    }));

    setErrorMsg(null);
    setBatchItems(items);
    await runBatchItems(items);
  };

  const handleRetryBatchItem = (id: string) => {
    if (isBatchRunning) return;
    const target = batchItems.find((item) => item.id === id);
    if (target) void runBatchItems([target]);
  };

  const handleDownloadBatchItem = (item: BatchItem) => {
    if (!item.cutoutImage) return;
    downloadDataUrl(item.cutoutImage, cutoutFileName(item.name));
  };

  const handleDownloadBatch = () => {
    const ready = batchItems.filter((item) => item.status === 'done' && item.cutoutImage);
    if (ready.length === 0) return;

    // Staggered: browsers drop downloads fired from a single tight loop.
    ready.forEach((item, index) => {
      window.setTimeout(
        () => downloadDataUrl(item.cutoutImage!, cutoutFileName(item.name)),
        index * 200,
      );
    });
    showToast(`Downloading ${ready.length} cutouts…`, 'success');
  };

  const handleReset = () => {
    setOriginalImage(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setErrorMsg(null);
    setIsLoading(false);
    setProgressHint(null);
    setBgConfig({
      mode: 'transparent',
      color: '#FFFFFF',
      customImageUrl: null,
      blurAmount: 10,
    });
    setPostProcess(DEFAULT_POST_PROCESS);
  };

  /** Pull one finished batch image onto the canvas. The grid stays put underneath it. */
  const handleOpenBatchItem = (item: BatchItem) => {
    setOriginalImage(item.originalImage);
    setCutoutImage(item.cutoutImage);
    setSvgPath(null);
    setSubjectLabel(item.subjectLabel);
    setErrorMsg(null);
    setPostProcess(DEFAULT_POST_PROCESS);
    showToast(`Opened ${item.name} in the studio`, 'info');
  };

  const handleClearBatch = () => {
    handleReset();
    setBatchItems([]);
  };

  const handleRestoreHistoryItem = (item: HistoryItem) => {
    setOriginalImage(item.originalImage);
    setCutoutImage(item.cutoutImage);
    setSvgPath(item.svgPath ?? null);
    setSubjectLabel(item.subjectLabel);
    setPostProcess(DEFAULT_POST_PROCESS);
    showToast(`Loaded history item: ${item.subjectLabel || 'background removal'}`, 'info');
  };

  // Keyboard Shortcuts Listener
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
        showToast('Canvas and settings reset', 'info');
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

  const isSettingsRoute = currentPath === '/settings' || currentPath.startsWith('/settings');

  return (
    <div className="app-shell atelier-app-shell">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <header className="atelier-header">
        <button type="button" className="atelier-brand" onClick={() => navigateTo('/')}>
          <img src="/atelier-icon.png" alt="Atelier" className="atelier-brand-icon" />
          <span>ATELIER</span>
        </button>
        <div className="atelier-header-actions">
          <span className="atelier-header-note">Private image workspace</span>
          {isSettingsRoute ? (
            <button type="button" className="atelier-header-button" onClick={() => navigateTo('/')}>
              <ImageIcon size={15} />
              <span>Studio</span>
            </button>
          ) : (
            <button type="button" className="atelier-header-button" onClick={() => navigateTo('/settings')}>
              <Settings size={15} />
              <span>Settings</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content View */}
      {isSettingsRoute ? (
        <main className="app-main atelier-main">
          <SettingsView
            agents={appState?.agents || []}
            initialSession={appState?.connect?.session || null}
            adminRequired={appState?.adminRequired || false}
            adminOk={appState?.adminOk ?? true}
            refreshState={fetchState}
            onBackToCanvas={() => navigateTo('/')}
            showToast={showToast}
          />
        </main>
      ) : (
        <main className="app-main atelier-main">
          {/* Step 1: Uploading State */}
          {!originalImage && batchItems.length === 0 && (
            <UploadZone onImagesSelected={handleImagesSelected} isLoading={isLoading} />
          )}

          {/* Step 2: Processing / Loading Overlay */}
          {isLoading && (
            <section className="atelier-processing" aria-live="polite">
              <div className="processing-mark"><RefreshCw size={22} className="spinning-icon" /></div>
              <span className="atelier-eyebrow">PROCESSING IMAGE</span>
              <h2>Separating the subject.</h2>
              <p>{progressHint ?? 'Detecting edges, hair, and transparent detail.'}</p>
              <div className="processing-progress" aria-hidden="true"><span /></div>
              <span className="processing-meta">{progressHint ? 'Agent processing can take a few minutes.' : 'Usually ready in a few seconds.'}</span>
            </section>
          )}

          {/* Error Notice */}
          {errorMsg && (
            <div className="notice error row align-center error-box">
              <AlertCircle size={20} />
              <div className="error-content">
                <strong>Background removal failed:</strong> {errorMsg}
              </div>
              <button type="button" className="button subtle" onClick={handleReset}>
                Try again
              </button>
            </div>
          )}

          {/* Step 3: Editor & Comparison Preview */}
          {originalImage && !isLoading && (
            <div className="atelier-studio-shell">
              <div className="studio-titlebar">
                <div>
                  <span className="atelier-eyebrow">STUDIO / READY</span>
                  <h2>Make the final cut.</h2>
                </div>
                <div className="studio-titlebar-meta">
                  <span className="studio-status-dot" />
                  <span>{subjectLabel ? `Subject: ${subjectLabel}` : 'Subject detected'}</span>
                </div>
              </div>
              <div className="editor-grid">
              {/* Left: Interactive Before/After Comparison Slider */}
              <div className="preview-panel">
                <div className="panel-header-row">
                  <span className="panel-heading">
                    <Layers size={16} /> Live comparison
                  </span>
                  <div className="panel-badges">
                    {subjectLabel && (
                      <span className="badge-subject">
                        Detected: {subjectLabel}
                      </span>
                    )}
                    <span className="badge-hint">
                      <Keyboard size={12} /> Hold Space to view original
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
                    showToast('Effects and color adjustments reset', 'info');
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
            </div>
          )}

          {/* Batch results — stays below the studio so opening one image keeps the grid */}
          {batchItems.length > 0 && (
            <BatchGrid
              items={batchItems}
              isRunning={isBatchRunning}
              onRetry={handleRetryBatchItem}
              onOpen={handleOpenBatchItem}
              onDownload={handleDownloadBatchItem}
              onDownloadAll={handleDownloadBatch}
              onReset={handleClearBatch}
            />
          )}

          {/* Session History Drawer */}
          <HistoryDrawer
            history={history}
            onSelect={handleRestoreHistoryItem}
            onClear={clearHistory}
          />
        </main>
      )}

      <footer className="app-footer">
        <p>© 2026 Atelier — Powered by Cloudflare Workers & Manyfold AI</p>
        <a
          className="footer-github-link"
          href="https://github.com/manyfold-open/rmbg"
          target="_blank"
          rel="noreferrer"
          aria-label="Open the Atelier GitHub repository"
          title="GitHub repository"
        >
          <img src="/github.svg" alt="" aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}

export default App;
