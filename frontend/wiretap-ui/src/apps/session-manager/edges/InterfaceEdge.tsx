// src/apps/session-manager/edges/InterfaceEdge.tsx
//
// A Node-RED style bezier between two ports, or between the node borders where
// an end names no port.

import { bezierPath, floatingAnchors, type EdgeGeometry } from "@wired-square/canvas/core";

export interface InterfaceEdgeData {
  stroke: string;
  animated: boolean;
  curvature: number;
}

export default function InterfaceEdge({ data, geometry }: { data: InterfaceEdgeData; geometry: EdgeGeometry }) {
  const floating = floatingAnchors(geometry.source, geometry.target);
  const d = bezierPath(geometry.sourcePort ?? floating.source, geometry.targetPort ?? floating.target, data.curvature);
  return (
    <>
      <path className="session-edge__hit" d={d} />
      <path className={data.animated ? "session-edge is-animated" : "session-edge"} d={d} style={{ stroke: data.stroke }} />
    </>
  );
}
