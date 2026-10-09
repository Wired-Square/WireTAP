// ui/src/apps/catalog/views/MuxCaseView.tsx

import React from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, bgSurface, sectionHeaderText, hoverLight, emptyStateText } from "../../../styles";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import { useState } from "react";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import { signalRange } from "./signalRanges";
import type { TomlNode } from "../types";
import { Button, IconButton } from "../../../components/Button";

export type MuxCaseViewProps = {
  selectedNode: TomlNode;

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
  onAddSignal,
  onAddNestedMux,
  onEditCase,
  onDeleteCase,
  onRequestDeleteSignal,
  onSelectNode,
}: MuxCaseViewProps) {
  const { t } = useTranslation("catalog");
  const caseValue = selectedNode.metadata?.caseValue;
  const muxCase = selectedNode.metadata!.muxCase!;
  const editable = !selectedNode.metadata?.inherited;
  const idKey = selectedNode.path[2];

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ muxPath: string[]; caseKey: string } | null>(null);
  const nonSignalChildren = React.useMemo(
    () => (selectedNode.children || []).filter((child) => child.type !== "signal"),
    [selectedNode.children]
  );
  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);

  const layout = useFrameLayout(selectedNode.path);
  const ranges = previewRanges(layout);
  const caseSignals = muxCase.signals;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-primary">
          {t("muxCaseView.titlePrefix", { value: caseValue })}
        </h3>

        {editable && <div className={flexRowGap2}>
          <Button
            onClick={() => onAddSignal(idKey, selectedNode.path)}
            variant="solid"
            tone="success"
            size="sm"
            title={t("muxCaseView.addSignalTooltip")}
          >
            {t("muxCaseView.addSignal")}
          </Button>

          <Button
            onClick={() => onAddNestedMux(selectedNode.path)}
            variant="solid"
            tone="purple"
            size="sm"
            title={t("muxCaseView.addNestedMuxTooltip")}
          >
            {t("muxCaseView.addNestedMux")}
          </Button>

          {onEditCase && (
            <IconButton
              onClick={() => {
                onEditCase(selectedNode.path.slice(0, -1), caseValue || '', muxCase.notes?.join("\n"));
              }}
              title={t("muxCaseView.editCase")}
            >
              <Pencil className={`${iconMd} text-secondary`} />
            </IconButton>
          )}

          <IconButton
            onClick={() => {
              const muxPath = selectedNode.path.slice(0, -1);
              const caseKey = selectedNode.path[selectedNode.path.length - 1];
              setPendingDelete({ muxPath, caseKey });
              setConfirmOpen(true);
            }}
            tone="danger"
            title={t("muxCaseView.deleteCase")}
          >
            <Trash2 className={`${iconMd} text-danger`} />
          </IconButton>
        </div>}
      </div>

      {muxCase.notes && (
        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("muxCaseView.notes")}</div>
          <div className="text-sm text-secondary whitespace-pre-wrap">
            {muxCase.notes.join("\n")}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {layout && (
          <div className="p-4 bg-surface rounded-lg">
            <div className="text-xs font-medium text-muted mb-2">
              {t("muxCaseView.bitLayoutTitle")}
            </div>
            <BitPreview
              numBytes={layout.byteLength}
              ranges={ranges}
              showLegend={false}
              onColorMapping={(lookup) => setColorForRange(() => lookup)}
            />
          </div>
        )}

        <div>
          <div className={`${sectionHeaderText} mb-2`}>
            {t("muxCaseView.signalsHeader", { count: caseSignals.length })}
          </div>
          {caseSignals.length === 0 ? (
            <div className={emptyStateText}>{t("muxCaseView.noSignals")}</div>
          ) : (
            <div className="space-y-2">
              {caseSignals.map((signal, idx) => (
                <div
                  key={`${signal.name || "signal"}-${idx}`}
                  className={`p-3 ${bgSurface} rounded-lg flex items-center justify-between`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-8 rounded-sm ${
                        colorForRange(signalRange(signal)) || "bg-surface"
                      }`}
                    />
                    <div>
                      <div className="font-medium text-primary flex items-center gap-2">
                        <span>⚡</span>
                        {signal.name || t("muxCaseView.signalDefault", { idx: idx + 1 })}
                      </div>
                      <div className={`${caption} mt-1`}>
                        {t("muxCaseView.bitsRange", {
                          start: signal.startBit ?? 0,
                          end: (signal.startBit ?? 0) + (signal.bitLength ?? 0) - 1,
                          length: signal.bitLength ?? 0,
                        })}
                      </div>
                      {signal.notes && (
                        <div className="text-xs text-muted mt-2 italic whitespace-pre-wrap">
                          {signal.notes.join("\n")}
                        </div>
                      )}
                    </div>
                  </div>

                  {onRequestDeleteSignal && editable && (
                    <IconButton
                      onClick={() =>
                        onRequestDeleteSignal(
                          idKey,
                          idx,
                          selectedNode.path,
                          signal.name
                        )
                      }
                      tone="danger"
                      title={t("muxCaseView.deleteSignal")}
                    >
                      <Trash2 className={`${iconMd} text-danger`} />
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {nonSignalChildren.length > 0 && (
          <div>
            <div className={`${sectionHeaderText} mb-2`}>
              {t("muxCaseView.otherContents", { count: nonSignalChildren.length })}
            </div>
            <div className="space-y-2">
              {nonSignalChildren.map((child, idx) => (
                <div
                  key={idx}
                  className={`p-3 ${bgSurface} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
                  onClick={() => onSelectNode(child)}
                >
                  <div className="font-medium text-primary flex items-center gap-2">
                    {child.type === "signal" && <span>⚡</span>}
                    {child.type === "mux" && <span>🔀</span>}
                    {child.key}
                  </div>


                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ConfirmDeleteDialog
        open={confirmOpen}
        title={t("muxCaseView.deleteCaseTitle")}
        message={t("muxCaseView.deleteCaseMessage")}
        highlightText={caseValue || undefined}
        confirmText={t("muxCaseView.deleteLabel")}
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
