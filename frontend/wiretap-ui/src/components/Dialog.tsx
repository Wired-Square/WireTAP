// The dialog primitive: renders the `.dialog` classes in styles/components.css.
// One surface in three slots — a pinned header, a scrolling body, a pinned
// footer. `onClose` makes it dismissible: the header's ✕, Escape and a click on
// the backdrop all call it; a dialog that must be answered passes none.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { useDismiss } from "./dismiss";
import { iconLg } from "../styles/spacing";
import { useTranslation } from "react-i18next";

export type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

export interface DialogProps {
  isOpen: boolean;
  /** Dismiss: the header ✕, Escape and the backdrop. Absent, the dialog must be answered */
  onClose?: () => void;
  /** Width: `sm` 384 · `md` 448 (default) · `lg` 512 · `xl` 672 · `2xl` 896 · `3xl` 1280 px */
  size?: DialogSize;
  /** Renders the standard header; compose a `<DialogHeader>` yourself for anything else */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Leading glyph in the standard header */
  icon?: ReactNode;
  /** On the frame — a fixed height (`h-125`) for a list that must not jump */
  className?: string;
  children: ReactNode;
}

interface DialogContextValue {
  titleId: string;
  onClose?: () => void;
}

const DialogContext = createContext<DialogContextValue>({ titleId: "" });

export function Dialog({ isOpen, onClose, size = "md", title, subtitle, icon, className = "", children }: DialogProps) {
  const titleId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  useDismiss(isOpen, onClose);

  // Focus moves into the frame on open and back to the opener on close.
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    const frame = frameRef.current;
    if (frame && !frame.contains(document.activeElement)) frame.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // mousedown, not click: a drag-select that ends on the backdrop must not dismiss.
  const onBackdropMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <DialogContext.Provider value={{ titleId, onClose }}>
      <div className="dialog-backdrop" onMouseDown={onBackdropMouseDown}>
        <div
          ref={frameRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`dialog ${size !== "md" ? `dialog--${size} ` : ""}${className}`}
        >
          {title !== undefined && (
            <DialogHeader>
              {icon && <span className="dialog__icon">{icon}</span>}
              <div className="dialog__heading">
                <DialogTitle>{title}</DialogTitle>
                {subtitle && <p className="dialog__subtitle">{subtitle}</p>}
              </div>
            </DialogHeader>
          )}
          {children}
        </div>
      </div>
    </DialogContext.Provider>
  );
}

export default Dialog;

/** A custom header row; draws the ✕ itself when the dialog is dismissible. */
export function DialogHeader({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { t } = useTranslation("common");
  const { onClose } = useContext(DialogContext);
  return (
    <div className={`dialog__header ${className}`} {...rest}>
      {children}
      {onClose && (
        <IconButton onClick={onClose} label={t("actions.close")} size="sm">
          <X className={iconLg} />
        </IconButton>
      )}
    </div>
  );
}

export function DialogTitle({ className = "", children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  const { titleId } = useContext(DialogContext);
  return (
    <h2 id={titleId} className={`dialog__title ${className}`} {...rest}>
      {children}
    </h2>
  );
}

export interface DialogBodyProps extends HTMLAttributes<HTMLDivElement> {
  /** `none` when the children draw their own rows — a list, a tab strip */
  padding?: "none" | "md";
}

export function DialogBody({ padding = "md", className = "", ...rest }: DialogBodyProps) {
  return <div className={`dialog__body ${padding === "none" ? "dialog__body--flush " : ""}${className}`} {...rest} />;
}

export function DialogFooter({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`dialog__footer ${className}`} {...rest} />;
}
