// ui/src/apps/discovery/views/serial/ChecksumExtractionDialog.tsx
//
// Dialog for configuring checksum detection and validation.

import { useEffect, useState, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { iconLg, flexRowGap2 } from '../../../../styles/spacing';
import Dialog from '../../../../components/Dialog';
import { resolveByteIndexSync, type ChecksumAlgorithm } from '../../../../utils/analysis/checksums';
import {
  autoDetectAlgorithm,
  calculateMatchRate,
  type AlgorithmMatch,
} from '../../../../utils/analysis/checksumAutoDetect';
import {
  type ChecksumConfig,
  CHECKSUM_ALGORITHMS,
  getChecksumByteCount,
} from './serialTypes';
import { byteToHex } from '../../../../utils/byteUtils';
import { bgSurface, bgDataView, textPrimary, textSecondary, textMuted, borderDefault, hoverBg } from '../../../../styles';
import { byteHighlight } from '../../../../styles/buttonStyles';

const DEFAULT_CHECKSUM_CONFIG: ChecksumConfig = {
  startByte: -2,
  numBytes: 2,
  endianness: 'little',
  algorithm: 'crc16_modbus',
  calcStartByte: 0,
  calcEndByte: -2, // Up to but not including checksum
};

interface ChecksumExtractionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sampleFrames: number[][];
  initialConfig: ChecksumConfig | null;
  onApply: (config: ChecksumConfig) => void;
  onClear?: () => void;
}

