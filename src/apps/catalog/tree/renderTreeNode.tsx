// ui/src/apps/catalog/tree/renderTreeNode.tsx

import React from "react";
import { ChevronDown, ChevronRight, Link2 } from "lucide-react";
import { iconMd, iconSm } from "../../../styles/spacing";
import { hoverLight } from "../../../styles";
import type { TomlNode } from "../types";
import { shouldShowNode } from "./treeUtils";

export type RenderTreeNode = (node: TomlNode, depth?: number) => React.ReactNode;

export type CreateRenderTreeNodeArgs = {
  expandedNodes: Set<string>;
  selectedNode: TomlNode | null;
  filterByNode: string | null;
  onNodeClick: (node: TomlNode) => void;
  onToggleExpand: (node: TomlNode) => void;
  formatFrameId?: (id: string) => { primary: string; secondary?: string };
};

/**
 * Creates a stable `renderTreeNode` function that can be passed into CatalogTreePanel.
 *
 * Note: selection/expansion state lives in CatalogEditor; this is purely presentational.
 */
export function createRenderTreeNode({
  expandedNodes,
  selectedNode,
  filterByNode,
  onNodeClick,
  onToggleExpand,
  formatFrameId,
}: CreateRenderTreeNodeArgs): RenderTreeNode {
  const render: RenderTreeNode = (node, depth = 0) => {
    const nodePath = node.path.join(".");
    const isExpanded = expandedNodes.has(nodePath);
    const hasChildren = !!node.children && node.children.length > 0 && node.type !== "meta";
    const isSelected = (selectedNode?.path.join(".") ?? "") === nodePath;
    const isCopy = node.metadata?.isCopy;

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
            {node.type === "signal" && "⚡ "}
            {node.type === "checksum" && "🔐 "}
            {node.type === "meta" && "📋 "}
            {node.type === "can-frame" && "🔖 "}
            {node.type === "can-config" && "⚙️ "}
            {node.type === "modbus-frame" && "📟 "}
            {node.type === "modbus-config" && "⚙️ "}
            {node.type === "serial-frame" && "📡 "}
            {node.type === "serial-config" && "⚙️ "}
            {node.type === "node" && "👤 "}
            {node.type === "mux" && "🔀 "}
            {node.type === "mux-case" && "📍 "}
            {node.type === "can-frame" && formatFrameId ? (() => {
              const formatted = formatFrameId(node.key);
              const notes = node.metadata?.notes;
              const firstNote = Array.isArray(notes) ? notes[0] : notes;
              const truncatedNote = firstNote && firstNote.length > 40
                ? firstNote.slice(0, 40) + "..."
                : firstNote;
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1.5">
                    <span>{formatted.primary}</span>
                    {formatted.secondary && (
                    <span className="tree-secondary-text text-xs">
                        ({formatted.secondary})
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
            {node.children!
              .filter((child) => shouldShowNode(child, filterByNode))
              .map((child) => render(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return render;
}
