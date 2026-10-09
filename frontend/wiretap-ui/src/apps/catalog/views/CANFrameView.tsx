// ui/src/apps/catalog/views/CANFrameView.tsx

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Layers } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { caption, labelSmall, labelSmallMuted, monoBody, bgSurface, hoverLight } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import type { TomlNode } from "../types";
import type { Mux, Signal } from "../../../types/catalogModel";
import { formatFrameId } from "../utils";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import { muxSignalCount, selectorRange, signalRange } from "./signalRanges";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
export type CANFrameViewProps = {
  selectedNode: TomlNode;
  displayFrameIdFormat?: "hex" | "decimal";

  editingSignal: boolean;

  // Signal actions
  onAddSignal: (idKey: string) => void;
  onEditSignal: (idKey: string, signalIndex: number, signal: Signal, parentPath?: string[]) => void;
  onRequestDeleteSignal: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;

  // Mux actions
  onAddMux: (ownerPath: string[]) => void;
  onEditMux?: (muxPath: string[], mux: Mux) => void;
  onDeleteMux?: (muxPath: string[]) => void;
  onAddCase?: (muxPath: string[]) => void;
  onSelectNode?: (node: TomlNode) => void;
};

export default function CANFrameView({
  selectedNode,
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
  const { t } = useTranslation("catalog");
  const frame = selectedNode.metadata!.frame!;
  const idKey = frame.key;
  const inherited = new Set(frame.inheritedFields ?? []);
  const mux = frame.mux;
  const muxInherited = inherited.has("mux");
  const [colorForRange, setColorForRange] = useState<(range: BitRange) => string | undefined>(() => () => undefined);
  const [confirmDeleteMux, setConfirmDeleteMux] = useState(false);
  const formattedId = formatFrameId(idKey, displayFrameIdFormat);
  const layout = useFrameLayout(selectedNode.path);
  const ranges = previewRanges(layout);
  const signalColor = useCallback((signal: Signal) => colorForRange(signalRange(signal)), [colorForRange]);

  const muxLegendColor = useMemo(
    () => (mux ? colorForRange(selectorRange(mux)) : undefined),
    [mux, colorForRange]
  );

  const muxNode = useMemo(
    () => selectedNode.children?.find((c) => c.type === "mux") || null,
    [selectedNode.children]
  );

  const sortedSignals = useMemo(
    () => frame.signals.map((signal, index) => ({ signal, index })).sort((a, b) => (a.signal.startBit ?? 0) - (b.signal.startBit ?? 0)),
    [frame.signals]
  );
  const muxSignals = mux ? muxSignalCount(mux) : 0;
  const notes = frame.notes ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>{t("canFrameView.id")}</div>
            <div className={`${monoBody} flex items-center gap-2`}>
              <span>{formattedId.primary}</span>
              {formattedId.secondary && (
                <span className="text-muted text-xs">({formattedId.secondary})</span>
              )}
            </div>
          </div>

          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("canFrameView.lengthDlc")} <span className="text-danger">{t("canFrameView.required")}</span>
              {inherited.has("length") && (
                <span className="ml-1 text-info" title={t("canFrameView.inheritedTooltip")}>
                  {t("canFrameView.inheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {frame.length || <span className="text-warning">{t("canFrameView.notSet")}</span>}
            </div>
          </div>

          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("canFrameView.transmitter")}
              {inherited.has("transmitter") && (
                <span className="ml-1 text-info" title={t("canFrameView.inheritedTooltip")}>
                  {t("canFrameView.inheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {frame.transmitter || <span className="text-muted">{t("canFrameView.none")}</span>}
            </div>
          </div>

          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("canFrameView.interval")}
              {inherited.has("interval") && (
                <span
                  className="ml-1 text-info"
                  title={t("canFrameView.intervalInheritedTooltip")}
                >
                  {t("canFrameView.inheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {frame.interval !== undefined ? (
                t("canFrameView.intervalMs", { ms: frame.interval })
              ) : (
                <span className="text-muted">{t("canFrameView.none")}</span>
              )}
            </div>
          </div>

          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("canFrameView.extendedId")}
              {inherited.has("extended") && (
                <span
                  className="ml-1 text-info"
                  title={t("canFrameView.extendedInheritedTooltip")}
                >
                  {t("canFrameView.inheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {frame.isExtended ? t("canFrameView.yes29bit") : t("canFrameView.no11bit")}
            </div>
          </div>

          <div className={`p-4 ${bgSurface} rounded-lg`}>
            <div className={labelSmallMuted}>
              {t("canFrameView.canFd")}
              {inherited.has("fd") && (
                <span
                  className="ml-1 text-info"
                  title={t("canFrameView.fdInheritedTooltip")}
                >
                  {t("canFrameView.inheritedSuffix")}
                </span>
              )}
            </div>
            <div className={monoBody}>
              {frame.isFd ? t("canFrameView.yes") : t("canFrameView.noClassic")}
            </div>
          </div>
        </div>

      {/* Notes card */}
      {notes.length > 0 && (
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={`${labelSmall} mb-2`}>
            {t("canFrameView.notes")}
          </div>
          <div className="text-sm text-secondary whitespace-pre-wrap">
            {notes.join("\n")}
          </div>
        </div>
      )}

      {/* Signals + Bit preview + Mux */}
      {!editingSignal && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-primary shrink-0">
              {t("canFrameView.signalsHeader", { count: frame.signals.length + muxSignals })}
              {mux && (
                <span className="ml-2 text-xs font-normal text-purple inline-flex items-center gap-2">
                  {muxLegendColor && <span className={`inline-block w-3 h-3 rounded ${muxLegendColor}`} />}
                  {t("canFrameView.muxSignalsHint", { count: muxSignals })}
                </span>
              )}
            </h3>

            <div className="flex items-center gap-2 shrink-0">
              <span className={caption}>
                {frame.length ? t("canFrameView.totalBytes", { count: frame.length }) : ""}
              </span>

              {!mux && (
                <Button
                  onClick={() => onAddMux(selectedNode.path)}
                  variant="solid"
                  tone="purple"
                  size="sm"
                >
                  {t("canFrameView.addMux")}
                </Button>
              )}

              {mux && !muxInherited && onAddCase && muxNode && (
                <Button
                  onClick={() => onAddCase(muxNode.path)}
                  variant="solid"
                  tone="purple"
                  size="sm"
                >
                  {t("canFrameView.addCase")}
                </Button>
              )}

              <Button
                onClick={() => onAddSignal(idKey)}
                variant="solid"
                tone="success"
                size="sm"
              >
                {t("canFrameView.addSignal")}
              </Button>
            </div>
          </div>

          {/* BitPreview — renders when there are any ranges (base signals or mux selector) */}
          {layout && ranges.length > 0 && (
            <div className="mb-4 p-4 bg-surface rounded-lg">
              <div className="text-xs font-medium text-secondary mb-3">
                {t("canFrameView.byteLayout")}
              </div>
              <BitPreview
                numBytes={layout.byteLength}
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
              {sortedSignals.map(({ signal, index }) => (
                <div
                  key={index}
                  className={`p-3 ${bgSurface} rounded-lg ${hoverLight} transition-colors`}
                >
                  <div className="flex items-start justify-between min-w-0">
                    <div className="flex-1 min-w-0 flex gap-3">
                      <div
                        className={`w-2 h-6 rounded-sm mt-1 shrink-0 ${
                          signalColor(signal) || "bg-surface"
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-primary flex items-center gap-2 min-w-0">
                          <span className="shrink-0">⚡</span>
                          <span className="truncate">{signal.name}</span>
                          {signal.inherited && (
                            <span
                              className="text-xs text-purple flex items-center gap-1"
                              title={t("canFrameView.inheritedFromMirror")}
                            >
                              <Layers className="w-3 h-3" />
                              <span>{t("canFrameView.inheritedShort")}</span>
                            </span>
                          )}
                        </div>

                        <div className={`${caption} mt-1 space-y-0.5`}>
                          <div>
                            {t("canFrameView.bitsRange", {
                              start: signal.startBit ?? 0,
                              end: (signal.startBit ?? 0) + (signal.bitLength ?? 0) - 1,
                              length: signal.bitLength ?? 0,
                            })}
                          </div>
                          {signal.unit && <div>{t("canFrameView.unit", { unit: signal.unit })}</div>}
                          {signal.factor !== undefined && <div>{t("canFrameView.factor", { factor: signal.factor })}</div>}
                          {signal.offset !== undefined && <div>{t("canFrameView.offset", { offset: signal.offset })}</div>}
                        </div>
                        {signal.notes && (
                          <div className="text-xs text-secondary mt-2 italic whitespace-pre-wrap">
                            {signal.notes.join("\n")}
                          </div>
                        )}
                      </div>
                    </div>

                    {!signal.inherited && <div className="flex items-center gap-2 ml-4 shrink-0">
                      <IconButton
                        onClick={() => onEditSignal(idKey, index, signal, selectedNode.path)}
                        title={t("canFrameView.editSignal")}
                      >
                        <Pencil className={`${iconMd} text-secondary`} />
                      </IconButton>

                      <IconButton
                        onClick={() => onRequestDeleteSignal(idKey, index, selectedNode.path, signal.name)}
                        tone="danger"
                        title={t("canFrameView.deleteSignal")}
                      >
                        <Trash2 className={`${iconMd} text-danger`} />
                      </IconButton>
                    </div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Mux section — selector bubble + inline cases */}
          {mux && (
            <div className="mt-4 space-y-3">
              {/* Mux selector bubble */}
              <Card tone="purple">
                <div className="flex items-start justify-between min-w-0">
                  <div className="flex-1 min-w-0 flex gap-3">
                    <div
                      className={`w-2 h-6 rounded-sm mt-1 shrink-0 ${muxLegendColor || "bg-purple-border"}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-primary flex items-center gap-2 min-w-0">
                        <span className="shrink-0">🔀</span>
                        <span className="truncate">{mux.name || t("canFrameView.muxName")}</span>
                        {muxInherited && (
                          <span className="text-xs text-purple flex items-center gap-1" title={t("canFrameView.inheritedFromMirror")}>
                            <Layers className="w-3 h-3" />
                            <span>{t("canFrameView.inheritedShort")}</span>
                          </span>
                        )}
                      </div>
                      <div className={`${caption} mt-1`}>
                        {t("canFrameView.bitsRange", {
                          start: mux.startBit,
                          end: mux.startBit + mux.bitLength - 1,
                          length: mux.bitLength,
                        })}
                        {mux.default !== undefined && (
                          <span className="ml-2 text-blue">{t("canFrameView.muxDefault", { value: mux.default })}</span>
                        )}
                      </div>
                      {mux.notes && (
                        <div className="text-xs text-secondary mt-2 italic whitespace-pre-wrap">
                          {mux.notes.join("\n")}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    {onEditMux && !muxInherited && (
                      <IconButton
                        onClick={() => onEditMux([...selectedNode.path, "mux"], mux)}
                        title={t("canFrameView.editMux")}
                      >
                        <Pencil className={`${iconMd} text-secondary`} />
                      </IconButton>
                    )}
                    {onDeleteMux && !muxInherited && (
                      <IconButton
                        onClick={() => setConfirmDeleteMux(true)}
                        tone="danger"
                        title={t("canFrameView.deleteMux")}
                      >
                        <Trash2 className={`${iconMd} text-danger`} />
                      </IconButton>
                    )}
                  </div>
                </div>
              </Card>

              {/* Mux cases */}
              {muxNode?.children && muxNode.children.length > 0 && (
                <div className="space-y-2 ml-4">
                  {muxNode.children.map((caseNode, idx) => {
                    const caseSignals = caseNode.metadata?.muxCase?.signals ?? [];
                    return (
                      <div
                        key={idx}
                        className={`p-3 ${bgSurface} rounded-lg ${onSelectNode ? `${hoverLight} cursor-pointer` : ""} transition-colors`}
                        onClick={onSelectNode ? () => onSelectNode(caseNode) : undefined}
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <div className="min-w-0">
                            <div className="font-medium text-primary flex items-center gap-2 min-w-0">
                              <span className="shrink-0">📍</span>
                              <span className="truncate">{caseNode.key}</span>
                              <span className={caption}>
                                {t("canFrameView.signalsCount", { count: caseSignals.length })}
                              </span>
                            </div>
                            {caseSignals.length > 0 && (
                              <div className={`${caption} mt-1 ml-6 space-y-0.5`}>
                                {caseSignals.map((sig, sIdx) => (
                                  <div key={sIdx} className="truncate">
                                    ⚡ {sig.name || t("canFrameView.signalDefault", { idx: sIdx + 1 })}
                                    <span className="ml-1 text-muted">
                                      ({sig.startBit ?? 0}:{sig.bitLength ?? 0})
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
          title={t("canFrameView.deleteMuxTitle")}
          message={t("canFrameView.deleteMuxMessage")}
          highlightText={mux?.name || undefined}
          confirmText={t("canFrameView.deleteLabel")}
          onCancel={() => setConfirmDeleteMux(false)}
          onConfirm={() => {
            setConfirmDeleteMux(false);
            onDeleteMux([...selectedNode.path, "mux"]);
          }}
        />
      )}
    </div>
  );
}
