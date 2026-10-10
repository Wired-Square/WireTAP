// src/apps/query/views/QueryBuilderPanel.tsx
//
// Query configuration panel. Users select query type, frame ID, byte index,
// and context window settings. The source
// (a SQLite capture or a WireTAP backend profile) is chosen via the shared Data Source
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
  buildQuerySpec,
  takesLimit,
} from "../stores/queryStore";
import { previewQuery, type QuerySource } from "../../../api/query";
import type { Frame, Signal } from "../../../types/catalogModel";
import { frameByKey, framesById } from "../../../utils/catalogFrames";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import type { FrameIdFormat } from "../../../hooks/useSettings";
import { formatFrameId, formatFrameIdInput, parseFrameId } from "../../../utils/frameIds";
import TimeBoundsInput, { type TimeBounds } from "../../../components/TimeBoundsInput";
import { labelSmallMuted } from "../../../styles/typography";
import { iconSm, flexRowGap2 } from "../../../styles/spacing";
import { bgSurface, borderDefault, textSecondary, textMuted } from "../../../styles/colourTokens";
import { Button } from "../../../components/Button";
import { PrimaryButton, Checkbox, Input, Select, Textarea } from "../../../components/forms";

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
  timeBounds: TimeBounds;
  onTimeBoundsChange: (bounds: TimeBounds) => void;
  /** Active frame-id display format (Auto/Hex/Dec toggle in the top bar) */
  displayIdFormat: FrameIdFormat;
}

