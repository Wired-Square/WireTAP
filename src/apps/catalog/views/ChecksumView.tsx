// ui/src/apps/catalog/views/ChecksumView.tsx

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary } from "../../../styles";
import { tomlParse } from "../toml";
import { getFrameByteLengthFromPath } from "../utils";
import { getAlgorithmInfo, resolveByteIndexSync } from "../checksums";
import type { TomlNode, ValidationError, ChecksumAlgorithm } from "../types";

export type ChecksumViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;

  // Actions
  onEditChecksum: (idKey: string, checksumIndex: number, checksum: any, checksumsParentPath?: string[]) => void;
  onRequestDeleteChecksum: (idKey: string, checksumIndex: number, checksumsParentPath?: string[], checksumName?: string) => void;

  // Validation
  onSetValidation: (errors: ValidationError[]) => void;
};

function normalizeTomlKey(seg: string): string {
  return seg.startsWith('"') && seg.endsWith('"') ? seg.slice(1, -1) : seg;
}

export default function ChecksumView({
  selectedNode,
  catalogContent,
  onEditChecksum,
  onRequestDeleteChecksum,
  onSetValidation,
}: ChecksumViewProps) {
  const locateChecksum = React.useCallback(() => {
    const checksumIdx = selectedNode.path.findIndex((seg) => seg === "checksum");
    if (checksumIdx < 0) return null;

    const checksumsParentPath = selectedNode.path.slice(0, checksumIdx);

    const parsed = tomlParse(catalogContent) as any;

    // Navigate to the parent object that owns the checksum array
    let cur: any = parsed;
    for (const seg of checksumsParentPath) {
      const key = normalizeTomlKey(seg);
      cur = cur?.[key];
    }

    const arr: any[] = Array.isArray(cur?.checksum) ? cur.checksum : [];
    const targetName = selectedNode.key;

    const idx = arr.findIndex((c) =>
      c && c.name === targetName
    );

    if (idx < 0) return null;

    const idKey = checksumsParentPath[checksumsParentPath.length - 1];
    return { idKey, idx, checksum: arr[idx], checksumsParentPath };
  }, [catalogContent, selectedNode.key, selectedNode.metadata?.properties, selectedNode.path]);

  // Get checksum properties
  const props = selectedNode.metadata?.properties || {};
  const algorithm = props.algorithm as ChecksumAlgorithm | undefined;
  const algorithmInfo = algorithm ? getAlgorithmInfo(algorithm) : undefined;

  // Get frame length for byte visualization
  let frameLength = 8;
  try {
    const parsed = tomlParse(catalogContent);
    frameLength = getFrameByteLengthFromPath(selectedNode.path, parsed);
  } catch {
    // Use default
  }

  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">Checksum Details</h3>
        <div className={flexRowGap2}>
          <button
            onClick={() => {
              try {
                const found = locateChecksum();
                if (!found) return;
                onEditChecksum(found.idKey, found.idx, found.checksum, found.checksumsParentPath);
              } catch (error) {
                console.error("Failed to locate/edit checksum:", error);
                onSetValidation([{ field: "checksum", message: "Failed to locate checksum for editing" }]);
              }
            }}
            className={iconButtonHover}
            title="Edit checksum"
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>

          <button
            onClick={() => {
              try {
                const found = locateChecksum();
                if (!found) return;
                onRequestDeleteChecksum(found.idKey, found.idx, found.checksumsParentPath, found.checksum?.name);
              } catch (error) {
                console.error("Failed to locate/delete checksum:", error);
                onSetValidation([{ field: "checksum", message: "Failed to locate checksum for deletion" }]);
              }
            }}
            className={iconButtonHoverDanger}
            title="Delete checksum"
          >
            <Trash2 className={`${iconMd} text-[color:var(--status-danger-text)]`} />
          </button>
        </div>
      </div>

      {/* Algorithm Info Card */}
      {algorithmInfo && (
        <div className="p-4 bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)] rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🔐</span>
            <span className="font-semibold text-[color:var(--status-info-text)]">{algorithmInfo.name}</span>
            <span className="px-2 py-0.5 text-xs font-medium bg-[var(--status-info-badge-bg)] text-[color:var(--status-info-badge-text)] rounded">
              {algorithmInfo.outputBytes} byte{algorithmInfo.outputBytes > 1 ? "s" : ""}
            </span>
          </div>
          <p className="text-sm text-[color:var(--status-info-text)]">{algorithmInfo.description}</p>
        </div>
      )}

      {/* Byte Range Visualization */}
      <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
        <h4 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Byte Layout</h4>
        {(() => {
          // Resolve negative indices for display
          const resolvedStartByte = props.start_byte !== undefined
            ? resolveByteIndexSync(props.start_byte, frameLength)
            : undefined;
          const resolvedCalcStart = props.calc_start_byte !== undefined
            ? resolveByteIndexSync(props.calc_start_byte, frameLength)
            : undefined;
          const resolvedCalcEnd = props.calc_end_byte !== undefined
            ? resolveByteIndexSync(props.calc_end_byte, frameLength)
            : undefined;

          return (
            <div className="flex flex-wrap gap-1 font-mono text-xs">
              {Array.from({ length: frameLength }).map((_, i) => {
                const isChecksumByte = resolvedStartByte !== undefined &&
                  props.byte_length !== undefined &&
                  i >= resolvedStartByte &&
                  i < resolvedStartByte + props.byte_length;

                const isCalcByte = resolvedCalcStart !== undefined &&
                  resolvedCalcEnd !== undefined &&
                  i >= resolvedCalcStart &&
                  i < resolvedCalcEnd;

                let bgClass = "bg-[var(--bg-tertiary)] text-[color:var(--text-muted)]";
                if (isChecksumByte) {
                  bgClass = "bg-purple-500 text-white";
                } else if (isCalcByte) {
                  bgClass = "bg-[var(--status-info-bg)] text-[color:var(--status-info-text)]";
                }

                return (
                  <div
                    key={i}
                    className={`w-8 h-8 flex items-center justify-center rounded ${bgClass}`}
                    title={isChecksumByte ? "Checksum location" : isCalcByte ? "Included in calculation" : `Byte ${i}`}
                  >
                    {i}
                  </div>
                );
              })}
            </div>
          );
        })()}
        <div className="flex items-center gap-4 mt-3 text-xs text-[color:var(--text-muted)]">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-purple-500"></div>
            <span>Checksum location</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-[var(--status-info-bg)]"></div>
            <span>Calculation range</span>
          </div>
        </div>
      </div>

      {/* Properties Grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Core Properties */}
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>name</div>
          <div className={monoBody}>"{props.name}"</div>
        </div>

        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>algorithm</div>
          <div className={monoBody}>{props.algorithm}</div>
        </div>

        {/* Checksum Location */}
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Checksum Position</div>
          <div className={monoBody}>
            {props.start_byte !== undefined && props.start_byte < 0 ? (
              <>
                byte {props.start_byte}{" "}
                <span className="text-[color:var(--text-muted)]">(→ {resolveByteIndexSync(props.start_byte, frameLength)})</span>
              </>
            ) : (
              `byte ${props.start_byte}`
            )}
            {" "}({props.byte_length} byte{props.byte_length > 1 ? "s" : ""})
          </div>
        </div>

        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>endianness</div>
          <div className={monoBody}>{props.endianness || "big"}</div>
        </div>

        {/* Calculation Range */}
        <div className={`p-3 ${bgSecondary} rounded-lg col-span-2`}>
          <div className={labelSmallMuted}>Calculation Range</div>
          {(() => {
            const hasNegativeStart = props.calc_start_byte !== undefined && props.calc_start_byte < 0;
            const hasNegativeEnd = props.calc_end_byte !== undefined && props.calc_end_byte < 0;
            const resolvedStart = props.calc_start_byte !== undefined
              ? resolveByteIndexSync(props.calc_start_byte, frameLength)
              : 0;
            const resolvedEnd = props.calc_end_byte !== undefined
              ? resolveByteIndexSync(props.calc_end_byte, frameLength)
              : frameLength;

            if (hasNegativeStart || hasNegativeEnd) {
              return (
                <div className={monoBody}>
                  bytes {props.calc_start_byte}
                  {hasNegativeStart && <span className="text-[color:var(--text-muted)]"> (→ {resolvedStart})</span>}
                  {" "}to {props.calc_end_byte}
                  {hasNegativeEnd && <span className="text-[color:var(--text-muted)]"> (→ {resolvedEnd})</span>}
                  {" "}= bytes {resolvedStart} to {resolvedEnd - 1}
                </div>
              );
            }

            return (
              <div className={monoBody}>
                bytes {props.calc_start_byte} to {resolvedEnd - 1} (exclusive end: {props.calc_end_byte})
              </div>
            );
          })()}
        </div>

        {/* Notes */}
        {props.notes && (
          <div className={`p-3 ${bgSecondary} rounded-lg col-span-2`}>
            <div className={labelSmallMuted}>notes</div>
            <div className="text-sm text-[color:var(--text-primary)]">{props.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
