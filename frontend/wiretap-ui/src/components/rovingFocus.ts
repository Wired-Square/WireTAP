// Arrow keys move the focus along a set of siblings — a tab strip's tabs, a
// menu's items — wrapping at the ends, with Home and End for the extremes.

import type { KeyboardEvent } from "react";

type Step = number | "first" | "last";

export function moveFocusAlong(
  e: KeyboardEvent<HTMLElement>,
  keys: Record<string, Step>,
  selector: string,
): HTMLElement | null {
  const step = keys[e.key];
  if (step === undefined || e.defaultPrevented) return null;
  if ((e.target as HTMLElement).closest("input, textarea, select")) return null;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
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
