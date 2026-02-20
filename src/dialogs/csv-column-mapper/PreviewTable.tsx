// ui/src/dialogs/csv-column-mapper/PreviewTable.tsx
//
// Horizontal CSV preview table with column role dropdowns.
// Scrollable both horizontally (many columns) and vertically (many rows).
// Colour-coded by role: payload green, Frame ID cyan, metadata amber.

import type { CsvColumnRole, CsvColumnMapping } from "../../api/buffer";
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

type Props = {
  headers: string[] | null;
  rows: string[][];
  mappings: CsvColumnMapping[];
  hasHeader: boolean;
  onMappingChange: (columnIndex: number, role: CsvColumnRole) => void;
};

/** Max data rows to display in the preview */
const MAX_VISIBLE_ROWS = 10;

export default function PreviewTable({
  headers,
  rows,
  mappings,
  hasHeader,
  onMappingChange,
}: Props) {
  const numColumns = mappings.length;
  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS);

  return (
    <div className={`overflow-auto max-h-80 border ${borderDefault} rounded`}>
      <table className="text-xs border-collapse">
        {/* Role selector row */}
        <thead className={`sticky top-0 z-10 ${bgSurface}`}>
          <tr>
            <th className={`px-2 py-1.5 text-left border-b ${borderDefault} ${textMuted} font-normal whitespace-nowrap sticky left-0 ${bgSurface} z-20`}>
              #
            </th>
            {Array.from({ length: numColumns }, (_, colIdx) => {
              const mapping = mappings.find((m) => m.column_index === colIdx);
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
                      onMappingChange(colIdx, e.target.value as CsvColumnRole)
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
              <td className={`px-2 py-1 border-b ${borderDefault} ${textMuted} font-mono sticky left-0 ${bgSurface} z-20`}>
                H
              </td>
              {headers.map((header, colIdx) => {
                const mapping = mappings.find((m) => m.column_index === colIdx);
                const role = mapping?.role ?? "ignore";
                const isIgnored = role === "ignore";
                const colour = roleColour(role);
                return (
                  <td
                    key={colIdx}
                    className={`px-2 py-1 border-b ${borderDefault} ${colour} font-mono whitespace-nowrap ${isIgnored ? "opacity-40" : ""}`}
                    title={header}
                  >
                    {header}
                  </td>
                );
              })}
            </tr>
          )}
        </thead>
        {/* Data rows */}
        <tbody>
          {visibleRows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className="hover:brightness-95"
            >
              <td className={`px-2 py-0.5 border-b ${borderDefault} ${textMuted} font-mono sticky left-0 ${bgSurface} z-20`}>
                {rowIdx + 1}
              </td>
              {Array.from({ length: numColumns }, (_, colIdx) => {
                const mapping = mappings.find((m) => m.column_index === colIdx);
                const role = mapping?.role ?? "ignore";
                const isIgnored = role === "ignore";
                const colour = roleColour(role);
                const cellValue = row[colIdx] ?? "";
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
  );
}
