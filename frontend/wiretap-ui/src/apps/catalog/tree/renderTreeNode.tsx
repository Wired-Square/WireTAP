// ui/src/apps/catalog/tree/renderTreeNode.tsx

import React from "react";
import {
  ChevronDown, ChevronRight, Link2, Layers,
  Network, Server, Cable, Zap, Lock, ClipboardList, User, Shuffle, MapPin,
  type LucideIcon,
} from "lucide-react";
import { iconMd, iconSm } from "../../../styles/spacing";
import { hoverLight } from "../../../styles";
import { textMuted, textSecondary } from "../../../styles/colourTokens";
import { formatFrameId as formatId } from "../../../utils/frameIds";
import type { TomlNode } from "../types";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { MODBUS_REGISTER_TONES } from "../../../utils/profileTraits";
import type { ModbusRegisterType } from "../../../api/io";

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
  "can-frame":     { Icon: Network,  cls: "text-green" },
  "modbus-frame":  { Icon: Server,   cls: "text-amber" },
  "serial-frame":  { Icon: Cable,    cls: "text-purple" },
  signal:          { Icon: Zap,           cls: "text-amber" },
  checksum:        { Icon: Lock,          cls: textMuted },
  meta:            { Icon: ClipboardList, cls: textMuted },
  node:            { Icon: User,          cls: textMuted },
  mux:             { Icon: Shuffle,       cls: "text-blue" },
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
    const { frame, signal, mux, muxCase, checksum, nodeDef } = node.metadata ?? {};
    const notes = (frame ?? signal ?? mux ?? muxCase ?? checksum ?? nodeDef)?.notes;
    const note = (max: number) => {
      const first = notes?.[0];
      return first && first.length > max ? first.slice(0, max) + "..." : first;
    };

    return (
      <div key={nodePath}>
        <div
          className={`flex items-center gap-1 px-2 py-1.5 ${hoverLight} cursor-pointer rounded ${
            isSelected ? "bg-info text-info" : ""
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => onNodeClick(node)}
        >
          {hasChildren ? (
            <IconButton
              size="xs"
              className="-m-0.5"
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
            </IconButton>
          ) : (
            <div className="w-4" />
          )}

          <span className="text-sm truncate flex items-center gap-1.5">
            {frame?.copyFrom && (
              <span title={`Copied from ${frame.copyFrom}`}>
                <Link2 className={`${iconSm} text-blue flex-shrink-0`} />
              </span>
            )}
            {frame?.mirrorOf && (
              <span title={`Mirror of ${frame.mirrorOf}`}>
                <Layers className={`${iconSm} text-purple flex-shrink-0`} />
              </span>
            )}
            {(() => {
              const icon = NODE_ICON[node.type];
              if (!icon) return null;
              const { Icon, cls } = icon;
              return <Icon className={`${iconSm} ${cls} flex-shrink-0`} />;
            })()}
            {node.type === "can-frame" && frame ? (() => {
              const id = formatId(frame.frameId, displayFrameIdFormat, frame.isExtended);
              const truncatedNote = note(40);
              return (
                <span className="flex flex-col">
                  <span>{id}</span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "modbus-frame" && frame ? (() => {
              const regType = frame.modbusRegisterType;
              const address = formatId(frame.frameId, displayFrameIdFormat);
              // The colour conveys the register type, so the row drops the `[holding]` text.
              const tone = regType ? MODBUS_REGISTER_TONES[regType as ModbusRegisterType] : undefined;
              return (
                <span className="flex items-center gap-1.5">
                  {address && (
                    <Badge tone={tone} size="sm" mono title={regType} className="font-semibold tabular-nums">
                      {address}
                    </Badge>
                  )}
                  <span>{node.key}</span>
                </span>
              );
            })() : node.type === "mux" && mux ? (() => {
              const truncatedNote = note(30);
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span>{node.key}</span>
                    <span className={`${textSecondary} text-xs`}>
                      ({mux.startBit}:{mux.bitLength})
                    </span>
                  </span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "mux-case" ? (() => {
              const truncatedNote = note(30);
              return (
                <span className="flex flex-col">
                  <span>{node.key}</span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "signal" && signal ? (() => {
              const truncatedNote = note(30);
              const hasStartBit = signal.startBit !== undefined;
              const hasBitLength = signal.bitLength !== undefined;
              // Modbus signals carry a synthesised per-signal register address
              // (frame base + bit offset) — surface it as a badge so the
              // multi-register layout is visible in the tree.
              const sigReg = signal.modbusRegister;
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    {typeof sigReg === "number" && (
                      <Badge size="sm" mono title="Register" className="font-semibold tabular-nums">
                        {formatId(sigReg, displayFrameIdFormat)}
                      </Badge>
                    )}
                    <span>{node.key}</span>
                    {hasStartBit && hasBitLength && (
                      <span className={`${textSecondary} text-xs`}>
                        ({signal.startBit}:{signal.bitLength})
                      </span>
                    )}
                  </span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "checksum" && checksum ? (() => {
              const truncatedNote = note(30);
              return (
                <span className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span>{node.key}</span>
                    <span className="text-purple text-xs font-medium">
                      [{checksum.algorithm}]
                    </span>
                    <span className={`${textSecondary} text-xs`}>
                      (byte {checksum.startByte}:{checksum.byteLength})
                    </span>
                  </span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : node.type === "node" ? (() => {
              const truncatedNote = note(30);
              return (
                <span className="flex flex-col">
                  <span>{node.key}</span>
                  {truncatedNote && (
                    <span className={`${textSecondary} text-xs italic`}>
                      {truncatedNote}
                    </span>
                  )}
                </span>
              );
            })() : (
              node.key
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
