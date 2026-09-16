// ui/src/apps/discovery/components/frameContextMenuItems.tsx
//
// The frame-row context menu items every Discovery table shares: copy the id,
// copy the payload, send it to the Frame Calculator.
//
// Each view appends its own entries around these (Filter/Solo in Frames,
// Unfilter in Filtered, nothing yet in serial Framed Bytes). Before this they
// were spelled three times and had already drifted — one copy formatted hex via
// `byteToHex`, the other two inlined the same expression by hand.

import { Calculator, ClipboardCopy, Copy } from "lucide-react";
import type { TFunction } from "i18next";
import type { ContextMenuItem } from "../../../components/ContextMenu";
import type { FrameRow } from "./FrameDataTable";
import { iconXs } from "../../../styles/spacing";
import { byteToHex, bytesToHex } from "../../../utils/byteUtils";
import { sendHexDataToCalculator } from "../../../utils/windowCommunication";

/** Renders a divider; label and onClick are ignored. */
export const menuSeparator: ContextMenuItem = { separator: true, label: "", onClick: () => {} };

interface FrameCopyItemOptions {
  frame: FrameRow;
  /** Discovery-namespaced translator. */
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
  const hexData = (frame.hexBytes ?? frame.bytes.map(byteToHex)).join(" ");

  return [
    ...(includeId
      ? [{
          label: t("contextMenu.copyId"),
          icon: <Copy className={iconXs} />,
          onClick: () => navigator.clipboard.writeText(formatId(frame.frame_id, frame.is_extended)),
        }]
      : []),
    {
      label: t("contextMenu.copyData"),
      icon: <ClipboardCopy className={iconXs} />,
      onClick: () => navigator.clipboard.writeText(hexData),
    },
  ];
}

/** Send the payload to the Frame Calculator. Replaced the per-row calculator column. */
export function frameInspectMenuItem(frame: FrameRow, t: TFunction): ContextMenuItem {
  return {
    label: t("contextMenu.inspect"),
    icon: <Calculator className={iconXs} />,
    onClick: () => sendHexDataToCalculator(bytesToHex(frame.bytes)),
  };
}
