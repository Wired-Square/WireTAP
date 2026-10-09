// ui/src/apps/catalog/views/SerialFrameView.tsx

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Settings, Trash2 } from "lucide-react";
import { iconMd, iconXs } from "../../../styles/spacing";
import { caption, labelSmall, labelSmallMuted, monoBody, bgSurface, hoverLight, emptyStateText } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import type { TomlNode } from "../types";
import type { Signal } from "../../../types/catalogModel";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import { muxSignalCount, selectorRange, signalRange } from "./signalRanges";
import { Button, IconButton } from "../../../components/Button";

export type SerialFrameViewProps = {
  selectedNode: TomlNode;

  // Flags
  editingSignal?: boolean;

  // Frame actions
  onEditFrame?: (node: TomlNode) => void;
  onDeleteFrame?: (key: string) => void;
  onEditSerialConfig?: () => void;

  // Signal actions
  onAddSignal?: (idKey: string) => void;
  onEditSignal?: (idKey: string, signalIndex: number, signal: Signal, parentPath?: string[]) => void;
  onRequestDeleteSignal?: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;

  // Mux actions
  onAddMux?: (ownerPath: string[]) => void;
};

export default function SerialFrameView({
  selectedNode,
  editingSignal,
  onEditFrame,
  onDeleteFrame,
  onEditSerialConfig,
  onAddSignal,
  onEditSignal,
  onRequestDeleteSignal,
  onAddMux,
}: SerialFrameViewProps) {
  const { t } = useTranslation("catalog");
  const frame = selectedNode.metadata!.frame!;
  const encoding = useCatalogEditorStore((s) => s.tree.catalog?.serial?.encoding);
  const idKey = frame.key;
  const { length, delimiter, transmitter, interval, mux } = frame;
  const intervalInherited = frame.inheritedFields?.includes("interval");
  const notes = frame.notes ?? [];
  const muxSignals = mux ? muxSignalCount(mux) : 0;
  const layout = useFrameLayout(selectedNode.path);
  const ranges = previewRanges(layout);
  const signals = useMemo(
    () => frame.signals.map((signal, index) => ({ signal, index })).sort((a, b) => (a.signal.startBit ?? 0) - (b.signal.startBit ?? 0)),
    [frame.signals]
  );

  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);
  const signalColor = useCallback((signal: Signal) => colorForRange(signalRange(signal)), [colorForRange]);
  const muxLegendColor = useMemo(
    () => (mux ? colorForRange(selectorRange(mux)) : undefined),
    [mux, colorForRange]
  );

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted">{t("serialFrame.subtitle")}</p>
          <div className="text-lg font-bold text-primary">
            {idKey}
          </div>
        </div>
        {(onEditFrame || onDeleteFrame) && (
          <div className="flex gap-2">
            {onEditFrame && (
              <IconButton
                onClick={() => onEditFrame(selectedNode)}
                title={t("serialFrame.editFrame")}
              >
                <Pencil className={`${iconMd} text-secondary`} />
              </IconButton>
            )}
            {onDeleteFrame && (
              <IconButton
                onClick={() => onDeleteFrame(selectedNode.key)}
                tone="danger"
                title={t("serialFrame.deleteFrame")}
              >
                <Trash2 className={`${iconMd} text-red`} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("serialFrame.frameId")}
          </div>
          <div className={monoBody}>
            {idKey}
          </div>
        </div>

        <button
          onClick={onEditSerialConfig}
          className={`p-4 ${bgSurface} rounded-lg text-left ${hoverLight} transition-colors group`}
          title={t("serialFrame.editEncoding")}
        >
          <div className={`${labelSmallMuted} flex items-center gap-1`}>
            {t("serialFrame.encoding")}
            <Settings className={`${iconXs} opacity-0 group-hover:opacity-100 transition-opacity`} />
          </div>
          <div className={`${monoBody} uppercase`}>
            {encoding ?? <span className="text-warning">{t("serialFrame.encodingNotSet")}</span>}
          </div>
        </button>

        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("serialFrame.length")}
          </div>
          <div className={monoBody}>
            {length || <span className="text-muted">{t("serialFrame.lengthNotSet")}</span>}
          </div>
        </div>

        {transmitter && (
          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("serialFrame.transmitter")}
            </div>
            <div className={monoBody}>
              {transmitter}
            </div>
          </div>
        )}

        {interval !== undefined && (
          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("serialFrame.interval")}
              {intervalInherited && (
                <span className="ml-1 text-blue" title={t("serialFrame.intervalInheritedTooltip")}>
                  {t("serialFrame.intervalInheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {t("serialFrame.intervalMs", { ms: interval })}
            </div>
          </div>
        )}
      </div>

      {/* Delimiter (for raw encoding) */}
      {delimiter && delimiter.length > 0 && (
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("serialFrame.delimiter")}
          </div>
          <div className={monoBody}>
            [{delimiter.map((b: number) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`).join(", ")}]
          </div>
        </div>
      )}

      {/* Notes */}
      {notes.length > 0 && (
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={`${labelSmall} mb-2`}>
            {t("serialFrame.notes")}
          </div>
          <div className="text-sm text-secondary whitespace-pre-wrap">
            {notes.join("\n")}
          </div>
        </div>
      )}

      {/* Signals + Bit preview */}
      {!editingSignal && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-primary">
              {t("serialFrame.signalsHeader", { count: frame.signals.length + muxSignals })}
              {mux && (
                <span className="ml-2 text-xs font-normal text-purple inline-flex items-center gap-2">
                  {muxLegendColor && <span className={`inline-block w-3 h-3 rounded ${muxLegendColor}`} />}
                  {t("serialFrame.muxSignalsHint", { count: muxSignals })}
                </span>
              )}
            </h3>

            <div className="flex items-center gap-3">
              <span className={caption}>
                {length ? t("serialFrame.totalBytes", { count: length }) : ""}
              </span>

              {onAddMux && !mux && (
                <Button
                  onClick={() => onAddMux(selectedNode.path)}
                  variant="solid"
                  tone="purple"
                  size="sm"
                >
                  {t("serialFrame.addMux")}
                </Button>
              )}

              {onAddSignal && (
                <Button
                  onClick={() => onAddSignal(idKey)}
                  variant="solid"
                  tone="success"
                  size="sm"
                >
                  {t("serialFrame.addSignal")}
                </Button>
              )}
            </div>
          </div>

          {layout && ranges.length > 0 && (
            <div className="mb-4 p-4 bg-surface rounded-lg">
              <div className="text-xs font-medium text-muted mb-3">
                {t("serialFrame.byteLayout")}
              </div>
              <BitPreview
                numBytes={layout.byteLength || 8}
                ranges={ranges}
                currentStartBit={0}
                currentBitLength={0}
                interactive={false}
                showLegend={false}
                onColorMapping={(lookup) => setColorForRange(() => lookup)}
              />
            </div>
          )}

          {signals.length > 0 && (
                  <div className="space-y-2">
                    {signals.map(({ signal, index }) => (
                      <div
                        key={index}
                        className={`p-3 ${bgSurface} rounded-lg ${hoverLight} transition-colors`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 flex gap-3">
                            <div
                              className={`w-2 h-6 rounded-sm mt-1 ${
                                signalColor(signal) || "bg-border-default"
                              }`}
                            />
                            <div>
                              <div className="font-medium text-primary flex items-center gap-2">
                                <span>⚡</span>
                                {signal.name}
                              </div>

                              <div className={`${caption} mt-1 space-y-0.5`}>
                                <div>
                                  {t("serialFrame.bitsRange", {
                                    start: signal.startBit ?? 0,
                                    end: (signal.startBit ?? 0) + (signal.bitLength ?? 0) - 1,
                                    length: signal.bitLength ?? 0,
                                  })}
                                </div>
                                {signal.unit && <div>{t("serialFrame.unit", { unit: signal.unit })}</div>}
                                {signal.factor !== undefined && <div>{t("serialFrame.factor", { factor: signal.factor })}</div>}
                                {signal.offset !== undefined && <div>{t("serialFrame.offset", { offset: signal.offset })}</div>}
                              </div>
                              {signal.notes && (
                                <div className="text-xs text-muted mt-2 italic whitespace-pre-wrap">
                                  {signal.notes.join("\n")}
                                </div>
                              )}
                            </div>
                          </div>

                          {(onEditSignal || onRequestDeleteSignal) && (
                            <div className="flex items-center gap-2 ml-4">
                              {onEditSignal && (
                                <IconButton
                                  onClick={() => onEditSignal(idKey, index, signal, selectedNode.path)}
                                  title={t("serialFrame.editSignal")}
                                >
                                  <Pencil className={`${iconMd} text-secondary`} />
                                </IconButton>
                              )}

                              {onRequestDeleteSignal && (
                                <IconButton
                                  onClick={() => onRequestDeleteSignal(idKey, index, selectedNode.path, signal.name)}
                                  tone="danger"
                                  title={t("serialFrame.deleteSignal")}
                                >
                                  <Trash2 className={`${iconMd} text-red`} />
                                </IconButton>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
          )}

          {signals.length === 0 && (
            <div className={`${emptyStateText} p-4 ${bgSurface} rounded-lg`}>
              {t("serialFrame.noSignalsHint")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
