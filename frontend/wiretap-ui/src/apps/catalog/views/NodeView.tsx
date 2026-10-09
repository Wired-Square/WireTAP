// ui/src/apps/catalog/views/NodeView.tsx

import React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Pencil } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, textMedium, bgSurface, sectionHeaderText, emptyStateText } from "../../../styles";
import type { TomlNode } from "../types";
import type { Frame, Mux } from "../../../types/catalogModel";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { formatFrameId } from "../utils";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
export type NodeViewProps = {
  selectedNode: TomlNode;
  onSelectPath: (path: string[]) => void;
  onAddCanFrameForNode?: (nodeName: string) => void;
  onAddRegisterForSlave?: (slaveAddress: number) => void;
  onEditNode?: (nodeName: string, notes?: string, deviceAddress?: number) => void;
  onDeleteNode?: (nodeName: string) => void;
  onRequestDeleteFrame?: (idKey: string) => void;
  onRequestDeleteRegister?: (key: string) => void;
  onRequestDeleteSignal?: (idKey: string, index: number, parentPath: string[], signalName?: string) => void;
  displayFrameIdFormat?: "hex" | "decimal";
};

type FrameSignal = {
  name: string;
  startBit?: number;
  bitLength?: number;
  location?: string;
  path: string[];
  parentPath: string[];
  index: number;
};

type FrameWithSignals = {
  id: string;
  length: number;
  signals: FrameSignal[];
};

/** A frame's own signals, its own mux cases' depth first, each with its document path. */
function ownSignals(frame: Frame): FrameSignal[] {
  const framePath = ["frame", frame.protocol, frame.key];
  const out: FrameSignal[] = [];
  const push = (signals: Frame["signals"], parentPath: string[], location: string) =>
    signals.forEach((s, index) => {
      if (s.inherited) return;
      out.push({
        name: s.name || `Signal ${index + 1}`,
        startBit: s.startBit,
        bitLength: s.bitLength,
        location,
        path: [...parentPath, "signals", String(index)],
        parentPath,
        index,
      });
    });
  const walk = (mux: Mux, muxPath: string[], prefix: string | null) => {
    for (const [k, c] of Object.entries(mux.cases)) {
      const location = prefix ? `${prefix} • case ${k}` : `case ${k}`;
      push(c.signals, [...muxPath, k], location);
      if (c.mux) walk(c.mux, [...muxPath, k, "mux"], location);
    }
  };
  push(frame.signals, framePath, "frame");
  if (frame.mux && !frame.inheritedFields?.includes("mux")) walk(frame.mux, [...framePath, "mux"], null);
  return out;
}

