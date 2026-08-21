import React from 'react';
import { Sparkles, CheckCircle, AlertTriangle, X } from 'lucide-react';
import type { ToastMessage } from '../types/studio';

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-pill ${toast.type || 'info'}`}>
          <div className="toast-icon">
            {toast.type === 'success' && <CheckCircle size={16} />}
            {toast.type === 'warning' && <AlertTriangle size={16} />}
            {(!toast.type || toast.type === 'info') && <Sparkles size={16} />}
          </div>
          <span className="toast-text">{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
