import { AlertCircle, Check, Download, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import type { BatchItem } from '../types/studio';

interface BatchGridProps {
  items: BatchItem[];
  isRunning: boolean;
  onRetry: (id: string) => void;
  onOpen: (item: BatchItem) => void;
  onDownload: (item: BatchItem) => void;
  onDownloadAll: () => void;
  onReset: () => void;
}

const STATUS_TEXT: Record<BatchItem['status'], string> = {
  queued: 'Queued',
  processing: 'Working',
  done: 'Done',
  failed: 'Failed',
};

/**
 * A batch runs for minutes and images finish out of order, so every card carries its own
 * state: what it is doing, what went wrong, and what can be done about it. Waiting for the
 * whole run before showing anything would leave the page looking hung.
 */
export const BatchGrid: React.FC<BatchGridProps> = ({
  items,
  isRunning,
  onRetry,
  onOpen,
  onDownload,
  onDownloadAll,
  onReset,
}) => {
  const done = items.filter((item) => item.status === 'done');
  const failed = items.filter((item) => item.status === 'failed');
  const settled = done.length + failed.length;
  const percent = items.length > 0 ? Math.round((settled / items.length) * 100) : 0;

  return (
    <section className="atelier-batch">
      <div className="atelier-batch-bar">
        <div className="atelier-batch-heading">
          <span className="atelier-eyebrow">
            <Sparkles size={12} /> BATCH / {isRunning ? 'RUNNING' : 'COMPLETE'}
          </span>
          <h2>
            {done.length} of {items.length} ready
            {failed.length > 0 && <span className="atelier-batch-failed"> · {failed.length} failed</span>}
          </h2>
          <p>
            {isRunning
              ? 'Several images run at once. They finish out of order — each card updates as it lands.'
              : 'Download what you need, or open an image in the studio to keep editing it.'}
          </p>
        </div>
        <div className="atelier-batch-actions">
          <button
            type="button"
            className="button primary"
            onClick={onDownloadAll}
            disabled={done.length === 0}
          >
            <Download size={16} /> Download all ({done.length})
          </button>
          <button type="button" className="button subtle" onClick={onReset} disabled={isRunning}>
            <RotateCcw size={16} /> New batch
          </button>
        </div>
      </div>

      <div className="atelier-batch-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>

      <ul className="atelier-batch-grid">
        {items.map((item) => (
          <li key={item.id} className={`atelier-batch-card is-${item.status}`}>
            <div className="atelier-batch-thumb checkerboard-sm">
              <img
                src={item.cutoutImage ?? item.originalImage}
                alt={item.name}
                loading="lazy"
                className={item.status === 'done' ? '' : 'is-pending'}
              />
              {item.status === 'processing' && (
                <span className="atelier-batch-spinner">
                  <RefreshCw size={18} className="spinning-icon" />
                </span>
              )}
            </div>

            <div className="atelier-batch-meta">
              <span className="atelier-batch-name" title={item.name}>
                {item.name}
              </span>
              <span className={`atelier-batch-status is-${item.status}`}>
                {item.status === 'done' && <Check size={12} />}
                {item.status === 'failed' && <AlertCircle size={12} />}
                {STATUS_TEXT[item.status]}
              </span>
            </div>

            {item.status === 'processing' && item.progress && (
              <p className="atelier-batch-note" aria-live="polite">
                {item.progress}
              </p>
            )}
            {item.status === 'failed' && item.error && (
              <p className="atelier-batch-note is-error">{item.error}</p>
            )}
            {item.status === 'done' && item.subjectLabel && (
              <p className="atelier-batch-note">Subject: {item.subjectLabel}</p>
            )}

            <div className="atelier-batch-card-actions">
              {item.status === 'done' && (
                <>
                  <button type="button" className="button subtle small" onClick={() => onDownload(item)}>
                    <Download size={14} /> PNG
                  </button>
                  <button type="button" className="button subtle small" onClick={() => onOpen(item)}>
                    Open
                  </button>
                </>
              )}
              {item.status === 'failed' && (
                <button
                  type="button"
                  className="button subtle small"
                  onClick={() => onRetry(item.id)}
                  disabled={isRunning}
                >
                  <RefreshCw size={14} /> Retry
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default BatchGrid;
