// ui/src/apps/catalog/layout/SelectionHeader.tsx

import { Link2, Layers, Pencil, Trash2 } from "lucide-react";
import { iconMd, iconXl, flexRowGap2 } from "../../../styles/spacing";
import type { TomlNode } from "../types";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type SelectionHeaderProps = {
  selectedNode: TomlNode;
  formatFrameId?: (id: string) => { primary: string; secondary?: string };
  onEdit?: () => void;
  onDelete?: () => void;
};

/** Count the signals decoded from a Modbus register (frame-level + mux cases). */
function modbusSignalCount(node: TomlNode): number {
  return (node.metadata?.signals?.length ?? 0) + (node.metadata?.muxSignalCount ?? 0);
}

function labelForNode(node: TomlNode): string {
  switch (node.type) {
    case "section":
      return "Table";
    case "table-array":
      return "Signals";
    case "signal":
      return "Signal";
    case "array":
      return "Array";
    case "meta":
      return "Metadata";
    case "can-frame":
      return "CAN Frame";
    case "modbus-frame":
      // A register decodes one signal; more than one makes it a register group.
      return modbusSignalCount(node) > 1 ? "Register Group" : "Register";
    case "node":
      // A Modbus node owns a device address; CAN/serial nodes are peers.
      return node.metadata?.deviceAddress != null ? "Slave" : "Peer";
    case "value":
      return "Value";
    case "mux":
      return "Mux";
    case "mux-case":
      return "Mux Case";
    case "inline-table":
      return "Inline Table";
    default:
      return node.type;
  }
}

export default function SelectionHeader({ selectedNode, formatFrameId, onEdit, onDelete }: SelectionHeaderProps) {
  const isCanFrame = selectedNode.type === "can-frame";
  const idLabel = isCanFrame && formatFrameId ? formatFrameId(selectedNode.key) : null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-[color:var(--text-primary)] flex items-center gap-3">
          {selectedNode.metadata?.isCopy && (
            <span title={`Copied from ${selectedNode.metadata?.copyFrom}`}>
              <Link2 className={`${iconXl} text-[color:var(--accent-primary)]`} />
            </span>
          )}
          {selectedNode.metadata?.isMirror && (
            <span title={`Mirror of ${selectedNode.metadata?.mirrorOf}`}>
              <Layers className={`${iconXl} text-[color:var(--accent-purple)]`} />
            </span>
          )}
          {idLabel ? (
            <span className={flexRowGap2}>
              <span>{idLabel.primary}</span>
              {idLabel.secondary && (
                <span className="text-[color:var(--text-muted)] text-lg">({idLabel.secondary})</span>
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
                <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
              </IconButton>
            )}
            {onDelete && (
              <IconButton onClick={onDelete} tone="danger" title="Delete frame">
                <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      <div className={`${flexRowGap2} text-sm text-[color:var(--text-muted)]`}>
        <Badge size="lg">{labelForNode(selectedNode)}</Badge>
        <span className="font-mono text-xs">{selectedNode.path.join(".")}</span>
        {selectedNode.metadata?.isCopy && (
          <Badge tone="primary" size="lg">Copy of {selectedNode.metadata?.copyFrom}</Badge>
        )}
        {selectedNode.metadata?.isMirror && (
          <Badge tone="purple" variant="outline" size="lg">Mirror of {selectedNode.metadata?.mirrorOf}</Badge>
        )}
      </div>
    </div>
  );
}
