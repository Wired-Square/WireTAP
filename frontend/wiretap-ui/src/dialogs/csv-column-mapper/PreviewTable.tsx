// ui/src/dialogs/csv-column-mapper/PreviewTable.tsx
//
// Horizontal CSV preview table with column role dropdowns.
// Scrollable both horizontally (many columns) and vertically (many rows).
// Colour-coded by role: payload green, Frame ID cyan, metadata amber.
// Shows scroll-edge shadows when content overflows horizontally.

import { useRef, useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CsvColumnRole, CsvColumnMapping } from "../../api/capture";
import {
  textMuted,
  textDataGreen,
  textDataCyan,
  textDataPurple,
  textDataOrange,
  textDataAmber,
} from "../../styles";
import { Select } from "../../components/forms";
import { Card } from "../../components/Card";
import { Table } from "../../components/Table";

const ROLE_KEYS: CsvColumnRole[] = [
  "ignore",
  "frame_id",
  "frame_id_data",
  "timestamp",
  "data_bytes",
  "data_byte",
  "dlc",
  "extended",
  "bus",
  "direction",
  "sequence",
];

/** Map column role to a text colour class */
function roleColour(role: CsvColumnRole): string {
  switch (role) {
    case "frame_id":
      return textDataCyan;
    case "frame_id_data":
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
    case "sequence":
      return textDataAmber;
    case "ignore":
    default:
      return textMuted;
  }
}

/** Format a duration in seconds to a compact string with microsecond precision.
 *  Separates ms and µs groups with a comma: `0.247,307 s` */
export function formatOffset(secs: number): string {
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

type Props = {
  headers: string[] | null;
  rows: string[][];
  mappings: CsvColumnMapping[];
  hasHeader: boolean;
  onMappingChange: (columnIndex: number, role: CsvColumnRole) => void;
  /** The importer's stamp for each row, shown in the timestamp column when set. */
  importedTimestampsUs: number[] | null;
};

/** Max data rows to display in the preview */
const MAX_VISIBLE_ROWS = 10;

export default function PreviewTable({
  headers,
  rows,
  mappings,
  hasHeader,
  onMappingChange,
  importedTimestampsUs,
}: Props) {
  const { t } = useTranslation("dialogs");
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

  const showImportedTs = importedTimestampsUs !== null && tsColIndex !== undefined;

  const getCellValue = (row: string[], colIdx: number, rowIdx: number): string => {
    const us = importedTimestampsUs?.[rowIdx];
    if (showImportedTs && colIdx === tsColIndex && us !== undefined) return formatOffset(us / 1_000_000);
    return row[colIdx] ?? "";
  };

  return (
    <div className="relative">
      <Card ref={scrollRef} padding="none" onScroll={updateScrollState} className="overflow-auto max-h-80">
        <Table size="sm" mono sticky hover className="whitespace-nowrap">
          {/* Role selector row */}
          <thead>
            <tr>
              <th className="table__pin">#</th>
              {Array.from({ length: numColumns }, (_, colIdx) => {
                const mapping = mappings.find(
                  (m) => m.column_index === colIdx
                );
                const role = mapping?.role ?? "ignore";
                const isIgnored = role === "ignore";
                return (
                  <th key={colIdx} className={`px-1 ${isIgnored ? "opacity-40" : ""}`}>
                    <Select
                      value={role}
                      onChange={(e) =>
                        onMappingChange(
                          colIdx,
                          e.target.value as CsvColumnRole
                        )
                      }
                      size="sm"
                      className="min-w-24"
                    >
                      {ROLE_KEYS.map((roleKey) => (
                        <option key={roleKey} value={roleKey}>
                          {t(`csvColumnMapperPreview.roles.${roleKey}`)}
                        </option>
                      ))}
                    </Select>
                  </th>
                );
              })}
            </tr>
            {/* Header row (if present) */}
            {hasHeader && headers && (
              <tr className="font-mono">
                <td className={`table__pin ${textMuted}`}>H</td>
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
                      className={`${colour} ${isIgnored ? "opacity-40" : ""}`}
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
              <tr key={rowIdx}>
                <td className={`table__pin ${textMuted}`}>{rowIdx + 1}</td>
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
                      className={`${colour} ${isIgnored ? "opacity-40" : ""}`}
                      title={cellValue}
                    >
                      {cellValue}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
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
