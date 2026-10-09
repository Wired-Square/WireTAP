// ui/src/apps/catalog/layout/SelectionHeader.tsx

import { Link2, Layers, Pencil, Trash2 } from "lucide-react";
import { iconMd, iconXl, flexRowGap2 } from "../../../styles/spacing";
import type { TomlNode } from "../types";
import { muxSignalCount } from "../views/signalRanges";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type SelectionHeaderProps = {
  selectedNode: TomlNode;
  formatFrameId?: (id: string) => { primary: string; secondary?: string };
  onEdit?: () => void;
  onDelete?: () => void;
};

function modbusSignalCount(node: TomlNode): number {
  const frame = node.metadata?.frame;
  return (frame?.signals.length ?? 0) + (frame?.mux ? muxSignalCount(frame.mux) : 0);
}

function labelForNode(node: TomlNode): string {
  switch (node.type) {
    case "section":
      return "Table";
    case "signal":
      return "Signal";
    case "meta":
      return "Metadata";
    case "can-frame":
      return "CAN Frame";
    case "modbus-frame":
      // A register decodes one signal; more than one makes it a register group.
      return modbusSignalCount(node) > 1 ? "Register Group" : "Register";
    case "node":
      // A Modbus node owns a device address; CAN/serial nodes are peers.
      return node.metadata?.nodeDef?.deviceAddress != null ? "Slave" : "Peer";
    case "mux":
      return "Mux";
    case "mux-case":
      return "Mux Case";
    default:
      return node.type;
  }
}

export default function SelectionHeader({ selectedNode, formatFrameId, onEdit, onDelete }: SelectionHeaderProps) {
  const isCanFrame = selectedNode.type === "can-frame";
  const copyFrom = selectedNode.metadata?.frame?.copyFrom;
  const mirrorOf = selectedNode.metadata?.frame?.mirrorOf;
  const idLabel = isCanFrame && formatFrameId ? formatFrameId(selectedNode.key) : null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-primary flex items-center gap-3">
          {copyFrom && (
            <span title={`Copied from ${copyFrom}`}>
              <Link2 className={`${iconXl} text-accent-primary`} />
            </span>
          )}
          {mirrorOf && (
            <span title={`Mirror of ${mirrorOf}`}>
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
            selectedNode.key
          )}
        </h2>
        {(onEdit || onDelete) && (
          <div className="flex gap-2">
            {onEdit && (
              <IconButton onClick={onEdit} title="Edit frame">
                <Pencil className={`${iconMd} text-secondary`} />
              </IconButton>
            )}
            {onDelete && (
              <IconButton onClick={onDelete} tone="danger" title="Delete frame">
                <Trash2 className={`${iconMd} text-danger`} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      <div className={`${flexRowGap2} text-sm text-muted`}>
        <Badge size="lg">{labelForNode(selectedNode)}</Badge>
        <span className="font-mono text-xs">{selectedNode.path.join(".")}</span>
        {copyFrom && (
          <Badge tone="primary" size="lg">Copy of {copyFrom}</Badge>
        )}
        {mirrorOf && (
          <Badge tone="purple" variant="outline" size="lg">Mirror of {mirrorOf}</Badge>
        )}
      </div>
    </div>
  );
}
