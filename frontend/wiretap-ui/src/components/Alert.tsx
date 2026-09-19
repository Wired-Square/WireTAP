// The alert primitive: renders the `.alert` classes in styles/components.css.
// A tinted message: box, text and glyph all come from the one `tone`. `icon`
// replaces the glyph only for a meaning the tone lacks (a spinner, the
// transmit-risk radio); a message that needs its own layout is a toned <Card>.

import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";

export type AlertTone = "info" | "success" | "warning" | "danger";
export type AlertSize = "sm" | "md" | "lg";

const GLYPH: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: TriangleAlert,
};

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  tone: AlertTone;
  /** Inset and type: `sm` 8 px / 12 px text · `md` 12 px / 14 px · `lg` 16 px / 14 px */
  size?: AlertSize;
  /** The strip form: full width, square, only its bottom edge drawn */
  banner?: boolean;
  icon?: ReactNode;
  /** Trailing control, right-aligned and centred on the message — a "Dismiss" link, a "Stop" button */
  action?: ReactNode;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ tone, size = "md", banner = false, icon, action, className = "", children, ...rest }, ref) => {
    const Glyph = GLYPH[tone];
    const classes = ["alert", `alert--${tone}`, size !== "md" && `alert--${size}`, banner && "alert--banner", className]
      .filter(Boolean)
      .join(" ");
    return (
      <div ref={ref} className={classes} {...rest}>
        <span className="alert__icon">{icon === undefined ? <Glyph /> : icon}</span>
        <div className="alert__body">{children}</div>
        {action && <div className="alert__action">{action}</div>}
      </div>
    );
  },
);
Alert.displayName = "Alert";

export default Alert;
