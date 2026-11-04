// ui/src/apps/catalog/layout/SelectionHeader.tsx

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link2, Layers, Pencil, Trash2 } from "lucide-react";
import { iconMd, iconXl, flexRowGap2 } from "../../../styles/spacing";
import type { TomlNode } from "../types";
import { nodeLabel } from "../tree/treeUtils";
import type { Frame } from "../../../types/catalogModel";
import type { FormattedId } from "../utils";
import { muxSignalCount } from "../views/signalRanges";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type SelectionHeaderProps = {
  selectedNode: TomlNode;
  formatFrameId?: (frame: Frame) => FormattedId;
  onEdit?: () => void;
  onDelete?: () => void;
};

function modbusSignalCount(node: TomlNode): number {
  const frame = node.metadata?.frame;
  return (frame?.signals.length ?? 0) + (frame?.mux ? muxSignalCount(frame.mux) : 0);
}

function labelForNode(node: TomlNode, t: TFunction): string {
  switch (node.type) {
    case "section":
      return t("selection.table");
    case "signal":
      return t("selection.signal");
    case "meta":
      return t("selection.metadata");
    case "can-frame":
      return t("selection.canFrame");
    case "modbus-frame":
      // A register decodes one signal; more than one makes it a register group.
      return t(modbusSignalCount(node) > 1 ? "selection.registerGroup" : "selection.register");
    case "node":
      // A Modbus node owns a device address; CAN/serial nodes are peers.
      return t(node.metadata?.nodeDef?.deviceAddress != null ? "selection.slave" : "selection.peer");
    case "mux":
      return t("selection.mux");
    case "mux-case":
      return t("selection.muxCase");
    default:
      return node.type;
  }
}

export default function SelectionHeader({ selectedNode, formatFrameId, onEdit, onDelete }: SelectionHeaderProps) {
  const { t } = useTranslation("catalog");
  const frame = selectedNode.metadata?.frame;
  const copyFrom = frame?.copyFrom;
  const mirrorOf = frame?.mirrorOf;
  const idLabel = selectedNode.type === "can-frame" && frame && formatFrameId ? formatFrameId(frame) : null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-primary flex items-center gap-3">
          {copyFrom && (
            <span title={t("selection.copiedFrom", { source: copyFrom })}>
              <Link2 className={`${iconXl} text-accent-primary`} />
            </span>
          )}
          {mirrorOf && (
            <span title={t("selection.mirrorOf", { source: mirrorOf })}>
              <Layers className={`${iconXl} text-purple`} />
            </span>
          )}
          {idLabel ? (
            <span className={flexRowGap2}>
              <span>{idLabel.primary}</span>
              {idLabel.secondary && (
                <span className="text-muted text-lg">({idLabel.secondary})</span>
              )}
            </span>
          ) : (
            nodeLabel(selectedNode)
          )}
        </h2>
        {(onEdit || onDelete) && (
          <div className="flex gap-2">
            {onEdit && (
              <IconButton onClick={onEdit} title={t("selection.editFrame")}>
                <Pencil className={`${iconMd} text-secondary`} />
              </IconButton>
            )}
            {onDelete && (
              <IconButton onClick={onDelete} tone="danger" title={t("selection.deleteFrame")}>
                <Trash2 className={`${iconMd} text-danger`} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      <div className={`${flexRowGap2} text-sm text-muted`}>
        <Badge size="lg">{labelForNode(selectedNode, t)}</Badge>
        <span className="font-mono text-xs">{selectedNode.path.join(".")}</span>
        {copyFrom && (
          <Badge tone="primary" size="lg">{t("selection.copyOf", { source: copyFrom })}</Badge>
        )}
        {mirrorOf && (
          <Badge tone="purple" variant="outline" size="lg">{t("selection.mirrorOf", { source: mirrorOf })}</Badge>
        )}
      </div>
    </div>
  );
}
