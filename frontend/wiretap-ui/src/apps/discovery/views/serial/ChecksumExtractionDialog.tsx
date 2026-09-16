// ui/src/apps/discovery/views/serial/ChecksumExtractionDialog.tsx
//
// Dialog for configuring checksum detection and validation.
//
// Detection runs in Rust beside the algorithms (`detect_checksum_cmd`), and the
// Serial Payload tool goes through the same engine. This dialog used to run its
// own narrower search that never varied the checksum position or the calculation
// start, so on a capture whose checksum was a sum-8 at -1 over [1:-1] it found
// nothing and fell back to a hardcoded CRC-16 Modbus that reported 0%.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { iconLg, flexRowGap2 } from '../../../../styles/spacing';
import Dialog from '../../../../components/Dialog';
import { resolveByteIndexSync, type ChecksumAlgorithm } from '../../../../utils/analysis/checksums';
import {
  detectChecksum,
  sweepChecksumSpecs,
  type ChecksumCandidate,
  type ChecksumDetectionResult,
} from '../../../../api/checksums';
import { configFromCandidate, matchesCandidate } from './checksumConfig';
import ChecksumCandidateList from '../../components/ChecksumCandidateList';
import {
  type ChecksumConfig,
  CHECKSUM_ALGORITHMS,
  getChecksumByteCount,
} from './serialTypes';
import { getCaptureFramesTail } from '../../../../api/capture';
import { byteToHex } from '../../../../utils/byteUtils';
import { alertWarning } from '../../../../styles/cardStyles';
import { bgSurface, bgDataView, textPrimary, textSecondary, textMuted, borderDefault, hoverBg } from '../../../../styles';
import { byteHighlight } from '../../../../styles/buttonStyles';

/**
 * Only used when detection finds nothing and the caller supplied no config — a
 * starting point for manual entry, not a guess. The position deliberately follows
 * the most common shape (a trailing 1-byte checksum) rather than the widest.
 */
const FALLBACK_CHECKSUM_CONFIG: ChecksumConfig = {
  startByte: -1,
  numBytes: 1,
  endianness: 'big',
  algorithm: 'unknown',
  calcStartByte: 0,
  calcEndByte: -1,
};

/** Debounce before re-checking a hand-edited configuration. */
const MATCH_RATE_DEBOUNCE_MS = 200;

/**
 * Frames read from the capture for detection. The engine caps its own sample at
 * the same number, so the ranked candidates and the live match rate are measured
 * against one set rather than reporting different denominators.
 */
const CAPTURE_SAMPLE_FRAMES = 200;

interface ChecksumExtractionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fallback sample — the page in view, used when there is no capture to read. */
  sampleFrames: number[][];
  /**
   * Capture to sample from. Detection reads the tail of this rather than the
   * visible page, so the answer does not depend on where the user is paged to.
   */
  captureId: string | null;
  captureFrameCount: number;
  initialConfig: ChecksumConfig | null;
  /**
   * Byte offsets just past a declared header field (from the ID/Source chips).
   * Hints for the calculation range — they widen the search, never narrow it.
   */
  headerBoundaries?: number[];
  onApply: (config: ChecksumConfig) => void;
  onClear?: () => void;
}

