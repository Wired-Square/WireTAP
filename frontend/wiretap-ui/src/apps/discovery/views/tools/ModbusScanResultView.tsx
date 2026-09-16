// ui/src/apps/discovery/views/tools/ModbusScanResultView.tsx
//
// A discovered register map is unreadable as raw hex. The whole point of the
// scan is to spot that 0x0938 next to a 0x01F4 is 236.0 V beside 50.0 Hz, and
// that needs the same value shown several ways at once — which is exactly what
// the throwaway scripts this feature replaces printed.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ModbusScanResults } from "../../../../stores/discoveryToolboxStore";
import {
  useDiscoveryFrameStore,
  getLastFrameDataMap,
} from "../../../../stores/discoveryFrameStore";
import {
  bgDataView,
  borderDefault,
  emptyStateContainer,
  emptyStateText,
  resultCell as td,
  resultHeaderCell as th,
  textMuted,
  textPrimary,
  textSecondary,
} from "../../../../styles";
import { iconSm } from "../../../../styles/spacing";
import { getCaptureLatestFrames } from "../../../../api/capture";
import { bytesToHex } from "../../../../utils/byteUtils";
import { parseFrameKey } from "../../../../utils/frameKey";
import { interpretPair, interpretRegister, type WordOrder } from "../../../../utils/modbusValues";
import CheckboxField from "../../../../components/forms/CheckboxField";

type Props = {
  results: ModbusScanResults;
  /** The session Discovery is showing, to tell "my frames" from a later sweep's. */
  currentSessionId: string;
  onClose: () => void;
  onCancel?: () => void;
};

/** One discovered address and its most recent value. */
type ScanRow = { address: number; bytes: number[]; bus: number };

const EMPTY_ROWS = new Map<number, ScanRow>();

/** The Modbus registers currently in the shared frame store, newest value per address. */
function liveModbusRows(): Map<number, ScanRow> {
  const byAddress = new Map<number, ScanRow>();
  for (const [key, data] of getLastFrameDataMap()) {
    const { protocol, frameId } = parseFrameKey(key);
    if (protocol !== "modbus") continue;
    byAddress.set(frameId, { address: frameId, bytes: data.bytes, bus: data.bus });
  }
  return byAddress;
}


