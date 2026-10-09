// ui/src/apps/catalog/layout/CatalogTreePanel.tsx

import React, { useState } from "react";
import { Cable, ChevronDown, ChevronRight, FoldVertical, Network, Plus, Server, UnfoldVertical, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, iconSm, iconXs } from "../../../styles/spacing";
import { emptyStateText, emptyStateHeading } from "../../../styles/typography";
import ResizableSidebar from "../../../components/ResizableSidebar";
import FindBar from "../components/FindBar";
import type { TomlNode, ProtocolType } from "../types";
import type { Catalog } from "../../../types/catalogModel";
import { hasFrames } from "../model";
import type { CatalogViewMode, FrameGroup } from "../tree/frameGroups";
import { Button, IconButton } from "../../../components/Button";
import { Tab, Tabs } from "../../../components/Tabs";
import { protocolTone } from "../../../utils/profileTraits";

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

  /** Which protocols have a configuration or frames, for the badges. */
  catalog: Catalog | null;

  onAddNode: () => void;
  onAddFrame: () => void;

  /** Expand every node with children. */
  onExpandAll: () => void;
  /** Collapse all nodes. */
  onCollapseAll: () => void;
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
  catalog,
  onAddNode,
  onAddFrame,
  onExpandAll,
  onCollapseAll,
}: CatalogTreePanelProps) {
  const { t } = useTranslation("catalog");
  // Per-node collapse in the Nodes view (ephemeral; keyed by group label).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  if (!visible) return null;

  // Protocol filter badges — shown when a protocol has config or frames.
  // Clicking one filters the tree to that protocol (toggles off when re-clicked).
  const protocolBadges = ([
    { protocol: "can", Icon: Network, label: "CAN" },
    { protocol: "modbus", Icon: Server, label: "Modbus" },
    { protocol: "serial", Icon: Cable, label: "Serial" },
  ] as const)
    .map((b) => ({ ...b, configured: !!catalog?.[b.protocol] }))
    .filter((b) => b.configured || hasFrames(catalog, b.protocol));
  const hasAnyBadge = protocolBadges.length > 0;

  // Collapsed content - just the action buttons as icons
  const collapsedContent = catalogPath ? (
    <>
      <IconButton
        onClick={onAddNode}
        variant="solid"
        tone="purple"
        title={t("tree.addNode")}
      >
        <UserPlus className={iconMd} />
      </IconButton>
      <IconButton
        onClick={() => onAddFrame()}
        variant="solid"
        tone="primary"
        title={t("tree.addFrame")}
      >
        <Plus className={iconMd} />
      </IconButton>
    </>
  ) : null;

  // Protocol filter badges — rendered in the sidebar header row, beside the
  // collapse toggle. Clicking one filters the tree to that protocol.
  const badgeHeader = catalogPath && hasAnyBadge ? (
    <div className="flex flex-wrap items-center gap-2">
      {protocolBadges.map(({ protocol, Icon, label, configured }) => {
        const active = selectedProtocol === protocol;
        return (
          <Button
            key={protocol}
            variant="outline"
            tone={protocolTone(protocol)}
            size="sm"
            pressed={active}
            onClick={() => setSelectedProtocol(active ? null : protocol)}
            title={active ? t("tree.showAllProtocols") : t("tree.filterToProtocol", { protocol: label })}
          >
            <Icon className={iconXs} />
            {label}
            {!configured && <span title={t("tree.noProtocolConfig", { protocol: label })}>!</span>}
          </Button>
        );
      })}
    </div>
  ) : undefined;

  return (
    <ResizableSidebar
      defaultWidth={320}
      minWidth={200}
      maxWidth={500}
      className="overflow-hidden"
      collapsible
      collapsedContent={collapsedContent}
      header={badgeHeader}
    >
      {/* Fixed header section */}
      {catalogPath && (
      <div className="flex-shrink-0 p-4 pb-0">
        {/* Action buttons - add on the left, expand/collapse on the right */}
        <div className="flex items-center gap-2 mb-3">
            <IconButton
              onClick={onAddNode}
              variant="solid"
              tone="purple"
              title={t("tree.addNode")}
            >
              <UserPlus className={iconMd} />
            </IconButton>
            <IconButton
              onClick={() => onAddFrame()}
              variant="solid"
              tone="primary"
              title={t("tree.addFrame")}
            >
              <Plus className={iconMd} />
            </IconButton>
            <div className="ml-auto flex items-center gap-1">
              <IconButton
                onClick={onExpandAll}
                size="sm"
                title={t("tree.expandAll")}
              >
                <UnfoldVertical className={iconSm} />
              </IconButton>
              <IconButton
                onClick={onCollapseAll}
                size="sm"
                title={t("tree.collapseAll")}
              >
                <FoldVertical className={iconSm} />
              </IconButton>
            </div>
          </div>

        {/* Search */}
        <div className="mb-3">
          <FindBar />
        </div>

        {/* View-mode selector */}
        <Tabs variant="segmented" className="flex mb-3">
            {VIEW_MODES.map((mode) => (
              <Tab key={mode} selected={viewMode === mode} onClick={() => setViewMode(mode)}>
                {t(`tree.viewMode.${mode}`)}
              </Tab>
            ))}
          </Tabs>
      </div>
      )}

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
            {frameGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.label);
              return (
                <div key={group.label || "all"} className="space-y-1">
                  {group.label && (
                    <button
                      onClick={() => toggleGroup(group.label)}
                      className="flex items-center gap-1 w-full px-1 py-0.5 rounded text-2xs font-semibold uppercase tracking-wide text-muted hover:bg-hover"
                    >
                      {collapsed ? (
                        <ChevronRight className={`${iconXs} flex-shrink-0`} />
                      ) : (
                        <ChevronDown className={`${iconXs} flex-shrink-0`} />
                      )}
                      <span className="truncate">{group.label}</span>
                      <span className="text-muted opacity-70">· {group.frames.length}</span>
                    </button>
                  )}
                  {!collapsed && group.frames.map((frame) => renderTreeNode(frame, 0))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ResizableSidebar>
  );
}
