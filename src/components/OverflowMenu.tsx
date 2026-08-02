// ui/src/components/OverflowMenu.tsx
/**
 * A kebab (⋮) button that opens a portalled, viewport-clamped menu.
 *
 * Extracted rather than hand-rolled a fourth time: `SessionControls`,
 * `PanelWrapper` and `DashboardTopBar` each grew their own copy of the same
 * portal-plus-positioner, and this is that pattern with the bespoke row content
 * replaced by a plain item list. Those three still have their own — their rows carry
 * toggles and colour states this does not model — so this is a new shared component,
 * not yet their replacement.
 *
 * Portalled to `document.body` because the trigger usually sits inside a scrolling or
 * `overflow: hidden` container that would otherwise clip the menu.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EllipsisVertical } from "lucide-react";

import { menuClasses, menuItem, menuDivider } from "../styles/menuStyles";
import { iconButtonHover } from "../styles/buttonStyles";
import { iconSm } from "../styles/spacing";
import { textDanger } from "../styles/colourTokens";

/**
 * A union rather than one optional-everything shape, so a divider is written
 * `{ separator: true }` instead of carrying a meaningless label and onClick.
 */
export type OverflowMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: ComponentType<{ className?: string }>;
      onClick: () => void;
      /** Destructive actions read red and sit below a divider by convention. */
      danger?: boolean;
      disabled?: boolean;
      /**
       * Second line under the label, for an item that has to explain itself.
       * Rendered rather than left to `title`: a disabled button takes no pointer
       * events, so its tooltip never appears — and there are no tooltips on touch.
       */
      hint?: string;
    };

/**
 * What `items` accepts. Exported so a builder can annotate its return type instead of
 * casting: the annotation is what keeps `{ separator: true }` from widening to
 * `boolean`, and a `.filter(Boolean) as OverflowMenuItem[]` would suppress checking of
 * the whole literal to do a job this component already does.
 */
export type OverflowMenuItems = (OverflowMenuItem | false | null | undefined)[];

type Props = {
  /** Falsy entries are dropped, so call sites can inline `cond && {…}`. */
  items: OverflowMenuItems;
  /** Tooltip and accessible name for the trigger. */
  title: string;
  className?: string;
  /**
   * What the trigger draws, defaulting to the kebab.
   *
   * For a toolbar that already speaks in glyphs: the button means the same thing
   * whether it acts once or offers a choice, so it must keep the same picture rather
   * than turn into a kebab as soon as there are two options. A node rather than an
   * icon-plus-size pair, so sizing stays with the glyph at the call site.
   */
  trigger?: ReactNode;
};

/** Gap between the trigger and the menu, and the minimum inset from the viewport. */
const GAP = 2;
const MARGIN = 4;

export default function OverflowMenu({
  items: rawItems,
  title,
  className,
  trigger = <EllipsisVertical className={iconSm} />,
}: Props) {
  const items = rawItems.filter(Boolean) as OverflowMenuItem[];
  const [open, setOpen] = useState(false);
  // Hidden until measured, so the menu never paints at 0,0 before being positioned.
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRect = useRef<DOMRect | null>(null);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (wasOpen) return false;
      buttonRect.current = buttonRef.current?.getBoundingClientRect() ?? null;
      setStyle({ visibility: "hidden" });
      return true;
    });
  }, []);

  // Close on a click outside, or on Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Measure once mounted, then place: below the trigger if it fits, above if not,
  // left-aligned and clamped to the viewport either way.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !buttonRect.current) return;
    const { offsetWidth: width, offsetHeight: height } = menuRef.current;
    const rect = buttonRect.current;

    let top = rect.bottom + GAP;
    if (top + height > window.innerHeight) top = rect.top - GAP - height;
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));

    // Right-align to the trigger: the kebab sits at the end of a row, so a
    // left-aligned menu would hang off the edge more often than not.
    let left = rect.right - width;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

    setStyle({ top, left, visibility: "visible" });
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${iconButtonHover} ${className ?? ""}`}
      >
        {trigger}
      </button>

      {open &&
        createPortal(
          <div ref={menuRef} role="menu" className={menuClasses} style={style}>
            {items.map((item, i) =>
              item.separator ? (
                <div key={`sep-${i}`} className={menuDivider} />
              ) : (
                <button
                  key={item.label}
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                  className={`${menuItem} ${item.hint ? "items-start" : ""} ${item.danger ? textDanger : ""}`}
                >
                  {item.icon && <item.icon className={`${iconSm} ${item.hint ? "mt-0.5" : ""}`} />}
                  {item.hint ? (
                    <span className="text-left">
                      {item.label}
                      <span className="block text-[color:var(--text-muted)]">{item.hint}</span>
                    </span>
                  ) : (
                    item.label
                  )}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
