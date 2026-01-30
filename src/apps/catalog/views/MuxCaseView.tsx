// ui/src/apps/catalog/views/MuxCaseView.tsx

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, iconButtonHover, iconButtonHoverDanger, bgSecondary, sectionHeaderText, hoverLight } from "../../../styles";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import { tomlParse } from "../toml";
import { extractMuxRangesFromPath, getFrameByteLengthFromPath } from "../utils";
import { useState } from "react";
import type { TomlNode } from "../types";

export type MuxCaseViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;

  onAddSignal: (idKey: string, signalPath: string[]) => void;
  onAddNestedMux: (muxCasePath: string[]) => void;

  // Edit the case value and notes
  onEditCase?: (muxPath: string[], caseValue: string, caseNotes?: string) => void;

  // Delete the case (MuxCaseView owns confirmation)
  onDeleteCase: (muxPath: string[], caseKey: string) => void;

  // Delete a signal within this case
  onRequestDeleteSignal?: (idKey: string, signalIndex: number, signalsParentPath: string[], signalName?: string) => void;

  onSelectNode: (node: TomlNode) => void;
};

export default function MuxCaseView({
  selectedNode,
  catalogContent,
  onAddSignal,
  onAddNestedMux,
  onEditCase,
  onDeleteCase,
  onRequestDeleteSignal,
  onSelectNode,
}: MuxCaseViewProps) {
  const caseValue = selectedNode.metadata?.caseValue;
  const idKey = selectedNode.path[2];

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ muxPath: string[]; caseKey: string } | null>(null);
  const nonSignalChildren = React.useMemo(
    () => (selectedNode.children || []).filter((child) => child.type !== "signal"),
    [selectedNode.children]
  );
  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);

  const { ranges, caseSignals, numBytes } = React.useMemo(() => {
    const next: BitRange[] = [];
    const signals: any[] = [];
    let bytes = selectedNode.metadata?.length || 8;

    try {
      const parsed = tomlParse(catalogContent) as any;
      const protocol = selectedNode.path[1];
      const frameKey = selectedNode.path[2];
      const frame = parsed?.frame?.[protocol]?.[frameKey];

      // Get frame byte length (handles CAN, Modbus, Serial)
      bytes = getFrameByteLengthFromPath(selectedNode.path, parsed);

      // Extract all mux ranges from the path hierarchy (handles nested muxes)
      const muxRanges = extractMuxRangesFromPath(selectedNode.path, parsed);
      next.push(...muxRanges);

      // Add frame-level signals
      if (frame?.signals) {
        frame.signals.forEach((signal: any) => {
          next.push({
            name: signal.name || "Signal",
            start_bit: signal.start_bit || 0,
            bit_length: signal.bit_length || 8,
            type: "signal",
          });
        });
      }

      // Traverse path to get signals from this mux case and parent cases
      let currentObj = frame;
      for (let i = 3; i < selectedNode.path.length; i++) {
        const segment = selectedNode.path[i];
        if (segment === "mux") {
          currentObj = currentObj?.mux;
          i++;
          if (i < selectedNode.path.length && currentObj) {
            const caseKey = selectedNode.path[i];
            const caseObj = currentObj[caseKey] || currentObj.cases?.[caseKey];
            if (caseObj) {
              const caseSignalsArr = caseObj.signals || [];
              // Check if this is the current mux case level (last case in path)
              const isCurrentLevel = i === selectedNode.path.length - 1;
              caseSignalsArr.forEach((signal: any) => {
                if (isCurrentLevel) {
                  signals.push(signal);
                }
                next.push({
                  name: signal.name || "Signal",
                  start_bit: signal.start_bit || 0,
                  bit_length: signal.bit_length || 8,
                  type: "signal",
                });
              });
              currentObj = caseObj;
            }
          }
        }
      }
    } catch {
      // ignore parse errors; fall back to defaults
    }

    return { ranges: next, caseSignals: signals, numBytes: bytes };
  }, [catalogContent, caseValue, idKey, selectedNode.path, selectedNode.metadata?.length]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">
          Mux Case: {caseValue}
        </h3>

        <div className={flexRowGap2}>
          <button
            onClick={() => {
              const idKey = selectedNode.path[2];
              onAddSignal(idKey, selectedNode.path);
            }}
            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-xs font-medium"
            title="Add signal"
          >
            + Add Signal
          </button>

          <button
            onClick={() => onAddNestedMux(selectedNode.path)}
            className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-medium"
            title="Add nested mux"
          >
            + Add Nested Mux
          </button>

          {onEditCase && (
            <button
              onClick={() => {
                const muxPath = selectedNode.path.slice(0, -1);
                const caseNotes = selectedNode.metadata?.properties?.notes;
                const notesStr = caseNotes
                  ? (Array.isArray(caseNotes) ? caseNotes.join('\n') : caseNotes)
                  : undefined;
                onEditCase(muxPath, caseValue || '', notesStr);
              }}
              className={iconButtonHover}
              title="Edit case"
            >
              <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
            </button>
          )}

          <button
            onClick={() => {
              const muxPath = selectedNode.path.slice(0, -1);
              const caseKey = selectedNode.path[selectedNode.path.length - 1];
              setPendingDelete({ muxPath, caseKey });
              setConfirmOpen(true);
            }}
            className={iconButtonHoverDanger}
            title="Delete case"
          >
            <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
          </button>
        </div>
      </div>

      {selectedNode.metadata?.properties?.notes && (
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Notes</div>
          <div className="text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap">
            {Array.isArray(selectedNode.metadata.properties.notes)
              ? selectedNode.metadata.properties.notes.join("\n")
              : selectedNode.metadata.properties.notes}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
          <div className="text-xs font-medium text-[color:var(--text-muted)] mb-2">
            Bit Layout (includes frame signals and this case)
          </div>
          <BitPreview
            numBytes={numBytes}
            ranges={ranges}
            showLegend={false}
            onColorMapping={(lookup) => setColorForRange(() => lookup)}
          />
        </div>

        <div>
          <div className={`${sectionHeaderText} mb-2`}>
            Signals ({caseSignals.length})
          </div>
          {caseSignals.length === 0 ? (
            <div className="text-sm text-[color:var(--text-muted)]">No signals in this case yet.</div>
          ) : (
            <div className="space-y-2">
              {caseSignals.map((signal: any, idx: number) => (
                <div
                  key={`${signal.name || "signal"}-${idx}`}
                  className={`p-3 ${bgSecondary} rounded-lg flex items-center justify-between`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-8 rounded-sm ${
                        colorForRange({
                          name: signal.name || `Signal ${idx + 1}`,
                          start_bit: signal.start_bit || 0,
                          bit_length: signal.bit_length || 8,
                          type: "signal",
                        }) || "bg-[var(--bg-surface)]"
                      }`}
                    />
                    <div>
                      <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2">
                        <span>⚡</span>
                        {signal.name || `Signal ${idx + 1}`}
                      </div>
                      <div className={`${caption} mt-1`}>
                        Bits {signal.start_bit ?? 0} - {(signal.start_bit ?? 0) + (signal.bit_length ?? 0) - 1} ({signal.bit_length ?? 0} bits)
                      </div>
                      {signal.notes && (
                        <div className="text-xs text-[color:var(--text-muted)] mt-2 italic whitespace-pre-wrap">
                          {Array.isArray(signal.notes) ? signal.notes.join('\n') : signal.notes}
                        </div>
                      )}
                    </div>
                  </div>

                  {onRequestDeleteSignal && (
                    <button
                      onClick={() =>
                        onRequestDeleteSignal(
                          idKey,
                          idx,
                          selectedNode.path,
                          signal.name
                        )
                      }
                      className={iconButtonHoverDanger}
                      title="Delete signal"
                    >
                      <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {nonSignalChildren.length > 0 && (
          <div>
            <div className={`${sectionHeaderText} mb-2`}>
              Other Contents ({nonSignalChildren.length})
            </div>
            <div className="space-y-2">
              {nonSignalChildren.map((child, idx) => (
                <div
                  key={idx}
                  className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
                  onClick={() => onSelectNode(child)}
                >
                  <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2">
                    {child.type === "signal" && <span>⚡</span>}
                    {child.type === "mux" && <span>🔀</span>}
                    {child.key}
                  </div>

                  {child.type === "signal" && child.metadata?.properties && (
                    <div className={`${caption} mt-1`}>
                      Bits {child.metadata.properties.start_bit ?? 0} -
                      {(child.metadata.properties.start_bit ?? 0) + (child.metadata.properties.bit_length ?? 0) - 1}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ConfirmDeleteDialog
        open={confirmOpen}
        title="Delete Mux Case"
        message="Are you sure you want to delete mux case"
        highlightText={caseValue || undefined}
        confirmText="Delete"
        onCancel={() => {
          setConfirmOpen(false);
          setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) {
            onDeleteCase(pendingDelete.muxPath, pendingDelete.caseKey);
          }
          setConfirmOpen(false);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
