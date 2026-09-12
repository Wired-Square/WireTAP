// ui/src/apps/discovery/views/DiscoveryModbusView.tsx
//
// The Modbus tab: every whole RTU message the session carries, in arrival order,
// one list across units. A raw view — no picker, no selection — the way a tap on
// an RS-485 line reads, with the request beside its reply. The rows come from the
// parent's `useCaptureFrameView` instance so the tab bar's toolbar can page it.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FrameDataTable, type FrameRow } from "../components";
import { frameCopyMenuItems, frameInspectMenuItem, menuSeparator } from "../components/frameContextMenuItems";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { formatProtocolFrameId } from "../../../utils/frameIds";
import type { UseBufferFrameViewResult } from "../hooks/useCaptureFrameView";
import type { TimeDisplayFormat } from "../../../types/common";

type Props = {
  view: UseBufferFrameViewResult;
  formatTime: (timestampUs: number, prevTimestampUs: number | null) => ReactNode;
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: TimeDisplayFormat;
  showRef: boolean;
  showBus: boolean;
  showAscii: boolean;
  autoFit: boolean;
  onFitChange: (rows: number) => void;
  useLocalTimezone: boolean;
};

export default function DiscoveryModbusView({
  view,
  formatTime,
  displayFrameIdFormat,
  displayTimeFormat,
  showRef,
  showBus,
  showAscii,
  autoFit,
  onFitChange,
  useLocalTimezone,
}: Props) {
  const { t } = useTranslation("discovery");
  const [contextMenu, setContextMenu] = useState<{ frame: FrameRow; position: { x: number; y: number } } | null>(null);

  useEffect(() => {
    setContextMenu(null);
  }, [view.currentPage, view.frames]);

  const handleContextMenu = useCallback((frame: FrameRow, position: { x: number; y: number }) => {
    setContextMenu({ frame, position });
  }, []);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    return [
      ...frameCopyMenuItems({
        frame,
        t,
        formatId: (id) => formatProtocolFrameId(frame.protocol, id, displayFrameIdFormat),
      }),
      menuSeparator,
      frameInspectMenuItem(frame, t),
    ];
  }, [contextMenu, displayFrameIdFormat, t]);

  return (
    <>
      <FrameDataTable
        displayTimeFormat={displayTimeFormat}
        frames={view.frames}
        formatTime={formatTime}
        emptyMessage={
          view.isLoading ? t("modbusView.loading") : view.tailing ? t("modbusView.waiting") : t("modbusView.none")
        }
        showRef={showRef}
        showBus={showBus}
        showAscii={showAscii}
        // No capture indices: `#` is the message's ordinal within its protocol,
        // which is what a list of one protocol's messages means by it.
        pageStartIndex={view.pageStartIndex}
        autoScroll={view.tailing}
        autoFit={autoFit}
        onFitChange={onFitChange}
        onContextMenu={handleContextMenu}
        useLocalTimezone={useLocalTimezone}
      />
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
