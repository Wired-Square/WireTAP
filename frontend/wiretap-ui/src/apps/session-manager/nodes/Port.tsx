// src/apps/session-manager/nodes/Port.tsx

import type { CSSProperties } from "react";

const PINNED = {
  left: "absolute left-0 -translate-x-1/2 -translate-y-1/2",
  right: "absolute right-0 translate-x-1/2 -translate-y-1/2",
};

interface PortProps {
  id: string;
  /** Inputs sit on the left, outputs on the right. */
  side: "left" | "right";
  className: string;
  /** Sits on the node's border, at `top` (half way down by default), rather than in the flow of its row. */
  pinned?: boolean;
  top?: string;
}

export function Port({ id, side, className, pinned, top = "50%" }: PortProps) {
  const style: CSSProperties | undefined = pinned ? { top } : undefined;
  return (
    <span
      data-canvas-port={id}
      data-canvas-side={side}
      data-canvas-port-kind={side === "left" ? "in" : "out"}
      className={`block w-3 h-3 rounded-full border-2 cursor-crosshair ${pinned ? PINNED[side] : ""} ${className}`}
      style={style}
    />
  );
}