export default function NodeView({
  selectedNode,
  onSelectPath,
  onAddCanFrameForNode,
  onAddRegisterForSlave,
  onEditNode,
  onDeleteNode,
  onRequestDeleteFrame,
  onRequestDeleteRegister,
  onRequestDeleteSignal,
  displayFrameIdFormat = "hex",
}: NodeViewProps) {
  const { t } = useTranslation("catalog");
  const nodeName = selectedNode.key;
  // A Modbus node is a slave: it owns a device address and registers reference
  // it by `node_address`. CAN/serial nodes are transmitters referenced by `transmitter`.
  const deviceAddress = selectedNode.metadata?.nodeDef?.deviceAddress;
  const isModbus = deviceAddress != null;
  const frameProtocol = isModbus ? "modbus" : "can";
  const catalog = useCatalogEditorStore((s) => s.tree.catalog);
  const framesForNode = React.useMemo<FrameWithSignals[]>(
    () =>
      (catalog?.frames ?? [])
        .filter((f) => f.protocol === frameProtocol && (isModbus ? f.modbusNode === nodeName : f.transmitter === nodeName))
        .sort((a, b) => a.frameId - b.frameId)
        .map((f) => ({ id: f.key, length: f.length, signals: ownSignals(f) })),
    [catalog, nodeName, frameProtocol, isModbus]
  );
  const nodeNotes = selectedNode.metadata?.nodeDef?.notes;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-primary">
          {isModbus ? t("nodeView.slave") : t("nodeView.transmittingNode")}
        </h3>

        <div className={flexRowGap2}>
          {(() => {
            // A Modbus slave seeds a new register by its address; a CAN node by name.
            const add =
              isModbus && deviceAddress != null
                ? { onClick: () => onAddRegisterForSlave?.(deviceAddress), label: t("nodeView.addRegister"), show: !!onAddRegisterForSlave }
                : { onClick: () => onAddCanFrameForNode?.(nodeName), label: t("nodeView.addCanFrame"), show: !!onAddCanFrameForNode };
            return add.show ? (
              <Button
                onClick={add.onClick}
                variant="solid"
                tone="primary"
                size="sm"
                title={add.label}
              >
                <Plus className={iconMd} />
                {add.label}
              </Button>
            ) : null;
          })()}

          {onEditNode && (
            <IconButton
              onClick={() => onEditNode(nodeName, nodeNotes?.join("\n"), deviceAddress)}
              title={t("nodeView.edit")}
            >
              <Pencil className={`${iconMd} text-secondary`} />
            </IconButton>
          )}

          {onDeleteNode && (
            <IconButton
              onClick={() => onDeleteNode(nodeName)}
              tone="danger"
              title={t("nodeView.deleteTooltip")}
            >
              <Trash2 className={`${iconMd} text-red`} />
            </IconButton>
          )}
        </div>
      </div>

      <div className={`p-4 ${bgSurface} rounded-lg`}>
        <div className={labelSmallMuted}>{t("metaView.name")}</div>
        <div className={monoBody}>{nodeName}</div>
      </div>

      {isModbus && (
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("nodeView.deviceAddress")}</div>
          <div className={monoBody}>{deviceAddress}</div>
        </div>
      )}

      {nodeNotes && (
        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("nodeView.notes")}</div>
          <div className="text-sm text-secondary whitespace-pre-wrap">
            {nodeNotes.join("\n")}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className={sectionHeaderText}>
          {isModbus
            ? t("nodeView.registersOnSlave", { count: framesForNode.length })
            : t("nodeView.transmittedFrames", { count: framesForNode.length })}
        </div>

        {framesForNode.length === 0 ? (
          <div className="text-sm text-muted">
            {isModbus ? t("nodeView.noRegisters") : t("nodeView.noTransmittedFrames")}
          </div>
        ) : (
          framesForNode.map((frame) => (
            <Card key={frame.id} padding="lg">
              {(() => {
                const formatted = formatFrameId(frame.id, displayFrameIdFormat);
                return (
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-primary flex items-center gap-2">
                  <span>🔖</span>
                  <span className={flexRowGap2}>
                    {formatted.primary}
                    {formatted.secondary && (
                      <span className={caption}>
                        ({formatted.secondary})
                      </span>
                    )}
                  </span>
                </div>
                <div className={flexRowGap2}>
                  <div className={caption}>
                    {t("nodeView.bytesUnit", { count: frame.length })}
                  </div>
                  <IconButton
                    onClick={() => onSelectPath(["frame", frameProtocol, frame.id])}
                    title={t("nodeView.editFrame")}
                  >
                    <Pencil className={`${iconMd} text-secondary`} />
                  </IconButton>
                  {(isModbus ? onRequestDeleteRegister : onRequestDeleteFrame) && (
                    <IconButton
                      onClick={() =>
                        isModbus
                          ? onRequestDeleteRegister?.(frame.id)
                          : onRequestDeleteFrame?.(frame.id)
                      }
                      tone="danger"
                      title={t("nodeView.deleteFrame")}
                    >
                      <Trash2 className={`${iconMd} text-red`} />
                    </IconButton>
                  )}
                </div>
              </div>
                );
              })()}

              {frame.signals.length === 0 ? (
                <div className={emptyStateText}>{t("nodeView.noSignals")}</div>
              ) : (
                <div className="space-y-2">
                  {frame.signals.map((signal, idx) => (
                    <div key={`${signal.name}-${idx}`} className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className={`${textMedium} flex items-center gap-2`}>
                          <span>⚡</span>
                          {signal.name}
                        </div>
                        <div className={caption}>
                          {signal.bitLength
                            ? t("nodeView.bitsRangeWithLength", {
                                start: signal.startBit ?? 0,
                                end: (signal.startBit ?? 0) + signal.bitLength - 1,
                                length: signal.bitLength,
                              })
                            : t("nodeView.bitsRange", {
                                start: signal.startBit ?? 0,
                                end: (signal.startBit ?? 0) - 1,
                              })}
                          {signal.location ? ` • ${signal.location}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <IconButton
                          onClick={() => onSelectPath(signal.path)}
                          title={t("nodeView.editSignal")}
                        >
                          <Pencil className={`${iconMd} text-secondary`} />
                        </IconButton>
                        {onRequestDeleteSignal && (
                          <IconButton
                            onClick={() =>
                              onRequestDeleteSignal(
                                frame.id,
                                signal.index,
                                signal.parentPath,
                                signal.name
                              )
                            }
                            tone="danger"
                            title={t("nodeView.deleteSignal")}
                          >
                            <Trash2 className={`${iconMd} text-red`} />
                          </IconButton>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
