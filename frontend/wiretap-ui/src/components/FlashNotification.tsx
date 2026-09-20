// Flash notification component for non-blocking toast messages

import { useEffect } from 'react';
import { iconMd } from "../styles/spacing";
import { IconButton } from "./Button";

export interface FlashNotificationProps {
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  onDismiss?: () => void;
}

export default function FlashNotification({
  message,
  type = 'info',
  duration = 2000,
  onDismiss,
}: FlashNotificationProps) {
  useEffect(() => {
    if (duration > 0 && onDismiss) {
      const timer = setTimeout(onDismiss, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  const bgColor = {
    info: 'bg-blue-500',
    success: 'bg-green-500',
    warning: 'bg-yellow-500',
    error: 'bg-red-500',
  }[type];

  return (
    <div className="fixed top-4 right-4 z-50 animate-fade-in">
      <div
        className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-62.5 max-w-100`}
      >
        <div className="flex-1">
          <p className="text-sm font-medium">{message}</p>
        </div>
        {onDismiss && (
          <IconButton
            onClick={onDismiss}
            size="sm"
            className="text-white hover:text-white"
            label="Dismiss"
          >
            <svg
              className={iconMd}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </IconButton>
        )}
      </div>
    </div>
  );
}
