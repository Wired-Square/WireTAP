// ui/src/dialogs/csv-column-mapper/CsvColumnMapperDialog.tsx
//
// Dialog for mapping CSV columns to CAN frame fields before import.
// Shows a preview of the CSV data with dropdown selectors per column.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  type CaptureMetadata,
  type CsvImportResult,
} from "../../api/capture";
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
function formatImportSummary(
  t: (key: string, opts?: Record<string, unknown>) => string,
  result: CsvImportResult,
  fileCount: number,
  hasSequence: boolean,
): string {
  const lines: string[] = [];
  lines.push(t("csvColumnMapper.summaryHeading"));
  const filePart = fileCount > 1 ? t("csvColumnMapper.summaryFromFilesPlain", { count: fileCount }) : "";
  lines.push(t("csvColumnMapper.summaryFramesImported", { count: `${result.metadata.count.toLocaleString()}${filePart}` }));

  if (hasSequence) {
    lines.push(t("csvColumnMapper.summaryGapsLine", { count: result.sequence_gaps.length }));
    if (result.sequence_gaps.length > 0) {
      lines.push(t("csvColumnMapper.summaryEstimatedDropped", { count: result.total_dropped.toLocaleString() }));
    }
    if (result.wrap_points.length > 0) {
      lines.push(
        t("csvColumnMapper.summaryWraparound", { values: result.wrap_points.map((v) => v.toLocaleString()).join(", ") }),
      );
    }
    if (result.sequence_gaps.length > 0) {
      lines.push("");
      lines.push(t("csvColumnMapper.summaryGapsTitle"));
      for (const gap of result.sequence_gaps) {
        const loc = gap.filename
          ? `${gap.filename} line ${gap.line}`
          : `line ${gap.line}`;
        lines.push(
          t("csvColumnMapper.summaryGapEntry", { loc, from: gap.from_seq, to: gap.to_seq, dropped: gap.dropped }),
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
  onImportComplete: (metadata: CaptureMetadata) => void;
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
  const { t } = useTranslation("dialogs");
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
              t("csvColumnMapper.importingFile", {
                current: event.payload.file_index + 1,
                total: event.payload.total_files,
                filename: event.payload.filename,
              })
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

    if (durationSecs < 1) return t("csvColumnMapper.duration.ms", { ms: Math.round(durationSecs * 1000) });
    if (durationSecs < 60) return t("csvColumnMapper.duration.s", { s: durationSecs.toFixed(1) });
    if (durationSecs < 3600) return t("csvColumnMapper.duration.min", { min: (durationSecs / 60).toFixed(1) });
    if (durationSecs < 86400) return t("csvColumnMapper.duration.h", { h: (durationSecs / 3600).toFixed(1) });
    return t("csvColumnMapper.duration.d", { d: (durationSecs / 86400).toFixed(1) });
  }, [hasTimestamp, preview, mappings, timestampUnit, t]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onCancel} maxWidth="max-w-4xl">
      <div className={`${cardElevated} ${paddingCard} space-y-4`}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className={h3}>{t("csvColumnMapper.title")}</h3>
            <div className={caption}>
              {isMultiFile ? (
                <>{t("csvColumnMapper.previewingFirst", { count: fileCount })}</>
              ) : (
                filename
              )}
              {preview && (
                <span className={`ml-2 ${textMuted}`}>
                  {t("csvColumnMapper.rowsCount", { count: preview.total_rows.toLocaleString() })}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Delimiter + header toggle */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className={`text-xs ${textSecondary} whitespace-nowrap`}>{t("csvColumnMapper.delimiter")}</label>
            <select
              value={delimiter}
              onChange={(e) => handleDelimiterChange(e.target.value as Delimiter)}
              disabled={isLoading}
              className={`text-xs px-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textSecondary} focus:outline-none`}
            >
              <option value="comma">{t("csvColumnMapper.delimiterOptions.comma")}</option>
              <option value="tab">{t("csvColumnMapper.delimiterOptions.tab")}</option>
              <option value="space">{t("csvColumnMapper.delimiterOptions.space")}</option>
              <option value="semicolon">{t("csvColumnMapper.delimiterOptions.semicolon")}</option>
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
            <span>{t("csvColumnMapper.firstRowHeader")}</span>
          </label>
        </div>

        {/* Preview table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8 gap-2">
            <Loader2 className={`${iconMd} animate-spin ${textMuted}`} />
            <span className={textMuted}>{t("csvColumnMapper.loadingPreview")}</span>
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
                  {showImportedTs ? t("csvColumnMapper.raw") : t("csvColumnMapper.preview")}
                </button>
                <label className={`text-xs ${textSecondary} whitespace-nowrap`}>
                  {t("csvColumnMapper.timestampUnit")}
                </label>
                <select
                  value={timestampUnit}
                  onChange={(e) => setTimestampUnit(e.target.value as TimestampUnit)}
                  className={`text-xs px-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textSecondary} focus:outline-none`}
                >
                  <option value="seconds">{t("csvColumnMapper.tsUnits.seconds")}</option>
                  <option value="milliseconds">{t("csvColumnMapper.tsUnits.milliseconds")}</option>
                  <option value="microseconds">{t("csvColumnMapper.tsUnits.microseconds")}</option>
                  <option value="nanoseconds">{t("csvColumnMapper.tsUnits.nanoseconds")}</option>
                </select>
                {estimatedDuration && (
                  <span className={`text-xs ${textMuted}`}>
                    {t("csvColumnMapper.estimatedDuration", { duration: estimatedDuration })}
                  </span>
                )}
                <label className={`flex items-center gap-1.5 text-xs ${textSecondary} cursor-pointer select-none ml-auto`}>
                  <input
                    type="checkbox"
                    checked={negateTimestamps}
                    onChange={(e) => setNegateTimestamps(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>{t("csvColumnMapper.negateTimestamps")}</span>
                </label>
              </div>
            )}

            {/* Validation hints */}
            {!hasFrameId && (
              <div className={`text-xs text-amber-600 ${bgSurface} border ${borderDefault} rounded px-3 py-2`}>
                {t("csvColumnMapper.validation.needFrameId")}
              </div>
            )}
            {hasFrameId && !hasData && (
              <div className={`text-xs ${textSecondary} ${bgSurface} border ${borderDefault} rounded px-3 py-2`}>
                {t("csvColumnMapper.validation.noDataColumns")}
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
                ? t("csvColumnMapper.importing")
                : isMultiFile
                  ? t("csvColumnMapper.importN", { count: fileCount })
                  : t("csvColumnMapper.import")
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
                    ? t("csvColumnMapper.completeWithGaps")
                    : t("csvColumnMapper.complete")}
                </h4>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      formatImportSummary(t, importSummary, fileCount, hasSequence)
                    );
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${borderDefault} ${bgSurface} ${textMuted} hover:brightness-90 transition-colors`}
                  title={t("csvColumnMapper.copyTooltip")}
                >
                  {copied ? (
                    <Check className={iconSm} />
                  ) : (
                    <Copy className={iconSm} />
                  )}
                  {copied ? t("csvColumnMapper.copied") : t("csvColumnMapper.copy")}
                </button>
              </div>
              <div className={`text-xs ${textSecondary} space-y-1`}>
                <p>
                  {t("csvColumnMapper.summaryFrames", { count: importSummary.metadata.count.toLocaleString() })}
                  {fileCount > 1 && t("csvColumnMapper.summaryFromFiles", { count: fileCount })}
                  {hasSequence && (
                    <>
                      {t("csvColumnMapper.summaryGaps", { count: importSummary.sequence_gaps.length })}
                      {importSummary.total_dropped > 0 && t("csvColumnMapper.summaryDropped", { count: importSummary.total_dropped.toLocaleString() })}
                    </>
                  )}
                </p>
                {hasSequence && importSummary.wrap_points.length > 0 && (
                  <p className={textMuted}>
                    {t("csvColumnMapper.summaryWraps", {
                      values: importSummary.wrap_points.map((v) => v.toLocaleString()).join(", "),
                    })}
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
                      {gap.filename
                        ? t("csvColumnMapper.gapLineFile", { filename: gap.filename, line: gap.line })
                        : t("csvColumnMapper.gapLine", { line: gap.line })}
                      {" "}{t("csvColumnMapper.gapTransition", { from: gap.from_seq, to: gap.to_seq })}{" "}
                      <span className="text-amber-500">
                        {t("csvColumnMapper.gapDropped", { count: gap.dropped })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter
              onConfirm={() => onImportComplete(importSummary.metadata)}
              confirmLabel={t("csvColumnMapper.done")}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
