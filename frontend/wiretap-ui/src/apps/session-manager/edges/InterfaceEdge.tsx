// src/apps/session-manager/edges/InterfaceEdge.tsx
//
// A Node-RED style bezier between two ports, or between the node borders where
// an end names no port.

import { floatingAnchors, type Anchor, type EdgeGeometry } from "@wired-square/canvas/core";

export interface InterfaceEdgeData {
  stroke: string;
  animated: boolean;
  curvature: number;
}

function controlOffset(distance: number, curvature: number) {
  return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}

function control({ x, y, side }: Anchor, towards: Anchor, curvature: number): [number, number] {
  switch (side) {
    case "left": return [x - controlOffset(x - towards.x, curvature), y];
    case "right": return [x + controlOffset(towards.x - x, curvature), y];
    case "top": return [x, y - controlOffset(y - towards.y, curvature)];
    case "bottom": return [x, y + controlOffset(towards.y - y, curvature)];
  }
}

export function bezierPath(geometry: EdgeGeometry, curvature: number): string {
  const floating = floatingAnchors(geometry.source, geometry.target);
  const source = geometry.sourcePort ?? floating.source;
  const target = geometry.targetPort ?? floating.target;
  const [scx, scy] = control(source, target, curvature);
  const [tcx, tcy] = control(target, source, curvature);
  return `M${source.x},${source.y} C${scx},${scy} ${tcx},${tcy} ${target.x},${target.y}`;
}

export default function InterfaceEdge({ data, geometry }: { data: InterfaceEdgeData; geometry: EdgeGeometry }) {
  const d = bezierPath(geometry, data.curvature);
  return (
    <>
      <path className="session-edge__hit" d={d} />
      <path className={data.animated ? "session-edge is-animated" : "session-edge"} d={d} style={{ stroke: data.stroke }} />
    </>
  );
}
