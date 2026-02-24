// ui/src/dialogs/csv-column-mapper/PreviewTable.tsx
//
// Horizontal CSV preview table with column role dropdowns.
// Scrollable both horizontally (many columns) and vertically (many rows).
// Colour-coded by role: payload green, Frame ID cyan, metadata amber.
// Shows scroll-edge shadows when content overflows horizontally.

import { useRef, useState, useCallback, useEffect } from "react";
import type {
  CsvColumnRole,
  CsvColumnMapping,
  TimestampUnit,
} from "../../api/buffer";
import {
  bgSurface,
  textSecondary,
  borderDefault,
  textMuted,
  textDataGreen,
  textDataCyan,
  textDataPurple,
  textDataOrange,
  textDataAmber,
} from "../../styles";

const ROLE_OPTIONS: { value: CsvColumnRole; label: string }[] = [
  { value: "ignore", label: "Ignore" },
  { value: "frame_id", label: "Frame ID" },
  { value: "timestamp", label: "Timestamp" },
  { value: "data_bytes", label: "Data (hex string)" },
  { value: "data_byte", label: "Data Byte" },
  { value: "dlc", label: "DLC / Length" },
  { value: "extended", label: "Extended Flag" },
  { value: "bus", label: "Bus" },
  { value: "direction", label: "Direction" },
];

/** Map column role to a text colour class */
function roleColour(role: CsvColumnRole): string {
  switch (role) {
    case "frame_id":
      return textDataCyan;
    case "data_bytes":
    case "data_byte":
      return textDataGreen;
    case "timestamp":
      return textDataPurple;
    case "dlc":
      return textDataOrange;
    case "bus":
    case "extended":
    case "direction":
      return textDataAmber;
    case "ignore":
    default:
      return textMuted;
  }
}

/** Format a duration in seconds to a compact string with microsecond precision.
 *  Separates ms and µs groups with a comma: `0.247,307 s` */
function formatOffset(secs: number): string {
  if (secs < 60) {
    const fixed = secs.toFixed(6);
    // Insert a thin space between the ms and µs groups: "0.247307" → "0.247 307"
    const dot = fixed.indexOf(".");
    if (dot !== -1 && fixed.length >= dot + 7) {
      return `${fixed.slice(0, dot + 4)},${fixed.slice(dot + 4)} s`;
    }
    return `${fixed} s`;
  }
  if (secs < 3600) return `${(secs / 60).toFixed(3)} min`;
  if (secs < 86400) return `${(secs / 3600).toFixed(3)} h`;
  return `${(secs / 86400).toFixed(3)} d`;
}

const UNIT_DIVISORS: Record<TimestampUnit, number> = {
  seconds: 1,
  milliseconds: 1_000,
  microseconds: 1_000_000,
  nanoseconds: 1_000_000_000,
};

type Props = {
  headers: string[] | null;
  rows: string[][];
  mappings: CsvColumnMapping[];
  hasHeader: boolean;
  onMappingChange: (columnIndex: number, role: CsvColumnRole) => void;
  timestampUnit: TimestampUnit;
  negateTimestamps: boolean;
  showImportedTs: boolean;
};

/** Max data rows to display in the preview */
const MAX_VISIBLE_ROWS = 10;

