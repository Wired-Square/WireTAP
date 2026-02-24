// ui/src/dialogs/csv-column-mapper/CsvColumnMapperDialog.tsx
//
// Dialog for mapping CSV columns to CAN frame fields before import.
// Shows a preview of the CSV data with dropdown selectors per column.

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2 } from "lucide-react";
import Dialog from "../../components/Dialog";
import { DialogFooter } from "../../components/forms/DialogFooter";
import PreviewTable from "./PreviewTable";
import {
  previewCsv,
  importCsvWithMapping,
  type CsvPreview,
  type CsvColumnMapping,
  type CsvColumnRole,
  type TimestampUnit,
  type BufferMetadata,
} from "../../api/buffer";
import {
  h3,
  cardElevated,
  paddingCard,
  caption,
  errorBoxCompact,
  textMuted,
  bgSurface,
  borderDefault,
  textSecondary,
  textDataPurple,
} from "../../styles";
import { iconMd } from "../../styles/spacing";

export type CsvColumnMapperDialogProps = {
  isOpen: boolean;
  filePath: string;
  onCancel: () => void;
  /** Called when import succeeds — returns the buffer metadata */
  onImportComplete: (metadata: BufferMetadata) => void;
};

export default function CsvColumnMapperDialog({
  isOpen,
  filePath,
  onCancel,
  onImportComplete,
}: CsvColumnMapperDialogProps) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mappings, setMappings] = useState<CsvColumnMapping[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timestampUnit, setTimestampUnit] = useState<TimestampUnit>("microseconds");
  const [negateTimestamps, setNegateTimestamps] = useState(false);
  const [showImportedTs, setShowImportedTs] = useState(false);

  // Extract filename from path
  const filename = filePath.split(/[/\\]/).pop() ?? filePath;

  // Load preview when dialog opens
  useEffect(() => {
    if (!isOpen || !filePath) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    previewCsv(filePath, 20)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setMappings(data.suggested_mappings);
        setHasHeader(data.has_header);
        setTimestampUnit(data.suggested_timestamp_unit);
        setNegateTimestamps(data.has_negative_timestamps);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, filePath]);

  // Handle header toggle — shift rows and re-run suggestions
  const handleHeaderToggle = useCallback(
    (checked: boolean) => {
      if (!preview) return;
      setHasHeader(checked);
      setIsLoading(true);
      setError(null);

      // Re-preview to recalculate suggestions with/without header
      // The backend always does its own detection, but we override has_header
      previewCsv(filePath, 20)
        .then((data) => {
          // Use the user's choice for has_header, but adjust data accordingly
          if (checked && !data.has_header) {
            // User says it's a header but backend disagrees — treat first data row as header
            const newHeaders = data.rows[0] ?? null;
            const newRows = data.rows.slice(1);
            setPreview({
              ...data,
              headers: newHeaders,
              rows: newRows,
              has_header: true,
              total_rows: data.total_rows - 1,
            });
            // Re-suggest with the user-chosen headers
            // Use the backend suggestions as a baseline since we can't run heuristics client-side
            setMappings(data.suggested_mappings);
          } else if (!checked && data.has_header) {
            // User says no header but backend detected one — include header as data row
            const newRows = data.headers
              ? [data.headers, ...data.rows]
              : data.rows;
            setPreview({
              ...data,
              headers: null,
              rows: newRows,
              has_header: false,
              total_rows: data.total_rows + 1,
            });
            setMappings(data.suggested_mappings);
          } else {
            // Agreement between user and backend
            setPreview(data);
            setMappings(data.suggested_mappings);
          }
          setTimestampUnit(data.suggested_timestamp_unit);
          setNegateTimestamps(data.has_negative_timestamps);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [filePath, preview]
  );

  // Handle column role change
  const handleMappingChange = useCallback(
    (columnIndex: number, role: CsvColumnRole) => {
      setMappings((prev) =>
        prev.map((m) =>
          m.column_index === columnIndex ? { ...m, role } : m
        )
      );
    },
    []
  );

  // Import with current mappings
  const handleImport = useCallback(async () => {
    setIsImporting(true);
    setError(null);

    try {
      const metadata = await importCsvWithMapping(filePath, mappings, hasHeader, timestampUnit, negateTimestamps);
      onImportComplete(metadata);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsImporting(false);
    }
  }, [filePath, mappings, hasHeader, timestampUnit, negateTimestamps, onImportComplete]);

  // Validation
  const hasFrameId = mappings.some((m) => m.role === "frame_id");
  const hasData =
    mappings.some((m) => m.role === "data_bytes") ||
    mappings.some((m) => m.role === "data_byte");
  const hasTimestamp = mappings.some((m) => m.role === "timestamp");
  const canImport = hasFrameId && !isLoading && !isImporting;

  // Estimated capture duration based on selected timestamp unit and preview data
  const estimatedDuration = useMemo(() => {
    if (!hasTimestamp || !preview || preview.rows.length < 2) return null;

    const tsColIndex = mappings.find((m) => m.role === "timestamp")?.column_index;
    if (tsColIndex === undefined) return null;

    const timestamps = preview.rows
      .map((row) => row[tsColIndex])
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));

    if (timestamps.length < 2) return null;

    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    const range = Math.abs(max - min);

    let durationSecs: number;
    switch (timestampUnit) {
      case "seconds":
        durationSecs = range;
        break;
      case "milliseconds":
        durationSecs = range / 1_000;
        break;
      case "microseconds":
        durationSecs = range / 1_000_000;
        break;
      case "nanoseconds":
        durationSecs = range / 1_000_000_000;
        break;
    }

    if (durationSecs < 1) return `${Math.round(durationSecs * 1000)} ms`;
    if (durationSecs < 60) return `${durationSecs.toFixed(1)} s`;
    if (durationSecs < 3600) return `${(durationSecs / 60).toFixed(1)} min`;
    if (durationSecs < 86400) return `${(durationSecs / 3600).toFixed(1)} h`;
    return `${(durationSecs / 86400).toFixed(1)} d`;
  }, [hasTimestamp, preview, mappings, timestampUnit]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onCancel} maxWidth="max-w-4xl">
      <div className={`${cardElevated} ${paddingCard} space-y-4`}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className={h3}>Map CSV Columns</h3>
            <div className={caption}>
              {filename}
              {preview && (
                <span className={`ml-2 ${textMuted}`}>
                  · {preview.total_rows.toLocaleString()} rows
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Header toggle */}
        <label className={`flex items-center gap-2 ${caption} cursor-pointer select-none`}>
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => handleHeaderToggle(e.target.checked)}
            disabled={isLoading}
            className="accent-blue-500"
          />
          <span>First row is a header</span>
        </label>

        {/* Preview table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8 gap-2">
            <Loader2 className={`${iconMd} animate-spin ${textMuted}`} />
            <span className={textMuted}>Loading preview...</span>
          </div>
        ) : preview ? (
          <>
            <PreviewTable
              headers={hasHeader ? preview.headers : null}
              rows={preview.rows}
              mappings={mappings}
              hasHeader={hasHeader}
              onMappingChange={handleMappingChange}
              timestampUnit={timestampUnit}
              negateTimestamps={negateTimestamps}
              showImportedTs={showImportedTs}
            />

            {/* Timestamp options */}
            {hasTimestamp && (
              <div className={`flex items-center gap-3 flex-wrap ${bgSurface} border ${borderDefault} rounded px-3 py-2`}>
                <button
                  type="button"
                  onClick={() => setShowImportedTs((v) => !v)}
                  className={`px-2 py-0.5 text-xs rounded border ${borderDefault} ${bgSurface} ${showImportedTs ? textDataPurple : textMuted} hover:brightness-90 transition-colors`}
                >
                  {showImportedTs ? "Raw" : "Preview"}
                </button>
                <label className={`text-xs ${textSecondary} whitespace-nowrap`}>
                  Timestamp unit
                </label>
                <select
                  value={timestampUnit}
                  onChange={(e) => setTimestampUnit(e.target.value as TimestampUnit)}
                  className={`text-xs px-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textSecondary} focus:outline-none`}
                >
                  <option value="seconds">Seconds</option>
                  <option value="milliseconds">Milliseconds</option>
                  <option value="microseconds">Microseconds</option>
                  <option value="nanoseconds">Nanoseconds</option>
                </select>
                {estimatedDuration && (
                  <span className={`text-xs ${textMuted}`}>
                    ≈ {estimatedDuration} estimated duration
                  </span>
                )}
                <label className={`flex items-center gap-1.5 text-xs ${textSecondary} cursor-pointer select-none ml-auto`}>
                  <input
                    type="checkbox"
                    checked={negateTimestamps}
                    onChange={(e) => setNegateTimestamps(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>Negate timestamps</span>
                </label>
              </div>
            )}

            {/* Validation hints */}
            {!hasFrameId && (
              <div className={`text-xs text-amber-600 ${bgSurface} border ${borderDefault} rounded px-3 py-2`}>
                Assign a <strong>Frame ID</strong> column to continue
              </div>
            )}
            {hasFrameId && !hasData && (
              <div className={`text-xs ${textSecondary} ${bgSurface} border ${borderDefault} rounded px-3 py-2`}>
                No data columns assigned — frames will be imported with empty payloads
              </div>
            )}
          </>
        ) : null}

        {/* Error display */}
        {error && <div className={errorBoxCompact}>{error}</div>}

        {/* Footer */}
        <DialogFooter
          onCancel={onCancel}
          onConfirm={handleImport}
          confirmLabel={isImporting ? "Importing..." : "Import"}
          confirmDisabled={!canImport}
        />
      </div>
    </Dialog>
  );
}
