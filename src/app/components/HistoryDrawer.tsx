import React from 'react';
import { Clock, Trash2, ArrowUpRight, Sparkles } from 'lucide-react';
import type { HistoryItem } from '../types/studio';

interface HistoryDrawerProps {
  history: HistoryItem[];
  onSelect: (item: HistoryItem) => void;
  onClear: () => void;
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({ history, onSelect, onClear }) => {
  if (history.length === 0) return null;

  return (
    <div className="history-drawer-panel">
      <div className="history-header">
        <div className="history-title-group">
          <Clock size={16} className="history-icon" />
          <h4 className="history-title">Session history</h4>
          <span className="history-count">{history.length} {history.length === 1 ? 'item' : 'items'}</span>
        </div>
        <button
          type="button"
          className="button subtle history-clear-btn"
          onClick={onClear}
          title="Clear all history"
        >
          <Trash2 size={14} />
          Clear history
        </button>
      </div>

      <div className="history-strip">
        {history.map((item) => {
          const displayImg = item.cutoutImage || item.originalImage;
          const timeStr = new Date(item.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={item.id}
              className="history-card"
              onClick={() => onSelect(item)}
            >
              <div
                className="history-thumb checkerboard-sm"
                style={{ backgroundImage: `url("${displayImg}")` }}
              >
                <div className="history-overlay">
                  <ArrowUpRight size={16} />
                </div>
              </div>
              <div className="history-meta">
                <span className="history-label">
                  <Sparkles size={10} /> {item.subjectLabel || 'Background removal'}
                </span>
                <span className="history-time">{timeStr}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
