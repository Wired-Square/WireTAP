// ui/src/apps/catalog/views/MuxView.tsx

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary, sectionHeaderText, hoverLight } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import type { TomlNode } from "../types";
import { tomlParse } from "../toml";
import { getFrameByteLengthFromPath } from "../utils";

export type MuxViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;
  onAddCase: (muxPath: string[]) => void;
  onEditMux: (muxPath: string[], muxData: any) => void;
  onDeleteMux: (muxPath: string[]) => void;
  onSelectNode: (node: TomlNode) => void;
};

export default function MuxView({
  selectedNode,
  catalogContent,
  onAddCase,
  onEditMux,
  onDeleteMux,
  onSelectNode,
}: MuxViewProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const { ranges, numBytes } = React.useMemo(() => {
    const r: BitRange[] = [];
    let bytes = 8;
    try {
      const parsed = tomlParse(catalogContent) as any;
      const protocol = selectedNode.path[1];
      const frameKey = selectedNode.path[2];
      const frame = parsed?.frame?.[protocol]?.[frameKey];
      bytes = getFrameByteLengthFromPath(selectedNode.path, parsed);

      // Frame-level signals
      if (frame?.signals) {
        frame.signals.forEach((signal: any) => {
          r.push({
            name: signal.name || "Signal",
            start_bit: signal.start_bit || 0,
            bit_length: signal.bit_length || 8,
            type: "signal",
          });
        });
      }

      // Mux selector range
      if (frame?.mux) {
        r.push({
          name: frame.mux.name || "Mux",
          start_bit: frame.mux.start_bit || 0,
          bit_length: frame.mux.bit_length || 8,
          type: "mux",
        });
      }
    } catch {
      // fall back to defaults
    }
    return { ranges: r, numBytes: bytes };
  }, [catalogContent, selectedNode.path]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">Mux Selector</h3>
        <div className={flexRowGap2}>
          <button
            onClick={() => onAddCase(selectedNode.path)}
            className="px-2 py-1 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-medium"
          >
            + Case
          </button>

          <button
            onClick={() => onEditMux(selectedNode.path, selectedNode.metadata?.properties || {})}
            className={iconButtonHover}
            title="Edit mux"
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>

          {/* Pattern A delete */}
          <button
            onClick={() => setConfirmOpen(true)}
            className={iconButtonHoverDanger}
            title="Delete mux"
          >
            <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
          </button>
        </div>
      </div>

      <div className={`p-3 ${bgSecondary} rounded-lg`}>
        <div className={labelSmallMuted}>Name</div>
        <div className={monoBody}>
          {selectedNode.metadata?.muxName || "N/A"}
        </div>
      </div>

      {ranges.length > 0 && (
        <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
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
          />
        </div>
      )}

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

      {selectedNode.metadata?.muxDefaultCase && (
        <div className="p-3 bg-[var(--status-info-bg)] border-2 border-[color:var(--status-info-border)] rounded-lg">
          <div className="text-xs font-medium text-[color:var(--text-blue)] mb-1">Default Case</div>
          <div className="font-mono text-sm text-[color:var(--text-blue)]">
            {selectedNode.metadata.muxDefaultCase}
          </div>
        </div>
      )}

      {selectedNode.children && selectedNode.children.length > 0 && (
        <div>
          <div className={`${sectionHeaderText} mb-2`}>
            Cases ({selectedNode.children.length})
          </div>
          <div className="space-y-2">
            {selectedNode.children.map((caseNode, idx) => {
              const caseSignals = caseNode.metadata?.properties?.signals || [];
              return (
                <div
                  key={idx}
                  className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
                  onClick={() => onSelectNode(caseNode)}
                >
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
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDeleteDialog
        open={confirmOpen}
        title="Delete Mux"
        message="Are you sure you want to delete mux"
        highlightText={selectedNode.metadata?.muxName || undefined}
        confirmText="Delete"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onDeleteMux(selectedNode.path);
        }}
      />
    </div>
  );
}
