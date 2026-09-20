// Flash notification component for non-blocking toast messages

import { useEffect } from 'react';
import { X } from "lucide-react";
import { iconMd } from "../styles/spacing";
import { IconButton } from "./Button";
import { Alert } from "./Alert";

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

  // The tints are translucent in the dark theme, so the toast sits on a surface.
  return (
    <div
      role={type === "error" ? "alert" : "status"}
      className="fixed top-4 right-4 z-50 animate-fade-in rounded-lg bg-surface shadow-lg"
    >
      <Alert
        tone={type === "error" ? "danger" : type}
        className="min-w-62.5 max-w-100"
        action={
          onDismiss && (
            <IconButton onClick={onDismiss} size="sm" label="Dismiss">
              <X className={iconMd} />
            </IconButton>
          )
        }
      >
        <p className="font-medium">{message}</p>
      </Alert>
    </div>
  );
}
