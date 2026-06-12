// src/apps/query/views/QueryBuilderPanel.tsx
//
// Query configuration panel. Users select query type, frame ID, byte index,
// and context window settings. Supports favourite-based time bounds. The source
// (a SQLite capture or a PostgreSQL profile) is chosen via the shared Data Source
// picker in the top bar, not here.

import { useCallback, useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ListPlus, ChevronRight, ChevronDown } from "lucide-react";
import {
  useQueryStore,
  QUERY_TYPE_INFO,
  CONTEXT_PRESETS,
  type QueryType,
  type SelectedSignal,
} from "../stores/queryStore";
import type { ResolvedSignal } from "../../../utils/catalogParser";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import type { TimeRangeFavorite } from "../../../utils/favorites";
import type { FrameIdFormat } from "../../../hooks/useSettings";
import { formatFrameId, formatFrameIdInput, parseFrameId } from "../../../utils/frameIds";
import TimeBoundsInput, { type TimeBounds } from "../../../components/TimeBoundsInput";
import { primaryButtonBase, buttonBase } from "../../../styles/buttonStyles";
import { labelSmallMuted, monoBody } from "../../../styles/typography";
import { iconSm, flexRowGap2 } from "../../../styles/spacing";
import { focusRing, bgSurface, borderDefault, textSecondary, textMuted } from "../../../styles/colourTokens";

// Compact form controls tuned to the Decoder data-view density. Width is applied
// at each call site so narrow numeric fields can opt out of the full width.
const fieldClass =
  `h-8 px-2 text-sm rounded border box-border bg-[var(--bg-primary)] border-[color:var(--border-default)] text-[color:var(--text-primary)] transition-colors ${focusRing} disabled:opacity-50 disabled:cursor-not-allowed`;
const sectionCard = `${bgSurface} ${borderDefault} rounded-lg p-2`;
const sectionLabel = `text-xs font-medium ${textSecondary}`;

/**
 * Editable frame-id text bound to a store value. Re-formats when the store value
 * or the active display format changes, without clobbering what the user is
 * mid-typing (a text that already parses to the store value is left alone).
 */
function useFrameIdField(storeValue: number, format: FrameIdFormat) {
  const [text, setText] = useState(() => formatFrameIdInput(storeValue, format));
  useEffect(() => {
    const parsed = parseFrameId(text, format);
    if (parsed === null || parsed !== storeValue) setText(formatFrameIdInput(storeValue, format));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeValue, format]);
  return [text, setText] as const;
}

interface Props {
  profileId: string | null;
  captureId?: string | null;
  disabled?: boolean;
  favourites: TimeRangeFavorite[];
  timeBounds: TimeBounds;
  onTimeBoundsChange: (bounds: TimeBounds) => void;
  /** Active frame-id display format (Auto/Hex/Dec toggle in the top bar) */
  displayIdFormat: FrameIdFormat;
}

