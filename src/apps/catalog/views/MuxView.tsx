// ui/src/apps/catalog/views/MuxView.tsx

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary, sectionHeaderText, hoverLight } from "../../../styles";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import type { TomlNode } from "../types";

export type MuxViewProps = {
  selectedNode: TomlNode;
  onAddCase: (muxPath: string[]) => void;
  onEditMux: (muxPath: string[], muxData: any) => void;
  onDeleteMux: (muxPath: string[]) => void;
  onSelectNode: (node: TomlNode) => void;
};

export default function MuxView({
  selectedNode,
  onAddCase,
  onEditMux,
  onDeleteMux,
  onSelectNode,
}: MuxViewProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">Mux Selector</h3>
        <div className={flexRowGap2}>
          <button
            onClick={() => onAddCase(selectedNode.path)}
            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-xs font-medium"
          >
            + Add Case
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

      <div className="grid grid-cols-3 gap-4">
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Name</div>
          <div className={monoBody}>
            {selectedNode.metadata?.muxName || "N/A"}
          </div>
        </div>
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Start Bit</div>
          <div className={monoBody}>
            {selectedNode.metadata?.muxStartBit ?? "N/A"}
          </div>
        </div>
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Bit Length</div>
          <div className={monoBody}>
            {selectedNode.metadata?.muxBitLength ?? "N/A"}
          </div>
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
            {selectedNode.children.map((caseNode, idx) => (
              <div
                key={idx}
                className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
                onClick={() => onSelectNode(caseNode)}
              >
                <div className="font-medium text-[color:var(--text-primary)]">{caseNode.key}</div>
              </div>
            ))}
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
