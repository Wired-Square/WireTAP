// ui/src/apps/catalog/tree/renderTreeNode.tsx

import React from "react";
import {
  ChevronDown, ChevronRight, Link2, Layers,
  Network, Server, Cable, Zap, Lock, ClipboardList, Settings, User, Shuffle, MapPin,
  type LucideIcon,
} from "lucide-react";
import { iconMd, iconSm } from "../../../styles/spacing";
import { hoverLight } from "../../../styles";
import { textMuted } from "../../../styles/colourTokens";
import { formatFrameId as formatId } from "../../../utils/frameIds";
import { parseCanIdToNumber } from "../utils";
import type { TomlNode } from "../types";

export type RenderTreeNode = (node: TomlNode, depth?: number) => React.ReactNode;

export type CreateRenderTreeNodeArgs = {
  expandedNodes: Set<string>;
  selectedNode: TomlNode | null;
  onNodeClick: (node: TomlNode) => void;
  onToggleExpand: (node: TomlNode) => void;
  displayFrameIdFormat?: "hex" | "decimal";
};

/**
 * Lucide icon per node type. Protocol frames reuse the badge icons
 * (Network/Server/Cable) with matching tones so rows read consistently across
 * CAN/Modbus/Serial. Copy (Link2) and mirror (Layers) indicators are separate.
 */
const NODE_ICON: Record<string, { Icon: LucideIcon; cls: string }> = {
  "can-frame":     { Icon: Network,  cls: "text-[color:var(--text-green)]" },
  "modbus-frame":  { Icon: Server,   cls: "text-[color:var(--text-amber)]" },
  "serial-frame":  { Icon: Cable,    cls: "text-[color:var(--text-purple)]" },
  "can-config":    { Icon: Settings, cls: textMuted },
  "modbus-config": { Icon: Settings, cls: textMuted },
  "serial-config": { Icon: Settings, cls: textMuted },
  signal:          { Icon: Zap,           cls: "text-[color:var(--text-amber)]" },
  checksum:        { Icon: Lock,          cls: textMuted },
  meta:            { Icon: ClipboardList, cls: textMuted },
  node:            { Icon: User,          cls: textMuted },
  mux:             { Icon: Shuffle,       cls: "text-[color:var(--accent-blue)]" },
  "mux-case":      { Icon: MapPin,        cls: textMuted },
};

/**
 * Creates a stable `renderTreeNode` function that can be passed into CatalogTreePanel.
 *
 * Note: selection/expansion state lives in CatalogEditor; this is purely presentational.
 */
