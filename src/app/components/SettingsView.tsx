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
      setR2Status({ enabled: false, message: 'Unable to load the R2 storage list' });
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
      setNotice({ type: 'success', text: 'Settings saved and updated.' });
      if (props.showToast) props.showToast('System settings saved', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `Save failed: ${msg}` });
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
      if (props.showToast) props.showToast('Agent verified', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `Agent verification failed: ${msg}` });
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
      if (props.showToast) props.showToast('Agent connection removed', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `Disconnect failed: ${msg}` });
    } finally {
      setBusyAgentId(null);
    }
  };

  const handleDeleteR2Item = async (key: string) => {
    try {
      await api(`/api/r2/${encodeURIComponent(key)}`, { method: 'DELETE' });
      setR2Items((prev) => prev.filter((item) => item.key !== key));
      if (props.showToast) props.showToast('Image deleted from R2 storage', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', text: `Unable to delete the R2 image: ${msg}` });
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    const fullUrl = window.location.origin + text;
    void navigator.clipboard.writeText(fullUrl);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
    if (props.showToast) props.showToast('Image URL copied to clipboard', 'success');
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
            <ArrowLeft size={16} /> Back to Studio
          </button>
          <div className="settings-heading-text">
            <span className="atelier-label">SYSTEM & SERVICE GOVERNANCE</span>
            <h1 className="atelier-heading">System settings</h1>
          </div>
        </div>

        <div className="settings-badge-status">
          <span className={`status-pill ${props.adminRequired ? 'protected' : 'open'}`}>
            <Lock size={12} />
            {props.adminRequired ? 'Admin access protected' : 'Open deployment mode'}
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
          <span>Manyfold Agent access ({props.agents.length})</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          <Cpu size={18} />
          <span>AI background removal & vision model</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'r2' ? 'active' : ''}`}
          onClick={() => setActiveTab('r2')}
        >
          <HardDrive size={18} />
          <span>Cloudflare R2 image library ({r2Items.length})</span>
        </button>

        <button
          type="button"
          className={`tab-item ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
        >
          <ShieldCheck size={18} />
          <span>Security & diagnostics</span>
        </button>
      </div>

      {/* Tab 1: Manyfold Agents */}
      {activeTab === 'agents' && (
        <section className="panel tab-panel">
          <div className="panel-header">
            <h3>Connected Manyfold Agents</h3>
            <p className="muted">
              Manage Manyfold AI Agents authorized for this workspace. Verify, rotate, or disconnect access.
            </p>
          </div>

          <div className="agent-list">
            {props.agents.length === 0 ? (
              <div className="empty-state">
                <p className="muted">No Manyfold Agent is connected. Start OAuth authorization below.</p>
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
                      {new URL(agent.rpcUrl).host} · Connected {new Date(agent.connectedAt).toLocaleString()}
                      {agent.expiresAt ? ` · Expires ${new Date(agent.expiresAt).toLocaleString()}` : ''}
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
                      {busyAgentId === agent.agentId ? 'Verifying…' : 'Verify again'}
                    </button>
                    {confirmAgentId === agent.agentId ? (
                      <span className="row">
                        <button
                          type="button"
                          className="button danger"
                          onClick={() => void handleDisconnectAgent(agent.agentId)}
                          disabled={busyAgentId === agent.agentId}
                        >
                          Confirm disconnect
                        </button>
                        <button
                          type="button"
                          className="button subtle"
                          onClick={() => setConfirmAgentId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="button danger-outline"
                        onClick={() => setConfirmAgentId(agent.agentId)}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="connect-section">
            <h4>Add and connect a Manyfold Agent</h4>
            <p className="muted">
              Authenticate with Manyfold in a secure popup. Credentials are encrypted and stored in Cloudflare D1.
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
              <h3>AI removal service & model controls</h3>
              <p className="muted">Adjust the vision model priority, prompt template, and compute limits.</p>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Primary model</label>
                <select
                  className="input-select"
                  value={settings.bgRemoveModel}
                  onChange={(e) => setSettings({ ...settings, bgRemoveModel: e.target.value })}
                >
                  <option value="gemini-3.6-flash">Gemini 3.6 Flash (recommended)</option>
                  <option value="gemini-3.5-pro">Gemini 3.5 Pro (fine edge analysis)</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (fast lightweight mode)</option>
                </select>
                <span className="form-hint">The Gemini vision model used for background removal and segmentation.</span>
              </div>

              <div className="form-group">
                <label className="form-label">Service delegation mode</label>
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
                  <option value="auto">Automatic (Manyfold Agent first, Gemini API fallback)</option>
                  <option value="agent_only">Manyfold Agent only</option>
                  <option value="gemini_only">Direct Gemini API only</option>
                </select>
                <span className="form-hint">Controls the request path and fallback behavior.</span>
              </div>

              <div className="form-group full-width">
                <label className="form-label">Gemini Vision removal system prompt</label>
                <textarea
                  className="input-textarea"
                  rows={4}
                  value={settings.geminiSystemPrompt}
                  onChange={(e) => setSettings({ ...settings, geminiSystemPrompt: e.target.value })}
                />
                <span className="form-hint">Instructions sent to the Gemini Vision API for subject extraction.</span>
              </div>

              <div className="form-group">
                <label className="form-label">Maximum image analysis size (px)</label>
                <input
                  type="number"
                  className="input-text"
                  value={settings.maxImageResolution}
                  onChange={(e) => setSettings({ ...settings, maxImageResolution: parseInt(e.target.value, 10) || 2048 })}
                  min={512}
                  max={4096}
                  step={256}
                />
                <span className="form-hint">The maximum size before the image is sent for AI vision analysis.</span>
              </div>
            </div>

            <div className="panel-actions">
              <button type="submit" className="button primary btn-save" disabled={savingSettings}>
                {savingSettings ? <RefreshCw size={16} className="spinning" /> : <Save size={16} />}
                {savingSettings ? 'Saving…' : 'Save model settings'}
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
              <h3>Cloudflare R2 image storage</h3>
              <p className="muted">
                View and manage images automatically backed up to the Cloudflare R2 bucket (<code>{settings.r2BucketName}</code>).
              </p>
            </div>
            <button
              type="button"
              className="button subtle"
              onClick={() => void fetchR2Items()}
              disabled={loadingR2}
            >
              <RefreshCw size={14} className={loadingR2 ? 'spinning' : ''} />
              Refresh
            </button>
          </div>

          {/* R2 Configuration Toggle Card */}
          <div className="r2-config-card">
            <div className="r2-toggle-row">
              <div>
                <strong>Automatically save cutouts to R2</strong>
                <p className="muted small">Each generated PNG is persisted to Cloudflare R2 when enabled.</p>
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
                      props.showToast(`R2 auto-save ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
                    }
                  }}
                />
                <span className="slider round"></span>
              </label>
            </div>

            {!r2Status.enabled && (
              <div className="notice warning row align-center margin-top-sm">
                <span>⚠ Cloudflare R2 binding: {r2Status.message || 'R2_IMAGE binding not detected'}</span>
              </div>
            )}
          </div>

          {/* R2 Saved Images Grid */}
          <div className="r2-items-grid">
            {r2Items.length === 0 ? (
              <div className="empty-state">
                <HardDrive size={32} className="muted" />
                <p className="muted">No images in R2 yet. Completed cutouts will appear here automatically.</p>
              </div>
            ) : (
              r2Items.map((item) => (
                <div className="r2-card" key={item.key}>
                  <div className="r2-card-preview">
                    <img src={item.url} alt={item.customMetadata?.label || item.key} loading="lazy" />
                  </div>
                  <div className="r2-card-body">
                    <div className="r2-card-title" title={item.key}>
                      <strong>{item.customMetadata?.label || 'AI cutout'}</strong>
                    </div>
                    <p className="r2-card-meta muted small">
                      {formatSize(item.size)} · {new Date(item.uploaded).toLocaleString()}
                    </p>
                    <div className="r2-card-actions">
                      <button
                        type="button"
                        className="button subtle icon-only"
                        title="Copy image API URL"
                        onClick={() => copyToClipboard(item.url, item.key)}
                      >
                        {copiedKey === item.key ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                      </button>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="button subtle icon-only"
                        title="Open in new tab"
                      >
                        <ExternalLink size={14} />
                      </a>
                      <button
                        type="button"
                        className="button danger-outline icon-only"
                        title="Delete image"
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
            <h3>Security & system diagnostics</h3>
            <p className="muted">Key protection, access control, and Cloudflare resource status.</p>
          </div>

          <div className="security-grid">
            <div className="security-card">
              <div className="card-header-icon">
                <Lock size={20} />
                <h4>Admin password (ADMIN_PASSWORD)</h4>
              </div>
              <p className="muted small">
                {props.adminRequired
                  ? 'ADMIN_PASSWORD is configured in Cloudflare Secrets. Only verified admins can access Settings.'
                  : 'ADMIN_PASSWORD is not configured. The site is open without a password. Add it in Cloudflare to lock access.'}
              </p>
              <div className="status-indicator">
                <span className={`badge ${props.adminRequired ? 'ok' : 'warn'}`}>
                  {props.adminRequired ? 'Protected (Locked)' : 'Open deployment'}
                </span>
              </div>
            </div>

            <div className="security-card">
              <div className="card-header-icon">
                <Database size={20} />
                <h4>Cloudflare D1 database</h4>
              </div>
              <p className="muted small">
                Agent credentials, connection sessions, and chat history are persisted securely in SQLite D1.
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
                The image object-storage binding (<code>R2_IMAGE</code>) stores high-resolution transparent cutouts.
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
