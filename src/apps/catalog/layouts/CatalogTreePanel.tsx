// ui/src/apps/catalog/layout/CatalogTreePanel.tsx

import React from "react";
import { Cable, Filter, Network, Plus, Server, UserPlus } from "lucide-react";
import { iconMd, iconXs } from "../../../styles/spacing";
import ResizableSidebar from "../../../components/ResizableSidebar";
import type { TomlNode, ProtocolType, CanProtocolConfig, ModbusProtocolConfig, SerialProtocolConfig } from "../types";

export type CatalogTreePanelProps = {
  // Visibility is controlled by CatalogEditor (only show in UI mode)
  visible: boolean;

  catalogPath: string | null;
  parsedTree: TomlNode[];
  renderTreeNode: (node: TomlNode, depth?: number) => React.ReactNode;

  // Scroll preservation
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: (scrollTop: number) => void;

  availablePeers: string[];

  filterByNode: string | null;
  setFilterByNode: (value: string | null) => void;

  // Protocol detection for badges
  hasCanFrames?: boolean;
  hasModbusFrames?: boolean;
  hasSerialFrames?: boolean;
  canConfig?: CanProtocolConfig;
  modbusConfig?: ModbusProtocolConfig;
  serialConfig?: SerialProtocolConfig;

  onAddNode: () => void;
  /** Legacy callback for CAN-only frame adding (kept for backward compat) */
  onAddCanFrame?: () => void;
  /** Generic callback for adding any protocol frame */
  onAddFrame?: (protocol?: ProtocolType) => void;

  // Unified config dialog opener
  onEditConfig?: () => void;
};

export default function CatalogTreePanel({
  visible,
  catalogPath,
  parsedTree,
  renderTreeNode,
  scrollRef,
  onScroll,
  availablePeers,
  filterByNode,
  setFilterByNode,
  hasCanFrames,
  hasModbusFrames,
  hasSerialFrames,
  canConfig,
  modbusConfig,
  serialConfig,
  onAddNode,
  onAddCanFrame,
  onAddFrame,
  onEditConfig,
}: CatalogTreePanelProps) {
  // Use generic handler if available, otherwise fall back to CAN-only
  const handleAddFrame = onAddFrame ?? onAddCanFrame;
  if (!visible) return null;

  // Determine which badges to show:
  // - Show badge if has config OR has frames for each protocol
  const showCanBadge = !!canConfig || hasCanFrames;
  const showModbusBadge = !!modbusConfig || hasModbusFrames;
  const showSerialBadge = !!serialConfig || hasSerialFrames;
  const hasAnyBadge = showCanBadge || showModbusBadge || showSerialBadge;

  // Collapsed content - just the action buttons as icons
  const collapsedContent = catalogPath ? (
    <>
      <button
        onClick={onAddNode}
        className="p-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
        title="Add new node"
      >
        <UserPlus className={iconMd} />
      </button>
      <button
        onClick={() => handleAddFrame?.()}
        className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        title="Add new frame"
      >
        <Plus className={iconMd} />
      </button>
    </>
  ) : null;

  return (
    <ResizableSidebar
      defaultWidth={320}
      minWidth={200}
      maxWidth={500}
      className="overflow-hidden"
      collapsible
      collapsedContent={collapsedContent}
    >
      {/* Fixed header section */}
      <div className="flex-shrink-0 p-4 pb-0">
        {/* Protocol badges */}
        {catalogPath && hasAnyBadge && (
          <div className="flex flex-wrap gap-2 mb-4">
            {showCanBadge && (
              <button
                onClick={onEditConfig}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--status-success-bg)] text-[color:var(--text-green)] hover:bg-[var(--status-success-bg-hover)] transition-colors cursor-pointer"
                title={canConfig ? `CAN config: ${canConfig.default_endianness}${canConfig.frame_id_mask !== undefined ? ', masked' : ''}` : "Configure CAN settings"}
              >
                <Network className={iconXs} />
                CAN
                {!canConfig && <span className="text-green-500">!</span>}
              </button>
            )}
            {showModbusBadge && (
              <button
                onClick={onEditConfig}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--status-warning-bg)] text-[color:var(--text-amber)] hover:bg-[var(--status-warning-bg-hover)] transition-colors cursor-pointer"
                title={modbusConfig ? `Modbus config: Addr ${modbusConfig.device_address}, Base ${modbusConfig.register_base}` : "Configure Modbus settings"}
              >
                <Server className={iconXs} />
                Modbus
                {!modbusConfig && <span className="text-amber-500">!</span>}
              </button>
            )}
            {showSerialBadge && (
              <button
                onClick={onEditConfig}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--status-purple-bg)] text-[color:var(--text-purple)] hover:bg-[var(--status-purple-bg-hover)] transition-colors cursor-pointer"
                title={serialConfig ? `Serial encoding: ${serialConfig.encoding.toUpperCase()}` : "Configure Serial settings"}
              >
                <Cable className={iconXs} />
                Serial
                {!serialConfig && <span className="text-purple-500">!</span>}
              </button>
            )}
          </div>
        )}

        {/* Action buttons - left aligned */}
        {catalogPath && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={onAddNode}
              className="p-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              title="Add new node"
            >
              <UserPlus className={iconMd} />
            </button>
            <button
              onClick={() => handleAddFrame?.()}
              className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              title="Add new frame"
            >
              <Plus className={iconMd} />
            </button>
            <button
              onClick={() => setFilterByNode(filterByNode !== null ? null : "")}
              title={filterByNode !== null ? "Clear filter" : "Filter by transmitting node"}
              style={{
                backgroundColor: filterByNode !== null ? "#2563eb" : undefined,
                color: filterByNode !== null ? "white" : undefined,
              }}
              className="p-2 rounded-lg transition-colors hover:opacity-90 bg-[var(--bg-surface)] text-[color:var(--text-secondary)]"
            >
              <Filter className={iconMd} />
            </button>
          </div>
        )}

        {/* Filter dropdown */}
        {filterByNode !== null && catalogPath && (
          <div className="mb-3">
            <select
              value={filterByNode}
              onChange={(e) => setFilterByNode(e.target.value || null)}
              className="w-full px-3 py-2 text-sm bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All nodes</option>
              <option value="__unknown__">Unknown</option>
              {availablePeers.map((peer) => (
                <option key={peer} value={peer}>
                  {peer}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Scrollable tree section */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 pb-4"
        onScroll={onScroll ? (e) => onScroll((e.target as HTMLDivElement).scrollTop) : undefined}
      >
        {!catalogPath ? (
          <p className="text-sm text-[color:var(--text-muted)]">Open a catalog file to view its structure</p>
        ) : parsedTree.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">No structure to display</p>
        ) : (
          <div className="space-y-1">{parsedTree.map((node) => renderTreeNode(node, 0))}</div>
        )}
      </div>
    </ResizableSidebar>
  );
}
