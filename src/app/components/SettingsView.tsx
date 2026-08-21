import { useState, useEffect } from 'react';
import {
  Bot,
  Cpu,
  HardDrive,
  ShieldCheck,
  RefreshCw,
  Trash2,
  ExternalLink,
  Copy,
  Check,
  Save,
  ArrowLeft,
  Database,
  Lock,
} from 'lucide-react';
import type { ConnectedAgent, ConnectSession, AppSettings, R2Item } from '../../shared/types';
import { api } from '../api';
import ConnectPanel from './ConnectPanel';
import PasswordGate from './PasswordGate';

export default function SettingsView(props: {
  agents: ConnectedAgent[];
  initialSession: ConnectSession | null;
  adminRequired: boolean;
  adminOk: boolean;
  refreshState: () => Promise<void>;
  onBackToCanvas?: () => void;
  showToast?: (text: string, type?: 'info' | 'success' | 'warning') => void;
}) {
  const [activeTab, setActiveTab] = useState<'agents' | 'models' | 'r2' | 'security'>('agents');
  
  // Settings & R2 State
  const [settings, setSettings] = useState<AppSettings>({
    bgRemoveModel: 'gemini-3.6-flash',
    bgRemoveMode: 'auto',
    geminiSystemPrompt:
      'You are Gemini 3.6 Flash, an expert computer vision model specializing in image segmentation and background removal. Analyze all main foreground subjects in this image (e.g. people, pets, products, objects, items). Extract the precise boundary contour outlining all main foreground subjects with ultra-high resolution edge accuracy, excluding background elements.',
    r2Enabled: true,
    r2BucketName: 'rmbg-images',
    maxImageResolution: 2048,
  });

  const [r2Items, setR2Items] = useState<R2Item[]>([]);
  const [r2Status, setR2Status] = useState<{ enabled: boolean; message?: string }>({ enabled: true });
  const [loadingR2, setLoadingR2] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Agents Action State
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [confirmAgentId, setConfirmAgentId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const fetchSettings = async () => {
    try {
      const res = await api<{ settings: AppSettings }>('/api/settings');
      if (res.settings) {
        setSettings(res.settings);
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  const fetchR2Items = async () => {
    setLoadingR2(true);
    try {
      const res = await api<{ items: R2Item[]; enabled: boolean; message?: string }>('/api/r2/list');
      setR2Items(res.items || []);
      setR2Status({ enabled: res.enabled, message: res.message });
    } catch (err) {
      console.error('Failed to list R2 items:', err);
      setR2Status({ enabled: false, message: '無法載入 R2 儲存清單' });
    } finally {
      setLoadingR2(false);
    }
  };

  useEffect(() => {
    if (props.adminOk || !props.adminRequired) {
      void fetchSettings();
      void fetchR2Items();
    }
  }, [props.adminOk, props.adminRequired]);

  // Lock Page if Admin Password Required and not passed
  if (props.adminRequired && !props.adminOk) {
    return <PasswordGate onSubmitted={props.refreshState} />;
  }

  const handleSaveSettings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSavingSettings(true);
    setNotice(null);
    try {
      const res = await api<{ settings: AppSettings }>('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (res.settings) {
        setSettings(res.settings);
      }
      setNotice({ type: 'success', text: '設定檔已成功儲存並更新！' });
      if (props.showToast) props.showToast('系統與工具設定已儲存', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `儲存失敗: ${msg}` });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleVerifyAgent = async (agentId: string) => {
    setBusyAgentId(agentId);
    setNotice(null);
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/verify`, { method: 'POST' });
      await props.refreshState();
      if (props.showToast) props.showToast('Agent 驗證成功', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `Agent 驗證失敗: ${msg}` });
    } finally {
      setBusyAgentId(null);
    }
  };

  const handleDisconnectAgent = async (agentId: string) => {
    setBusyAgentId(agentId);
    setNotice(null);
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      setConfirmAgentId(null);
      await props.refreshState();
      if (props.showToast) props.showToast('已移除 Agent 連線', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `斷開連線失敗: ${msg}` });
    } finally {
      setBusyAgentId(null);
    }
  };

  const handleDeleteR2Item = async (key: string) => {
    try {
      await api(`/api/r2/${encodeURIComponent(key)}`, { method: 'DELETE' });
      setR2Items((prev) => prev.filter((item) => item.key !== key));
      if (props.showToast) props.showToast('已從 R2 儲存區刪除圖片', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `刪除 R2 圖片失敗: ${msg}` });
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    const fullUrl = window.location.origin + text;
    void navigator.clipboard.writeText(fullUrl);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
    if (props.showToast) props.showToast('圖片 URL 已複製到剪貼簿', 'success');
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="admin-settings-container">
      {/* Top Header Row with Return Button */}
      <div className="settings-header-row">
        <div className="settings-title-group">
          <button
            type="button"
            className="button subtle btn-back"
            onClick={props.onBackToCanvas || (() => (window.location.href = '/'))}
          >
            <ArrowLeft size={16} /> 返回去背畫布
          </button>
          <div className="settings-heading-text">
            <span className="atelier-label">SYSTEM & SERVICE GOVERNANCE</span>
            <h1 className="atelier-heading">系統與工具管理設定</h1>
          </div>
        </div>

        <div className="settings-badge-status">
          <span className={`status-pill ${props.adminRequired ? 'protected' : 'open'}`}>
            <Lock size={12} />
            {props.adminRequired ? '管理員權限控制中' : '開放部署模式'}
          </span>
        </div>
      </div>

      {notice && (
        <div className={`notice ${notice.type === 'error' ? 'error' : 'success'} row align-center`}>
          <span>{notice.text}</span>
        </div>
      )}

      {/* Settings Navigation Tabs */}
      <div className="settings-tabs">
        <button
          type="button"
          className={`tab-item ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          <Bot size={18} />
          <span>Manyfold Agent 授權 ({props.agents.length})</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          <Cpu size={18} />
          <span>AI 去背與 Vision 模型</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'r2' ? 'active' : ''}`}
          onClick={() => setActiveTab('r2')}
        >
          <HardDrive size={18} />
          <span>Cloudflare R2 圖片庫 ({r2Items.length})</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
        >
          <ShieldCheck size={18} />
          <span>安全性與診斷</span>
        </button>
      </div>

      {/* Tab 1: Manyfold Agents */}
      {activeTab === 'agents' && (
        <section className="panel tab-panel">
          <div className="panel-header">
            <h3>Connected Manyfold Agents</h3>
            <p className="muted">
              管理已授權至此星系的 Manyfold AI Agent。可進行線上驗證、連線輪替與取消綁定。
            </p>
          </div>

          <div className="agent-list">
            {props.agents.length === 0 ? (
              <div className="empty-state">
                <p className="muted">尚未連線任何 Manyfold Agent，請在下方開始 OAuth 授權。</p>
              </div>
            ) : (
              props.agents.map((agent) => (
                <div className="agent-card" key={agent.agentId}>
                  <div className="agent-card-main">
                    <div className="agent-card-title">
                      <strong>{agent.name}</strong>
                      {agent.verified ? (
                        <span className="badge ok">✓ verified</span>
                      ) : (
                        <span className="badge warn" title={agent.warning ?? undefined}>
                          unverified
                        </span>
                      )}
                    </div>
                    {agent.description && <p className="muted">{agent.description}</p>}
                    <p className="muted small">
                      {new URL(agent.rpcUrl).host} · 已連線 {new Date(agent.connectedAt).toLocaleString()}
                      {agent.expiresAt ? ` · 授權到期 ${new Date(agent.expiresAt).toLocaleString()}` : ''}
                    </p>
                    {agent.warning && <p className="warn small">⚠ {agent.warning}</p>}
                  </div>
                  <div className="agent-card-actions">
                    <button
                      type="button"
                      className="button subtle"
                      onClick={() => void handleVerifyAgent(agent.agentId)}
                      disabled={busyAgentId === agent.agentId}
                    >
                      {busyAgentId === agent.agentId ? '驗證中…' : '重新驗證'}
                    </button>
                    {confirmAgentId === agent.agentId ? (
                      <span className="row">
                        <button
                          type="button"
                          className="button danger"
                          onClick={() => void handleDisconnectAgent(agent.agentId)}
                          disabled={busyAgentId === agent.agentId}
                        >
                          確認中斷連線
                        </button>
                        <button
                          type="button"
                          className="button subtle"
                          onClick={() => setConfirmAgentId(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="button danger-outline"
                        onClick={() => setConfirmAgentId(agent.agentId)}
                      >
                        中斷連線
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="connect-section">
            <h4>新增與整合 Manyfold Agent</h4>
            <p className="muted">
              透過安全 Popup 對 Manyfold 發起認證，完成後金鑰自動加密存放於 Cloudflare D1。
            </p>
            <ConnectPanel initialSession={props.initialSession} onConnected={props.refreshState} />
          </div>
        </section>
      )}

      {/* Tab 2: AI Vision Models */}
      {activeTab === 'models' && (
        <section className="panel tab-panel">
          <form onSubmit={(e) => void handleSaveSettings(e)}>
            <div className="panel-header">
              <h3>AI 去背服務與模型控管</h3>
              <p className="muted">調整核心視覺模型的調用優先級、提示詞範本與計算上限。</p>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">主要去背模型 (Primary Model)</label>
                <select
                  className="input-select"
                  value={settings.bgRemoveModel}
                  onChange={(e) => setSettings({ ...settings, bgRemoveModel: e.target.value })}
                >
                  <option value="gemini-3.6-flash">Gemini 3.6 Flash (預設推薦 — 高速高精準度)</option>
                  <option value="gemini-3.5-pro">Gemini 3.5 Pro (細緻邊緣多重分析)</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (極速輕量模式)</option>
                </select>
                <span className="form-hint">預設去背與輪廓分割所使用的 Gemini 視覺模型版本。</span>
              </div>

              <div className="form-group">
                <label className="form-label">服務調用策略 (Delegation Mode)</label>
                <select
                  className="input-select"
                  value={settings.bgRemoveMode}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      bgRemoveMode: e.target.value as AppSettings['bgRemoveMode'],
                    })
                  }
                >
                  <option value="auto">自動委派 (優先 Manyfold Agent A2A，失敗時備援 Gemini API)</option>
                  <option value="agent_only">僅限 Manyfold Agent (強迫使用 Agent 執行)</option>
                  <option value="gemini_only">僅限 Direct Gemini API (直接調用 Gemini 3.6 Flash)</option>
                </select>
                <span className="form-hint">控制請求處理的流轉路徑與降級機制。</span>
              </div>

              <div className="form-group full-width">
                <label className="form-label">Gemini Vision 去背 System Prompt</label>
                <textarea
                  className="input-textarea"
                  rows={4}
                  value={settings.geminiSystemPrompt}
                  onChange={(e) => setSettings({ ...settings, geminiSystemPrompt: e.target.value })}
                />
                <span className="form-hint">發送給 Gemini Vision API 的視覺輪廓提取指示詞。</span>
              </div>

              <div className="form-group">
                <label className="form-label">最大影像分析尺寸 (Max Resolution px)</label>
                <input
                  type="number"
                  className="input-text"
                  value={settings.maxImageResolution}
                  onChange={(e) => setSettings({ ...settings, maxImageResolution: parseInt(e.target.value, 10) || 2048 })}
                  min={512}
                  max={4096}
                  step={256}
                />
                <span className="form-hint">輸入傳送給 AI Vision 分析前的尺寸上限。</span>
              </div>
            </div>

            <div className="panel-actions">
              <button type="submit" className="button primary btn-save" disabled={savingSettings}>
                {savingSettings ? <RefreshCw size={16} className="spinning" /> : <Save size={16} />}
                {savingSettings ? '儲存中…' : '儲存模型設定'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Tab 3: Cloudflare R2 Storage */}
      {activeTab === 'r2' && (
        <section className="panel tab-panel">
          <div className="panel-header row justify-between align-center">
            <div>
              <h3>Cloudflare R2 圖片儲存庫</h3>
              <p className="muted">
                檢視與管理所有 AI 去背後自動備份儲存至 Cloudflare R2 Bucket (<code>{settings.r2BucketName}</code>) 的圖檔。
              </p>
            </div>
            <button
              type="button"
              className="button subtle"
              onClick={() => void fetchR2Items()}
              disabled={loadingR2}
            >
              <RefreshCw size={14} className={loadingR2 ? 'spinning' : ''} />
              重新整理
            </button>
          </div>

          {/* R2 Configuration Toggle Card */}
          <div className="r2-config-card">
            <div className="r2-toggle-row">
              <div>
                <strong>自動儲存去背圖片至 R2 (R2 Storage Auto-Save)</strong>
                <p className="muted small">開啟後每次去背產出的 PNG 圖片均會同步持久化存入 Cloudflare R2。</p>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={settings.r2Enabled}
                  onChange={(e) => {
                    const next = { ...settings, r2Enabled: e.target.checked };
                    setSettings(next);
                    void api('/api/settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(next),
                    });
                    if (props.showToast) {
                      props.showToast(`R2 自動存圖已${e.target.checked ? '開啟' : '關閉'}`, 'info');
                    }
                  }}
                />
                <span className="slider round"></span>
              </label>
            </div>

            {!r2Status.enabled && (
              <div className="notice warning row align-center margin-top-sm">
                <span>⚠ Cloudflare R2 綁定狀態：{r2Status.message || '未偵測到 R2_IMAGE Binding'}</span>
              </div>
            )}
          </div>

          {/* R2 Saved Images Grid */}
          <div className="r2-items-grid">
            {r2Items.length === 0 ? (
              <div className="empty-state">
                <HardDrive size={32} className="muted" />
                <p className="muted">R2 儲存庫中尚無照片。去背處理完成後圖片會自動出現在這裡。</p>
              </div>
            ) : (
              r2Items.map((item) => (
                <div className="r2-card" key={item.key}>
                  <div className="r2-card-preview">
                    <img src={item.url} alt={item.customMetadata?.label || item.key} loading="lazy" />
                  </div>
                  <div className="r2-card-body">
                    <div className="r2-card-title" title={item.key}>
                      <strong>{item.customMetadata?.label || 'AI 去背圖檔'}</strong>
                    </div>
                    <p className="r2-card-meta muted small">
                      {formatSize(item.size)} · {new Date(item.uploaded).toLocaleString()}
                    </p>
                    <div className="r2-card-actions">
                      <button
                        type="button"
                        className="button subtle icon-only"
                        title="複製圖片 API 連結"
                        onClick={() => copyToClipboard(item.url, item.key)}
                      >
                        {copiedKey === item.key ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                      </button>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="button subtle icon-only"
                        title="在新分頁開啟"
                      >
                        <ExternalLink size={14} />
                      </a>
                      <button
                        type="button"
                        className="button danger-outline icon-only"
                        title="刪除圖檔"
                        onClick={() => void handleDeleteR2Item(item.key)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Tab 4: Security & Diagnostics */}
      {activeTab === 'security' && (
        <section className="panel tab-panel">
          <div className="panel-header">
            <h3>安全性與系統資安診斷</h3>
            <p className="muted">金鑰防護、存取密碼與 Cloudflare 資源整合狀態。</p>
          </div>

          <div className="security-grid">
            <div className="security-card">
              <div className="card-header-icon">
                <Lock size={20} />
                <h4>管理員密碼 (ADMIN_PASSWORD)</h4>
              </div>
              <p className="muted small">
                {props.adminRequired
                  ? '已在 Cloudflare Secrets 設定 ADMIN_PASSWORD。只有驗證通過的管理員可以進入此 Settings 頁面。'
                  : '目前未設定 ADMIN_PASSWORD，網站處於無密碼開放模式。如需專屬鎖定請在 Cloudflare 設定此秘密值。'}
              </p>
              <div className="status-indicator">
                <span className={`badge ${props.adminRequired ? 'ok' : 'warn'}`}>
                  {props.adminRequired ? '已防護 (Locked)' : '開放部署 (Open)'}
                </span>
              </div>
            </div>

            <div className="security-card">
              <div className="card-header-icon">
                <Database size={20} />
                <h4>Cloudflare D1 節點資料庫</h4>
              </div>
              <p className="muted small">
                Agent 加密金鑰、連線 Session 與聊天紀錄安全持久化儲存於 SQLite D1 Database。
              </p>
              <div className="status-indicator">
                <span className="badge ok">D1 DB Online</span>
              </div>
            </div>

            <div className="security-card">
              <div className="card-header-icon">
                <HardDrive size={20} />
                <h4>Cloudflare R2 Bucket Binding</h4>
              </div>
              <p className="muted small">
                圖片物件儲存 Binding (<code>R2_IMAGE</code>) 用於存放高解析度透明去背產圖。
              </p>
              <div className="status-indicator">
                <span className={`badge ${r2Status.enabled ? 'ok' : 'warn'}`}>
                  {r2Status.enabled ? 'R2 Storage Bound' : 'Unbound'}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
