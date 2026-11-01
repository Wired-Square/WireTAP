// src/apps/session-manager/utils/draggedPositions.ts

import type { CanvasNode, Point } from "@wired-square/canvas/core";

export type DraggedPositions = ReadonlyMap<string, Point>;

/** The laid-out nodes, each the user has dragged at its dragged position. */
export function placeDragged<N extends CanvasNode<unknown>>(nodes: readonly N[], dragged: DraggedPositions): N[] {
  return nodes.map((node) => {
    const position = dragged.get(node.id);
    return position ? { ...node, ...position } : node;
  });
}

/** `dragged` without the nodes that have gone, so one that returns starts at its layout position; `dragged` itself when none have. */
export function forgetGone(dragged: DraggedPositions, nodes: readonly CanvasNode<unknown>[]): DraggedPositions {
  const ids = new Set(nodes.map((node) => node.id));
  const kept = [...dragged].filter(([id]) => ids.has(id));
  return kept.length === dragged.size ? dragged : new Map(kept);
}