export default function ChecksumExtractionDialog({
  isOpen,
  onClose,
  sampleFrames,
  initialConfig,
  onApply,
  onClear,
}: ChecksumExtractionDialogProps) {
  const [config, setConfig] = useState<ChecksumConfig>(initialConfig ?? DEFAULT_CHECKSUM_CONFIG);
  const [detectedAlgorithms, setDetectedAlgorithms] = useState<AlgorithmMatch[]>([]);
  const [matchRate, setMatchRate] = useState<{ matches: number; total: number }>({ matches: 0, total: 0 });

  // Track whether we've initialized for this dialog open session
  const hasInitializedRef = useRef(false);

  // Detect which algorithms match the sample frames using shared utility
  const detectAlgorithms = useCallback(async () => {
    if (sampleFrames.length === 0) return;

    const results = await autoDetectAlgorithm(sampleFrames, { maxSamples: 20 });
    setDetectedAlgorithms(results);

    // Auto-select best match if found (>= 80% match rate)
    if (results.length > 0 && results[0].matchRate >= 80) {
      const bestMatch = results[0];
      const byteCount = getChecksumByteCount(bestMatch.algorithm);
      setConfig(prev => ({
        ...prev,
        algorithm: bestMatch.algorithm,
        numBytes: byteCount,
        startByte: -byteCount,
        calcEndByte: -byteCount,
        endianness: bestMatch.endianness,
      }));
    }
  }, [sampleFrames]);

  // Calculate match rate for current config using shared utility
  const updateMatchRate = useCallback(async () => {
    if (config.algorithm === 'unknown') {
      setMatchRate({ matches: 0, total: 0 });
      return;
    }

    const framesToCheck = sampleFrames.slice(0, 20);
    const result = await calculateMatchRate(framesToCheck, config.algorithm, {
      checksumStart: config.startByte,
      checksumBytes: config.numBytes,
      endianness: config.endianness,
      calcStart: config.calcStartByte,
      calcEnd: config.calcEndByte,
    });

    setMatchRate({ matches: result.matches, total: result.total });
  }, [config, sampleFrames]);

  // Reset state and detect algorithms when dialog opens (only once per open)
  useEffect(() => {
    if (isOpen && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setConfig(initialConfig ?? DEFAULT_CHECKSUM_CONFIG);
      detectAlgorithms();
    }
    if (!isOpen) {
      // Reset the flag when dialog closes
      hasInitializedRef.current = false;
    }
  }, [isOpen, initialConfig, detectAlgorithms]);

  // Update match rate when config changes
  useEffect(() => {
    if (isOpen) {
      updateMatchRate();
    }
  }, [isOpen, config, updateMatchRate]);

  const matchPercentage = matchRate.total > 0 ? (matchRate.matches / matchRate.total) * 100 : 0;

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className={`text-lg font-semibold ${textPrimary}`}>Configure Checksum</h2>
          <button onClick={onClose} className={`p-1 ${hoverBg} rounded`}>
            <X className={`${iconLg} ${textSecondary}`} />
          </button>
        </div>

        {/* Algorithm Detection Results */}
        {detectedAlgorithms.length > 0 && (
          <div className="bg-green-900/30 border border-green-700 rounded p-3">
            <div className="text-sm text-green-400 font-medium mb-2">Detected Algorithms:</div>
            <div className="flex flex-wrap gap-2">
              {detectedAlgorithms.map((match) => (
                <button
                  key={`${match.algorithm}-${match.endianness}`}
                  onClick={() => {
                    const byteCount = getChecksumByteCount(match.algorithm);
                    setConfig(prev => ({
                      ...prev,
                      algorithm: match.algorithm,
                      numBytes: byteCount,
                      startByte: -byteCount,
                      calcEndByte: -byteCount,
                      endianness: match.endianness,
                    }));
                  }}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    config.algorithm === match.algorithm && config.endianness === match.endianness
                      ? 'bg-green-600 text-white'
                      : `${bgSurface} ${textSecondary} hover:brightness-95`
                  }`}
                >
                  {CHECKSUM_ALGORITHMS.find(a => a.value === match.algorithm)?.label}
                  {match.endianness === 'big' ? ' (BE)' : ''}
                  {' '}({match.matchCount}/{match.totalCount})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sample frames preview */}
        <div className={`space-y-2 font-mono text-sm ${bgDataView} p-3 rounded max-h-40 overflow-y-auto`}>
          {sampleFrames.slice(0, 5).map((frame, frameIdx) => {
            const checksumStart = resolveByteIndexSync(config.startByte, frame.length);
            const calcEnd = resolveByteIndexSync(config.calcEndByte, frame.length);

            return (
              <div key={frameIdx} className={flexRowGap2}>
                <span className={`${textMuted} w-6 text-right`}>{frameIdx + 1}.</span>
                <div className="flex gap-1 flex-wrap">
                  {frame.map((byte, byteIdx) => {
                    const isChecksum = byteIdx >= checksumStart && byteIdx < checksumStart + config.numBytes;
                    const isCalcData = byteIdx >= config.calcStartByte && byteIdx < calcEnd;

                    return (
                      <span
                        key={byteIdx}
                        className={byteHighlight(
                          isChecksum ? 'checksum' : isCalcData ? 'calcData' : 'default'
                        )}
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
            Algorithm:
            <select
              value={config.algorithm}
              onChange={(e) => {
                const algo = e.target.value as ChecksumAlgorithm;
                const byteCount = getChecksumByteCount(algo);
                setConfig(prev => ({
                  ...prev,
                  algorithm: algo,
                  numBytes: byteCount,
                  startByte: -byteCount,
                  calcEndByte: -byteCount,
                }));
              }}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary}`}
            >
              {CHECKSUM_ALGORITHMS.map(algo => (
                <option key={algo.value} value={algo.value}>{algo.label}</option>
              ))}
            </select>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            Byte order:
            <select
              value={config.endianness}
              onChange={(e) => setConfig(prev => ({ ...prev, endianness: e.target.value as 'big' | 'little' }))}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary}`}
            >
              <option value="little">Little Endian</option>
              <option value="big">Big Endian</option>
            </select>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            Checksum position:
            <input
              type="number"
              value={config.startByte}
              onChange={(e) => setConfig(prev => ({ ...prev, startByte: Number(e.target.value) }))}
              className={`px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary}`}
            />
            <span className={`text-xs ${textMuted}`}>Negative = from end (e.g., -2)</span>
          </label>

          <label className={`flex flex-col gap-1 text-sm ${textSecondary}`}>
            Calc data range:
            <div className={flexRowGap2}>
              <input
                type="number"
                value={config.calcStartByte}
                onChange={(e) => setConfig(prev => ({ ...prev, calcStartByte: Number(e.target.value) }))}
                className={`w-16 px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary} text-center`}
              />
              <span className={textMuted}>to</span>
              <input
                type="number"
                value={config.calcEndByte}
                onChange={(e) => setConfig(prev => ({ ...prev, calcEndByte: Number(e.target.value) }))}
                className={`w-16 px-2 py-1.5 ${bgSurface} ${borderDefault} rounded ${textPrimary} text-center`}
              />
            </div>
          </label>
        </div>

        {/* Match Rate */}
        <div className={`text-sm p-2 rounded ${
          matchPercentage >= 90 ? 'bg-green-900/30 text-green-400' :
          matchPercentage >= 50 ? 'bg-yellow-900/30 text-yellow-400' :
          'bg-red-900/30 text-red-400'
        }`}>
          Match rate: {matchRate.matches}/{matchRate.total} frames ({matchPercentage.toFixed(0)}%)
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          {onClear ? (
            <button
              onClick={() => {
                onClear();
                onClose();
              }}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 rounded"
            >
              Clear
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-gray-600 hover:bg-gray-500 rounded"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() => {
              onApply(config);
              onClose();
            }}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 rounded font-medium"
          >
            Apply
          </button>
        </div>
      </div>
    </Dialog>
  );
}
