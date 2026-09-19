// Escape reaches only the layer opened last: dialogs, menus and popovers share
// one stack, so a menu over a dialog closes alone and the dialog on the next
// press. A layer without a dismiss handler still holds the top, which is how
// a dialog that must be answered swallows Escape.

import { useEffect, useRef, type RefObject } from "react";

const layers: symbol[] = [];

export interface DismissOptions {
  /** Elements a mousedown may land in without dismissing; none means clicks are not watched */
  inside?: RefObject<Element | null>[];
}

export function useDismiss(open: boolean, onDismiss: (() => void) | undefined, { inside }: DismissOptions = {}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  const watchClicks = inside !== undefined;

  useEffect(() => {
    if (!open) return;
    const self = Symbol("layer");
    layers.push(self);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (layers[layers.length - 1] !== self || !onDismissRef.current) return;
      e.preventDefault();
      onDismissRef.current();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (insideRef.current?.some((r) => r.current?.contains(e.target as Node))) return;
      onDismissRef.current?.();
    };
    document.addEventListener("keydown", onKeyDown);
    if (watchClicks) document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
      layers.splice(layers.indexOf(self), 1);
    };
  }, [open, watchClicks]);
}
