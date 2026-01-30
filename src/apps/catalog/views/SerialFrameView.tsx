// ui/src/apps/catalog/views/SerialFrameView.tsx

import { useCallback, useMemo, useState } from "react";
import { Pencil, Settings, Trash2 } from "lucide-react";
import { iconMd, iconXs } from "../../../styles/spacing";
import { caption, labelSmall, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary, hoverLight } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import type { TomlNode } from "../types";
import { tomlParse } from "../toml";

export type SerialFrameViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;

  // Flags
  editingSignal?: boolean;

  // Frame actions
  onEditFrame?: (node: TomlNode) => void;
  onDeleteFrame?: (key: string) => void;
  onEditSerialConfig?: () => void;

  // Signal actions
  onAddSignal?: (idKey: string) => void;
  onEditSignal?: (idKey: string, signalIndex: number, signal: any, parentPath?: string[]) => void;
  onRequestDeleteSignal?: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;

  // Mux actions
  onAddMux?: (idKey: string) => void;
};

export default function SerialFrameView({
  selectedNode,
  catalogContent,
  editingSignal,
  onEditFrame,
  onDeleteFrame,
  onEditSerialConfig,
  onAddSignal,
  onEditSignal,
  onRequestDeleteSignal,
  onAddMux,
}: SerialFrameViewProps) {
  const encoding = selectedNode.metadata?.encoding;
  const frameId = selectedNode.metadata?.frameId ?? selectedNode.key;
  const idKey = selectedNode.key;
  const length = selectedNode.metadata?.length;
  const delimiter = selectedNode.metadata?.delimiter;
  const maxLength = selectedNode.metadata?.maxLength;
  const transmitter = selectedNode.metadata?.transmitter;
  const interval = selectedNode.metadata?.interval;
  const intervalInherited = selectedNode.metadata?.intervalInherited;
  const notes = selectedNode.metadata?.notes;

  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);

  const signalColor = useCallback(
    (signal: any) =>
      colorForRange({
        name: signal.name || "Signal",
        start_bit: signal.start_bit || 0,
        bit_length: signal.bit_length || 8,
        type: "signal",
      }),
    [colorForRange]
  );

  const muxLegendColor = useMemo(() => {
    try {
      const parsed = tomlParse(catalogContent) as any;
      const existingMux = parsed?.frame?.serial?.[idKey]?.mux;
      if (!existingMux) return undefined;
      return colorForRange({
        name: existingMux.name || "Mux",
        start_bit: existingMux.start_bit || 0,
        bit_length: existingMux.bit_length || 8,
        type: "mux",
      });
    } catch {
      return undefined;
    }
  }, [catalogContent, idKey, colorForRange]);

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-[color:var(--text-muted)]">Configure Serial frame properties</p>
          <div className="text-lg font-bold text-[color:var(--text-primary)]">
            {frameId}
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
            Frame ID
          </div>
          <div className={monoBody}>
            {frameId}
          </div>
        </div>

        <button
          onClick={onEditSerialConfig}
          className={`p-4 ${bgSecondary} rounded-lg text-left ${hoverLight} transition-colors group`}
          title="Edit serial encoding configuration"
        >
          <div className={`${labelSmallMuted} flex items-center gap-1`}>
            Encoding
            <Settings className={`${iconXs} opacity-0 group-hover:opacity-100 transition-opacity`} />
          </div>
          <div className={`${monoBody} uppercase`}>
            {encoding ?? <span className="text-orange-500">Not set - click to configure</span>}
          </div>
        </button>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Length
          </div>
          <div className={monoBody}>
            {length ?? <span className="text-slate-400">Not set</span>}
          </div>
        </div>

        {maxLength !== undefined && (
          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Max Length
            </div>
            <div className={monoBody}>
              {maxLength}
            </div>
          </div>
        )}

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

      {/* Delimiter (for raw encoding) */}
      {delimiter && delimiter.length > 0 && (
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Delimiter
          </div>
          <div className={monoBody}>
            [{delimiter.map((b: number) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`).join(", ")}]
          </div>
        </div>
      )}

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

      {/* Signals + Bit preview */}
      {!editingSignal && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
              Signals ({(selectedNode.metadata?.signals?.length || 0) + (selectedNode.metadata?.muxSignalCount || 0)})
              {selectedNode.metadata?.hasMux && (
                <span className="ml-2 text-xs font-normal text-[color:var(--text-purple)] inline-flex items-center gap-2">
                  {muxLegendColor && <span className={`inline-block w-3 h-3 rounded ${muxLegendColor}`} />}
                  (includes {selectedNode.metadata.muxSignalCount} mux signals)
                </span>
              )}
            </h3>

            <div className="flex items-center gap-3">
              <span className={caption}>
                {length ? `${length} bytes total` : ""}
              </span>

              {onAddMux && !selectedNode.metadata?.hasMux && (
                <button
                  onClick={() => onAddMux(idKey)}
                  className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-medium"
                >
                  + Add Mux
                </button>
              )}

              {onAddSignal && (
                <button
                  onClick={() => onAddSignal(idKey)}
                  className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-xs font-medium"
                >
                  + Add Signal
                </button>
              )}
            </div>
          </div>

          {selectedNode.metadata?.signals && selectedNode.metadata.signals.length > 0 &&
            (() => {
              const signals = [...selectedNode.metadata.signals].sort(
                (a, b) => (a.start_bit ?? 0) - (b.start_bit ?? 0)
              );

              const ranges: BitRange[] = [];
              signals.forEach((signal: any) => {
                ranges.push({
                  name: signal.name || "Signal",
                  start_bit: signal.start_bit || 0,
                  bit_length: signal.bit_length || 8,
                  type: "signal",
                });
              });

              // mux selector range
              try {
                const parsed = tomlParse(catalogContent) as any;
                const existingMux = parsed?.frame?.serial?.[idKey]?.mux;
                if (existingMux) {
                  ranges.push({
                    name: existingMux.name || "Mux",
                    start_bit: existingMux.start_bit || 0,
                    bit_length: existingMux.bit_length || 8,
                    type: "mux",
                  });
                }
              } catch {
                // ignore parse errors: view should still render signals list
              }

              const numBytes = length || 8;

              return (
                <>
                  <div className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
                    <div className="text-xs font-medium text-[color:var(--text-muted)] mb-3">
                      Byte Layout (LSB first)
                    </div>
                    <BitPreview
                      numBytes={numBytes}
                      ranges={ranges}
                      currentStartBit={0}
                      currentBitLength={0}
                      interactive={false}
                      showLegend={false}
                      onColorMapping={(lookup) => setColorForRange(() => lookup)}
                    />
                  </div>

                  <div className="space-y-2">
                    {signals.map((signal: any, idx: number) => (
                      <div
                        key={idx}
                        className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} transition-colors`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 flex gap-3">
                            <div
                              className={`w-2 h-6 rounded-sm mt-1 ${
                                signalColor(signal) || "bg-[var(--border-default)]"
                              }`}
                            />
                            <div>
                              <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2">
                                <span>⚡</span>
                                {signal.name}
                              </div>

                              <div className={`${caption} mt-1 space-y-0.5`}>
                                <div>
                                  Bits {signal.start_bit ?? 0} - {(signal.start_bit ?? 0) + (signal.bit_length ?? 0) - 1} ({signal.bit_length ?? 0} bits)
                                </div>
                                {signal.unit && <div>Unit: {signal.unit}</div>}
                                {signal.factor !== undefined && <div>Factor: {signal.factor}</div>}
                                {signal.offset !== undefined && <div>Offset: {signal.offset}</div>}
                              </div>
                              {signal.notes && (
                                <div className="text-xs text-[color:var(--text-muted)] mt-2 italic whitespace-pre-wrap">
                                  {Array.isArray(signal.notes) ? signal.notes.join('\n') : signal.notes}
                                </div>
                              )}
                            </div>
                          </div>

                          {(onEditSignal || onRequestDeleteSignal) && (
                            <div className="flex items-center gap-2 ml-4">
                              {onEditSignal && (
                                <button
                                  onClick={() => onEditSignal(idKey, idx, signal, ["frame", "serial", idKey])}
                                  className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors"
                                  title="Edit signal"
                                >
                                  <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
                                </button>
                              )}

                              {onRequestDeleteSignal && (
                                <button
                                  onClick={() => onRequestDeleteSignal(idKey, idx, ["frame", "serial", idKey], signal.name)}
                                  className={iconButtonHoverDanger}
                                  title="Delete signal"
                                >
                                  <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

          {(!selectedNode.metadata?.signals || selectedNode.metadata.signals.length === 0) && (
            <div className={`text-sm text-[color:var(--text-muted)] p-4 ${bgSecondary} rounded-lg`}>
              No signals defined. Click "+ Add Signal" to create one.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
