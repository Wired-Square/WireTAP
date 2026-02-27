// ui/src/apps/catalog/views/CANFrameView.tsx

import { useCallback, useMemo, useState } from "react";
import { Pencil, Trash2, Layers } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { caption, labelSmall, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary, hoverLight } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import type { TomlNode } from "../types";
import { tomlParse } from "../toml";
import { formatFrameId } from "../utils";

export type CANFrameViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;
  displayFrameIdFormat?: "hex" | "decimal";

  // Flags
  editingId: boolean;
  editingSignal: boolean;

  // Signal actions
  onAddSignal: (idKey: string) => void;
  onEditSignal: (idKey: string, signalIndex: number, signal: any, parentPath?: string[]) => void;
  onRequestDeleteSignal: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;

  // Mux actions
  onAddMux: (idKey: string) => void;
  onEditMux?: (muxPath: string[], muxData: any) => void;
  onDeleteMux?: (muxPath: string[]) => void;
  onAddCase?: (muxPath: string[]) => void;
  onSelectNode?: (node: TomlNode) => void;
};

export default function CANFrameView({
  selectedNode,
  catalogContent,
  editingId,
  editingSignal,
  onAddSignal,
  onEditSignal,
  onRequestDeleteSignal,
  onAddMux,
  onEditMux,
  onDeleteMux,
  onAddCase,
  onSelectNode,
  displayFrameIdFormat = "hex",
}: CANFrameViewProps) {
  const idKey = selectedNode.metadata?.idValue || selectedNode.key;
  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);
  const [confirmDeleteMux, setConfirmDeleteMux] = useState(false);
  const formattedId = formatFrameId(idKey, displayFrameIdFormat);
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

  // Parse mux data from TOML for display
  const muxData = useMemo(() => {
    try {
      const parsed = tomlParse(catalogContent) as any;
      return parsed?.frame?.can?.[idKey]?.mux || null;
    } catch {
      return null;
    }
  }, [catalogContent, idKey]);

  const muxLegendColor = useMemo(() => {
    if (!muxData) return undefined;
    return colorForRange({
      name: muxData.name || "Mux",
      start_bit: muxData.start_bit || 0,
      bit_length: muxData.bit_length || 8,
      type: "mux",
    });
  }, [muxData, colorForRange]);

  // Mux tree node from children (for case iteration)
  const muxNode = useMemo(
    () => selectedNode.children?.find((c) => c.type === "mux") || null,
    [selectedNode.children]
  );

  // Compute all bit ranges (base signals + mux selector) for BitPreview
  const { ranges, sortedSignals, numBytes } = useMemo(() => {
    const r: BitRange[] = [];
    const signals = selectedNode.metadata?.signals
      ? [...selectedNode.metadata.signals].sort((a: any, b: any) => (a.start_bit ?? 0) - (b.start_bit ?? 0))
      : [];

    signals.forEach((signal: any) => {
      r.push({
        name: signal.name || "Signal",
        start_bit: signal.start_bit || 0,
        bit_length: signal.bit_length || 8,
        type: "signal",
      });
    });

    if (muxData) {
      r.push({
        name: muxData.name || "Mux",
        start_bit: muxData.start_bit || 0,
        bit_length: muxData.bit_length || 8,
        type: "mux",
      });
    }

    return { ranges: r, sortedSignals: signals, numBytes: selectedNode.metadata?.length || 8 };
  }, [selectedNode.metadata?.signals, selectedNode.metadata?.length, muxData]);

  return (
    <div className="space-y-6">
      {/* Summary cards (non-edit only) */}
      {!editingId && (
        <div className="grid grid-cols-2 gap-4">
          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>ID</div>
            <div className={`${monoBody} flex items-center gap-2`}>
              <span>{formattedId.primary}</span>
              {formattedId.secondary && (
                <span className="text-[color:var(--text-muted)] text-xs">({formattedId.secondary})</span>
              )}
            </div>
          </div>

          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Length (DLC) <span className="text-red-500">*</span>
              {selectedNode.metadata?.lengthInherited && (
                <span className="ml-1 text-[color:var(--status-info-text)]" title="Inherited from copied ID">
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {selectedNode.metadata?.length || <span className="text-orange-500">Not set</span>}
            </div>
          </div>

          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Transmitter
              {selectedNode.metadata?.transmitterInherited && (
                <span className="ml-1 text-[color:var(--status-info-text)]" title="Inherited from copied ID">
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {selectedNode.metadata?.transmitter || <span className="text-[color:var(--text-muted)]">None</span>}
            </div>
          </div>

          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Interval
              {selectedNode.metadata?.intervalInherited && (
                <span
                  className="ml-1 text-[color:var(--status-info-text)]"
                  title="Inherited from copied ID or default_interval"
                >
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {selectedNode.metadata?.interval !== undefined ? (
                `${selectedNode.metadata.interval} ms`
              ) : (
                <span className="text-[color:var(--text-muted)]">None</span>
              )}
            </div>
          </div>

          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              Extended ID
              {selectedNode.metadata?.extendedInherited && (
                <span
                  className="ml-1 text-[color:var(--status-info-text)]"
                  title="Inherited from default_extended or auto-detected"
                >
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {selectedNode.metadata?.extended ? "Yes (29-bit)" : "No (11-bit)"}
            </div>
          </div>

          <div className={`p-4 ${bgSecondary} rounded-lg`}>
            <div className={labelSmallMuted}>
              CAN FD
              {selectedNode.metadata?.fdInherited && (
                <span
                  className="ml-1 text-[color:var(--status-info-text)]"
                  title="Inherited from default_fd"
                >
                  (inherited)
                </span>
              )}
            </div>
            <div className={monoBody}>
              {selectedNode.metadata?.fd ? "Yes" : "No (Classic)"}
            </div>
          </div>
        </div>
      )}

      {/* Notes card */}
      {!editingId && selectedNode.metadata?.notes && (
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={`${labelSmall} mb-2`}>
            Notes
          </div>
          <div className="text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap">
            {Array.isArray(selectedNode.metadata.notes)
              ? selectedNode.metadata.notes.join("\n")
              : selectedNode.metadata.notes}
          </div>
        </div>
      )}

      {/* Signals + Bit preview + Mux */}
      {!editingId && !editingSignal && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)] shrink-0">
              Signals ({(selectedNode.metadata?.signals?.length || 0) + (selectedNode.metadata?.muxSignalCount || 0)})
              {selectedNode.metadata?.hasMux && (
                <span className="ml-2 text-xs font-normal text-[color:var(--text-purple)] inline-flex items-center gap-2">
                  {muxLegendColor && <span className={`inline-block w-3 h-3 rounded ${muxLegendColor}`} />}
                  (includes {selectedNode.metadata.muxSignalCount} mux signals)
                </span>
              )}
            </h3>

            <div className="flex items-center gap-2 shrink-0">
              <span className={caption}>
                {selectedNode.metadata?.length ? `${selectedNode.metadata.length} bytes total` : ""}
              </span>

              {!selectedNode.metadata?.hasMux && (
                <button
                  onClick={() => onAddMux(idKey)}
                  className="px-2 py-1 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-medium"
                >
                  + Mux
                </button>
              )}

              {selectedNode.metadata?.hasMux && onAddCase && muxNode && (
                <button
                  onClick={() => onAddCase(muxNode.path)}
                  className="px-2 py-1 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-medium"
                >
                  + Case
                </button>
              )}

              <button
                onClick={() => onAddSignal(idKey)}
                className="px-2 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-xs font-medium"
              >
                + Signal
              </button>
            </div>
          </div>

          {/* BitPreview — renders when there are any ranges (base signals or mux selector) */}
          {ranges.length > 0 && (
            <div className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
              <div className="text-xs font-medium text-[color:var(--text-secondary)] mb-3">
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
          )}

          {/* Base signals list */}
          {sortedSignals.length > 0 && (
            <div className="space-y-2">
              {sortedSignals.map((signal: any, idx: number) => (
                <div
                  key={idx}
                  className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} transition-colors`}
                >
                  <div className="flex items-start justify-between min-w-0">
                    <div className="flex-1 min-w-0 flex gap-3">
                      <div
                        className={`w-2 h-6 rounded-sm mt-1 shrink-0 ${
                          signalColor(signal) || "bg-[var(--bg-surface)]"
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2 min-w-0">
                          <span className="shrink-0">⚡</span>
                          <span className="truncate">{signal.name}</span>
                          {signal._inherited && (
                            <span
                              className="text-xs text-[color:var(--accent-purple)] flex items-center gap-1"
                              title="Inherited from mirror primary"
                            >
                              <Layers className="w-3 h-3" />
                              <span>inherited</span>
                            </span>
                          )}
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
                          <div className="text-xs text-[color:var(--text-secondary)] mt-2 italic whitespace-pre-wrap">
                            {Array.isArray(signal.notes) ? signal.notes.join('\n') : signal.notes}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4 shrink-0">
                      <button
                        onClick={() => onEditSignal(idKey, idx, signal, ["frame", "can", idKey])}
                        className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors"
                        title="Edit signal"
                      >
                        <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
                      </button>

                      <button
                        onClick={() => onRequestDeleteSignal(idKey, idx, signal.name)}
                        className={iconButtonHoverDanger}
                        title="Delete signal"
                      >
                        <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Mux section — selector bubble + inline cases */}
          {selectedNode.metadata?.hasMux && muxData && (
            <div className="mt-4 space-y-3">
              {/* Mux selector bubble */}
              <div className="p-3 border-2 border-purple-500/30 bg-purple-500/5 rounded-lg">
                <div className="flex items-start justify-between min-w-0">
                  <div className="flex-1 min-w-0 flex gap-3">
                    <div
                      className={`w-2 h-6 rounded-sm mt-1 shrink-0 ${muxLegendColor || "bg-purple-500/30"}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2 min-w-0">
                        <span className="shrink-0">🔀</span>
                        <span className="truncate">{muxData.name || "Mux"}</span>
                      </div>
                      <div className={`${caption} mt-1`}>
                        Bits {muxData.start_bit ?? 0} - {(muxData.start_bit ?? 0) + (muxData.bit_length ?? 0) - 1} ({muxData.bit_length ?? 0} bits)
                        {muxData.default !== undefined && (
                          <span className="ml-2 text-[color:var(--text-blue)]">default: {muxData.default}</span>
                        )}
                      </div>
                      {muxData.notes && (
                        <div className="text-xs text-[color:var(--text-secondary)] mt-2 italic whitespace-pre-wrap">
                          {Array.isArray(muxData.notes) ? muxData.notes.join('\n') : muxData.notes}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    {onEditMux && (
                      <button
                        onClick={() => onEditMux(["frame", "can", idKey, "mux"], muxData)}
                        className={iconButtonHover}
                        title="Edit mux"
                      >
                        <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
                      </button>
                    )}
                    {onDeleteMux && (
                      <button
                        onClick={() => setConfirmDeleteMux(true)}
                        className={iconButtonHoverDanger}
                        title="Delete mux"
                      >
                        <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Mux cases */}
              {muxNode?.children && muxNode.children.length > 0 && (
                <div className="space-y-2 ml-4">
                  {muxNode.children.map((caseNode, idx) => {
                    const caseSignals = caseNode.metadata?.properties?.signals || [];
                    return (
                      <div
                        key={idx}
                        className={`p-3 ${bgSecondary} rounded-lg ${onSelectNode ? `${hoverLight} cursor-pointer` : ""} transition-colors`}
                        onClick={onSelectNode ? () => onSelectNode(caseNode) : undefined}
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <div className="min-w-0">
                            <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2 min-w-0">
                              <span className="shrink-0">📍</span>
                              <span className="truncate">{caseNode.key}</span>
                              <span className={caption}>
                                {caseSignals.length} signal{caseSignals.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            {caseSignals.length > 0 && (
                              <div className={`${caption} mt-1 ml-6 space-y-0.5`}>
                                {caseSignals.map((sig: any, sIdx: number) => (
                                  <div key={sIdx} className="truncate">
                                    ⚡ {sig.name || `Signal ${sIdx + 1}`}
                                    <span className="ml-1 text-[color:var(--text-muted)]">
                                      ({sig.start_bit ?? 0}:{sig.bit_length ?? 0})
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mux delete confirmation */}
      {onDeleteMux && (
        <ConfirmDeleteDialog
          open={confirmDeleteMux}
          title="Delete Mux"
          message="Are you sure you want to delete mux"
          highlightText={muxData?.name || undefined}
          confirmText="Delete"
          onCancel={() => setConfirmDeleteMux(false)}
          onConfirm={() => {
            setConfirmDeleteMux(false);
            onDeleteMux(["frame", "can", idKey, "mux"]);
          }}
        />
      )}
    </div>
  );
}
