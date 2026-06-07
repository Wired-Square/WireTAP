// ui/src/apps/catalog/layout/CatalogTreePanel.tsx

import React from "react";
import { Cable, Network, Plus, Server, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, iconXs } from "../../../styles/spacing";
import { emptyStateText, emptyStateHeading } from "../../../styles/typography";
import { iconActionButton } from "../../../styles/buttonStyles";
import ResizableSidebar from "../../../components/ResizableSidebar";
import type { TomlNode, ProtocolType, CanProtocolConfig, ModbusProtocolConfig, SerialProtocolConfig } from "../types";
import type { CatalogViewMode, FrameGroup } from "../tree/frameGroups";

const VIEW_MODES: CatalogViewMode[] = ["tree", "frames", "nodes"];

export type CatalogTreePanelProps = {
  // Visibility is controlled by CatalogEditor (only show in UI mode)
  visible: boolean;

  catalogPath: string | null;
  parsedTree: TomlNode[];
  renderTreeNode: (node: TomlNode, depth?: number) => React.ReactNode;

  // Scroll preservation
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: (scrollTop: number) => void;

  viewMode: CatalogViewMode;
  setViewMode: (mode: CatalogViewMode) => void;
  /** Grouped frames for non-Tree view modes (empty in Tree mode). */
  frameGroups: FrameGroup[];

  /** Active protocol filter from the badges (null = all). */
  selectedProtocol: ProtocolType | null;
  setSelectedProtocol: (protocol: ProtocolType | null) => void;

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
};

export default function CatalogTreePanel({
  visible,
  catalogPath,
  parsedTree,
  renderTreeNode,
  scrollRef,
  onScroll,
  viewMode,
  setViewMode,
  frameGroups,
  selectedProtocol,
  setSelectedProtocol,
  hasCanFrames,
  hasModbusFrames,
  hasSerialFrames,
  canConfig,
  modbusConfig,
  serialConfig,
  onAddNode,
  onAddCanFrame,
  onAddFrame,
}: CatalogTreePanelProps) {
  const { t } = useTranslation("catalog");
  // Use generic handler if available, otherwise fall back to CAN-only
  const handleAddFrame = onAddFrame ?? onAddCanFrame;
  if (!visible) return null;

  // Protocol filter badges — shown when a protocol has config or frames.
  // Clicking one filters the tree to that protocol (toggles off when re-clicked).
  const protocolBadges = [
    {
      protocol: "can" as ProtocolType,
      show: !!canConfig || hasCanFrames,
      Icon: Network,
      label: "CAN",
      configured: !!canConfig,
      tone: "bg-[var(--status-success-bg)] text-[color:var(--text-green)] hover:bg-[var(--status-success-bg-hover)]",
    },
    {
      protocol: "modbus" as ProtocolType,
      show: !!modbusConfig || hasModbusFrames,
      Icon: Server,
      label: "Modbus",
      configured: !!modbusConfig,
      tone: "bg-[var(--status-warning-bg)] text-[color:var(--text-amber)] hover:bg-[var(--status-warning-bg-hover)]",
    },
    {
      protocol: "serial" as ProtocolType,
      show: !!serialConfig || hasSerialFrames,
      Icon: Cable,
      label: "Serial",
      configured: !!serialConfig,
      tone: "bg-[var(--status-purple-bg)] text-[color:var(--text-purple)] hover:bg-[var(--status-purple-bg-hover)]",
    },
  ].filter((b) => b.show);
  const hasAnyBadge = protocolBadges.length > 0;

  // Collapsed content - just the action buttons as icons
  const collapsedContent = catalogPath ? (
    <>
      <button
        onClick={onAddNode}
        className={iconActionButton('purple')}
        title={t("tree.addNode")}
      >
        <UserPlus className={iconMd} />
      </button>
      <button
        onClick={() => handleAddFrame?.()}
        className={iconActionButton('blue')}
        title={t("tree.addFrame")}
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
        {/* Protocol filter badges */}
        {catalogPath && hasAnyBadge && (
          <div className="flex flex-wrap gap-2 mb-4">
            {protocolBadges.map(({ protocol, Icon, label, configured, tone }) => {
              const active = selectedProtocol === protocol;
              return (
                <button
                  key={protocol}
                  onClick={() => setSelectedProtocol(active ? null : protocol)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${tone} ${
                    active
                      ? "ring-2 ring-inset ring-[color:currentColor]"
                      : selectedProtocol
                        ? "opacity-50 hover:opacity-100"
                        : ""
                  }`}
                  title={active ? t("tree.showAllProtocols") : t("tree.filterToProtocol", { protocol: label })}
                >
                  <Icon className={iconXs} />
                  {label}
                  {!configured && <span title={t("tree.noProtocolConfig", { protocol: label })}>!</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Action buttons - left aligned */}
        {catalogPath && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={onAddNode}
              className={iconActionButton('purple')}
              title={t("tree.addNode")}
            >
              <UserPlus className={iconMd} />
            </button>
            <button
              onClick={() => handleAddFrame?.()}
              className={iconActionButton('blue')}
              title={t("tree.addFrame")}
            >
              <Plus className={iconMd} />
            </button>
          </div>
        )}

        {/* View-mode selector */}
        {catalogPath && (
          <div className="flex mb-3 rounded-lg border border-[color:var(--border-default)] overflow-hidden text-xs">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`flex-1 px-2 py-1.5 transition-colors ${
                  viewMode === mode
                    ? "bg-[var(--accent-blue)] text-white font-medium"
                    : "bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)]"
                }`}
              >
                {t(`tree.viewMode.${mode}`)}
              </button>
            ))}
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
          <p className={`${emptyStateText} ${emptyStateHeading}`}>{t("tree.openCatalogPrompt")}</p>
        ) : parsedTree.length === 0 ? (
          <p className={`${emptyStateText} ${emptyStateHeading}`}>{t("tree.emptyStructure")}</p>
        ) : viewMode === "tree" ? (
          <div className="space-y-1">{parsedTree.map((node) => renderTreeNode(node, 0))}</div>
        ) : frameGroups.length === 0 ? (
          <p className={`${emptyStateText} ${emptyStateHeading}`}>{t("tree.noFrames")}</p>
        ) : (
          <div className="space-y-3">
            {frameGroups.map((group) => (
              <div key={group.label || "all"} className="space-y-1">
                {group.label && (
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                    {group.label}
                  </div>
                )}
                {group.frames.map((frame) => renderTreeNode(frame, 0))}
              </div>
            ))}
          </div>
        )}
      </div>
    </ResizableSidebar>
  );
}
