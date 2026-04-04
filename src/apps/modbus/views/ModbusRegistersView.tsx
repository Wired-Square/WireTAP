// ui/src/apps/modbus/views/ModbusRegistersView.tsx
//
// Register data table showing live Modbus register values with decoded signals.
// Filtered by selectedFrames (from FramePicker).

import { useMemo } from "react";
import { formatFrameId } from "../../../utils/frameIds";
import { parseFrameKey } from "../../../utils/frameKey";
import { formatIsoUs } from "../../../utils/timeFormat";
import { bgDataView, textPrimary, textMuted, textSecondary, borderDefault } from "../../../styles";
import { emptyStateText } from "../../../styles/typography";
import { monoBody } from "../../../styles/typography";
import { getRegisterValues, type RegisterValue } from "../stores/modbusStore";
import type { FrameDetail } from "../../../types/decoder";
import type { ModbusPollGroup } from "../../../utils/modbusPollBuilder";

interface Props {
  frames: Map<string, FrameDetail>;
  selectedFrames: Set<string>;
  pollGroups: ModbusPollGroup[];
  registerVersion: number;
  displayFrameIdFormat: "hex" | "decimal";
}

type RegisterRow = {
  frameKey: string;
  numericId: number;
  frameDef: FrameDetail;
  registerValue: RegisterValue | undefined;
  pollGroup: ModbusPollGroup | undefined;
};

export default function ModbusRegistersView({
  frames,
  selectedFrames,
  pollGroups,
  registerVersion,
  displayFrameIdFormat,
}: Props) {
  // Force re-render when registerVersion changes
  void registerVersion;
  const registerValues = getRegisterValues();

  // Build poll group lookup by frame_id
  const pollLookup = useMemo(() => {
    const map = new Map<number, ModbusPollGroup>();
    for (const pg of pollGroups) {
      map.set(pg.frame_id, pg);
    }
    return map;
  }, [pollGroups]);

  // Build sorted rows — only show selected frames
  // registerVersion triggers recomputation when mutable _registerValues map is updated
  const rows: RegisterRow[] = useMemo(() => {
    const result: RegisterRow[] = [];
    for (const [fk, frameDef] of frames) {
      if (!selectedFrames.has(fk)) continue;
      const { frameId } = parseFrameKey(fk);
      result.push({
        frameKey: fk,
        numericId: frameId,
        frameDef,
        registerValue: registerValues.get(fk),
        pollGroup: pollLookup.get(frameId),
      });
    }
    return result.sort((a, b) => a.numericId - b.numericId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, selectedFrames, registerVersion, pollLookup]);

  if (frames.size === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${bgDataView}`}>
        <p className={emptyStateText}>
          Load a Modbus catalogue to configure register polling.
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${bgDataView}`}>
        <p className={emptyStateText}>
          No registers selected. Use the frame picker to select registers.
        </p>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto ${bgDataView}`}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10">
          <tr className={`${bgDataView} border-b ${borderDefault}`}>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>Register</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>Type</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>Raw</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>Signals</th>
            <th className={`px-3 py-1.5 text-right font-medium ${textSecondary}`}>Interval</th>
            <th className={`px-3 py-1.5 text-right font-medium ${textSecondary}`}>Last Update</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.frameKey}
              className={`border-b border-[color:var(--border-subtle)] hover:bg-[var(--bg-hover)]`}
            >
              {/* Register address */}
              <td className={`px-3 py-1.5 ${monoBody} ${textPrimary}`}>
                {formatFrameId(row.numericId, displayFrameIdFormat)}
                {row.frameDef.signals.length > 0 && (
                  <span className={`ml-2 ${textMuted} font-sans`}>
                    {row.frameDef.signals.length === 1
                      ? row.frameDef.signals[0].name
                      : `${row.frameDef.signals.length} signals`}
                  </span>
                )}
              </td>

              {/* Register type */}
              <td className={`px-3 py-1.5 ${textSecondary}`}>
                {row.pollGroup?.register_type ?? '—'}
              </td>

              {/* Raw bytes */}
              <td className={`px-3 py-1.5 ${monoBody} ${textMuted}`}>
                {row.registerValue
                  ? row.registerValue.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')
                  : '—'}
              </td>

              {/* Decoded signals */}
              <td className={`px-3 py-1.5 ${textPrimary}`}>
                {row.registerValue && row.registerValue.decoded.length > 0 ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {row.registerValue.decoded.map((sig, i) => (
                      <span key={i} className="whitespace-nowrap">
                        <span className="text-[color:var(--text-data-primary)]">{sig.value}</span>
                        {sig.unit && (
                          <span className={`ml-0.5 ${textMuted}`}>{sig.unit}</span>
                        )}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className={textMuted}>—</span>
                )}
              </td>

              {/* Poll interval */}
              <td className={`px-3 py-1.5 text-right ${textMuted}`}>
                {row.pollGroup?.interval_ms
                  ? `${(row.pollGroup.interval_ms / 1000).toFixed(1)}s`
                  : '—'}
              </td>

              {/* Last update */}
              <td className={`px-3 py-1.5 text-right ${monoBody} ${textMuted}`}>
                {row.registerValue
                  ? formatIsoUs(row.registerValue.timestamp)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
