// Where a floating surface goes: below its anchor, above when there is no
// room, its start or end edge on the anchor's — or at a point — clamped to the
// viewport with a margin.

const GAP = 2;
const MARGIN = 4;

export interface Size {
  width: number;
  height: number;
}

export interface PlaceOptions {
  anchor?: DOMRect;
  /** A point instead of an anchor — a context menu at the pointer */
  at?: { x: number; y: number };
  align?: "start" | "end";
  matchWidth?: boolean;
}

export interface Placement {
  top: number;
  left: number;
  width?: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

export function placePopover(
  size: Size,
  { anchor, at, align = "start", matchWidth = false }: PlaceOptions,
  viewport: Size = { width: window.innerWidth, height: window.innerHeight },
): Placement {
  let top = at?.y ?? 0;
  let left = at?.x ?? 0;
  if (anchor) {
    top = anchor.bottom + GAP;
    if (top + size.height > viewport.height - MARGIN) top = anchor.top - GAP - size.height;
    left = align === "end" ? anchor.right - size.width : anchor.left;
  }
  return {
    top: clamp(top, MARGIN, viewport.height - size.height - MARGIN),
    left: clamp(left, MARGIN, viewport.width - size.width - MARGIN),
    width: matchWidth && anchor ? anchor.width : undefined,
  };
}
