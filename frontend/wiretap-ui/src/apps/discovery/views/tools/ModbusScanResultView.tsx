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
import { useSessionStore } from "../../../../stores/sessionStore";
import {
  bgDataView,
  borderDefault,
  emptyStateContainer,
  emptyStateText,
  textMuted,
  textPrimary,
  textSecondary,
} from "../../../../styles";
import { Table } from "../../../../components/Table";
import { iconSm } from "../../../../styles/spacing";
import { getCaptureLatestFrames } from "../../../../api/capture";
import { bytesToHex } from "../../../../utils/byteUtils";
import { interpretPair, interpretRegister, type WordOrder } from "../../../../utils/modbusValues";
import CheckboxField from "../../../../components/forms/CheckboxField";
import { Button, IconButton } from "../../../../components/Button";
import { Select } from "../../../../components/forms";

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

  // While Discovery is joined to this sweep, its frame count moves as registers land,
  // and each move re-reads the newest value per register from the sweep's capture.
  const isLive = sessionId === currentSessionId;
  const liveCaptureId = useSessionStore((s) => (isLive ? s.sessions[sessionId]?.capture.id ?? null : null));
  const frameCount = useSessionStore((s) => (isLive ? s.sessions[sessionId]?.frameCount ?? 0 : 0));
  const readCaptureId = captureId ?? liveCaptureId;
  const [byAddress, setByAddress] = useState<Map<number, ScanRow>>(EMPTY_ROWS);

  useEffect(() => {
    if (!readCaptureId) {
      setByAddress(EMPTY_ROWS);
      return;
    }
    let cancelled = false;
    // One row per register, reduced in SQLite: a sweep writes each register once
    // *per pass*, so asking for every row would ship 20× the data for the same
    // table. See `getCaptureLatestFrames`.
    getCaptureLatestFrames(readCaptureId)
      .then((frames) => {
        if (cancelled) return;
        setByAddress(
          new Map(frames.map((f) => [f.frame_id, { address: f.frame_id, bytes: f.bytes, bus: f.bus }]))
        );
      })
      .catch(() => {
        // A capture that has been cleaned up leaves the tab empty, not broken.
        if (!cancelled) setByAddress(EMPTY_ROWS);
      });
    return () => {
      cancelled = true;
    };
  }, [readCaptureId, frameCount]);

  // A repeated sweep writes each register once per pass; the table shows the
  // current value, and what changed between passes is the Changes tool's job.
  const rows = useMemo(() => [...byAddress.values()].sort((a, b) => a.address - b.address), [byAddress]);

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
                <Select
                  value={wordOrder}
                  onChange={(e) => setWordOrder(e.target.value as WordOrder)}
                  className="w-auto"
                  title={t("modbusScan.wordOrder")}
                >
                  <option value="big">{t("modbusScan.wordOrderBig")}</option>
                  <option value="little">{t("modbusScan.wordOrderLittle")}</option>
                </Select>
              )}
            </>
          )}
          {isScanning && onCancel && (
            <Button onClick={onCancel} variant="ghost" tone="danger" size="sm">
              {t("modbusScan.cancel")}
            </Button>
          )}
          {!isScanning && (
            <IconButton onClick={onClose} size="sm" title={t("modbusScan.close")}>
              <X className={iconSm} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isScanning && progress && progress.total > 0 && (
        <div className="h-1 bg-surface">
          <div
            className="h-full bg-text-purple transition-all duration-200"
            style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }}
          />
        </div>
      )}

      {/* Diagnoses — a silent function code is a finding, not an error */}
      {notes.length > 0 && (
        <div className={`px-4 py-1.5 border-b ${borderDefault} space-y-0.5`}>
          {notes.map((note, i) => (
            <p key={i} className="text-xs text-warning">
              {note}
            </p>
          ))}
        </div>
      )}

      {/* Results table */}
      <div className={`flex-1 overflow-auto ${bgDataView}`}>
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
          <Table sticky hover>
            <thead>
              <tr>
                <th>{t("modbusScan.tableUnitId")}</th>
                <th>{t("modbusScan.tableVendor")}</th>
                <th>{t("modbusScan.tableProduct")}</th>
                <th>{t("modbusScan.tableRevision")}</th>
                <th>{t("modbusScan.tableData")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const info = deviceInfo.get(row.bus);
                return (
                  <tr key={`${row.address}-${row.bus}`}>
                    <td className={`font-mono ${textSecondary}`}>{row.bus}</td>
                    <td>{info?.vendor ?? t("modbusScan.noValue")}</td>
                    <td className={textSecondary}>{info?.product_code ?? t("modbusScan.noValue")}</td>
                    <td className={textMuted}>{info?.revision ?? t("modbusScan.noValue")}</td>
                    <td className={`font-mono ${textMuted}`}>
                      {row.bytes.length > 0 ? bytesToHex(row.bytes) : t("modbusScan.noValue")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Table mono sticky hover>
            <thead>
              <tr>
                <th>{t("modbusScan.tableRegister")}</th>
                <th>{t("modbusScan.tableHex")}</th>
                <th>{t("modbusScan.tableU16")}</th>
                <th>{t("modbusScan.tableS16")}</th>
                <th>{t("modbusScan.tableAscii")}</th>
                {showWide && (
                  <>
                    <th>{t("modbusScan.tableU32")}</th>
                    <th>{t("modbusScan.tableS32")}</th>
                    <th>{t("modbusScan.tableF32")}</th>
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
                  <tr key={`${row.bus}-${row.address}`}>
                    <td>{row.address}</td>
                    <td className={textMuted}>{v.hex}</td>
                    <td className={textSecondary}>{v.u16}</td>
                    <td className={textSecondary}>{v.s16}</td>
                    <td className={textMuted}>{v.ascii}</td>
                    {showWide && (
                      <>
                        <td className={textSecondary}>{wide?.u32 ?? ""}</td>
                        <td className={textSecondary}>{wide?.s32 ?? ""}</td>
                        <td className={textMuted}>
                          {wide ? formatFloat(wide.f32) : ""}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
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
