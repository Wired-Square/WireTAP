// The React face of the dismiss stack in behaviour/dismiss.ts: a layer for as
// long as `open` holds, reading the latest handler and `inside` refs.

import { useEffect, useRef, type RefObject } from "react";
import { pushDismissLayer } from "./behaviour/dismiss";

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
    return pushDismissLayer({
      onDismiss: () => onDismissRef.current?.(),
      isInside: watchClicks ? (target) => insideRef.current?.some((r) => r.current?.contains(target)) ?? false : undefined,
    });
  }, [open, watchClicks]);
}