export default function PreviewTable({
  headers,
  rows,
  mappings,
  hasHeader,
  onMappingChange,
  timestampUnit,
  negateTimestamps,
  showImportedTs,
}: Props) {
  const numColumns = mappings.length;
  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS);

  // --- Scroll shadow state ---
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState, mappings]);

  // --- Timestamp preview ---
  const tsColIndex = mappings.find((m) => m.role === "timestamp")
    ?.column_index;

  // Compute interpreted offsets for each visible row when preview is active
  const interpretedOffsets: string[] = (() => {
    if (!showImportedTs || tsColIndex === undefined) return [];
    const divisor = UNIT_DIVISORS[timestampUnit];
    const rawValues = visibleRows.map((row) => {
      const s = row[tsColIndex];
      if (!s) return NaN;
      const v = Number(s);
      return negateTimestamps ? Math.abs(v) : v;
    });
    const validValues = rawValues.filter((v) => !isNaN(v));
    if (validValues.length === 0) return rawValues.map(() => "—");
    const minVal = Math.min(...validValues);
    return rawValues.map((v) => {
      if (isNaN(v)) return "—";
      const offset = (v - minVal) / divisor;
      return formatOffset(offset);
    });
  })();

  /** Get the display value for a cell, substituting timestamp preview when active */
  const getCellValue = (row: string[], colIdx: number, rowIdx: number): string => {
    if (showImportedTs && colIdx === tsColIndex && interpretedOffsets[rowIdx]) {
      return interpretedOffsets[rowIdx];
    }
    return row[colIdx] ?? "";
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className={`overflow-auto max-h-80 border ${borderDefault} rounded`}
      >
        <table className="text-xs border-collapse">
          {/* Role selector row */}
          <thead className={`sticky top-0 z-10 ${bgSurface}`}>
            <tr>
              <th
                className={`px-2 py-1.5 text-left border-b ${borderDefault} ${textMuted} font-normal whitespace-nowrap sticky left-0 ${bgSurface} z-20`}
              >
                #
              </th>
              {Array.from({ length: numColumns }, (_, colIdx) => {
                const mapping = mappings.find(
                  (m) => m.column_index === colIdx
                );
                const role = mapping?.role ?? "ignore";
                const isIgnored = role === "ignore";
                return (
                  <th
                    key={colIdx}
                    className={`px-1 py-1.5 border-b ${borderDefault} ${isIgnored ? "opacity-40" : ""}`}
                  >
                    <select
                      value={role}
                      onChange={(e) =>
                        onMappingChange(
                          colIdx,
                          e.target.value as CsvColumnRole
                        )
                      }
                      className={`w-full min-w-24 px-1.5 py-1 text-xs rounded border ${borderDefault} ${bgSurface} ${textSecondary}`}
                    >
                      {ROLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </th>
                );
              })}
            </tr>
            {/* Header row (if present) */}
            {hasHeader && headers && (
              <tr className={bgSurface}>
                <td
                  className={`px-2 py-1 border-b ${borderDefault} ${textMuted} font-mono sticky left-0 ${bgSurface} z-20`}
                >
                  H
                </td>
                {headers.map((header, colIdx) => {
                  const mapping = mappings.find(
                    (m) => m.column_index === colIdx
                  );
                  const role = mapping?.role ?? "ignore";
                  const isIgnored = role === "ignore";
                  const colour = roleColour(role);
                  return (
                    <td
                      key={colIdx}
                      className={`px-2 py-1 border-b ${borderDefault} ${colour} font-mono whitespace-nowrap ${isIgnored ? "opacity-40" : ""}`}
                      title={header}
                    >
                      {showImportedTs && colIdx === tsColIndex
                        ? "Offset"
                        : header}
                    </td>
                  );
                })}
              </tr>
            )}
          </thead>
          {/* Data rows */}
          <tbody>
            {visibleRows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:brightness-95">
                <td
                  className={`px-2 py-0.5 border-b ${borderDefault} ${textMuted} font-mono sticky left-0 ${bgSurface} z-20`}
                >
                  {rowIdx + 1}
                </td>
                {Array.from({ length: numColumns }, (_, colIdx) => {
                  const mapping = mappings.find(
                    (m) => m.column_index === colIdx
                  );
                  const role = mapping?.role ?? "ignore";
                  const isIgnored = role === "ignore";
                  const colour = roleColour(role);
                  const cellValue = getCellValue(row, colIdx, rowIdx);
                  return (
                    <td
                      key={colIdx}
                      className={`px-2 py-0.5 border-b ${borderDefault} ${colour} font-mono whitespace-nowrap ${isIgnored ? "opacity-40" : ""}`}
                      title={cellValue}
                    >
                      {cellValue}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Scroll edge shadows */}
      {canScrollLeft && (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-black/15 to-transparent rounded-l" />
      )}
      {canScrollRight && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-black/15 to-transparent rounded-r" />
      )}
    </div>
  );
}