export default function ChecksumExtractionDialog({
  isOpen,
  onClose,
  sampleFrames,
  captureId,
  captureFrameCount,
  initialConfig,
  headerBoundaries,
  onApply,
  onClear,
}: ChecksumExtractionDialogProps) {
  const { t } = useTranslation("discovery");
  const [config, setConfig] = useState<ChecksumConfig>(initialConfig ?? FALLBACK_CHECKSUM_CONFIG);
  const [detection, setDetection] = useState<ChecksumDetectionResult | null>(null);
  /** The set detection actually ran on — the match rate must agree with it. */
  const [frames, setFrames] = useState<number[][]>(sampleFrames);
  const [matchRate, setMatchRate] = useState<{ matches: number; total: number }>({ matches: 0, total: 0 });

  // Track whether we've initialized for this dialog open session
  const hasInitializedRef = useRef(false);
  // Guards against a slow response overwriting a newer one.
  const matchRequestRef = useRef(0);

  /** The capture tail if there is one, else whatever the page gave us. */
  const loadSample = useCallback(async (): Promise<number[][]> => {
    if (!captureId || captureFrameCount === 0) return sampleFrames;
    try {
      const { frames } = await getCaptureFramesTail(captureId, CAPTURE_SAMPLE_FRAMES, []);
      return frames.length > 0 ? frames.map((f) => f.bytes) : sampleFrames;
    } catch {
      return sampleFrames;
    }
  }, [captureId, captureFrameCount, sampleFrames]);

  const appliedIndex = useMemo(
    () => detection?.candidates.findIndex(c => matchesCandidate(config, c)) ?? -1,
    [detection, config],
  );
  const applied = appliedIndex >= 0 ? detection!.candidates[appliedIndex] : null;

  const runDetection = useCallback(async () => {
    const frames = await loadSample();
    setFrames(frames);
    const result = await detectChecksum(frames, { headerBoundaries });
    setDetection(result);
    // Only seed when the caller had nothing — a config the user already chose
    // (or one restored from the store) outranks a fresh detection.
    if (result.bestCandidate && !initialConfig) {
      setConfig(configFromCandidate(result.bestCandidate));
    }
  }, [loadSample, headerBoundaries, initialConfig]);

  /**
   * Re-check the current configuration.
   *
   * One batched sweep of a single spec rather than one IPC call per sampled
   * frame, which is what made every keystroke in a number field cost twenty
   * round trips.
   */
  const updateMatchRate = useCallback(async () => {
    if (config.algorithm === 'unknown' || frames.length === 0) {
      setMatchRate({ matches: 0, total: 0 });
      return;
    }

    if (applied) {
      // Detection already measured this exact geometry, over the same frames.
      setMatchRate({ matches: applied.matchCount, total: applied.totalCount });
      return;
    }

    const request = ++matchRequestRef.current;
    const { results } = await sweepChecksumSpecs(
      frames,
      [{
        algorithm: config.algorithm,
        position: config.startByte,
        byteLength: config.numBytes as 1 | 2,
        bigEndian: config.endianness === 'big',
        calcStartByte: config.calcStartByte,
        calcEndByte: config.calcEndByte,
      }],
    );

    if (request !== matchRequestRef.current) return;
    const result = results[0];
    setMatchRate({ matches: result?.matchCount ?? 0, total: result?.totalCount ?? 0 });
  }, [config, frames, applied]);

  // Reset state and detect when the dialog opens (only once per open)
  useEffect(() => {
    if (isOpen && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setConfig(initialConfig ?? FALLBACK_CHECKSUM_CONFIG);
      runDetection();
    }
    if (!isOpen) {
      hasInitializedRef.current = false;
      setDetection(null);
    }
  }, [isOpen, initialConfig, runDetection]);

  // Re-check on config change, debounced so held arrow keys do not queue calls.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(updateMatchRate, MATCH_RATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, updateMatchRate]);

  const applyCandidate = useCallback((candidate: ChecksumCandidate) => {
    setConfig(configFromCandidate(candidate));
  }, []);

  /**
   * The byte count is a property of the algorithm, so it always follows. The
   * positions only move far enough to stay valid — a wider checksum has to fit,
   * and it must not sit inside its own calculation range. Anything the user
   * chose beyond that survives, which is what stopped the dropdown from
   * silently undoing a hand-set position.
   */
  const handleAlgorithmChange = useCallback((algorithm: ChecksumAlgorithm | 'unknown') => {
    const byteCount = getChecksumByteCount(algorithm);
    setConfig(prev => {
      const startByte = Math.min(prev.startByte, -byteCount);
      return {
        ...prev,
        algorithm,
        numBytes: byteCount,
        startByte,
        calcEndByte: Math.min(prev.calcEndByte, startByte),
      };
    });
  }, []);

  const setPosition = useCallback((patch: Partial<ChecksumConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
  }, []);

  const matchPercentage = matchRate.total > 0 ? (matchRate.matches / matchRate.total) * 100 : 0;

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className={`text-lg font-semibold ${textPrimary}`}>{t("serial.checksumDialogTitle")}</h2>
          <button onClick={onClose} className={`p-1 ${hoverBg} rounded`} aria-label={t("common:actions.close")}>
            <X className={`${iconLg} ${textSecondary}`} />
          </button>
        </div>

        {/*
          Three states, one expression: still searching, ranked candidates, or an
          explanation. A bare red 0% reads as "your data is wrong" — naming what
          was searched and what the trailing bytes look like points at the next
          thing to try.
        */}
        {detection === null ? (
          <div className={`text-sm ${textMuted}`}>{t("serial.checksumDetecting")}</div>
        ) : detection.candidates.length > 0 ? (
          <div className="space-y-2">
            <div className={`text-sm font-medium ${textSecondary}`}>
              {t("serialAnalysis.candidateChecksums")}
            </div>
            <div className="max-h-64 overflow-y-auto">
              <ChecksumCandidateList
                candidates={detection.candidates}
                appliedIndex={appliedIndex === -1 ? null : appliedIndex}
                onApply={applyCandidate}
              />
            </div>
          </div>
        ) : (
          <div className={`${alertWarning} space-y-2`}>
            <div className="text-sm font-medium text-[color:var(--status-warning-text)]">
              {t("serial.checksumNoCandidates")}
            </div>
            <ul className={`text-xs ${textMuted} list-disc pl-4 space-y-0.5`}>
              {detection.notes.map((note, idx) => (
                <li key={idx}>{t(`serial.checksumNote.${note.code}`, note.values)}</li>
              ))}
            </ul>
            {detection.tailColumns.length > 0 && (
              <div className={`text-xs ${textMuted} font-mono`}>
                {detection.tailColumns.map(column => (
                  <div key={column.position}>
                    {t("serial.checksumTailColumn", {
                      position: column.position,
                      distinct: column.distinctValues,
                      samples: column.sampleCount,
                    })}
                    {column.constantValue !== null
                      ? ` — ${t("serial.checksumColumnConstant", { value: byteToHex(column.constantValue) })}`
                      : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Sample frames preview */}
        <div className={`space-y-2 font-mono text-sm ${bgDataView} p-3 rounded max-h-40 overflow-y-auto`}>
          {frames.slice(0, 5).map((frame, frameIdx) => {
            const checksumStart = resolveByteIndexSync(config.startByte, frame.length);
            const calcEnd = resolveByteIndexSync(config.calcEndByte, frame.length);

            return (
              <div key={frameIdx} className={flexRowGap2}>
                <span className={`${textMuted} w-6 text-right`}>{frameIdx + 1}.</span>
                <div className="flex gap-1 flex-wrap">
                  {frame.map((byte, byteIdx) => {
                    const isChecksum = byteIdx >= checksumStart && byteIdx < checksumStart + config.numBytes;
                    const isCalcData = byteIdx >= config.calcStartByte && byteIdx < calcEnd;
                    // Mark constant trailing columns, so it is visible why a
                    // position was passed over rather than merely asserted.
                    const isConstant = detection?.tailColumns.some(
                      c => c.constantValue !== null && frame.length + c.position === byteIdx
                    ) ?? false;

                    return (
                      <span
                        key={byteIdx}
                        className={`${byteHighlight(
                          isChecksum ? 'checksum' : isCalcData ? 'calcData' : 'default'
                        )}${isConstant && !isChecksum ? ' underline decoration-dotted opacity-60' : ''}`}
                        title={isConstant ? t("serial.checksumColumnConstantTooltip") : undefined}
                      >
                        {byteToHex(byte)}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Configuration */}
        <div className={`grid grid-cols-2 gap-4 pt-2 border-t ${borderDefault}`}>
          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            {t("serial.algorithm")}
            <select
              value={config.algorithm}
              onChange={(e) => handleAlgorithmChange(e.target.value as ChecksumAlgorithm)}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary}`}
            >
              {CHECKSUM_ALGORITHMS.map(algo => (
                <option key={algo.value} value={algo.value}>{algo.label}</option>
              ))}
            </select>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            {t("serial.byteOrder")}
            <select
              value={config.endianness}
              onChange={(e) => setConfig(prev => ({ ...prev, endianness: e.target.value as 'big' | 'little' }))}
              disabled={config.numBytes < 2}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary} disabled:opacity-50`}
            >
              <option value="little">{t("serial.littleEndian")}</option>
              <option value="big">{t("serial.bigEndian")}</option>
            </select>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            {t("serial.checksumPosition")}
            <input
              type="number"
              value={config.startByte}
              onChange={(e) => setPosition({ startByte: Number(e.target.value) })}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary}`}
            />
            <span className={`text-xs ${textMuted}`}>{t("serial.negativeHint")}</span>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            {t("serial.calcDataRange")}
            <div className={flexRowGap2}>
              <input
                type="number"
                value={config.calcStartByte}
                onChange={(e) => setPosition({ calcStartByte: Number(e.target.value) })}
                className={`w-16 px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary} text-center`}
              />
              <span className={textMuted}>{t("serial.rangeTo")}</span>
              <input
                type="number"
                value={config.calcEndByte}
                onChange={(e) => setPosition({ calcEndByte: Number(e.target.value) })}
                className={`w-16 px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary} text-center`}
              />
            </div>
          </label>
        </div>

        {/* Match Rate */}
        <div className="flex items-center gap-2">
          <div className={`flex-1 text-sm p-2 rounded ${
            matchPercentage >= 90 ? 'bg-green-900/30 text-green-400' :
            matchPercentage >= 50 ? 'bg-yellow-900/30 text-yellow-400' :
            'bg-red-900/30 text-red-400'
          }`}>
            {t("serial.matchRate", { matches: matchRate.matches, total: matchRate.total, percent: matchPercentage.toFixed(0) })}
          </div>
          {detection?.bestCandidate && (
            <button
              type="button"
              onClick={() => applyCandidate(detection.bestCandidate!)}
              className={`px-3 py-2 text-sm ${bgSurface} ${textSecondary} hover:brightness-95 rounded whitespace-nowrap`}
            >
              {t("serial.checksumResetToDetected")}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          {onClear ? (
            <button
              onClick={() => {
                onClear();
                onClose();
              }}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded"
            >
              {t("serial.clear")}
            </button>
          ) : (
            <button
              onClick={onClose}
              className={`px-4 py-2 text-sm ${bgSurface} ${textSecondary} hover:brightness-95 rounded`}
            >
              {t("modbusScan.cancel")}
            </button>
          )}
          <button
            onClick={() => {
              onApply(config);
              onClose();
            }}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 rounded font-medium"
          >
            {t("serial.apply")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
