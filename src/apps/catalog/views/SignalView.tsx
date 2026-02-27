// ui/src/apps/catalog/views/SignalView.tsx

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { labelSmall, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, bgSecondary } from "../../../styles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import { tomlParse } from "../toml";
import { extractMuxRangesFromPath, getFrameByteLengthFromPath } from "../utils";
import type { TomlNode, ValidationError } from "../types";

export type SignalViewProps = {
  selectedNode: TomlNode;
  catalogContent: string;
  inheritedByteOrder?: "little" | "big";

  // Actions
  onEditSignal: (idKey: string, signalIndex: number, signal: any, signalsParentPath?: string[]) => void;
  onRequestDeleteSignal: (idKey: string, signalIndex: number, signalsParentPath?: string[], signalName?: string) => void;

  // Validation
  onSetValidation: (errors: ValidationError[]) => void;
};

export default function SignalView({
  selectedNode,
  catalogContent,
  inheritedByteOrder,
  onEditSignal,
  onRequestDeleteSignal,
  onSetValidation,
}: SignalViewProps) {
  // Use tree metadata directly instead of re-parsing TOML and searching by properties.
  const locateSignal = React.useCallback(() => {
    const signalsIdx = selectedNode.path.findIndex(
      (seg) => seg === "signals" || seg === "signal"
    );
    if (signalsIdx < 0) return null;

    const signalsParentPath = selectedNode.path.slice(0, signalsIdx);
    const idKey = signalsParentPath[signalsParentPath.length - 1];
    const idx = selectedNode.metadata?.signalIndex;
    const signal = selectedNode.metadata?.properties;

    if (idx === undefined || idx === null || !signal) return null;

    return { idKey, idx, signal, signalsParentPath };
  }, [selectedNode.metadata?.signalIndex, selectedNode.metadata?.properties, selectedNode.path]);

  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">Signal Details</h3>
        <div className={flexRowGap2}>
          <button
            onClick={() => {
              try {
                const found = locateSignal();
                if (!found) return;
                onEditSignal(found.idKey, found.idx, found.signal, found.signalsParentPath);
              } catch (error) {
                console.error("Failed to locate/edit signal:", error);
                onSetValidation([{ field: "signal", message: "Failed to locate signal for editing" }]);
              }
            }}
            className={iconButtonHover}
            title="Edit signal"
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>

          {/* Pattern A delete */}
          <button
            onClick={() => {
              try {
                const found = locateSignal();
                if (!found) return;
                onRequestDeleteSignal(found.idKey, found.idx, found.signalsParentPath, found.signal?.name);
              } catch (error) {
                console.error("Failed to locate/delete signal:", error);
                onSetValidation([{ field: "signal", message: "Failed to locate signal for deletion" }]);
              }
            }}
            className={iconButtonHoverDanger}
            title="Delete signal"
          >
            <Trash2 className={`${iconMd} text-[color:var(--text-danger)]`} />
          </button>
        </div>
      </div>

      {/* Bit Preview - shows signal and all parent mux selectors */}
      {selectedNode.metadata?.properties &&
        (() => {
          const signal = selectedNode.metadata!.properties as any;
          const startBit = signal.start_bit ?? 0;
          const bitLength = signal.bit_length ?? 0;

          // Build ranges including all parent mux selectors
          const ranges: BitRange[] = [];

          try {
            const parsed = tomlParse(catalogContent);
            // Extract all mux ranges from the path hierarchy
            const muxRanges = extractMuxRangesFromPath(selectedNode.path, parsed);
            ranges.push(...muxRanges);

            // Get frame length for numBytes (handles CAN, Modbus, Serial)
            const frameLength = getFrameByteLengthFromPath(selectedNode.path, parsed);

            return (
              <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
                <h4 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Bit Preview</h4>
                <BitPreview
                  numBytes={frameLength}
                  ranges={ranges}
                  currentStartBit={startBit}
                  currentBitLength={bitLength}
                  showLegend={ranges.length > 0}
                />
              </div>
            );
          } catch {
            // Fallback: show just the signal bytes if parsing fails
            const endBit = startBit + bitLength;
            const startByte = Math.floor(startBit / 8);
            const endByte = Math.floor((endBit - 1) / 8);
            const numBytes = endByte - startByte + 1;

            return (
              <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
                <h4 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Bit Preview</h4>
                <BitPreview
                  numBytes={numBytes}
                  ranges={[]}
                  currentStartBit={startBit - startByte * 8}
                  currentBitLength={bitLength}
                  showLegend={false}
                />
              </div>
            );
          }
        })()}

      {selectedNode.metadata?.muxCase && (
        <div className="p-3 bg-[var(--bg-purple)] border-2 border-[color:var(--border-purple)] rounded-lg">
          <div className="text-xs font-medium text-[color:var(--text-purple)] mb-1">Mux Case</div>
          <div className="font-mono text-sm text-[color:var(--text-purple-strong)]">{selectedNode.metadata.muxCase}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {selectedNode.metadata?.properties &&
          Object.entries(selectedNode.metadata.properties)
            .filter(([key]) => key !== "endianness" && key !== "byte_order")
            .map(([key, value]) => (
            <div key={key} className={`p-3 ${bgSecondary} rounded-lg min-w-0`}>
              <div className={labelSmallMuted}>{key}</div>
              <div className={`${monoBody} break-all`}>
                {typeof value === "boolean"
                  ? value
                    ? "true"
                    : "false"
                  : typeof value === "number"
                    ? value
                    : typeof value === "string"
                      ? `"${value}"`
                      : JSON.stringify(value)}
              </div>
            </div>
          ))}

        {/* Byte Order - show inherited value if not explicitly set */}
        {(() => {
          const props = selectedNode.metadata?.properties as any;
          const explicitByteOrder = props?.endianness || props?.byte_order;
          const effectiveByteOrder = explicitByteOrder || inheritedByteOrder;
          const isInherited = !explicitByteOrder && !!inheritedByteOrder;

          if (!effectiveByteOrder) return null;

          return (
            <div className={`p-3 ${bgSecondary} rounded-lg min-w-0`}>
              <div className={`${flexRowGap2} mb-1`}>
                <span className={labelSmall}>byte_order</span>
                {isInherited && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-[var(--bg-accent)] text-[color:var(--accent-primary)] rounded">
                    Inherited
                  </span>
                )}
              </div>
              <div className={`${monoBody} break-all`}>
                "{effectiveByteOrder}"
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
