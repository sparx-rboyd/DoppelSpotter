'use client';

import { createPortal } from 'react-dom';
import { CheckCircle, X } from 'lucide-react';

interface ToastProps {
  message: string;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  return createPortal(
    <div
      className="fixed bottom-6 inset-x-0 z-[110] flex justify-center px-4 pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-gray-900 px-4 py-3 shadow-2xl text-white text-sm max-w-sm w-full"
        style={{ animation: 'toast-slide-in 0.25s ease-out forwards' }}
        role="status"
      >
        <CheckCircle className="h-4 w-4 flex-shrink-0 text-green-400" />
        <span className="flex-1 leading-5">{message}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-full p-0.5 text-gray-400 hover:text-white transition"
          aria-label="Dismiss notification"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
