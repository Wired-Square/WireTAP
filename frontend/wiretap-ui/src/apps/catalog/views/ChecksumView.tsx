// ui/src/apps/catalog/views/ChecksumView.tsx

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, bgSurface } from "../../../styles";
import { getAlgorithmInfo, resolveByteIndexSync } from "../checksums";
import type { TomlNode, ChecksumAlgorithm } from "../types";
import type { FrameChecksum } from "../../../types/catalogModel";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { frameAt } from "../model";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
export type ChecksumViewProps = {
  selectedNode: TomlNode;

  // Actions
  onEditChecksum: (idKey: string, checksumIndex: number, checksum: FrameChecksum, checksumsParentPath?: string[]) => void;
  onRequestDeleteChecksum: (idKey: string, checksumIndex: number, checksumsParentPath?: string[], checksumName?: string) => void;
};

export default function ChecksumView({
  selectedNode,
  onEditChecksum,
  onRequestDeleteChecksum,
}: ChecksumViewProps) {
  const { t } = useTranslation("catalog");
  const checksum = selectedNode.metadata!.checksum!;
  const checksumIndex = selectedNode.metadata!.checksumIndex!;
  const checksumsParentPath = selectedNode.path.slice(0, -2);
  const idKey = selectedNode.path[2];
  const frameLength = useCatalogEditorStore((s) => frameAt(s.tree.catalog, selectedNode.path)?.length ?? 8);
  const algorithm = checksum.algorithm as ChecksumAlgorithm;
  const algorithmInfo = getAlgorithmInfo(algorithm);
  const notes = checksum.notes?.join("\n");


  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-primary">{t("checksumDetails.title")}</h3>
        <div className={flexRowGap2}>
          <IconButton
            onClick={() => onEditChecksum(idKey, checksumIndex, checksum, checksumsParentPath)}
            title={t("checksumDetails.edit")}
          >
            <Pencil className={`${iconMd} text-secondary`} />
          </IconButton>

          <IconButton
            onClick={() => onRequestDeleteChecksum(idKey, checksumIndex, checksumsParentPath, checksum.name)}
            tone="danger"
            title={t("checksumDetails.delete")}
          >
            <Trash2 className={`${iconMd} text-danger`} />
          </IconButton>
        </div>
      </div>

      {/* Algorithm Info Card */}
      {algorithmInfo && (
        <Card tone="info" padding="lg">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🔐</span>
            <span className="font-semibold text-info">{algorithmInfo.name}</span>
            <Badge tone="primary" variant="outline">
              {t("checksumDetails.outputBytes", { count: algorithmInfo.outputBytes })}
            </Badge>
          </div>
          <p className="text-sm text-info">{algorithmInfo.description}</p>
        </Card>
      )}

      {/* Byte Range Visualization */}
      <div className="p-4 bg-surface rounded-lg">
        <h4 className="text-sm font-semibold text-primary mb-3">{t("checksumDetails.byteLayout")}</h4>
        {(() => {
          // Resolve negative indices for display
          const resolvedStartByte = checksum.startByte !== undefined
            ? resolveByteIndexSync(checksum.startByte, frameLength)
            : undefined;
          const resolvedCalcStart = checksum.calcStartByte !== undefined
            ? resolveByteIndexSync(checksum.calcStartByte, frameLength)
            : undefined;
          const resolvedCalcEnd = checksum.calcEndByte !== undefined
            ? resolveByteIndexSync(checksum.calcEndByte, frameLength)
            : undefined;

          return (
            <div className="flex flex-wrap gap-1 font-mono text-xs">
              {Array.from({ length: frameLength }).map((_, i) => {
                const isChecksumByte = resolvedStartByte !== undefined &&
                  checksum.byteLength !== undefined &&
                  i >= resolvedStartByte &&
                  i < resolvedStartByte + checksum.byteLength;

                const isCalcByte = resolvedCalcStart !== undefined &&
                  resolvedCalcEnd !== undefined &&
                  i >= resolvedCalcStart &&
                  i < resolvedCalcEnd;

                let bgClass = "bg-tertiary text-muted";
                if (isChecksumByte) {
                  bgClass = "bg-purple text-purple";
                } else if (isCalcByte) {
                  bgClass = "bg-info text-info";
                }

                return (
                  <div
                    key={i}
                    className={`w-8 h-8 flex items-center justify-center rounded ${bgClass}`}
                    title={isChecksumByte ? t("checksumDetails.tooltipChecksumLocation") : isCalcByte ? t("checksumDetails.tooltipCalculationRange") : t("checksumDetails.byteTooltip", { idx: i })}
                  >
                    {i}
                  </div>
                );
              })}
            </div>
          );
        })()}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-purple"></div>
            <span>{t("checksumDetails.checksumLocation")}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-info"></div>
            <span>{t("checksumDetails.calculationLegend")}</span>
          </div>
        </div>
      </div>

      {/* Properties Grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Core Properties */}
        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("checksumDetails.name")}</div>
          <div className={monoBody}>"{checksum.name}"</div>
        </div>

        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("checksumDetails.algorithm")}</div>
          <div className={monoBody}>{checksum.algorithm}</div>
        </div>

        {/* Checksum Location */}
        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("checksumDetails.checksumPosition")}</div>
          <div className={monoBody}>
            {checksum.startByte !== undefined && checksum.startByte < 0 ? (
              <>
                {t("checksumDetails.byteWithResolved", { idx: checksum.startByte, resolved: resolveByteIndexSync(checksum.startByte, frameLength) })}
              </>
            ) : (
              t("checksumDetails.byteSingle", { idx: checksum.startByte })
            )}
            {" "}({t("checksumDetails.byteCount", { count: checksum.byteLength })})
          </div>
        </div>

        <div className={`p-3 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>{t("checksumDetails.endianness")}</div>
          <div className={monoBody}>{checksum.endianness || "big"}</div>
        </div>

        {/* Calculation Range */}
        <div className={`p-3 ${bgSurface} rounded-lg col-span-2`}>
          <div className={labelSmallMuted}>{t("checksumDetails.calculationRange")}</div>
          {(() => {
            const hasNegativeStart = checksum.calcStartByte !== undefined && checksum.calcStartByte < 0;
            const hasNegativeEnd = checksum.calcEndByte !== undefined && checksum.calcEndByte < 0;
            const resolvedStart = checksum.calcStartByte !== undefined
              ? resolveByteIndexSync(checksum.calcStartByte, frameLength)
              : 0;
            const resolvedEnd = checksum.calcEndByte !== undefined
              ? resolveByteIndexSync(checksum.calcEndByte, frameLength)
              : frameLength;

            if (hasNegativeStart || hasNegativeEnd) {
              return (
                <div className={monoBody}>
                  bytes {checksum.calcStartByte}
                  {hasNegativeStart && <span className="text-muted"> (→ {resolvedStart})</span>}
                  {" "}to {checksum.calcEndByte}
                  {hasNegativeEnd && <span className="text-muted"> (→ {resolvedEnd})</span>}
                  {" "}= bytes {resolvedStart} to {resolvedEnd - 1}
                </div>
              );
            }

            return (
              <div className={monoBody}>
                bytes {checksum.calcStartByte} to {resolvedEnd - 1} (exclusive end: {checksum.calcEndByte})
              </div>
            );
          })()}
        </div>

        {/* Notes */}
        {notes && (
          <div className={`p-3 ${bgSurface} rounded-lg col-span-2`}>
            <div className={labelSmallMuted}>{t("checksumDetails.notes")}</div>
            <div className="text-sm text-primary">{notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