export default function QueryBuilderPanel({
  profileId,
  captureId,
  disabled = false,
  timeBounds,
  onTimeBoundsChange,
  displayIdFormat,
}: Props) {
  const { t } = useTranslation("query");
  // Store selectors
  const queryType = useQueryStore((s) => s.queryType);
  const queryParams = useQueryStore((s) => s.queryParams);
  const contextWindow = useQueryStore((s) => s.contextWindow);
  const catalog = useQueryStore((s) => s.catalog);
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

  const catalogFrameMap = useMemo(() => (catalog ? framesById(catalog) : new Map<number, Frame>()), [catalog]);
  const catalogFrames = useMemo(
    () => Array.from(catalogFrameMap, ([id, frame]) => ({ id, frame })).sort((a, b) => a.id - b.id),
    [catalogFrameMap]
  );

  const currentFrameSignals = useMemo(
    (): Signal[] => catalogFrameMap.get(queryParams.frameId)?.signals ?? [],
    [catalogFrameMap, queryParams.frameId]
  );

  const hasCatalogFrames = catalogFrames.length > 0;

  const mirrorFrames = useMemo(() => catalogFrames.filter(({ frame }) => frame.mirrorOf), [catalogFrames]);

  const mirrorSource = useCallback(
    (frame: Frame): Frame | undefined => (frame.mirrorOf ? frameByKey(catalog, frame.protocol, frame.mirrorOf) : undefined),
    [catalog]
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
  const source = useMemo((): QuerySource | null => {
    if (captureId) return { kind: "capture", id: captureId };
    return profileId ? { kind: "backend", id: profileId } : null;
  }, [captureId, profileId]);

  const handleAddToQueue = useCallback(() => {
    if (source) enqueueQuery(source, timeBounds, limitOverride);
  }, [source, timeBounds, limitOverride, enqueueQuery]);

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
        const isExtended = catalogFrameMap.get(frameId)?.isExtended ?? false;
        updateQueryParams({ frameId, isExtended });
        setSelectedSignal(null); // Clear signal when frame changes
        setFrameIdText(formatFrameIdInput(frameId, displayIdFormat));
      }
    },
    [updateQueryParams, setSelectedSignal, catalogFrameMap, displayIdFormat, setFrameIdText]
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
      if (signal && signal.startBit !== undefined && signal.bitLength !== undefined) {
        const newSignal: SelectedSignal = {
          frameId: queryParams.frameId,
          signalName: signal.name ?? signalName,
          startBit: signal.startBit,
          bitLength: signal.bitLength,
          byteIndex: Math.floor(signal.startBit / 8),
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

      const frame = catalogFrameMap.get(mirrorFrameId);
      const sourceFrameId = frame ? mirrorSource(frame)?.frameId ?? null : null;
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
    [catalogFrameMap, mirrorSource, updateQueryParams, displayIdFormat, setMirrorFrameIdText, setSourceFrameIdText]
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
  const showInventory = queryType === "frame_inventory";

  // Frame-id label/placeholder follow the active display format.
  const isHex = displayIdFormat === "hex";
  const frameIdLabel = t("builder.frameIdManual", {
    type: t(isHex ? "builder.frameIdTypeHex" : "builder.frameIdTypeDecimal"),
  });
  const frameIdPlaceholder = t(isHex ? "builder.frameIdPlaceholderHex" : "builder.frameIdPlaceholderDecimal");
  const byteIndexLabel = selectedSignal ? t("builder.byteIndexFromSignal") : t("builder.byteIndex");

  const maxLimit = 100_000;

  const handleLimitChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const limit = parseInt(e.target.value, 10);
      if (!isNaN(limit) && limit >= 100 && limit <= maxLimit) {
        setLimitOverride(limit);
      }
    },
    [maxLimit]
  );

  const catalogPath = useQueryStore((s) => s.catalogPath);
  const [sqlPreview, setSqlPreview] = useState("");
  useEffect(() => {
    if (!sqlOpen || !source) return;
    let current = true;
    const show = (text: string) => current && setSqlPreview(text);
    try {
      const spec = buildQuerySpec(queryType, queryParams, timeBounds, limitOverride);
      previewQuery({ source, spec, ...(catalogPath ? { catalog_path: catalogPath } : {}) })
        .then((sql) => show(sql.join("\n\n")))
        .catch((e) => show(String(e)));
    } catch (e) {
      show(e instanceof Error ? e.message : String(e));
    }
    return () => {
      current = false;
    };
  }, [sqlOpen, source, queryType, queryParams, timeBounds, limitOverride, catalogPath]);

  // ── Reusable field fragments ──

  const extendedCheckbox = (
    <label className={`${flexRowGap2} h-8 ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
      <Checkbox
        checked={queryParams.isExtended === true}
        onChange={handleExtendedChange}
        disabled={disabled}
      />
      {t("builder.extended")}
    </label>
  );

  // Byte index field, reused by the catalog and manual frame selectors.
  const byteIndexField = (
    <div className={hasCatalogFrames ? undefined : "w-24"}>
      <label className={labelSmallMuted}>{byteIndexLabel}</label>
      <Input
        type="number"
        min={0}
        max={63}
        value={queryParams.byteIndex}
        onChange={handleByteIndexChange}
        disabled={disabled || !!selectedSignal}
        className="mt-1"
      />
    </div>
  );

  // Frame selector: a catalog dropdown when a catalog is loaded, else manual entry.
  const frameSelector = hasCatalogFrames ? (
    <div className="space-y-2">
      <div>
        <label className={labelSmallMuted}>{t("builder.frame")}</label>
        <Select
          value={queryParams.frameId}
          onChange={handleCatalogFrameChange}
          disabled={disabled}
          className="mt-1"
        >
          {catalogFrames.map(({ id, frame }) => (
            <option key={id} value={id}>
              {fmtId(id, frame.isExtended)}
              {frame.transmitter ? ` — ${frame.transmitter}` : ""}
            </option>
          ))}
        </Select>
      </div>

      {/* Signal Picker (for byte_changes / distribution) */}
      {showByteIndex && currentFrameSignals.length > 0 && (
        <div>
          <label className={labelSmallMuted}>{t("builder.signal")}</label>
          <Select
            value={selectedSignal?.signalName ?? ""}
            onChange={handleCatalogSignalChange}
            disabled={disabled}
            className="mt-1"
          >
            <option value="">{t("builder.selectSignalOrByte")}</option>
            {currentFrameSignals
              .filter((s) => s.name && s.startBit !== undefined)
              .map((signal) => (
                <option key={signal.name} value={signal.name}>
                  {signal.name}
                  {signal.unit ? ` (${signal.unit})` : ""}
                  {t("builder.signalOption", { byte: Math.floor((signal.startBit ?? 0) / 8) })}
                </option>
              ))}
          </Select>
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
        <Input
          type="text"
          value={frameIdText}
          onChange={handleFrameIdInput(setFrameIdText, "frameId")}
          disabled={disabled}
          placeholder={frameIdPlaceholder}
          className="mt-1"
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
            <Input
              type="number"
              min={0}
              max={7}
              value={queryParams.muxSelectorByte}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0 && v < 64) updateQueryParams({ muxSelectorByte: v });
              }}
              disabled={disabled}
              className="mt-1"
            />
          </div>
          <div>
            <label className={labelSmallMuted}>{t("builder.payloadLength")}</label>
            <Input
              type="number"
              min={1}
              max={64}
              value={queryParams.payloadLength}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 64) updateQueryParams({ payloadLength: v });
              }}
              disabled={disabled}
              className="mt-1"
            />
          </div>
          <label className={`${flexRowGap2} ${textSecondary} text-xs ${disabled ? "opacity-50" : ""}`}>
            <Checkbox
              checked={queryParams.include16Bit}
              onChange={(e) => updateQueryParams({ include16Bit: e.target.checked })}
              disabled={disabled}
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
            <Input
              type="number"
              min={1}
              max={60000}
              value={queryParams.gapThresholdMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) updateQueryParams({ gapThresholdMs: v });
              }}
              disabled={disabled}
              className="w-24"
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
            <Input
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
              className="w-24"
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
          <Select
            value={queryType}
            onChange={handleQueryTypeChange}
            disabled={disabled}
            className="mt-1"
          >
            {Object.entries(QUERY_TYPE_INFO).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label}
              </option>
            ))}
          </Select>
          <p className={`text-xs ${textSecondary} mt-1`}>{queryInfo.description}</p>
        </div>

        {/* Parameters — vary by query type */}
        {showMirrorValidation ? (
          <div className="space-y-2">
            {/* Mirror Frame Selection - Catalog picker or manual */}
            {mirrorFrames.length > 0 ? (
              <div>
                <label className={labelSmallMuted}>{t("builder.mirrorFrame")}</label>
                <Select
                  value={queryParams.mirrorFrameId}
                  onChange={handleCatalogMirrorFrameChange}
                  disabled={disabled}
                  className="mt-1"
                >
                  <option value={0}>{t("builder.selectMirror")}</option>
                  {mirrorFrames.map(({ id, frame }) => {
                    const source = mirrorSource(frame);
                    const sourceInfo = source
                      ? ` → ${fmtId(source.frameId, source.isExtended)}${source.transmitter ? ` — ${source.transmitter}` : ""}`
                      : "";
                    return (
                      <option key={id} value={id}>
                        {fmtId(id, frame.isExtended)}
                        {frame.transmitter ? ` — ${frame.transmitter}` : ""}
                        {sourceInfo}
                      </option>
                    );
                  })}
                </Select>
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
                    <Input
                      type="text"
                      value={mirrorFrameIdText}
                      onChange={handleFrameIdInput(setMirrorFrameIdText, "mirrorFrameId")}
                      disabled={disabled}
                      placeholder={frameIdPlaceholder}
                      className="flex-1"
                    />
                    {extendedCheckbox}
                  </div>
                </div>
                <div>
                  <label className={labelSmallMuted}>{t("builder.sourceFrameId")}</label>
                  <Input
                    type="text"
                    value={sourceFrameIdText}
                    onChange={handleFrameIdInput(setSourceFrameIdText, "sourceFrameId")}
                    disabled={disabled}
                    placeholder={frameIdPlaceholder}
                    className="mt-1"
                  />
                </div>
              </>
            )}
            {/* Tolerance */}
            <div>
              <label className={labelSmallMuted}>{t("builder.tolerance")}</label>
              <div className={`${flexRowGap2} mt-1`}>
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={queryParams.toleranceMs}
                  onChange={handleToleranceChange}
                  disabled={disabled}
                  className="w-20"
                />
                <span className={`text-xs ${textMuted}`}>{t("builder.toleranceHint")}</span>
              </div>
            </div>
          </div>
        ) : showInventory ? (
          /* Inventory — no parameters beyond the time range */
          <p className={`text-xs ${textMuted}`}>{t("builder.inventoryHint")}</p>
        ) : showPatternSearch ? (
          /* Pattern Search — no frame ID, just a hex pattern input */
          <div>
            <label className={labelSmallMuted}>{t("builder.bytePattern")}</label>
            <Input
              type="text"
              value={patternText}
              onChange={handlePatternTextChange}
              disabled={disabled}
              placeholder={t("builder.patternPlaceholder")}
              mono
              className="mt-1"
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
                <Button
                  key={preset.label}
                  onClick={() => handlePresetClick(preset.beforeMs, preset.afterMs)}
                  disabled={disabled}
                  size="sm"
                  tone="warning"
                  pressed={contextWindow.beforeMs === preset.beforeMs && contextWindow.afterMs === preset.afterMs}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-2 flex-1 min-w-45">
              <div className="flex-1">
                <label className={`text-xs ${textMuted}`}>{t("builder.before")}</label>
                <div className={flexRowGap2}>
                  <Input
                    type="number"
                    min={0}
                    value={contextWindow.beforeMs}
                    onChange={handleContextBeforeChange}
                    disabled={disabled}
                  />
                  <span className={`text-xs ${textMuted}`}>{t("builder.ms")}</span>
                </div>
              </div>
              <div className="flex-1">
                <label className={`text-xs ${textMuted}`}>{t("builder.after")}</label>
                <div className={flexRowGap2}>
                  <Input
                    type="number"
                    min={0}
                    value={contextWindow.afterMs}
                    onChange={handleContextAfterChange}
                    disabled={disabled}
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
            <Textarea
              readOnly
              value={sqlPreview}
              mono
              className="mt-2"
              rows={8}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          )}
        </div>
      </div>

      {/* Fixed bottom section with Add to Queue Button */}
      <div className="flex-shrink-0 p-4 pt-0 space-y-2">
        {takesLimit(queryType) && (
          <div className="flex items-center justify-center gap-2">
            <label className={`text-xs ${textMuted}`}>{t("builder.limitResults")}</label>
            <Input
              type="number"
              min={100}
              max={maxLimit}
              step={1000}
              value={limitOverride}
              onChange={handleLimitChange}
              disabled={disabled}
              className="w-24 text-center"
            />
            <span className={`text-xs ${textMuted}`}>{t("builder.results")}</span>
          </div>
        )}

        <PrimaryButton
          onClick={handleAddToQueue}
          disabled={disabled}
          className="w-full"
        >
          <ListPlus className={iconSm} />
          {t("builder.addToQueue")}
        </PrimaryButton>
      </div>
    </div>
  );
}
