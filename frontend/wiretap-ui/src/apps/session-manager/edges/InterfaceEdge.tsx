// src/apps/session-manager/edges/InterfaceEdge.tsx
//
// Custom edge using bezier curves for smoother routing (Node-RED style).
// Labels have been removed since bus numbers are now shown inside nodes.

import { type EdgeProps, getBezierPath } from "@xyflow/react";

export interface InterfaceEdgeData {
  /** Interface ID on the source side (e.g., "bus0") */
  sourceInterface: string;
  /** Interface ID on the session side (e.g., "bus0") */
  targetInterface: string;
}

export default function InterfaceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  // Use a generous curvature for loose, Node-RED-style curves
  const curvature = 0.4;
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature,
  });

  return (
    <path
      id={id}
      style={style}
      className="react-flow__edge-path"
      d={edgePath}
      markerEnd={markerEnd}
    />
  );
}
