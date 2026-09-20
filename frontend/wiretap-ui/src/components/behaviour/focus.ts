// Keyboard focus inside a primitive: the arrow keys along a set of siblings,
// Tab held inside a frame, and focus returned to where it was when a layer
// closes.

/** The event surface these read — a native KeyboardEvent or a framework's synthetic one. */
export interface KeyEvent {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  preventDefault(): void;
}

type Step = number | "first" | "last";

/**
 * Moves focus along the elements matching `selector` inside the current
 * target, wrapping at the ends; `"first"` and `"last"` for Home and End.
 * Returns the element focused, or null when the key was not one of `keys`.
 */
export function moveFocusAlong(e: KeyEvent, keys: Record<string, Step>, selector: string): HTMLElement | null {
  const step = keys[e.key];
  if (step === undefined || e.defaultPrevented) return null;
  if ((e.target as HTMLElement).closest("input, textarea, select")) return null;
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(selector)];
  if (items.length === 0) return null;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const next =
    step === "first" ? 0
    : step === "last" ? last
    : current < 0 ? (step > 0 ? 0 : last)
    : (current + step + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
  return items[next];
}

const TABBABLE = ':is(a[href], button, input, select, textarea, [tabindex]):not(:disabled, [tabindex="-1"])';

/** Tab from the frame's last tabbable, or from the frame itself, wraps to the first; Shift+Tab the reverse. */
export function trapTab(e: KeyEvent): void {
  if (e.key !== "Tab" || e.defaultPrevented) return;
  const frame = e.currentTarget as HTMLElement;
  const tabbables = frame.querySelectorAll<HTMLElement>(TABBABLE);
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  const active = document.activeElement;
  const atEdge = active === frame || active === (e.shiftKey ? first : last);
  if (!atEdge) return;
  e.preventDefault();
  (e.shiftKey ? last : first)?.focus();
}

/** Remembers the focused element; the returned function focuses it again if it is still in the document. */
export function rememberFocus(): () => void {
  const el = document.activeElement as HTMLElement | null;
  return () => {
    if (el && document.contains(el)) el.focus();
  };
}