export function createRenderTreeNode({
  expandedNodes,
  selectedNode,
  onNodeClick,
  onToggleExpand,
  displayFrameIdFormat = "hex",
}: CreateRenderTreeNodeArgs): RenderTreeNode {
  const render: RenderTreeNode = (node, depth = 0) => {
    const nodePath = node.path.join(".");
    const isExpanded = expandedNodes.has(nodePath);
    const hasChildren = !!node.children && node.children.length > 0 && node.type !== "meta";
    const isSelected = (selectedNode?.path.join(".") ?? "") === nodePath;
    const isCopy = node.metadata?.isCopy;
    const isMirror = node.metadata?.isMirror;

    return (
      <div key={nodePath}>
        <div
          className={`flex items-center gap-1 px-2 py-1.5 ${hoverLight} cursor-pointer rounded ${
            isSelected ? "bg-[var(--selected-bg)] text-[color:var(--selected-text)]" : ""
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => onNodeClick(node)}
        >
          {hasChildren ? (
            <button
              type="button"
              className="p-0.5 -m-0.5 hover:bg-[var(--hover-bg)] rounded"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(node);
              }}
            >
              {isExpanded ? (
                <ChevronDown className={`${iconMd} flex-shrink-0`} />
              ) : (
                <ChevronRight className={`${iconMd} flex-shrink-0`} />
              )}
            </button>
          ) : (
            <div className="w-4" />
          )}

          <span className="text-sm truncate flex items-center gap-1.5">
            {isCopy && (
              <span title={`Copied from ${node.metadata?.copyFrom}`}>
                <Link2 className={`${iconSm} text-[color:var(--accent-blue)] flex-shrink-0`} />
              </span>
            )}
            {isMirror && (
              <span title={`Mirror of ${node.metadata?.mirrorOf}`}>
                <Layers className={`${iconSm} text-[color:var(--accent-purple)] flex-shrink-0`} />
              </span>
            )}
            {(() => {
              const icon = NODE_ICON[node.type];
              if (!icon) return null;
              const { Icon, cls } = icon;
              return <Icon className={`${iconSm} ${cls} flex-shrink-0`} />;
            })()}
            {node.type === "can-frame" ? (() => {
              const num = parseCanIdToNumber(node.key);
              const id = num !== null
                ? formatId(num, displayFrameIdFormat, node.metadata?.extended)
                : node.key;
              const notes = node.metadata?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 40
                ? firstNote.slice(0, 40) + "..."
                : firstNote;
              return (
                <span className="flex flex-col">
                  <span>{id}</span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "modbus-frame" ? (() => {
              const regNum = node.metadata?.registerNumber;
              const regType = node.metadata?.registerType;
              const address = typeof regNum === "number"
                ? formatId(regNum, displayFrameIdFormat)
                : undefined;
              return (
                <span className="flex items-center gap-1.5">
                  <span>{node.key}</span>
                  {address && (
                    <span className="tree-secondary-text text-xs">
                      {address}
                    </span>
                  )}
                  {regType && (
                    <span className="text-[color:var(--accent-purple)] text-xs font-medium">
                      [{regType}]
                    </span>
                  )}
                </span>
              );
            })() : node.type === "mux" ? (() => {
              const notes = node.metadata?.properties?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 30
                ? firstNote.slice(0, 30) + "..."
                : firstNote;
              const hasStartBit = node.metadata?.muxStartBit !== undefined;
              const hasBitLength = node.metadata?.muxBitLength !== undefined;
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span>{node.key}</span>
                    {hasStartBit && hasBitLength && (
                      <span className="tree-secondary-text text-xs">
                        ({node.metadata?.muxStartBit}:{node.metadata?.muxBitLength})
                      </span>
                    )}
                  </span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "mux-case" ? (() => {
              const notes = node.metadata?.properties?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 30
                ? firstNote.slice(0, 30) + "..."
                : firstNote;
              return (
                <span className="flex flex-col">
                  <span>{node.key}</span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "signal" ? (() => {
              const notes = node.metadata?.properties?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 30
                ? firstNote.slice(0, 30) + "..."
                : firstNote;
              const hasStartBit = node.metadata?.signalStartBit !== undefined;
              const hasBitLength = node.metadata?.signalBitLength !== undefined;
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span>{node.key}</span>
                    {hasStartBit && hasBitLength && (
                      <span className="tree-secondary-text text-xs">
                        ({node.metadata?.signalStartBit}:{node.metadata?.signalBitLength})
                      </span>
                    )}
                  </span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "checksum" ? (() => {
              const notes = node.metadata?.properties?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 30
                ? firstNote.slice(0, 30) + "..."
                : firstNote;
              const algorithm = node.metadata?.checksumAlgorithm;
              const startByte = node.metadata?.checksumStartByte;
              const byteLength = node.metadata?.checksumByteLength;
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span>{node.key}</span>
                    {algorithm && (
                      <span className="text-[color:var(--accent-purple)] text-xs font-medium">
                        [{algorithm}]
                      </span>
                    )}
                    {startByte !== undefined && byteLength !== undefined && (
                      <span className="tree-secondary-text text-xs">
                        (byte {startByte}:{byteLength})
                      </span>
                    )}
                  </span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "node" ? (() => {
              const notes = node.metadata?.properties?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 30
                ? firstNote.slice(0, 30) + "..."
                : firstNote;
              return (
                <span className="flex flex-col">
                  <span>{node.key}</span>
                  {truncatedNote && (
                    <span className="tree-secondary-text text-xs italic">
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : (
              node.key
            )}
            {node.type === "array" && ` [${node.metadata?.arrayItems?.length || 0}]`}
            {node.type === "value" && node.value !== undefined && (
              <span className="tree-secondary-text ml-1">
                = {String(node.value).substring(0, 20)}
                {String(node.value).length > 20 ? "..." : ""}
              </span>
            )}
          </span>
        </div>

        {hasChildren && isExpanded && (
          <div>
            {node.children!.map((child) => render(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return render;
}
