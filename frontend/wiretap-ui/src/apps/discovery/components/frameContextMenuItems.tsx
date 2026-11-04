// ui/src/apps/discovery/components/frameContextMenuItems.tsx
//
// The frame-row context menu items the Discovery and Decoder tables share: copy
// the id, copy the payload, send it to the Frame Calculator, filter, solo, send
// to Transmit, add an event; and the header's column menu.
//
// Each view picks the entries it needs and appends its own. Before this they
// were spelled several times and had already drifted — one copy formatted hex
// via `byteToHex`, the others inlined the same expression by hand.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calculator, ClipboardCopy, Copy, Filter, Flag, Send, Target } from "lucide-react";
import type { TFunction } from "i18next";
import { useShallow } from "@wired-square/store/react";
import type { ContextMenuItem } from "../../../components/ContextMenu";
import type { FrameRow } from "./FrameDataTable";
import type { CanEditorState } from "../../../stores/transmitStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { byteToHex, bytesToHex } from "../../../utils/byteUtils";
import { sendHexDataToCalculator } from "../../../utils/windowCommunication";

/** Renders a divider; label and onClick are ignored. */
export const menuSeparator: ContextMenuItem = { separator: true, label: "", onClick: () => {} };

/** Copy ID (when there is an id) / Copy Data, from text already formatted for the clipboard. */
export function copyMenuItems(t: TFunction, { id, data }: { id?: string; data: string }): ContextMenuItem[] {
  return [
    ...(id !== undefined
      ? [{ label: t("discovery:contextMenu.copyId"), icon: <Copy />, onClick: () => navigator.clipboard.writeText(id) }]
      : []),
    { label: t("discovery:contextMenu.copyData"), icon: <ClipboardCopy />, onClick: () => navigator.clipboard.writeText(data) },
  ];
}

interface FrameCopyItemOptions {
  frame: FrameRow;
  t: TFunction;
  /** Formats the frame id in the panel's effective base. */
  formatId: (id: number, isExtended?: boolean) => string;
  /** Omit Copy ID where the protocol has no id to copy (serial without a declared field). */
  includeId?: boolean;
}

/** Copy ID / Copy Data. */
export function frameCopyMenuItems({
  frame,
  t,
  formatId,
  includeId = true,
}: FrameCopyItemOptions): ContextMenuItem[] {
  return copyMenuItems(t, {
    id: includeId ? formatId(frame.frame_id, frame.is_extended) : undefined,
    data: (frame.hexBytes ?? frame.bytes.map(byteToHex)).join(" "),
  });
}

/** Send a payload, as unspaced hex, to the Frame Calculator. */
export function inspectMenuItem(t: TFunction, hex: string): ContextMenuItem {
  return { label: t("discovery:contextMenu.inspect"), icon: <Calculator />, onClick: () => sendHexDataToCalculator(hex) };
}

/** Send the payload to the Frame Calculator. Replaced the per-row calculator column. */
export function frameInspectMenuItem(frame: FrameRow, t: TFunction): ContextMenuItem {
  return inspectMenuItem(t, bytesToHex(frame.bytes));
}

/** Filter this frame out, or show it alone. */
export function selectionMenuItems(t: TFunction, { onFilter, onSolo }: { onFilter: () => void; onSolo: () => void }): ContextMenuItem[] {
  return [
    { label: t("discovery:contextMenu.filter"), icon: <Filter />, onClick: onFilter },
    { label: t("discovery:contextMenu.solo"), icon: <Target />, onClick: onSolo },
  ];
}

export function sendToTransmitMenuItem(t: TFunction, onClick: () => void): ContextMenuItem {
  return { label: t("discovery:contextMenu.sendToTransmit"), icon: <Send />, onClick };
}

export function addEventMenuItem(t: TFunction, onClick: () => void): ContextMenuItem {
  return { label: t("discovery:contextMenu.addEvent"), icon: <Flag />, onClick };
}

const COLUMN_TOGGLES = [
  ["columns.ref", "showRefColumn", "toggleShowRefColumn"],
  ["columns.bus", "showBusColumn", "toggleShowBusColumn"],
  ["columns.ascii", "showAsciiColumn", "toggleShowAsciiColumn"],
  ["columns.source", "showSourceColumn", "toggleShowSourceColumn"],
] as const;

/** The table header's show/hide-a-column menu, the same in every Discovery frame table. */
export function useColumnVisibilityMenuItems(): ContextMenuItem[] {
  const { t } = useTranslation("discovery");
  const toggles = useDiscoveryUIStore(useShallow((s) => COLUMN_TOGGLES.map(([, , toggle]) => s[toggle])));
  return useMemo(
    () => COLUMN_TOGGLES.map(([labelKey], i) => ({ label: t(labelKey), onClick: toggles[i] })),
    [toggles, t],
  );
}

/** The Transmit editor loaded with this frame, as received. */
export function canEditorFromFrame(frame: FrameRow): Partial<CanEditorState> {
  return {
    frameId: frame.frame_id.toString(16).toUpperCase(),
    dlc: frame.dlc,
    data: [...frame.bytes],
    isExtended: frame.is_extended ?? false,
    isFd: frame.is_fd ?? false,
    isBrs: frame.is_brs ?? false,
    isRtr: frame.is_rtr ?? false,
    bus: frame.bus ?? 0,
  };
}