export default function QueryBuilderPanel({
  profileId,
  captureId,
  disabled = false,
  favourites,
  timeBounds,
  onTimeBoundsChange,
  displayIdFormat,
}: Props) {
  const { t } = useTranslation("query");
  // Store selectors
  const queryType = useQueryStore((s) => s.queryType);
  const queryParams = useQueryStore((s) => s.queryParams);
  const contextWindow = useQueryStore((s) => s.contextWindow);
  const parsedCatalog = useQueryStore((s) => s.parsedCatalog);
  const selectedSignal = useQueryStore((s) => s.selectedSignal);

  // Settings
  const queryResultLimit = useSettingsStore((s) => s.buffers.queryResultLimit);

  // Store actions
  const setQueryType = useQueryStore((s) => s.setQueryType);
  const updateQueryParams = useQueryStore((s) => s.updateQueryParams);
  const setContextWindow = useQueryStore((s) => s.setContextWindow);
  const enqueueQuery = useQueryStore((s) => s.enqueueQuery);
  const setSelectedSignal = useQueryStore((s) => s.setSelectedSignal);

  // Format/parse a frame id using the active display format.
  const fmtId = useCallback(
    (id: number, isExtended?: boolean) => formatFrameId(id, displayIdFormat, isExtended),
    [displayIdFormat]
  );

  // Catalog-derived data: sorted frames list
  const catalogFrames = useMemo(() => {
    if (!parsedCatalog?.frames) return [];
    return Array.from(parsedCatalog.frames.entries())
      .map(([id, frame]) => ({ id, frame }))
      .sort((a, b) => a.id - b.id);
  }, [parsedCatalog]);

  // Get signals for currently selected frame
  const currentFrameSignals = useMemo((): ResolvedSignal[] => {
    if (!parsedCatalog?.frames) return [];
    const frame = parsedCatalog.frames.get(queryParams.frameId);
    return frame?.signals ?? [];
  }, [parsedCatalog, queryParams.frameId]);

  // Whether we have a catalog with frames to pick from
  const hasCatalogFrames = catalogFrames.length > 0;

  // Catalog-derived data: frames with mirrorOf defined (for mirror validation)
  const mirrorFrames = useMemo(() => {
    if (!parsedCatalog?.frames) return [];
    return Array.from(parsedCatalog.frames.entries())
      .filter(([_, frame]) => frame.mirrorOf)
      .map(([id, frame]) => ({ id, frame }))
      .sort((a, b) => a.id - b.id);
  }, [parsedCatalog]);

  // Resolve mirrorOf reference to source frame ID
  const getMirrorSourceId = useCallback(
    (mirrorOf: string): number | null => {
      if (!parsedCatalog?.frames) return null;
      // mirrorOf is a string like "0x123" or "Engine_Status" - try to find it
      for (const [id, frame] of parsedCatalog.frames.entries()) {
        // Check if mirrorOf matches the frame ID in hex
        if (mirrorOf.toLowerCase() === `0x${id.toString(16).toLowerCase()}`) {
          return id;
        }
        // Check if mirrorOf matches transmitter name
        if (frame.transmitter && mirrorOf.toLowerCase() === frame.transmitter.toLowerCase()) {
          return id;
        }
      }
      // Try parsing as numeric
      return parseFrameId(mirrorOf, "auto");
    },
    [parsedCatalog]
  );

  // Frame ID text inputs (allow free typing; re-format on store/format change).
  const [frameIdText, setFrameIdText] = useFrameIdField(queryParams.frameId, displayIdFormat);
  const [mirrorFrameIdText, setMirrorFrameIdText] = useFrameIdField(queryParams.mirrorFrameId, displayIdFormat);
  const [sourceFrameIdText, setSourceFrameIdText] = useFrameIdField(queryParams.sourceFrameId, displayIdFormat);

  // Local state for pattern search (hex string like "AA ?? BB")
  const [patternText, setPatternText] = useState("");

  // Local state for result limit (allows per-query override)
  const [limitOverride, setLimitOverride] = useState(queryResultLimit);

  // SQL preview is collapsed by default to keep the form compact.
  const [sqlOpen, setSqlOpen] = useState(false);

  // Sync limit override when settings change
  useEffect(() => {
    setLimitOverride(queryResultLimit);
  }, [queryResultLimit]);

  // Commit a frame-id text input to the store on a valid parse.
  const handleFrameIdInput = useCallback(
    (setText: (s: string) => void, key: "frameId" | "mirrorFrameId" | "sourceFrameId") =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setText(value);
        const id = parseFrameId(value, displayIdFormat);
        if (id !== null) updateQueryParams({ [key]: id });
      },
    [displayIdFormat, updateQueryParams]
  );

  // Handle pattern text change — parse "AA ?? BB" into pattern + mask arrays
  const handlePatternTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setPatternText(text);

      const tokens = text.trim().split(/\s+/).filter(Boolean);
      const pattern: number[] = [];
      const mask: number[] = [];
      for (const tok of tokens) {
        if (tok === "??" || tok === "**") {
          pattern.push(0);
          mask.push(0); // wildcard
        } else {
          const val = parseInt(tok, 16);
          if (!isNaN(val) && val >= 0 && val <= 255) {
            pattern.push(val);
            mask.push(0xff);
          }
        }
      }
      updateQueryParams({ pattern, patternMask: mask });
    },
    [updateQueryParams]
  );

  // Add to queue handler
  const handleAddToQueue = useCallback(() => {
    if (captureId) {
      enqueueQuery(captureId, "capture", timeBounds, limitOverride);
    } else if (profileId) {
      enqueueQuery(profileId, "postgres", timeBounds, limitOverride);
    }
  }, [profileId, captureId, timeBounds, limitOverride, enqueueQuery]);

  // Handle query type change
  const handleQueryTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setQueryType(e.target.value as QueryType);
    },
    [setQueryType]
  );

  // Handle byte index change
  const handleByteIndexChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const byteIndex = parseInt(e.target.value, 10);
      if (!isNaN(byteIndex) && byteIndex >= 0 && byteIndex < 64) {
        updateQueryParams({ byteIndex });
      }
    },
    [updateQueryParams]
  );

  // Handle extended ID toggle
  // Unchecked = null (no filter, query both), Checked = true (extended only)
  const handleExtendedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateQueryParams({ isExtended: e.target.checked ? true : null });
    },
    [updateQueryParams]
  );

  // Handle catalog frame selection
  const handleCatalogFrameChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const frameId = parseInt(e.target.value, 10);
      if (!isNaN(frameId)) {
        // Get the frame's isExtended value from the catalog
        const frame = parsedCatalog?.frames.get(frameId);
        const isExtended = frame?.isExtended ?? false;
        updateQueryParams({ frameId, isExtended });
        setSelectedSignal(null); // Clear signal when frame changes
        setFrameIdText(formatFrameIdInput(frameId, displayIdFormat));
      }
    },
    [updateQueryParams, setSelectedSignal, parsedCatalog, displayIdFormat, setFrameIdText]
  );

  // Handle catalog signal selection
  const handleCatalogSignalChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const signalName = e.target.value;
      if (!signalName) {
        setSelectedSignal(null);
        return;
      }
      const signal = currentFrameSignals.find((s) => s.name === signalName);
      if (signal && signal.start_bit !== undefined && signal.bit_length !== undefined) {
        const newSignal: SelectedSignal = {
          frameId: queryParams.frameId,
          signalName: signal.name ?? signalName,
          startBit: signal.start_bit,
          bitLength: signal.bit_length,
          byteIndex: Math.floor(signal.start_bit / 8),
        };
        setSelectedSignal(newSignal);
      }
    },
    [currentFrameSignals, queryParams.frameId, setSelectedSignal]
  );

  // Handle mirror frame selection from catalog
  const handleCatalogMirrorFrameChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const mirrorFrameId = parseInt(e.target.value, 10);
      if (isNaN(mirrorFrameId)) return;

      // Find the frame and resolve its mirrorOf to get the source
      const mirrorEntry = mirrorFrames.find((mf) => mf.id === mirrorFrameId);
      const mirrorOf = mirrorEntry?.frame.mirrorOf;
      const sourceFrameId = mirrorOf ? getMirrorSourceId(mirrorOf) : null;

      // Get the frame's isExtended value from the catalog
      const frame = parsedCatalog?.frames.get(mirrorFrameId);
      const isExtended = frame?.isExtended ?? false;

      updateQueryParams({
        mirrorFrameId,
        sourceFrameId: sourceFrameId ?? 0,
        isExtended,
      });
      setMirrorFrameIdText(formatFrameIdInput(mirrorFrameId, displayIdFormat));
      if (sourceFrameId !== null) {
        setSourceFrameIdText(formatFrameIdInput(sourceFrameId, displayIdFormat));
      }
    },
    [mirrorFrames, getMirrorSourceId, updateQueryParams, parsedCatalog, displayIdFormat, setMirrorFrameIdText, setSourceFrameIdText]
  );

  // Handle tolerance change
  const handleToleranceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const toleranceMs = parseInt(e.target.value, 10);
      if (!isNaN(toleranceMs) && toleranceMs >= 0) {
        updateQueryParams({ toleranceMs });
      }
    },
    [updateQueryParams]
  );

  // Handle context preset click
  const handlePresetClick = useCallback(
    (beforeMs: number, afterMs: number) => {
      setContextWindow({ beforeMs, afterMs });
    },
    [setContextWindow]
  );

  // Handle custom context window change
  const handleContextBeforeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const beforeMs = parseInt(e.target.value, 10);
      if (!isNaN(beforeMs) && beforeMs >= 0) {
        setContextWindow({ ...contextWindow, beforeMs });
      }
    },
    [contextWindow, setContextWindow]
  );

  const handleContextAfterChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const afterMs = parseInt(e.target.value, 10);
      if (!isNaN(afterMs) && afterMs >= 0) {
        setContextWindow({ ...contextWindow, afterMs });
      }
    },
    [contextWindow, setContextWindow]
  );

  const queryInfo = QUERY_TYPE_INFO[queryType];
  const showByteIndex = queryType === "byte_changes" || queryType === "distribution";
  const showMirrorValidation = queryType === "mirror_validation";
  const showMuxStatistics = queryType === "mux_statistics";
  const showGapAnalysis = queryType === "gap_analysis";
  const showFrequency = queryType === "frequency";
  const showPatternSearch = queryType === "pattern_search";

  // Frame-id label/placeholder follow the active display format.
  const isHex = displayIdFormat === "hex";
  const frameIdLabel = t("builder.frameIdManual", {
    type: t(isHex ? "builder.frameIdTypeHex" : "builder.frameIdTypeDecimal"),
  });
  const frameIdPlaceholder = t(isHex ? "builder.frameIdPlaceholderHex" : "builder.frameIdPlaceholderDecimal");
  const byteIndexLabel = selectedSignal ? t("builder.byteIndexFromSignal") : t("builder.byteIndex");

  // Handle limit override change
  // Mux statistics scans raw frames for aggregation, so allow a higher ceiling
  const maxLimit = showMuxStatistics ? 10_000_000 : 100_000;

  const handleLimitChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const limit = parseInt(e.target.value, 10);
      if (!isNaN(limit) && limit >= 100 && limit <= maxLimit) {
        setLimitOverride(limit);
      }
    },
    [maxLimit]
  );

  // Whether we're targeting a buffer (SQLite) vs PostgreSQL
  const isBufferSource = !!captureId;

  // Generate SQL query preview
  const sqlPreview = useMemo(() => {
    const frameId = queryParams.frameId;
    const byteIndex = queryParams.byteIndex;

    if (isBufferSource) {
      // SQLite-flavoured preview for buffer queries
      const extendedClause = queryParams.isExtended !== null
        ? ` AND is_extended = ${queryParams.isExtended ? 1 : 0}`
        : "";

      let timeConditions = "";
      if (timeBounds.startTime) {
        timeConditions += `\n     AND timestamp_us >= <start_us>`;
      }
      if (timeBounds.endTime) {
        timeConditions += `\n     AND timestamp_us <= <end_us>`;
      }

      if (queryType === "byte_changes") {
        return `-- SQLite buffer query
WITH ordered AS (
  SELECT timestamp_us, payload,
    LAG(payload) OVER (ORDER BY timestamp_us) AS prev_payload
  FROM frames
  WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
)
SELECT timestamp_us, prev_payload, payload
FROM ordered
WHERE prev_payload IS NOT NULL
  -- Filter in Rust: byte[${byteIndex}] changed
LIMIT ${limitOverride.toLocaleString()}`;
      }

      if (queryType === "frame_changes") {
        return `-- SQLite buffer query
WITH ordered AS (
  SELECT timestamp_us, payload,
    LAG(payload) OVER (ORDER BY timestamp_us) AS prev_payload
  FROM frames
  WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
)
SELECT timestamp_us, prev_payload, payload
FROM ordered
WHERE prev_payload IS NOT NULL
  AND prev_payload != payload
LIMIT ${limitOverride.toLocaleString()}`;
      }

      if (queryType === "mirror_validation") {
        const { mirrorFrameId, sourceFrameId, toleranceMs } = queryParams;
        return `-- SQLite buffer query (two-pointer match in Rust)
-- Mirror frames:
SELECT timestamp_us, payload FROM frames
WHERE frame_id = ${mirrorFrameId}${extendedClause}${timeConditions}

-- Source frames:
SELECT timestamp_us, payload FROM frames
WHERE frame_id = ${sourceFrameId}${extendedClause}${timeConditions}

-- Tolerance: ${toleranceMs}ms (${toleranceMs * 1000}µs)
LIMIT ${limitOverride.toLocaleString()}`;
      }

      if (queryType === "mux_statistics") {
        const { muxSelectorByte } = queryParams;
        return `-- SQLite buffer query
SELECT payload FROM frames
WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
ORDER BY rowid
LIMIT ${limitOverride.toLocaleString()}
-- Group by payload[${muxSelectorByte}], compute stats in Rust`;
      }

      if (queryType === "first_last") {
        return `-- SQLite buffer query
SELECT timestamp_us, payload FROM frames
WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
ORDER BY rowid ASC LIMIT 1
-- + ORDER BY rowid DESC LIMIT 1 + COUNT(*)`;
      }

      if (queryType === "frequency") {
        const bucketUs = queryParams.bucketSizeMs * 1000;
        return `-- SQLite buffer query (intervals computed in Rust)
SELECT timestamp_us FROM frames
WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
ORDER BY rowid
LIMIT ${limitOverride.toLocaleString()}
-- Bucket size: ${queryParams.bucketSizeMs}ms (${bucketUs}µs)`;
      }

      if (queryType === "distribution") {
        return `-- SQLite buffer query (distribution computed in Rust)
SELECT payload FROM frames
WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
ORDER BY rowid
-- Extract byte[${byteIndex}], count distinct values`;
      }

      if (queryType === "gap_analysis") {
        const thresholdUs = queryParams.gapThresholdMs * 1000;
        return `-- SQLite buffer query (gaps detected in Rust)
SELECT timestamp_us FROM frames
WHERE frame_id = ${frameId}${extendedClause}${timeConditions}
ORDER BY rowid
-- Find gaps > ${queryParams.gapThresholdMs}ms (${thresholdUs}µs)
LIMIT ${limitOverride.toLocaleString()}`;
      }

      if (queryType === "pattern_search") {
        const patternStr = queryParams.pattern
          .map((b, i) => (queryParams.patternMask[i] === 0 ? "??" : b.toString(16).toUpperCase().padStart(2, "0")))
          .join(" ") || "(empty)";
        return `-- SQLite capture query (pattern matching in Rust)
SELECT timestamp_us, frame_id, is_extended, payload
FROM frames
WHERE capture_id = ?${timeConditions}
ORDER BY rowid
LIMIT ${limitOverride.toLocaleString()}
-- Pattern: ${patternStr}`;
      }

      return `-- Query type "${queryType}" not yet implemented for captures`;
    }

    // PostgreSQL preview
    const extendedClause = queryParams.isExtended !== null
      ? ` AND extended = ${queryParams.isExtended}`
      : "";

    let timeConditions = "";
    if (timeBounds.startTime) {
      timeConditions += `\n     AND ts >= '${timeBounds.startTime}'::timestamptz`;
    }
    if (timeBounds.endTime) {
      timeConditions += `\n     AND ts < '${timeBounds.endTime}'::timestamptz`;
    }

    if (queryType === "byte_changes") {
      return `WITH ordered_frames AS (
  SELECT ts,
    get_byte_safe(data_bytes, ${byteIndex}) as curr_byte,
    LAG(get_byte_safe(data_bytes, ${byteIndex})) OVER (ORDER BY ts) as prev_byte
  FROM can_frame
  WHERE id = ${frameId}${extendedClause}${timeConditions}
  ORDER BY ts
)
SELECT
  (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us,
  prev_byte, curr_byte
FROM ordered_frames
WHERE prev_byte IS NOT NULL
  AND curr_byte IS NOT NULL
  AND prev_byte IS DISTINCT FROM curr_byte
ORDER BY ts
LIMIT ${limitOverride.toLocaleString()}`;
    }

    if (queryType === "frame_changes") {
      return `WITH ordered_frames AS (
  SELECT ts, data_bytes,
    LAG(data_bytes) OVER (ORDER BY ts) as prev_data
  FROM can_frame
  WHERE id = ${frameId}${extendedClause}${timeConditions}
  ORDER BY ts
)
SELECT
  (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us,
  prev_data, data_bytes
FROM ordered_frames
WHERE prev_data IS NOT NULL
  AND prev_data IS DISTINCT FROM data_bytes
ORDER BY ts
LIMIT ${limitOverride.toLocaleString()}`;
    }

    if (queryType === "mirror_validation") {
      const { mirrorFrameId, sourceFrameId, toleranceMs } = queryParams;
      return `WITH mirror_frames AS (
  SELECT ts, data_bytes FROM can_frame
  WHERE id = ${mirrorFrameId}${extendedClause}${timeConditions}
),
source_frames AS (
  SELECT ts, data_bytes FROM can_frame
  WHERE id = ${sourceFrameId}${extendedClause}${timeConditions}
)
SELECT
  (EXTRACT(EPOCH FROM m.ts) * 1000000)::float8 as mirror_ts,
  (EXTRACT(EPOCH FROM s.ts) * 1000000)::float8 as source_ts,
  m.data_bytes as mirror_payload,
  s.data_bytes as source_payload
FROM mirror_frames m
JOIN source_frames s
  ON ABS(EXTRACT(EPOCH FROM (m.ts - s.ts)) * 1000) < ${toleranceMs}
WHERE m.data_bytes IS DISTINCT FROM s.data_bytes
ORDER BY m.ts
LIMIT ${limitOverride.toLocaleString()}`;
    }

    if (queryType === "mux_statistics") {
      const { muxSelectorByte } = queryParams;
      return `SELECT
  get_byte_safe(data_bytes, ${muxSelectorByte}) as mux_value,
  data_bytes
FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}
LIMIT ${limitOverride.toLocaleString()}
-- Group by mux_value, compute per-byte stats in Rust`;
    }

    if (queryType === "first_last") {
      return `-- First occurrence:
SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8, data_bytes
FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}
ORDER BY ts ASC LIMIT 1

-- Last occurrence:
SELECT ... ORDER BY ts DESC LIMIT 1

-- Total count:
SELECT COUNT(*) FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}`;
    }

    if (queryType === "frequency") {
      const bucketUs = queryParams.bucketSizeMs * 1000;
      return `-- Intervals computed in Rust, bucketed by ${queryParams.bucketSizeMs}ms
SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us
FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}
ORDER BY ts
LIMIT ${limitOverride.toLocaleString()}
-- Bucket size: ${queryParams.bucketSizeMs}ms (${bucketUs}µs)`;
    }

    if (queryType === "distribution") {
      return `SELECT
  get_byte_safe(data_bytes, ${byteIndex}) as value,
  COUNT(*) as count
FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}
GROUP BY value
ORDER BY count DESC`;
    }

    if (queryType === "gap_analysis") {
      const thresholdUs = queryParams.gapThresholdMs * 1000;
      return `-- Gaps detected in Rust from ordered timestamps
SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us
FROM can_frame
WHERE id = ${frameId}${extendedClause}${timeConditions}
ORDER BY ts
-- Find gaps > ${queryParams.gapThresholdMs}ms (${thresholdUs}µs)
LIMIT ${limitOverride.toLocaleString()}`;
    }

    if (queryType === "pattern_search") {
      const patternStr = queryParams.pattern
        .map((b, i) => (queryParams.patternMask[i] === 0 ? "??" : b.toString(16).toUpperCase().padStart(2, "0")))
        .join(" ") || "(empty)";
      return `-- Pattern matching in Rust
SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8,
  id, extended, data_bytes
FROM can_frame
WHERE 1=1${timeConditions}
ORDER BY ts
LIMIT ${limitOverride.toLocaleString()}
-- Pattern: ${patternStr}`;
    }

    return `-- Query type "${queryType}" not yet implemented`;
  }, [queryType, queryParams, timeBounds, limitOverride, isBufferSource]);

  // ── Reusable field fragments ──

  const extendedCheckbox = (
    <label className={`${flexRowGap2} h-8 ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
      <input
        type="checkbox"
        checked={queryParams.isExtended === true}
        onChange={handleExtendedChange}
        disabled={disabled}
        className="disabled:cursor-not-allowed"
      />
      {t("builder.extended")}
    </label>
  );

  // Byte index field, reused by the catalog and manual frame selectors.
  const byteIndexField = (
    <div className={hasCatalogFrames ? undefined : "w-24"}>
      <label className={labelSmallMuted}>{byteIndexLabel}</label>
      <input
        type="number"
        min={0}
        max={63}
        value={queryParams.byteIndex}
        onChange={handleByteIndexChange}
        disabled={disabled || !!selectedSignal}
        className={`${fieldClass} w-full mt-1`}
      />
    </div>
  );

  // Frame selector: a catalog dropdown when a catalog is loaded, else manual entry.
  const frameSelector = hasCatalogFrames ? (
    <div className="space-y-2">
      <div>
        <label className={labelSmallMuted}>{t("builder.frame")}</label>
        <select
          value={queryParams.frameId}
          onChange={handleCatalogFrameChange}
          disabled={disabled}
          className={`${fieldClass} w-full mt-1`}
        >
          {catalogFrames.map(({ id, frame }) => (
            <option key={id} value={id}>
              {fmtId(id, frame.isExtended)}
              {frame.transmitter ? ` — ${frame.transmitter}` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Signal Picker (for byte_changes / distribution) */}
      {showByteIndex && currentFrameSignals.length > 0 && (
        <div>
          <label className={labelSmallMuted}>{t("builder.signal")}</label>
          <select
            value={selectedSignal?.signalName ?? ""}
            onChange={handleCatalogSignalChange}
            disabled={disabled}
            className={`${fieldClass} w-full mt-1`}
          >
            <option value="">{t("builder.selectSignalOrByte")}</option>
            {currentFrameSignals
              .filter((s) => s.name && s.start_bit !== undefined)
              .map((signal) => (
                <option key={signal.name} value={signal.name}>
                  {signal.name}
                  {signal.unit ? ` (${signal.unit})` : ""}
                  {t("builder.signalOption", { byte: Math.floor((signal.start_bit ?? 0) / 8) })}
                </option>
              ))}
          </select>
          {selectedSignal && (
            <p className={`text-xs ${textMuted} mt-1`}>
              {t("builder.signalPosition", { startBit: selectedSignal.startBit, bitLength: selectedSignal.bitLength, byteIndex: selectedSignal.byteIndex })}
            </p>
          )}
        </div>
      )}

      {/* Byte Index (catalog mode — stacked under the signal picker) */}
      {showByteIndex && byteIndexField}
    </div>
  ) : (
    // Manual entry — frame id, byte index and extended on one line.
    <div className="flex gap-2 items-end">
      <div className="flex-1">
        <label className={labelSmallMuted}>{frameIdLabel}</label>
        <input
          type="text"
          value={frameIdText}
          onChange={handleFrameIdInput(setFrameIdText, "frameId")}
          disabled={disabled}
          placeholder={frameIdPlaceholder}
          className={`${fieldClass} w-full mt-1`}
        />
      </div>
      {showByteIndex && byteIndexField}
      {extendedCheckbox}
    </div>
  );

  // Query-type-specific parameters, rendered once regardless of catalog vs manual.
  const queryTypeParams = (
    <>
      {/* Mux Statistics Parameters */}
      {showMuxStatistics && (
        <div className="space-y-2">
          <div>
            <label className={labelSmallMuted}>{t("builder.muxSelectorByte")}</label>
            <input
              type="number"
              min={0}
              max={7}
              value={queryParams.muxSelectorByte}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0 && v < 64) updateQueryParams({ muxSelectorByte: v });
              }}
              disabled={disabled}
              className={`${fieldClass} w-full mt-1`}
            />
          </div>
          <div>
            <label className={labelSmallMuted}>{t("builder.payloadLength")}</label>
            <input
              type="number"
              min={1}
              max={64}
              value={queryParams.payloadLength}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 64) updateQueryParams({ payloadLength: v });
              }}
              disabled={disabled}
              className={`${fieldClass} w-full mt-1`}
            />
          </div>
          <label className={`${flexRowGap2} ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
            <input
              type="checkbox"
              checked={queryParams.include16Bit}
              onChange={(e) => updateQueryParams({ include16Bit: e.target.checked })}
              disabled={disabled}
              className="disabled:cursor-not-allowed"
            />
            {t("builder.include16Bit")}
          </label>
        </div>
      )}

      {/* Gap Analysis Parameters */}
      {showGapAnalysis && (
        <div>
          <label className={labelSmallMuted}>{t("builder.gapThreshold")}</label>
          <div className={`${flexRowGap2} mt-1`}>
            <input
              type="number"
              min={1}
              max={60000}
              value={queryParams.gapThresholdMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) updateQueryParams({ gapThresholdMs: v });
              }}
              disabled={disabled}
              className={`${fieldClass} w-24`}
            />
            <span className={`text-xs ${textMuted}`}>{t("builder.gapHint")}</span>
          </div>
        </div>
      )}

      {/* Frequency Parameters */}
      {showFrequency && (
        <div>
          <label className={labelSmallMuted}>{t("builder.bucketSize")}</label>
          <div className={`${flexRowGap2} mt-1`}>
            <input
              type="number"
              min={10}
              max={60000}
              step={100}
              value={queryParams.bucketSizeMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 10) updateQueryParams({ bucketSizeMs: v });
              }}
              disabled={disabled}
              className={`${fieldClass} w-24`}
            />
            <span className={`text-xs ${textMuted}`}>{t("builder.bucketHint")}</span>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable form content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Query Type */}
        <div>
          <label className={labelSmallMuted}>{t("builder.queryType")}</label>
          <select
            value={queryType}
            onChange={handleQueryTypeChange}
            disabled={disabled}
            className={`${fieldClass} w-full mt-1`}
          >
            {Object.entries(QUERY_TYPE_INFO).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label}
              </option>
            ))}
          </select>
          <p className={`text-xs ${textSecondary} mt-1`}>{queryInfo.description}</p>
        </div>

        {/* Parameters — vary by query type */}
        {showMirrorValidation ? (
          <div className="space-y-2">
            {/* Mirror Frame Selection - Catalog picker or manual */}
            {mirrorFrames.length > 0 ? (
              <div>
                <label className={labelSmallMuted}>{t("builder.mirrorFrame")}</label>
                <select
                  value={queryParams.mirrorFrameId}
                  onChange={handleCatalogMirrorFrameChange}
                  disabled={disabled}
                  className={`${fieldClass} w-full mt-1`}
                >
                  <option value={0}>{t("builder.selectMirror")}</option>
                  {mirrorFrames.map(({ id, frame }) => {
                    // Resolve source frame info for display
                    const sourceId = frame.mirrorOf ? getMirrorSourceId(frame.mirrorOf) : null;
                    const sourceFrame = sourceId !== null ? parsedCatalog?.frames.get(sourceId) : null;
                    const sourceInfo = sourceId !== null
                      ? ` → ${fmtId(sourceId, sourceFrame?.isExtended)}${sourceFrame?.transmitter ? ` — ${sourceFrame.transmitter}` : ""}`
                      : "";
                    return (
                      <option key={id} value={id}>
                        {fmtId(id, frame.isExtended)}
                        {frame.transmitter ? ` — ${frame.transmitter}` : ""}
                        {sourceInfo}
                      </option>
                    );
                  })}
                </select>
                {queryParams.mirrorFrameId > 0 && (
                  <p className={`text-xs ${textMuted} mt-1`}>
                    {t("builder.mirrorsTo", { id: fmtId(queryParams.sourceFrameId) })}
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Manual mirror frame ID inputs */}
                <div>
                  <label className={labelSmallMuted}>{t("builder.mirrorFrameId")}</label>
                  <div className={`${flexRowGap2} mt-1`}>
                    <input
                      type="text"
                      value={mirrorFrameIdText}
                      onChange={handleFrameIdInput(setMirrorFrameIdText, "mirrorFrameId")}
                      disabled={disabled}
                      placeholder={frameIdPlaceholder}
                      className={`${fieldClass} flex-1`}
                    />
                    {extendedCheckbox}
                  </div>
                </div>
                <div>
                  <label className={labelSmallMuted}>{t("builder.sourceFrameId")}</label>
                  <input
                    type="text"
                    value={sourceFrameIdText}
                    onChange={handleFrameIdInput(setSourceFrameIdText, "sourceFrameId")}
                    disabled={disabled}
                    placeholder={frameIdPlaceholder}
                    className={`${fieldClass} w-full mt-1`}
                  />
                </div>
              </>
            )}
            {/* Tolerance */}
            <div>
              <label className={labelSmallMuted}>{t("builder.tolerance")}</label>
              <div className={`${flexRowGap2} mt-1`}>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={queryParams.toleranceMs}
                  onChange={handleToleranceChange}
                  disabled={disabled}
                  className={`${fieldClass} w-20`}
                />
                <span className={`text-xs ${textMuted}`}>{t("builder.toleranceHint")}</span>
              </div>
            </div>
          </div>
        ) : showPatternSearch ? (
          /* Pattern Search — no frame ID, just a hex pattern input */
          <div>
            <label className={labelSmallMuted}>{t("builder.bytePattern")}</label>
            <input
              type="text"
              value={patternText}
              onChange={handlePatternTextChange}
              disabled={disabled}
              placeholder={t("builder.patternPlaceholder")}
              className={`${fieldClass} w-full mt-1 font-mono`}
            />
            <p className={`text-xs ${textMuted} mt-1`}>
              {queryParams.pattern.length > 0
                ? t("builder.patternStats", { bytes: queryParams.pattern.length, wildcards: queryParams.patternMask.filter((m) => m === 0).length })
                : t("builder.patternHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {frameSelector}
            {queryTypeParams}
          </div>
        )}

        {/* Context Window */}
        <div className={sectionCard}>
          <div className={`${flexRowGap2} mb-1`}>
            <label className={sectionLabel}>{t("builder.contextWindow")}</label>
            <span className={`text-xs ${textMuted}`}>{t("builder.contextHint")}</span>
          </div>

          {/* Presets + Custom inputs in responsive layout */}
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-wrap gap-1">
              {CONTEXT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => handlePresetClick(preset.beforeMs, preset.afterMs)}
                  disabled={disabled}
                  className={`${buttonBase} text-xs px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                    contextWindow.beforeMs === preset.beforeMs &&
                    contextWindow.afterMs === preset.afterMs
                      ? "bg-amber-500/20 text-amber-400"
                      : ""
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 flex-1 min-w-[180px]">
              <div className="flex-1">
                <label className={`text-xs ${textMuted}`}>{t("builder.before")}</label>
                <div className={flexRowGap2}>
                  <input
                    type="number"
                    min={0}
                    value={contextWindow.beforeMs}
                    onChange={handleContextBeforeChange}
                    disabled={disabled}
                    className={`${fieldClass} w-full`}
                  />
                  <span className={`text-xs ${textMuted}`}>{t("builder.ms")}</span>
                </div>
              </div>
              <div className="flex-1">
                <label className={`text-xs ${textMuted}`}>{t("builder.after")}</label>
                <div className={flexRowGap2}>
                  <input
                    type="number"
                    min={0}
                    value={contextWindow.afterMs}
                    onChange={handleContextAfterChange}
                    disabled={disabled}
                    className={`${fieldClass} w-full`}
                  />
                  <span className={`text-xs ${textMuted}`}>{t("builder.ms")}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Time Bounds */}
        <div className={sectionCard}>
          <label className={`${sectionLabel} mb-2 block`}>{t("builder.timeBounds")}</label>
          <TimeBoundsInput
            value={timeBounds}
            onChange={onTimeBoundsChange}
            bookmarks={favourites}
            showBookmarks={true}
            showMaxFrames={false}
            disabled={disabled}
          />
        </div>

        {/* SQL Query Preview — collapsible to keep the form compact */}
        <div className={sectionCard}>
          <button
            type="button"
            onClick={() => setSqlOpen((o) => !o)}
            className={`${flexRowGap2} ${sectionLabel} w-full`}
            aria-expanded={sqlOpen}
            aria-label={t("builder.sqlPreviewToggle")}
          >
            {sqlOpen ? <ChevronDown className={iconSm} /> : <ChevronRight className={iconSm} />}
            {t("builder.sqlPreview")}
          </button>
          {sqlOpen && (
            <textarea
              readOnly
              value={sqlPreview}
              className={`${monoBody} text-xs w-full mt-2 p-2 rounded border ${borderDefault} bg-[var(--bg-primary)] ${textSecondary} resize-none`}
              rows={8}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          )}
        </div>
      </div>

      {/* Fixed bottom section with Add to Queue Button */}
      <div className="flex-shrink-0 p-4 pt-0 space-y-2">
        {/* Result limit input */}
        <div className="flex items-center justify-center gap-2">
          <label className={`text-xs ${textMuted}`}>{showMuxStatistics ? t("builder.scanUpTo") : t("builder.limitResults")}</label>
          <input
            type="number"
            min={100}
            max={maxLimit}
            step={showMuxStatistics ? 100000 : 1000}
            value={limitOverride}
            onChange={handleLimitChange}
            disabled={disabled}
            className={`${fieldClass} ${showMuxStatistics ? "w-32" : "w-24"} text-center`}
          />
          <span className={`text-xs ${textMuted}`}>{t("builder.rows")}</span>
        </div>

        <button
          onClick={handleAddToQueue}
          disabled={disabled}
          className={`${primaryButtonBase} w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <ListPlus className={iconSm} />
          {t("builder.addToQueue")}
        </button>
      </div>
    </div>
  );
}
