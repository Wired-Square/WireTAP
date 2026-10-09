// ui/src/apps/catalog/views/MuxView.tsx

import React from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, bgSurface, sectionHeaderText, hoverLight } from "../../../styles";
import BitPreview from "../../../components/BitPreview";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import type { TomlNode } from "../types";
import type { Mux } from "../../../types/catalogModel";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
export type MuxViewProps = {
  selectedNode: TomlNode;
  onAddCase: (muxPath: string[]) => void;
  onEditMux: (muxPath: string[], mux: Mux) => void;
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
  const { t } = useTranslation("catalog");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const mux = selectedNode.metadata!.mux!;
  const editable = !selectedNode.metadata?.inherited;
  const layout = useFrameLayout(selectedNode.path);
  const ranges = previewRanges(layout);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-primary">{t("muxView.title")}</h3>
        {editable && <div className={flexRowGap2}>
          <Button
            onClick={() => onAddCase(selectedNode.path)}
            variant="solid"
            tone="purple"
            size="sm"
          >
            {t("muxView.addCase")}
          </Button>

          <IconButton
            onClick={() => onEditMux(selectedNode.path, mux)}
            title={t("muxView.editMux")}
          >
            <Pencil className={`${iconMd} text-secondary`} />
          </IconButton>

          {/* Pattern A delete */}
          <IconButton
            onClick={() => setConfirmOpen(true)}
            tone="danger"
            title={t("muxView.deleteMux")}
          >
            <Trash2 className={`${iconMd} text-danger`} />
          </IconButton>
        </div>}
      </div>

      <div className={`p-3 ${bgSurface} rounded-lg`}>
        <div className={labelSmallMuted}>{t("muxView.name")}</div>
        <div className={monoBody}>
          {mux.name || t("muxView.nameNa")}
        </div>
      </div>

      {layout && ranges.length > 0 && (
        <div className="p-4 bg-surface rounded-lg">
          <div className="text-xs font-medium text-secondary mb-3">
            {t("muxView.byteLayout")}
          </div>
          <BitPreview
            numBytes={layout.byteLength}
            ranges={ranges}
            currentStartBit={0}
            currentBitLength={0}
            interactive={false}
            showLegend={false}
          />
        </div>
      )}

      {mux.notes && (
        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("muxView.notes")}</div>
          <div className="text-sm text-secondary whitespace-pre-wrap">
            {mux.notes.join("\n")}
          </div>
        </div>
      )}

      {mux.default && (
        <Card tone="info">
          <div className="text-xs font-medium text-info mb-1">{t("muxView.defaultCase")}</div>
          <div className="font-mono text-sm text-info">
            {mux.default}
          </div>
        </Card>
      )}

      {selectedNode.children && selectedNode.children.length > 0 && (
        <div>
          <div className={`${sectionHeaderText} mb-2`}>
            {t("muxView.casesHeader", { count: selectedNode.children.length })}
          </div>
          <div className="space-y-2">
            {selectedNode.children.map((caseNode, idx) => {
              const caseSignals = caseNode.metadata?.muxCase?.signals ?? [];
              return (
                <div
                  key={idx}
                  className={`p-3 ${bgSurface} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
                  onClick={() => onSelectNode(caseNode)}
                >
                  <div className="font-medium text-primary flex items-center gap-2 min-w-0">
                    <span className="shrink-0">📍</span>
                    <span className="truncate">{caseNode.key}</span>
                    <span className={caption}>
                      {t("muxView.signalsCount", { count: caseSignals.length })}
                    </span>
                  </div>
                  {caseSignals.length > 0 && (
                    <div className={`${caption} mt-1 ml-6 space-y-0.5`}>
                      {caseSignals.map((sig, sIdx) => (
                        <div key={sIdx} className="truncate">
                          ⚡ {sig.name || t("muxView.signalDefault", { idx: sIdx + 1 })}
                          <span className="ml-1 text-muted">
                            ({sig.startBit ?? 0}:{sig.bitLength ?? 0})
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
        title={t("muxView.deleteMuxTitle")}
        message={t("muxView.deleteMuxMessage")}
        highlightText={mux.name || undefined}
        confirmText={t("muxView.deleteLabel")}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onDeleteMux(selectedNode.path);
        }}
      />
    </div>
  );
}
