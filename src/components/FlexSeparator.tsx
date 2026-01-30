// ui/src/components/FlexSeparator.tsx

import { useRef, useState, useLayoutEffect } from "react";

/**
 * A separator that hides itself when it's the first item on a wrapped line.
 * Use this in flex-wrap containers to avoid leading separators on new lines.
 */
export default function FlexSeparator() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    const checkPosition = () => {
      if (!ref.current) return;
      const el = ref.current;
      const parent = el.parentElement;
      if (!parent) return;

      // Get this element's position
      const elRect = el.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();

      // Check if we're at the start of a line (within a small tolerance for the gap)
      // If our left edge is close to the parent's left edge (+ padding), we're first on the line
      const parentStyle = getComputedStyle(parent);
      const paddingLeft = parseFloat(parentStyle.paddingLeft) || 0;
      const isFirstOnLine = elRect.left <= parentRect.left + paddingLeft + 8; // 8px tolerance for gap

      setVisible(!isFirstOnLine);
    };

    checkPosition();

    const observer = new ResizeObserver(checkPosition);
    if (ref.current?.parentElement) {
      observer.observe(ref.current.parentElement);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`w-px h-5 bg-[var(--border-default)] mx-1 shrink-0 transition-opacity ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
