// ui/src/apps/catalog/views/ModbusFrameView.tsx

import { Pencil, Trash2 } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { labelSmall, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary } from "../../../styles";
import type { TomlNode } from "../types";

export type ModbusFrameViewProps = {
  selectedNode: TomlNode;
  onEditFrame?: (node: TomlNode) => void;
  onDeleteFrame?: (key: string) => void;
};

export default function ModbusFrameView({
  selectedNode,
  onEditFrame,
  onDeleteFrame,
}: ModbusFrameViewProps) {
  const registerNumber = selectedNode.metadata?.registerNumber;
  const deviceAddress = selectedNode.metadata?.deviceAddress;
  const deviceAddressInherited = selectedNode.metadata?.deviceAddressInherited;
  const registerType = selectedNode.metadata?.registerType ?? "holding";
  const length = selectedNode.metadata?.length;
  const transmitter = selectedNode.metadata?.transmitter;
  const interval = selectedNode.metadata?.interval;
  const intervalInherited = selectedNode.metadata?.intervalInherited;
  const notes = selectedNode.metadata?.notes;

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-[color:var(--text-muted)]">Configure Modbus frame properties</p>
          <div className="text-lg font-bold text-[color:var(--text-primary)]">
            {selectedNode.key}
          </div>
        </div>
        {(onEditFrame || onDeleteFrame) && (
          <div className="flex gap-2">
            {onEditFrame && (
              <button
                onClick={() => onEditFrame(selectedNode)}
                className={iconButtonHover}
                title="Edit frame"
              >
                <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
              </button>
            )}
            {onDeleteFrame && (
              <button
                onClick={() => onDeleteFrame(selectedNode.key)}
                className={iconButtonHoverDanger}
                title="Delete frame"
              >
                <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Register Number
          </div>
          <div className={monoBody}>
            {registerNumber ?? <span className="text-orange-500">Not set</span>}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Device Address
            {deviceAddressInherited && (
              <span className="ml-1 text-[color:var(--text-blue)]" title="Inherited from default_modbus_device_address">
                (inherited)
              </span>
            )}
          </div>
          <div className={monoBody}>
            {deviceAddress ?? <span className="text-orange-500">Not set</span>}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Register Type
          </div>
          <div className={`${monoBody} capitalize`}>
            {registerType}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Length (Registers)
          </div>
          <div className={monoBody}>
            {length ?? 1}
          </div>
        </div>

        {transmitter && (
          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Transmitter
            </div>
            <div className={monoBody}>
              {transmitter}
            </div>
          </div>
        )}

        {interval !== undefined && (
          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Interval
              {intervalInherited && (
                <span className="ml-1 text-[color:var(--text-blue)]" title="Inherited from default_interval">
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {interval} ms
            </div>
          </div>
        )}
      </div>

      {/* Notes */}
      {notes && (
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={`${labelSmall} mb-2`}>
            Notes
          </div>
          <div className="text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap">
            {Array.isArray(notes) ? notes.join("\n") : notes}
          </div>
        </div>
      )}

      {/* Signals info */}
      {selectedNode.children && selectedNode.children.length > 0 && (
        <div className="text-sm text-[color:var(--text-muted)]">
          This Modbus frame has {selectedNode.children.length} child node(s). Use the tree to navigate.
        </div>
      )}
    </div>
  );
}
