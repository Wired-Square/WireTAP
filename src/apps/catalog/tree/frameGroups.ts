// ui/src/apps/catalog/tree/frameGroups.ts
//
// Derives flat, grouped frame lists from the parsed catalog tree for the
// Catalog Editor's non-Tree view modes (Frames / Nodes), plus a protocol
// filter applied to the tree before display.

import type { TomlNode, ProtocolType } from "../types";
import { parseCanIdToNumber } from "../utils";

export type CatalogViewMode = "tree" | "frames" | "nodes";

export type FrameGroup = { label: string; frames: TomlNode[] };

const FRAME_TYPES = new Set(["can-frame", "modbus-frame", "serial-frame"]);
const UNASSIGNED = "Unassigned";

/**
 * Narrow the tree to a single protocol's frames (used by the protocol badges).
 * Only the top-level `[frame]` section is filtered; meta/node sections are
 * intentionally left visible (they're protocol-agnostic). Child node references
 * are preserved so expansion/selection paths still match. A no-op (returns the
 * same array) when no protocol is selected.
 */
export function applyProtocolFilter(parsedTree: TomlNode[], protocol: ProtocolType | null): TomlNode[] {
  if (!protocol) return parsedTree;
  return parsedTree.map((node) =>
    node.key === "frame" && node.type === "section" && node.children
      ? { ...node, children: node.children.filter((p) => p.key === protocol) }
      : node
  );
}

/** All protocol frame nodes, gathered from the `[frame]` section of the tree. */
export function collectFrameNodes(parsedTree: TomlNode[]): TomlNode[] {
  const frameSection = parsedTree.find((n) => n.key === "frame" && n.type === "section");
  if (!frameSection?.children) return [];
  return frameSection.children.flatMap((protocol) =>
    (protocol.children ?? []).filter((n) => FRAME_TYPES.has(n.type))
  );
}

/** Sortable numeric id for a frame: register number (Modbus) or parsed CAN id. */
function frameNumericId(frame: TomlNode): number {
  return frame.metadata?.registerNumber ?? parseCanIdToNumber(frame.key) ?? 0;
}

/** The node a frame belongs to: CAN transmitter or Modbus slave (else Unassigned). */
function nodeKey(frame: TomlNode): string {
  if (frame.metadata?.frameType === "modbus") {
    return frame.metadata?.node ?? UNASSIGNED;
  }
  return frame.metadata?.transmitter ?? UNASSIGNED;
}

/**
 * Build the grouped flat list for a non-Tree view mode.
 * - `frames`: a single unlabelled group with every frame.
 * - `nodes`: one group per node, frames sorted by id within, groups sorted by
 *   label with "Unassigned" pinned last.
 */
export function buildFrameGroups(parsedTree: TomlNode[], mode: CatalogViewMode): FrameGroup[] {
  const frames = collectFrameNodes(parsedTree).sort((a, b) => frameNumericId(a) - frameNumericId(b));

  if (mode === "frames") return frames.length ? [{ label: "", frames }] : [];

  const groups = new Map<string, TomlNode[]>();
  for (const frame of frames) {
    const key = nodeKey(frame);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(frame);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    })
    .map(([label, frames]) => ({ label, frames }));
}