export default function ModbusScanResultView({
  results,
  currentSessionId,
  onClose,
  onCancel,
}: Props) {
  const { t } = useTranslation("discovery");
  const { scanType, isScanning, progress, deviceInfo, notes, sessionId, captureId } = results;
  const hasDeviceInfo = deviceInfo.size > 0;

  const [wordOrder, setWordOrder] = useState<WordOrder>("big");
  const [showWide, setShowWide] = useState(false);

  /**
   * Whose frames are in the shared store right now.
   *
   * While Discovery is joined to this sweep, its registers stream into the
   * shared frame store like any other source's, and the store already keeps the
   * latest value per key, maintained incrementally on each flush — reading that
   * is free, and it is what makes the table fill live. Start a second sweep and
   * the store is cleared and refilled with *that* one's registers, so this tab
   * has to fall back to the capture it wrote, or it would silently show the
   * newer sweep's values under the older sweep's heading.
   */
  const isLive = sessionId === currentSessionId;
  // Subscribed only while this sweep owns the frame store. A finished tab that
  // kept the subscription would rebuild its whole table on every flush of an
  // unrelated session, twice a second, for a result that cannot change.
  const frameVersion = useDiscoveryFrameStore((s) => (isLive ? s.frameVersion : 0));
  const [captured, setCaptured] = useState<Map<number, ScanRow>>(EMPTY_ROWS);

  useEffect(() => {
    if (isLive || !captureId) return;
    let cancelled = false;
    // One row per register, reduced in SQLite: a sweep writes each register once
    // *per pass*, so asking for every row would ship 20× the data for the same
    // table. See `getCaptureLatestFrames`.
    getCaptureLatestFrames(captureId)
      .then((frames) => {
        if (cancelled) return;
        setCaptured(
          new Map(frames.map((f) => [f.frame_id, { address: f.frame_id, bytes: f.bytes, bus: f.bus }]))
        );
      })
      .catch(() => {
        // A capture that has been cleaned up leaves the tab empty, not broken.
        if (!cancelled) setCaptured(EMPTY_ROWS);
      });
    return () => {
      cancelled = true;
    };
  }, [isLive, captureId]);

  // A repeated sweep writes each register once per pass; the table shows the
  // current value, and what changed between passes is the Changes tool's job.
  const { rows, byAddress } = useMemo(() => {
    const byAddress = isLive ? liveModbusRows() : captured;
    const rows = [...byAddress.values()].sort((a, b) => a.address - b.address);
    return { rows, byAddress };
    // frameVersion is the store's reactivity counter for its mutable buffers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameVersion, isLive, captured]);

  // One line whichever phase the sweep is in. Before the first progress tick it
  // is empty — the tab opens with the sweep, so the table's own placeholder is
  // what speaks until the device answers.
  const status = !isScanning
    ? `${scanType === "register"
        ? t("modbusScan.registersFound", { count: rows.length })
        : t("modbusScan.devicesFound", { count: rows.length })}${
        hasDeviceInfo ? ` ${t("modbusScan.identified", { count: deviceInfo.size })}` : ""
      }`
    : progress
      ? `${t("modbusScan.scanningProgress", {
          current: progress.current,
          total: progress.total,
          found: progress.found_count,
        })}${
          progress.total_passes > 1
            ? ` ${t("modbusScan.passOf", { pass: progress.pass, total: progress.total_passes })}`
            : ""
        }`
      : "";

  return (
    <div className={`flex flex-col h-full ${bgDataView}`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${borderDefault}`}>
        <div className="flex items-center gap-3">
          <h3 className={`text-sm font-medium ${textPrimary}`}>
            {scanType === "register"
              ? t("modbusScan.registerScanTitle")
              : t("modbusScan.unitIdScanTitle")}
          </h3>
          <span className={`text-xs ${textMuted}`}>{status}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {scanType === "register" && rows.length > 0 && (
            <>
              <CheckboxField
                checked={showWide}
                onChange={setShowWide}
                label={t("modbusScan.show32Bit")}
                labelClass={textMuted}
              />
              {showWide && (
                <select
                  value={wordOrder}
                  onChange={(e) => setWordOrder(e.target.value as WordOrder)}
                  className={`px-1 py-0.5 rounded border ${borderDefault} bg-[var(--bg-surface)] ${textSecondary}`}
                  title={t("modbusScan.wordOrder")}
                >
                  <option value="big">{t("modbusScan.wordOrderBig")}</option>
                  <option value="little">{t("modbusScan.wordOrderLittle")}</option>
                </select>
              )}
            </>
          )}
          {isScanning && onCancel && (
            <button
              onClick={onCancel}
              className={`px-2 py-0.5 rounded hover:bg-red-600 hover:text-white transition-colors ${textMuted}`}
            >
              {t("modbusScan.cancel")}
            </button>
          )}
          {!isScanning && (
            <button onClick={onClose} className={`${textMuted} hover:${textPrimary}`} title={t("modbusScan.close")}>
              <X className={iconSm} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isScanning && progress && progress.total > 0 && (
        <div className="h-1 bg-[var(--bg-surface)]">
          <div
            className="h-full bg-purple-500 transition-all duration-200"
            style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }}
          />
        </div>
      )}

      {/* Diagnoses — a silent function code is a finding, not an error */}
      {notes.length > 0 && (
        <div className={`px-4 py-1.5 border-b ${borderDefault} space-y-0.5`}>
          {notes.map((note, i) => (
            <p key={i} className="text-xs text-amber-500">
              {note}
            </p>
          ))}
        </div>
      )}

      {/* Results table */}
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className={emptyStateContainer}>
            <p className={emptyStateText}>
              {!isScanning
                ? t("modbusScan.noResults")
                : progress
                  ? t("modbusScan.scanning")
                  : t("modbusScan.connecting")}
            </p>
          </div>
        ) : scanType === "unit-id" ? (
          <table className="w-full text-xs">
            <thead className={`sticky top-0 ${bgDataView}`}>
              <tr className={`border-b ${borderDefault}`}>
                <th className={th}>{t("modbusScan.tableUnitId")}</th>
                <th className={th}>{t("modbusScan.tableVendor")}</th>
                <th className={th}>{t("modbusScan.tableProduct")}</th>
                <th className={th}>{t("modbusScan.tableRevision")}</th>
                <th className={th}>{t("modbusScan.tableData")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const info = deviceInfo.get(row.bus);
                return (
                  <tr
                    key={`${row.address}-${row.bus}`}
                    className="border-b border-[color:var(--border-default)]/30 hover:bg-[var(--bg-surface)]"
                  >
                    <td className={td(textSecondary)}>{row.bus}</td>
                    <td className={`px-3 py-1 ${textPrimary}`}>{info?.vendor ?? t("modbusScan.noValue")}</td>
                    <td className={`px-3 py-1 ${textSecondary}`}>{info?.product_code ?? t("modbusScan.noValue")}</td>
                    <td className={`px-3 py-1 ${textMuted}`}>{info?.revision ?? t("modbusScan.noValue")}</td>
                    <td className={td(textMuted)}>
                      {row.bytes.length > 0 ? bytesToHex(row.bytes) : t("modbusScan.noValue")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs">
            <thead className={`sticky top-0 ${bgDataView}`}>
              <tr className={`border-b ${borderDefault}`}>
                <th className={th}>{t("modbusScan.tableRegister")}</th>
                <th className={th}>{t("modbusScan.tableHex")}</th>
                <th className={th}>{t("modbusScan.tableU16")}</th>
                <th className={th}>{t("modbusScan.tableS16")}</th>
                <th className={th}>{t("modbusScan.tableAscii")}</th>
                {showWide && (
                  <>
                    <th className={th}>{t("modbusScan.tableU32")}</th>
                    <th className={th}>{t("modbusScan.tableS32")}</th>
                    <th className={th}>{t("modbusScan.tableF32")}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const v = interpretRegister(row.bytes);
                // The 32-bit reading pairs this register with the next one, and
                // only means anything if that neighbour was actually found.
                const next = byAddress.get(row.address + 1);
                const wide = next ? interpretPair(row.bytes, next.bytes, wordOrder) : null;
                return (
                  <tr
                    key={`${row.bus}-${row.address}`}
                    className="border-b border-[color:var(--border-default)]/30 hover:bg-[var(--bg-surface)]"
                  >
                    <td className={td(textPrimary)}>{row.address}</td>
                    <td className={td(textMuted)}>{v.hex}</td>
                    <td className={td(textSecondary)}>{v.u16}</td>
                    <td className={td(textSecondary)}>{v.s16}</td>
                    <td className={td(textMuted)}>{v.ascii}</td>
                    {showWide && (
                      <>
                        <td className={td(textSecondary)}>{wide?.u32 ?? ""}</td>
                        <td className={td(textSecondary)}>{wide?.s32 ?? ""}</td>
                        <td className={td(textMuted)}>
                          {wide ? formatFloat(wide.f32) : ""}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Keep float columns narrow: absurd exponents are the tell-tale of a wrong word order. */
function formatFloat(f: number): string {
  if (!Number.isFinite(f)) return "—";
  const abs = Math.abs(f);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e9)) return f.toExponential(3);
  return f.toFixed(3);
}
