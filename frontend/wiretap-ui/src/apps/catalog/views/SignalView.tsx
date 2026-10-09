// ui/src/apps/catalog/views/SignalView.tsx

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { labelSmall, labelSmallMuted, monoBody, bgSurface } from "../../../styles";
import BitPreview from "../../../components/BitPreview";
import type { TomlNode } from "../types";
import type { Signal } from "../../../types/catalogModel";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { defaultByteOrder } from "../model";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type SignalViewProps = {
  selectedNode: TomlNode;

  // Actions
  onEditSignal: (idKey: string, signalIndex: number, signal: Signal, signalsParentPath?: string[]) => void;
  onRequestDeleteSignal: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;
};

/** The signal's catalogue keys, in the order the editor lists them. */
function signalProperties(signal: Signal): [string, unknown][] {
  const entries: [string, unknown][] = [
    ["name", signal.name],
    ["start_bit", signal.startBit],
    ["bit_length", signal.bitLength],
    ["signed", signal.signed],
    ["word_order", signal.wordOrder],
    ["factor", signal.factor],
    ["offset", signal.offset],
    ["unit", signal.unit],
    ["min", signal.min],
    ["max", signal.max],
    ["format", signal.format],
    ["enum", signal.enum],
    ["confidence", signal.confidence],
    ["display", signal.display],
    ["notes", signal.notes],
    ["modbus_register", signal.modbusRegister],
    ["modbus_register_count", signal.modbusRegisterCount],
  ];
  return entries.filter(([, value]) => value !== undefined);
}

export default function SignalView({
  selectedNode,
  onEditSignal,
  onRequestDeleteSignal,
}: SignalViewProps) {
  const { t } = useTranslation("catalog");
  const signal = selectedNode.metadata!.signal!;
  const signalIndex = selectedNode.metadata!.signalIndex!;
  const signalsParentPath = selectedNode.path.slice(0, -2);
  const idKey = selectedNode.path[2];
  const inheritedByteOrder = useCatalogEditorStore((s) => defaultByteOrder(s.tree.catalog, selectedNode.path[1]));
  const layout = useFrameLayout(selectedNode.path);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-primary">{t("signalDetails.title")}</h3>
        {!selectedNode.metadata?.inherited && <div className={flexRowGap2}>
          <IconButton
            onClick={() => onEditSignal(idKey, signalIndex, signal, signalsParentPath)}
            title={t("signalDetails.edit")}
          >
            <Pencil className={`${iconMd} text-secondary`} />
          </IconButton>

          <IconButton
            onClick={() => onRequestDeleteSignal(idKey, signalIndex, signalsParentPath, signal.name)}
            tone="danger"
            title={t("signalDetails.delete")}
          >
            <Trash2 className={`${iconMd} text-danger`} />
          </IconButton>
        </div>}
      </div>

      {layout && (
        <div className="p-4 bg-surface rounded-lg">
          <h4 className="text-sm font-semibold text-primary mb-3">{t("signalDetails.bitPreview")}</h4>
          <BitPreview
            numBytes={layout.byteLength}
            ranges={previewRanges(layout, true)}
            currentStartBit={signal.startBit ?? 0}
            currentBitLength={signal.bitLength ?? 0}
            showLegend={layout.ranges.length > 1}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {signalProperties(signal).map(([key, value]) => (
            <div key={key} className={`p-3 ${bgSurface} rounded-lg min-w-0`}>
              <div className={labelSmallMuted}>{key}</div>
              <div className={`${monoBody} break-all`}>
                {typeof value === "boolean"
                  ? value
                    ? "true"
                    : "false"
                  : typeof value === "number"
                    ? value
                    : typeof value === "string"
                      ? `"${value}"`
                      : JSON.stringify(value)}
              </div>
            </div>
          ))}

        {/* Byte Order - show inherited value if not explicitly set */}
        {(() => {
          const explicitByteOrder = signal.endianness;
          const effectiveByteOrder = explicitByteOrder || inheritedByteOrder;
          const isInherited = !explicitByteOrder && !!inheritedByteOrder;

          if (!effectiveByteOrder) return null;

          return (
            <div className={`p-3 ${bgSurface} rounded-lg min-w-0`}>
              <div className={`${flexRowGap2} mb-1`}>
                <span className={labelSmall}>{t("signalDetails.byteOrderLabel")}</span>
                {isInherited && (
                  <Badge tone="primary" size="sm">{t("signalDetails.inheritedBadge")}</Badge>
                )}
              </div>
              <div className={`${monoBody} break-all`}>
                "{effectiveByteOrder}"
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
