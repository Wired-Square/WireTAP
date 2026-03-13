// ui/src/dialogs/csv-column-mapper/CsvColumnMapperDialog.tsx
//
// Dialog for mapping CSV columns to CAN frame fields before import.
// Shows a preview of the CSV data with dropdown selectors per column.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Copy, Check } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Dialog from "../../components/Dialog";
import { DialogFooter } from "../../components/forms/DialogFooter";
import PreviewTable from "./PreviewTable";
import {
  previewCsv,
  importCsvWithMapping,
  importCsvBatchWithMapping,
  type CsvPreview,
  type CsvColumnMapping,
  type CsvColumnRole,
  type TimestampUnit,
  type Delimiter,
  type BufferMetadata,
  type CsvImportResult,
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
import { iconMd, iconSm } from "../../styles/spacing";

/** Format import summary as plain text for copying */
function formatImportSummary(result: CsvImportResult, fileCount: number, hasSequence: boolean): string {
  const lines: string[] = [];
  lines.push(`Import Summary`);
  const filePart = fileCount > 1 ? ` from ${fileCount} files` : "";
  lines.push(`Frames imported: ${result.metadata.count.toLocaleString()}${filePart}`);

  if (hasSequence) {
    lines.push(`Sequence gaps: ${result.sequence_gaps.length}`);
    if (result.sequence_gaps.length > 0) {
      lines.push(`Estimated dropped frames: ${result.total_dropped.toLocaleString()}`);
    }
    if (result.wrap_points.length > 0) {
      lines.push(
        `Sequence wraparound at: ${result.wrap_points.map((v) => v.toLocaleString()).join(", ")}`
      );
    }
    if (result.sequence_gaps.length > 0) {
      lines.push("");
      lines.push("Gaps:");
      for (const gap of result.sequence_gaps) {
        const loc = gap.filename
          ? `${gap.filename} line ${gap.line}`
          : `line ${gap.line}`;
        lines.push(
          `  ${loc}: seq ${gap.from_seq} → ${gap.to_seq} (${gap.dropped} dropped)`
        );
      }
    }
  }

  return lines.join("\n");
}

export type CsvColumnMapperDialogProps = {
  isOpen: boolean;
  filePath: string;
  /** When set, multiple files will be imported using the same column mapping */
  allFilePaths?: string[];
  /** Per-file header detection (parallel to allFilePaths). Auto-detected if not provided. */
  hasHeaderPerFile?: boolean[];
  /** Session ID to associate the imported buffer with */
  sessionId: string;
  onCancel: () => void;
  /** Called when import succeeds — returns the buffer metadata */
  onImportComplete: (metadata: BufferMetadata) => void;
};

export default function CsvColumnMapperDialog({
  isOpen,
  filePath,
  allFilePaths,
  hasHeaderPerFile,
  sessionId,
  onCancel,
  onImportComplete,
}: CsvColumnMapperDialogProps) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mappings, setMappings] = useState<CsvColumnMapping[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState<Delimiter>("comma");
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timestampUnit, setTimestampUnit] = useState<TimestampUnit>("microseconds");
  const [negateTimestamps, setNegateTimestamps] = useState(false);
  const [showImportedTs, setShowImportedTs] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<CsvImportResult | null>(null);
  const [copied, setCopied] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const isMultiFile = allFilePaths && allFilePaths.length > 1;
  const fileCount = allFilePaths?.length ?? 1;
  const hasSequence = mappings.some((m) => m.role === "sequence");

  // Extract filename from path
  const filename = filePath.split(/[/\\]/).pop() ?? filePath;

  // Clean up progress listener on unmount
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

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
        setDelimiter(data.delimiter);
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

  // Re-preview helper — used by delimiter change and header toggle
  const rePreview = useCallback(
    (overrideDelimiter?: Delimiter, overrideHasHeader?: boolean) => {
      setIsLoading(true);
      setError(null);

      const delimToUse = overrideDelimiter ?? delimiter;
      const headerCheck = overrideHasHeader ?? hasHeader;

      previewCsv(filePath, 20, delimToUse)
        .then((data) => {
          if (overrideDelimiter !== undefined) {
            setDelimiter(overrideDelimiter);
          }

          // Adjust header vs no-header based on user's choice
          if (headerCheck && !data.has_header) {
            const newHeaders = data.rows[0] ?? null;
            const newRows = data.rows.slice(1);
            setPreview({
              ...data,
              headers: newHeaders,
              rows: newRows,
              has_header: true,
              total_rows: data.total_rows - 1,
            });
            setMappings(data.suggested_mappings);
          } else if (!headerCheck && data.has_header) {
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
            setPreview(data);
            setMappings(data.suggested_mappings);
            setHasHeader(data.has_header);
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
    [filePath, delimiter, hasHeader]
  );

  // Handle delimiter change — re-preview with new delimiter
  const handleDelimiterChange = useCallback(
    (newDelimiter: Delimiter) => {
      rePreview(newDelimiter);
    },
    [rePreview]
  );

  // Handle header toggle — shift rows and re-run suggestions
  const handleHeaderToggle = useCallback(
    (checked: boolean) => {
      if (!preview) return;
      setHasHeader(checked);
      rePreview(undefined, checked);
    },
    [preview, rePreview]
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
    setImportProgress(null);

    try {
      let result: CsvImportResult;

      if (isMultiFile && allFilePaths) {
        // Listen for per-file progress events
        unlistenRef.current = await listen<{ file_index: number; total_files: number; filename: string }>(
          "csv-import-progress",
          (event) => {
            setImportProgress(
              `Importing file ${event.payload.file_index + 1} of ${event.payload.total_files}: ${event.payload.filename}`
            );
          }
        );

        // Build per-file header flags: use provided detection or fall back to current hasHeader for all
        const perFileHeaders = hasHeaderPerFile ?? allFilePaths.map(() => hasHeader);
        result = await importCsvBatchWithMapping(sessionId, allFilePaths, mappings, perFileHeaders, timestampUnit, negateTimestamps, delimiter);

        unlistenRef.current?.();
        unlistenRef.current = null;
      } else {
        result = await importCsvWithMapping(sessionId, filePath, mappings, hasHeader, timestampUnit, negateTimestamps, delimiter);
      }

      setImportSummary(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsImporting(false);
      setImportProgress(null);
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }, [sessionId, filePath, allFilePaths, isMultiFile, mappings, hasHeader, timestampUnit, negateTimestamps, delimiter, onImportComplete]);

  // Validation
  const hasFrameId = mappings.some((m) => m.role === "frame_id" || m.role === "frame_id_data");
  const hasData =
    mappings.some((m) => m.role === "data_bytes") ||
    mappings.some((m) => m.role === "data_byte") ||
    mappings.some((m) => m.role === "frame_id_data");
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
            <h3 className={h3}>Map Columns</h3>
            <div className={caption}>
              {isMultiFile ? (
                <>
                  Previewing first file · {fileCount} files selected
                </>
              ) : (
                filename
              )}
              {preview && (
                <span className={`ml-2 ${textMuted}`}>
                  · {preview.total_rows.toLocaleString()} rows
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Delimiter + header toggle */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className={`text-xs ${textSecondary} whitespace-nowrap`}>Delimiter</label>
            <select
              value={delimiter}
              onChange={(e) => handleDelimiterChange(e.target.value as Delimiter)}
              disabled={isLoading}
              className={`text-xs px-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textSecondary} focus:outline-none`}
            >
              <option value="comma">Comma</option>
              <option value="tab">Tab</option>
              <option value="space">Space</option>
              <option value="semicolon">Semicolon</option>
            </select>
          </div>
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
        </div>

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

        {/* Import progress */}
        {importProgress && (
          <div className={`flex items-center gap-2 text-xs ${textMuted}`}>
            <Loader2 className={`${iconMd} animate-spin`} />
            <span>{importProgress}</span>
          </div>
        )}

        {/* Footer */}
        {!importSummary && (
          <DialogFooter
            onCancel={onCancel}
            onConfirm={handleImport}
            confirmLabel={
              isImporting
                ? "Importing..."
                : isMultiFile
                  ? `Import ${fileCount} Files`
                  : "Import"
            }
            confirmDisabled={!canImport}
          />
        )}

        {/* Post-import summary */}
        {importSummary && (
          <div className="space-y-3">
            <div className={`border ${borderDefault} rounded p-3 ${bgSurface}`}>
              <div className="flex items-center justify-between mb-2">
                <h4 className={`text-sm font-medium ${textSecondary}`}>
                  {importSummary.sequence_gaps.length > 0
                    ? "Import Complete — Sequence Gaps Detected"
                    : "Import Complete"}
                </h4>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      formatImportSummary(importSummary, fileCount, hasSequence)
                    );
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${borderDefault} ${bgSurface} ${textMuted} hover:brightness-90 transition-colors`}
                  title="Copy summary to clipboard"
                >
                  {copied ? (
                    <Check className={iconSm} />
                  ) : (
                    <Copy className={iconSm} />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className={`text-xs ${textSecondary} space-y-1`}>
                <p>
                  {importSummary.metadata.count.toLocaleString()} frames imported
                  {fileCount > 1 && ` from ${fileCount} files`}
                  {hasSequence && (
                    <>
                      {" · "}{importSummary.sequence_gaps.length} gap{importSummary.sequence_gaps.length !== 1 ? "s" : ""} detected
                      {importSummary.total_dropped > 0 && (
                        <>{" · ~"}{importSummary.total_dropped.toLocaleString()} dropped</>
                      )}
                    </>
                  )}
                </p>
                {hasSequence && importSummary.wrap_points.length > 0 && (
                  <p className={textMuted}>
                    Sequence wraps at:{" "}
                    {importSummary.wrap_points.map((v) => v.toLocaleString()).join(", ")}
                  </p>
                )}
              </div>
              {importSummary.sequence_gaps.length > 0 && (
                <div
                  className={`mt-2 text-xs font-mono ${textMuted} overflow-y-auto border-t ${borderDefault} pt-2`}
                  style={{ maxHeight: "12rem" }}
                >
                  {importSummary.sequence_gaps.map((gap, i) => (
                    <div key={i} className="py-0.5">
                      {gap.filename ? `${gap.filename} ` : ""}line {gap.line}:{" "}
                      seq {gap.from_seq} → {gap.to_seq}{" "}
                      <span className="text-amber-500">
                        ({gap.dropped} dropped)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter
              onConfirm={() => onImportComplete(importSummary.metadata)}
              confirmLabel="Done"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
