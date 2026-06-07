// ui/src/apps/modbus/views/ModbusRegistersView.tsx
//
// Register data table showing live Modbus register values with decoded signals.
// Filtered by selectedFrames (from FramePicker).

import { Fragment, useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { formatFrameId } from "../../../utils/frameIds";
import { parseFrameKey } from "../../../utils/frameKey";
import { bytesToAscii } from "../../../utils/byteUtils";
import { signalRegister, signalByteRange } from "../../../utils/modbusRegisters";
import { bgDataView, textPrimary, textMuted, textSecondary, borderDefault } from "../../../styles";
import { emptyStateText, monoBody } from "../../../styles/typography";
import { badgeSmallNeutral, badgeSmallInfo, badgeSmallSuccess, badgeSmallPurple, badgeSmallWarning } from "../../../styles/badgeStyles";
import { getRegisterValues, type RegisterValue } from "../stores/modbusStore";
import type { FrameDetail } from "../../../types/decoder";
import type { ModbusPollGroup } from "../../../utils/modbusPollBuilder";

export type ModbusTimeFormat = "seconds" | "human";

/** Format milliseconds as seconds ("5.0s") or human ("5m 9s") */
function formatDuration(ms: number, fmt: ModbusTimeFormat): string {
  const totalSeconds = Math.round(ms / 1000);
  if (fmt === "seconds") {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Format register bytes as spaced lowercase hex, or printable ASCII between pipes */
function formatRawBytes(bytes: number[], format: "hex" | "ascii"): string {
  return format === "ascii"
    ? `|${bytesToAscii(bytes)}|`
    : bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/** Format a microsecond timestamp as relative time from now */
function formatElapsed(timestampUs: number, nowMs: number, fmt: ModbusTimeFormat): string {
  const elapsedMs = nowMs - timestampUs / 1000;
  if (elapsedMs < 500) return 'now';
  return formatDuration(elapsedMs, fmt);
}

interface Props {
  frames: Map<string, FrameDetail>;
  selectedFrames: Set<string>;
  pollGroups: ModbusPollGroup[];
  registerVersion: number;
  displayFrameIdFormat: "hex" | "decimal";
  timeFormat: ModbusTimeFormat;
  rawFormat: "hex" | "ascii";
  splitRegisters: boolean;
}

type RegisterRow = {
  frameKey: string;
  numericId: number;
  frameDef: FrameDetail;
  registerValue: RegisterValue | undefined;
  pollGroup: ModbusPollGroup | undefined;
};

const TYPE_BADGE: Record<string, string> = {
  holding: badgeSmallInfo,
  input: badgeSmallSuccess,
  coil: badgeSmallWarning,
  discrete: badgeSmallPurple,
};

export default function ModbusRegistersView({
  frames,
  selectedFrames,
  pollGroups,
  registerVersion,
  displayFrameIdFormat,
  timeFormat,
  rawFormat,
  splitRegisters,
}: Props) {
  const { t } = useTranslation("modbus");
  // Tick every second to update relative timestamps
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  const typeBadge = (row: RegisterRow) =>
    row.pollGroup ? (
      <span className={TYPE_BADGE[row.pollGroup.register_type] ?? badgeSmallNeutral}>
        {row.pollGroup.register_type}
      </span>
    ) : (
      <span className={textMuted}>—</span>
    );
  const intervalCell = (row: RegisterRow) =>
    row.pollGroup?.interval_ms ? formatDuration(row.pollGroup.interval_ms, timeFormat) : '—';
  const lastUpdateCell = (row: RegisterRow) =>
    row.registerValue ? formatElapsed(row.registerValue.timestamp, nowMs, timeFormat) : '—';
  const decodedSpan = (value: string, unit?: string, key?: number) => (
    <span key={key} className="whitespace-nowrap">
      <span className="text-[color:var(--text-data-primary)]">{value}</span>
      {unit && <span className={`ml-0.5 ${textMuted}`}>{unit}</span>}
    </span>
  );

  // One row per frame (grouped) — the default presentation.
  const renderFrameRow = (row: RegisterRow) => (
    <tr
      key={row.frameKey}
      className="border-b border-[color:var(--border-subtle)] hover:bg-[var(--bg-hover)]"
    >
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
      <td className="px-3 py-1.5">{typeBadge(row)}</td>
      <td className={`px-3 py-1.5 ${monoBody} ${textMuted}`}>
        {row.registerValue ? formatRawBytes(row.registerValue.bytes, rawFormat) : '—'}
      </td>
      <td className={`px-3 py-1.5 ${textPrimary}`}>
        {row.registerValue && row.registerValue.decoded.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {row.registerValue.decoded.map((sig, i) => decodedSpan(sig.value, sig.unit, i))}
          </div>
        ) : (
          <span className={textMuted}>—</span>
        )}
      </td>
      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${textMuted}`}>{intervalCell(row)}</td>
      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${textMuted}`}>{lastUpdateCell(row)}</td>
    </tr>
  );

  // Split mode: a group header per frame, then one row per signal at its real register.
  const renderSplitGroup = (row: RegisterRow) => {
    const bytes = row.registerValue?.bytes;
    return (
      <Fragment key={row.frameKey}>
        <tr className="border-b border-[color:var(--border-subtle)] bg-[var(--bg-surface)]">
          <td colSpan={6} className={`px-3 py-1 ${monoBody} ${textMuted}`}>
            <span className={textSecondary}>{formatFrameId(row.numericId, displayFrameIdFormat)}</span>
            {row.frameDef.name && <span className="ml-2 font-sans">{row.frameDef.name}</span>}
          </td>
        </tr>
        {row.frameDef.signals.map((sig, i) => {
          const reg = signalRegister(row.numericId, sig.start_bit ?? 0);
          const { start, length } = signalByteRange(sig.start_bit ?? 0, sig.bit_length ?? 16);
          const slice = bytes?.slice(start, start + length);
          const dec = row.registerValue?.decoded[i];
          return (
            <tr
              key={`${row.frameKey}:${i}`}
              className="border-b border-[color:var(--border-subtle)] hover:bg-[var(--bg-hover)] border-l-2 border-l-[color:var(--accent-purple)]"
            >
              <td className={`px-3 py-1.5 ${monoBody} ${textPrimary}`}>
                {formatFrameId(reg, displayFrameIdFormat)}
                {sig.name && <span className={`ml-2 ${textMuted} font-sans`}>{sig.name}</span>}
              </td>
              <td className="px-3 py-1.5">{typeBadge(row)}</td>
              <td className={`px-3 py-1.5 ${monoBody} ${textMuted}`}>
                {slice && slice.length > 0 ? formatRawBytes(slice, rawFormat) : '—'}
              </td>
              <td className={`px-3 py-1.5 ${textPrimary}`}>
                {dec ? decodedSpan(dec.value, dec.unit) : <span className={textMuted}>—</span>}
              </td>
              <td className={`px-3 py-1.5 text-right whitespace-nowrap ${textMuted}`}>{intervalCell(row)}</td>
              <td className={`px-3 py-1.5 text-right whitespace-nowrap ${textMuted}`}>{lastUpdateCell(row)}</td>
            </tr>
          );
        })}
      </Fragment>
    );
  };

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
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>{t("registers.columns.register")}</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>{t("registers.columns.type")}</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>{t("registers.columns.raw")}</th>
            <th className={`px-3 py-1.5 text-left font-medium ${textSecondary}`}>{t("registers.columns.signals")}</th>
            <th className={`px-3 py-1.5 text-right font-medium ${textSecondary}`}>{t("registers.columns.interval")}</th>
            <th className={`px-3 py-1.5 text-right font-medium ${textSecondary}`}>{t("registers.columns.lastUpdate")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => splitRegisters ? renderSplitGroup(row) : renderFrameRow(row))}
        </tbody>
      </table>
    </div>
  );
}
