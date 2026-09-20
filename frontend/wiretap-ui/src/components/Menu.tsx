// The menu primitive: renders the `.popover` and `.menu` classes in
// styles/components.css. `Popover` is the floating surface — portalled to the
// body, placed against an anchor or at a point, dismissed by Escape and a
// click outside; `Menu` is a popover with menu semantics, arrow-key focus,
// Tab closing it and focus returned to the opener; `MenuItem`, `MenuSeparator`
// and `MenuHeading` are its rows. An item closes the menu after its click
// unless told to stay.
// `usePopover` holds the open state between a trigger and its popover.

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "./dismiss";
import { moveFocusAlong } from "./rovingFocus";

const GAP = 2;
const MARGIN = 4;

export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  /** The element the popover hangs off: below it, above when there is no room, clamped to the window */
  anchorRef?: RefObject<HTMLElement | null>;
  /** A point instead of an anchor — a context menu at the pointer */
  at?: { x: number; y: number };
  /** Which edge lines up with the anchor's */
  align?: "start" | "end";
  /** As wide as the anchor — a list under its field */
  matchWidth?: boolean;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

export const Popover = forwardRef<HTMLDivElement, PopoverProps>(
  ({ open, onClose, anchorRef, at, align = "start", matchWidth = false, className = "", style, children, ...rest }, ref) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const [placed, setPlaced] = useState<CSSProperties>({ visibility: "hidden" });
    useDismiss(open, onClose, { inside: anchorRef ? [innerRef, anchorRef] : [innerRef] });

    const atX = at?.x;
    const atY = at?.y;
    useLayoutEffect(() => {
      const el = innerRef.current;
      if (!open || !el) return;
      const { offsetWidth: w, offsetHeight: h } = el;
      const anchor = anchorRef?.current?.getBoundingClientRect();
      let top = atY ?? 0;
      let left = atX ?? 0;
      if (anchor) {
        top = anchor.bottom + GAP;
        if (top + h > window.innerHeight - MARGIN) top = anchor.top - GAP - h;
        left = align === "end" ? anchor.right - w : anchor.left;
      }
      setPlaced({
        top: clamp(top, MARGIN, window.innerHeight - h - MARGIN),
        left: clamp(left, MARGIN, window.innerWidth - w - MARGIN),
        width: matchWidth && anchor ? anchor.width : undefined,
        visibility: "visible",
      });
    }, [open, anchorRef, atX, atY, align, matchWidth]);

    if (!open) return null;

    return createPortal(
      <div
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        className={`popover ${className}`}
        style={{ ...placed, ...style }}
        {...rest}
      >
        {children}
      </div>,
      document.body,
    );
  },
);
Popover.displayName = "Popover";

/**
 * The open state shared by a trigger button and its popover: spread `trigger`
 * on the button and `popover` on the `<Menu>` or `<Popover>`.
 */
export function usePopover(popup: "menu" | "listbox" | "dialog" = "menu") {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), []);
  return {
    open,
    close,
    toggle,
    trigger: { ref: anchorRef, onClick: toggle, "aria-haspopup": popup, "aria-expanded": open } as const,
    popover: { open, onClose: close, anchorRef },
  };
}

const MenuContext = createContext<{ close: () => void }>({ close: () => {} });

export interface MenuProps extends PopoverProps {
  /** Roomier rows with larger glyphs — the app launcher */
  size?: "md" | "lg";
}

const KEYS = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" } as const;

export function Menu({ open, onClose, size = "md", className = "", onKeyDown, children, ...rest }: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus moves into the menu on open and back to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    menuRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  return (
    <MenuContext.Provider value={{ close: onClose }}>
      <Popover
        ref={menuRef}
        open={open}
        onClose={onClose}
        role="menu"
        tabIndex={-1}
        className={`menu ${size === "lg" ? "menu--lg " : ""}${className}`}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key === "Tab" && !e.defaultPrevented) {
            e.preventDefault();
            onClose();
          }
          moveFocusAlong(e, KEYS, '[role^="menuitem"]:not(:disabled)');
        }}
        {...rest}
      >
        {children}
      </Popover>
    </MenuContext.Provider>
  );
}

export type MenuItemTone = "neutral" | "danger" | "warning";

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: MenuItemTone;
  icon?: ReactNode;
  /** A second line under the label, for an item that has to explain itself */
  hint?: ReactNode;
  /** A toggle: rendered as a checkbox item, lit when on */
  checked?: boolean;
  /** Stay open after the click */
  keepOpen?: boolean;
}

export function menuItemClass(tone: MenuItemTone = "neutral", className = ""): string {
  return ["menu__item", tone !== "neutral" && `menu__item--${tone}`, className].filter(Boolean).join(" ");
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  ({ tone, icon, hint, checked, keepOpen = false, className = "", type = "button", onClick, children, ...rest }, ref) => {
    const { close } = useContext(MenuContext);
    return (
      <button
        ref={ref}
        type={type}
        role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked}
        className={menuItemClass(tone, `${hint ? "items-start " : ""}${className}`)}
        onClick={(e) => {
          onClick?.(e);
          if (!keepOpen) close();
        }}
        {...rest}
      >
        {icon && <span className="menu__icon">{icon}</span>}
        {hint ? (
          <span>
            {children}
            <span className="menu__hint">{hint}</span>
          </span>
        ) : (
          children
        )}
      </button>
    );
  },
);
MenuItem.displayName = "MenuItem";

export function MenuSeparator() {
  return <div role="separator" className="menu__separator" />;
}

export function MenuHeading({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`menu__heading ${className}`} {...rest} />;
}
