// The toast: an alert floated at the corner of the window, announced to
// assistive tech, gone on its own after `duration`. Renders the `.toast`
// classes in styles/components.css.

import { useEffect } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { Alert } from "./Alert";
import { primitiveString } from "./strings";

export interface FlashNotificationProps {
  message: string;
  type?: "info" | "success" | "warning" | "error";
  duration?: number;
  onDismiss?: () => void;
}

export default function FlashNotification({ message, type = "info", duration = 2000, onDismiss }: FlashNotificationProps) {
  useEffect(() => {
    if (duration > 0 && onDismiss) {
      const timer = setTimeout(onDismiss, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  return (
    <div role={type === "error" ? "alert" : "status"} className="toast">
      <Alert
        tone={type === "error" ? "danger" : type}
        action={
          onDismiss && (
            <IconButton onClick={onDismiss} size="sm" label={primitiveString("dismiss")} className="toast__dismiss">
              <X />
            </IconButton>
          )
        }
      >
        <p className="toast__message">{message}</p>
      </Alert>
    </div>
  );
}
