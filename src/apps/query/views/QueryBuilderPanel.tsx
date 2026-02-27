// src/apps/query/views/QueryBuilderPanel.tsx
//
// Query configuration panel. Users select query type, frame ID, byte index,
// and context window settings. Supports favourite-based time bounds.

import { useCallback, useState, useEffect, useMemo } from "react";
import { ListPlus, HardDrive } from "lucide-react";
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
import type { BufferMetadata } from "../../../api/buffer";
import TimeBoundsInput, { type TimeBounds } from "../../../components/TimeBoundsInput";
import { primaryButtonBase, buttonBase } from "../../../styles/buttonStyles";
import { inputBase } from "../../../styles/inputStyles";
import { labelSmallMuted, monoBody } from "../../../styles/typography";
import { iconSm, flexRowGap2 } from "../../../styles/spacing";
import { bgSurface, borderDefault, textSecondary, textMuted } from "../../../styles/colourTokens";

interface Props {
  profileId: string | null;
  bufferId?: string | null;
  disabled?: boolean;
  favourites: TimeRangeFavorite[];
  timeBounds: TimeBounds;
  onTimeBoundsChange: (bounds: TimeBounds) => void;
  buffers?: BufferMetadata[];
  onSelectBuffer?: (bufferId: string | null) => void;
}

export default function QueryBuilderPanel({
  profileId,
  bufferId,
  disabled = false,
  favourites,
  timeBounds,
  onTimeBoundsChange,
  buffers = [],
  onSelectBuffer,
}: Props) {
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
      const parsed = mirrorOf.startsWith("0x")
        ? parseInt(mirrorOf, 16)
        : parseInt(mirrorOf, 10);
      return isNaN(parsed) ? null : parsed;
    },
    [parsedCatalog]
  );

  // Local state for frame ID input (allows free typing)
  const [frameIdText, setFrameIdText] = useState(
    `0x${queryParams.frameId.toString(16).toUpperCase()}`
  );

  // Local state for mirror frame ID inputs
  const [mirrorFrameIdText, setMirrorFrameIdText] = useState(
    `0x${queryParams.mirrorFrameId.toString(16).toUpperCase()}`
  );
  const [sourceFrameIdText, setSourceFrameIdText] = useState(
    `0x${queryParams.sourceFrameId.toString(16).toUpperCase()}`
  );

  // Local state for pattern search (hex string like "AA ?? BB")
  const [patternText, setPatternText] = useState("");

  // Local state for result limit (allows per-query override)
  const [limitOverride, setLimitOverride] = useState(queryResultLimit);

  // Sync local state when store changes externally
  useEffect(() => {
    const storeHex = `0x${queryParams.frameId.toString(16).toUpperCase()}`;
    // Only sync if the parsed values differ (to avoid overwriting user input)
    const currentParsed = frameIdText.startsWith("0x")
      ? parseInt(frameIdText, 16)
      : parseInt(frameIdText, 10);
    if (isNaN(currentParsed) || currentParsed !== queryParams.frameId) {
      setFrameIdText(storeHex);
    }
  }, [queryParams.frameId]);

  // Sync mirror frame ID text
  useEffect(() => {
    const storeHex = `0x${queryParams.mirrorFrameId.toString(16).toUpperCase()}`;
    const currentParsed = mirrorFrameIdText.startsWith("0x")
      ? parseInt(mirrorFrameIdText, 16)
      : parseInt(mirrorFrameIdText, 10);
    if (isNaN(currentParsed) || currentParsed !== queryParams.mirrorFrameId) {
      setMirrorFrameIdText(storeHex);
    }
  }, [queryParams.mirrorFrameId]);

  // Sync source frame ID text
  useEffect(() => {
    const storeHex = `0x${queryParams.sourceFrameId.toString(16).toUpperCase()}`;
    const currentParsed = sourceFrameIdText.startsWith("0x")
      ? parseInt(sourceFrameIdText, 16)
      : parseInt(sourceFrameIdText, 10);
    if (isNaN(currentParsed) || currentParsed !== queryParams.sourceFrameId) {
      setSourceFrameIdText(storeHex);
    }
  }, [queryParams.sourceFrameId]);

  // Sync limit override when settings change
  useEffect(() => {
    setLimitOverride(queryResultLimit);
  }, [queryResultLimit]);

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
    if (bufferId) {
      enqueueQuery(bufferId, "buffer", timeBounds, limitOverride);
    } else if (profileId) {
      enqueueQuery(profileId, "postgres", timeBounds, limitOverride);
    }
  }, [profileId, bufferId, timeBounds, limitOverride, enqueueQuery]);

  // Handle query type change
  const handleQueryTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setQueryType(e.target.value as QueryType);
    },
    [setQueryType]
  );

  // Handle frame ID change - update local state immediately, store on valid parse
  const handleFrameIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setFrameIdText(value);

      // Support hex (0x...) or decimal
      const frameId = value.startsWith("0x")
        ? parseInt(value, 16)
        : parseInt(value, 10);
      if (!isNaN(frameId) && frameId >= 0) {
        updateQueryParams({ frameId });
      }
    },
    [updateQueryParams]
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
        setFrameIdText(`0x${frameId.toString(16).toUpperCase()}`);
      }
    },
    [updateQueryParams, setSelectedSignal, parsedCatalog]
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

  // Handle mirror frame ID change (manual input)
  const handleMirrorFrameIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setMirrorFrameIdText(value);
      const frameId = value.startsWith("0x")
        ? parseInt(value, 16)
        : parseInt(value, 10);
      if (!isNaN(frameId) && frameId >= 0) {
        updateQueryParams({ mirrorFrameId: frameId });
      }
    },
    [updateQueryParams]
  );

  // Handle source frame ID change (manual input)
  const handleSourceFrameIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSourceFrameIdText(value);
      const frameId = value.startsWith("0x")
        ? parseInt(value, 16)
        : parseInt(value, 10);
      if (!isNaN(frameId) && frameId >= 0) {
        updateQueryParams({ sourceFrameId: frameId });
      }
    },
    [updateQueryParams]
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
      setMirrorFrameIdText(`0x${mirrorFrameId.toString(16).toUpperCase()}`);
      if (sourceFrameId !== null) {
        setSourceFrameIdText(`0x${sourceFrameId.toString(16).toUpperCase()}`);
      }
    },
    [mirrorFrames, getMirrorSourceId, updateQueryParams, parsedCatalog]
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
  // These types don't need a frame ID input (or use their own specialised inputs)
  const hideFrameId = showMirrorValidation || showPatternSearch;

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
  const isBufferSource = !!bufferId;

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
        return `-- SQLite buffer query (pattern matching in Rust)
SELECT timestamp_us, frame_id, is_extended, payload
FROM frames
WHERE buffer_id = ?${timeConditions}
ORDER BY rowid
LIMIT ${limitOverride.toLocaleString()}
-- Pattern: ${patternStr}`;
      }

      return `-- Query type "${queryType}" not yet implemented for buffers`;
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

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable form content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Buffer Source Selector (shown when buffers are available) */}
        {buffers.length > 0 && (
          <div>
            <label className={labelSmallMuted}>Buffer Source</label>
            <div className={`${flexRowGap2} mt-1`}>
              <HardDrive className={`${iconSm} ${textSecondary} flex-shrink-0`} />
              <select
                value={bufferId ?? ""}
                onChange={(e) => onSelectBuffer?.(e.target.value || null)}
                className={`${inputBase} flex-1`}
              >
                <option value="">{profileId ? "Using PostgreSQL profile" : "— Select buffer —"}</option>
                {buffers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.count.toLocaleString()} frames)
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Query Type */}
        <div>
          <label className={labelSmallMuted}>Query Type</label>
          <select
            value={queryType}
            onChange={handleQueryTypeChange}
            disabled={disabled}
            className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {Object.entries(QUERY_TYPE_INFO).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label}
              </option>
            ))}
          </select>
          <p className={`text-xs ${textSecondary} mt-1`}>{queryInfo.description}</p>
        </div>

        {/* Mirror Validation Parameters */}
        {showMirrorValidation ? (
          <div className="space-y-2">
            {/* Mirror Frame Selection - Catalog picker or manual */}
            {mirrorFrames.length > 0 ? (
              <>
                <div>
                  <label className={labelSmallMuted}>Mirror Frame</label>
                  <select
                    value={queryParams.mirrorFrameId}
                    onChange={handleCatalogMirrorFrameChange}
                    disabled={disabled}
                    className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <option value={0}>— Select mirror frame —</option>
                    {mirrorFrames.map(({ id, frame }) => {
                      // Resolve source frame info for display
                      const sourceId = frame.mirrorOf ? getMirrorSourceId(frame.mirrorOf) : null;
                      const sourceFrame = sourceId !== null ? parsedCatalog?.frames.get(sourceId) : null;
                      const sourceInfo = sourceId !== null
                        ? ` → 0x${sourceId.toString(16).toUpperCase().padStart(3, "0")}${sourceFrame?.transmitter ? ` — ${sourceFrame.transmitter}` : ""}`
                        : "";
                      return (
                        <option key={id} value={id}>
                          0x{id.toString(16).toUpperCase().padStart(3, "0")}
                          {frame.transmitter ? ` — ${frame.transmitter}` : ""}
                          {sourceInfo}
                        </option>
                      );
                    })}
                  </select>
                  {queryParams.mirrorFrameId > 0 && (
                    <p className={`text-xs ${textMuted} mt-1`}>
                      mirrors → 0x{queryParams.sourceFrameId.toString(16).toUpperCase().padStart(3, "0")}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Manual mirror frame ID inputs */}
                <div>
                  <label className={labelSmallMuted}>Mirror Frame ID</label>
                  <div className={`${flexRowGap2} mt-1`}>
                    <input
                      type="text"
                      value={mirrorFrameIdText}
                      onChange={handleMirrorFrameIdChange}
                      disabled={disabled}
                      placeholder="0x123"
                      className={`${inputBase} flex-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                    <label className={`${flexRowGap2} ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={queryParams.isExtended === true}
                        onChange={handleExtendedChange}
                        disabled={disabled}
                        className="disabled:cursor-not-allowed"
                      />
                      Extended
                    </label>
                  </div>
                </div>
                <div>
                  <label className={labelSmallMuted}>Source Frame ID</label>
                  <input
                    type="text"
                    value={sourceFrameIdText}
                    onChange={handleSourceFrameIdChange}
                    disabled={disabled}
                    placeholder="0x456"
                    className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                </div>
              </>
            )}
            {/* Tolerance */}
            <div>
              <label className={labelSmallMuted}>Tolerance</label>
              <div className={`${flexRowGap2} mt-1`}>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={queryParams.toleranceMs}
                  onChange={handleToleranceChange}
                  disabled={disabled}
                  className={`${inputBase} w-20 disabled:opacity-50 disabled:cursor-not-allowed`}
                />
                <span className={`text-xs ${textMuted}`}>ms — how close timestamps must be</span>
              </div>
            </div>
          </div>
        ) : showPatternSearch ? (
          /* Pattern Search — no frame ID, just a hex pattern input */
          <div className="space-y-2">
            <div>
              <label className={labelSmallMuted}>Byte Pattern (hex, ?? = wildcard)</label>
              <input
                type="text"
                value={patternText}
                onChange={handlePatternTextChange}
                disabled={disabled}
                placeholder="AA ?? BB CC"
                className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed font-mono`}
              />
              <p className={`text-xs ${textMuted} mt-1`}>
                {queryParams.pattern.length > 0
                  ? `${queryParams.pattern.length} bytes, ${queryParams.patternMask.filter((m) => m === 0).length} wildcards`
                  : "Enter hex bytes separated by spaces"}
              </p>
            </div>
          </div>
        ) : (
          /* Frame Selection - Catalog picker or manual input */
          hasCatalogFrames ? (
            <div className="space-y-2">
              {/* Catalog Frame Picker */}
              <div>
                <label className={labelSmallMuted}>Frame</label>
                <select
                  value={queryParams.frameId}
                  onChange={handleCatalogFrameChange}
                  disabled={disabled}
                  className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {catalogFrames.map(({ id, frame }) => (
                    <option key={id} value={id}>
                      0x{id.toString(16).toUpperCase().padStart(3, "0")}
                      {frame.transmitter ? ` — ${frame.transmitter}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              {/* Signal Picker (for byte_changes / distribution) */}
              {showByteIndex && currentFrameSignals.length > 0 && (
                <div>
                  <label className={labelSmallMuted}>Signal</label>
                  <select
                    value={selectedSignal?.signalName ?? ""}
                    onChange={handleCatalogSignalChange}
                    disabled={disabled}
                    className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <option value="">— Select signal or use byte index below —</option>
                    {currentFrameSignals
                      .filter((s) => s.name && s.start_bit !== undefined)
                      .map((signal) => (
                        <option key={signal.name} value={signal.name}>
                          {signal.name}
                          {signal.unit ? ` (${signal.unit})` : ""}
                          {` — byte ${Math.floor((signal.start_bit ?? 0) / 8)}`}
                        </option>
                      ))}
                  </select>
                  {selectedSignal && (
                    <p className={`text-xs ${textMuted} mt-1`}>
                      start_bit: {selectedSignal.startBit}, bit_length: {selectedSignal.bitLength}
                      {" → "} byte {selectedSignal.byteIndex}
                    </p>
                  )}
                </div>
              )}

              {/* Byte Index - shown when no signal selected or no signals available */}
              {showByteIndex && (
                <div>
                  <label className={labelSmallMuted}>
                    Byte Index {selectedSignal ? "(from signal)" : ""}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={63}
                    value={queryParams.byteIndex}
                    onChange={handleByteIndexChange}
                    disabled={disabled || !!selectedSignal}
                    className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                </div>
              )}

              {/* Mux Statistics Parameters */}
              {showMuxStatistics && (
                <div className="space-y-2">
                  <div>
                    <label className={labelSmallMuted}>Mux Selector Byte</label>
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
                      className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                  </div>
                  <div>
                    <label className={labelSmallMuted}>Payload Length (bytes)</label>
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
                      className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
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
                    Include 16-bit word statistics (LE &amp; BE)
                  </label>
                </div>
              )}

              {/* Gap Analysis Parameters */}
              {showGapAnalysis && (
                <div>
                  <label className={labelSmallMuted}>Gap Threshold</label>
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
                      className={`${inputBase} w-24 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                    <span className={`text-xs ${textMuted}`}>ms — minimum gap duration to report</span>
                  </div>
                </div>
              )}

              {/* Frequency Parameters */}
              {showFrequency && (
                <div>
                  <label className={labelSmallMuted}>Bucket Size</label>
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
                      className={`${inputBase} w-24 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                    <span className={`text-xs ${textMuted}`}>ms — time bucket width</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Manual Frame ID Input */}
              {!hideFrameId && (
              <div>
                <label className={labelSmallMuted}>Frame ID (hex or decimal)</label>
                <div className={`${flexRowGap2} mt-1`}>
                  <input
                    type="text"
                    value={frameIdText}
                    onChange={handleFrameIdChange}
                    disabled={disabled}
                    placeholder="0x123 or 291"
                    className={`${inputBase} flex-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                  <label className={`${flexRowGap2} ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
                    <input
                      type="checkbox"
                      checked={queryParams.isExtended === true}
                      onChange={handleExtendedChange}
                      disabled={disabled}
                      className="disabled:cursor-not-allowed"
                    />
                    Extended
                  </label>
                </div>
              </div>
              )}

              {/* Byte Index (for byte_changes / distribution) */}
              {showByteIndex && (
                <div>
                  <label className={labelSmallMuted}>Byte Index</label>
                  <input
                    type="number"
                    min={0}
                    max={63}
                    value={queryParams.byteIndex}
                    onChange={handleByteIndexChange}
                    disabled={disabled}
                    className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                </div>
              )}

              {/* Mux Statistics Parameters */}
              {showMuxStatistics && (
                <div className="space-y-2">
                  <div>
                    <label className={labelSmallMuted}>Mux Selector Byte</label>
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
                      className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                  </div>
                  <div>
                    <label className={labelSmallMuted}>Payload Length (bytes)</label>
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
                      className={`${inputBase} w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed`}
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
                    Include 16-bit word statistics (LE &amp; BE)
                  </label>
                </div>
              )}

              {/* Gap Analysis Parameters */}
              {showGapAnalysis && (
                <div>
                  <label className={labelSmallMuted}>Gap Threshold</label>
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
                      className={`${inputBase} w-24 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                    <span className={`text-xs ${textMuted}`}>ms — minimum gap duration to report</span>
                  </div>
                </div>
              )}

              {/* Frequency Parameters */}
              {showFrequency && (
                <div>
                  <label className={labelSmallMuted}>Bucket Size</label>
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
                      className={`${inputBase} w-24 disabled:opacity-50 disabled:cursor-not-allowed`}
                    />
                    <span className={`text-xs ${textMuted}`}>ms — time bucket width</span>
                  </div>
                </div>
              )}
            </>
          )
        )}

        {/* Context Window */}
        <div className={`${bgSurface} ${borderDefault} rounded-lg p-2`}>
          <div className={`${flexRowGap2} mb-1`}>
            <label className={`text-xs font-medium ${textSecondary}`}>Context Window</label>
            <span className={`text-xs ${textMuted}`}>— data to ingest around each event</span>
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
                <label className={`text-xs ${textMuted}`}>Before</label>
                <div className={flexRowGap2}>
                  <input
                    type="number"
                    min={0}
                    value={contextWindow.beforeMs}
                    onChange={handleContextBeforeChange}
                    disabled={disabled}
                    className={`${inputBase} w-full text-xs disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                  <span className={`text-xs ${textMuted}`}>ms</span>
                </div>
              </div>
              <div className="flex-1">
                <label className={`text-xs ${textMuted}`}>After</label>
                <div className={flexRowGap2}>
                  <input
                    type="number"
                    min={0}
                    value={contextWindow.afterMs}
                    onChange={handleContextAfterChange}
                    disabled={disabled}
                    className={`${inputBase} w-full text-xs disabled:opacity-50 disabled:cursor-not-allowed`}
                  />
                  <span className={`text-xs ${textMuted}`}>ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Time Bounds */}
        <div className={`${bgSurface} ${borderDefault} rounded-lg p-2`}>
          <label className={`text-xs font-medium ${textSecondary} mb-2 block`}>Time Bounds</label>
          <TimeBoundsInput
            value={timeBounds}
            onChange={onTimeBoundsChange}
            bookmarks={favourites}
            showBookmarks={true}
            disabled={disabled}
          />
        </div>

        {/* SQL Query Preview */}
        <div className={`${bgSurface} ${borderDefault} rounded-lg p-2`}>
          <label className={`text-xs font-medium ${textSecondary} mb-1 block`}>SQL Query Preview</label>
          <textarea
            readOnly
            value={sqlPreview}
            className={`${monoBody} text-xs w-full p-2 rounded border ${borderDefault} ${bgSurface} ${textSecondary} resize-none`}
            rows={5}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>
      </div>

      {/* Fixed bottom section with Add to Queue Button */}
      <div className="flex-shrink-0 p-4 pt-0 space-y-2">
        {/* Result limit input */}
        <div className="flex items-center justify-center gap-2">
          <label className={`text-xs ${textMuted}`}>{showMuxStatistics ? "Scan up to" : "Limit results to"}</label>
          <input
            type="number"
            min={100}
            max={maxLimit}
            step={showMuxStatistics ? 100000 : 1000}
            value={limitOverride}
            onChange={handleLimitChange}
            disabled={disabled}
            className={`${inputBase} ${showMuxStatistics ? "w-32" : "w-24"} text-xs text-center disabled:opacity-50 disabled:cursor-not-allowed`}
          />
          <span className={`text-xs ${textMuted}`}>rows</span>
        </div>

        <button
          onClick={handleAddToQueue}
          disabled={disabled}
          className={`${primaryButtonBase} w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <ListPlus className={iconSm} />
          Add to Queue
        </button>
      </div>
    </div>
  );
}
