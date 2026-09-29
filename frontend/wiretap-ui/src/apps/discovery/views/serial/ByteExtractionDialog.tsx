// ui/src/apps/discovery/views/serial/ByteExtractionDialog.tsx
//
// Dialog for configuring byte extraction from serial frames.
// Used for frame ID and source address extraction.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { flexRowGap2 } from '../../../../styles/spacing';
import Dialog, { DialogBody, DialogFooter } from '../../../../components/Dialog';
import { resolveByteIndexSync } from '../../../../utils/analysis/checksums';
import { type ExtractionConfig } from './serialTypes';
import { byteToHex } from '../../../../utils/byteUtils';
import { extractSerialIds, toFrameIdConfig } from '../../../../api/capture';
import { tlog } from '../../../../api/settings';
import { bgSurface, bgDataView, textPrimary, textSecondary, textMuted, borderDefault } from '../../../../styles';
import { Button } from '../../../../components/Button';
import { DangerButton, SecondaryButton, Checkbox, Input, Select } from '../../../../components/forms';

/** The backend reads a serial id of one or two bytes. */
const MAX_ID_BYTES = 2;

interface ByteExtractionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  sampleFrames: number[][];
  initialConfig: ExtractionConfig;
  onApply: (config: ExtractionConfig) => void;
  onClear?: () => void; // Optional clear handler to remove the config
  color: string; // 'cyan', 'purple', or 'amber'
  supportsNegativeIndex?: boolean; // Enable negative indexing (for checksum at end of frame)
}

export default function ByteExtractionDialog({
  isOpen,
  onClose,
  title,
  sampleFrames,
  initialConfig,
  onApply,
  onClear,
  color,
  supportsNegativeIndex = false,
}: ByteExtractionDialogProps) {
  const { t } = useTranslation("discovery");
  const [startByte, setStartByte] = useState(initialConfig.startByte);
  const [numBytes, setNumBytes] = useState(initialConfig.numBytes);
  const [endianness, setEndianness] = useState(initialConfig.endianness);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [useNegativeIndex, setUseNegativeIndex] = useState(initialConfig.startByte < 0);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStartByte(initialConfig.startByte);
      setNumBytes(initialConfig.numBytes);
      setEndianness(initialConfig.endianness);
      setSelectionStart(null);
      setUseNegativeIndex(initialConfig.startByte < 0);
    }
  }, [isOpen, initialConfig]);

  // Get a representative frame length for negative index resolution
  const representativeLength = sampleFrames.length > 0 ? sampleFrames[0].length : 8;

  // Handle byte click for visual selection
  const handleByteClick = (byteIndex: number, frameLength: number) => {
    if (selectionStart === null) {
      // Start new selection
      setSelectionStart(byteIndex);
      if (useNegativeIndex) {
        // Convert to negative index
        setStartByte(byteIndex - frameLength);
      } else {
        setStartByte(byteIndex);
      }
      setNumBytes(1);
    } else {
      // Complete selection
      const start = Math.min(selectionStart, byteIndex);
      const end = Math.max(selectionStart, byteIndex);
      if (useNegativeIndex) {
        // Convert to negative index from end
        setStartByte(start - frameLength);
      } else {
        setStartByte(start);
      }
      setNumBytes(Math.min(end - start + 1, MAX_ID_BYTES));
      setSelectionStart(null);
    }
  };

  // Check if byte is in current selection range (handles negative indices)
  const isByteSelected = (byteIndex: number, frameLength: number) => {
    const resolvedStart = resolveByteIndexSync(startByte, frameLength);
    return byteIndex >= resolvedStart && byteIndex < resolvedStart + numBytes;
  };

  const previewFrames = useMemo(() => sampleFrames.slice(0, 5), [sampleFrames]);
  const [previewIds, setPreviewIds] = useState<(number | null)[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    extractSerialIds(previewFrames, toFrameIdConfig({ startByte, numBytes, endianness }))
      .then((ids) => { if (!cancelled) setPreviewIds(ids.map((id) => id.frame_id)); })
      .catch((e) => tlog.info(`[ByteExtractionDialog] Preview failed: ${e}`));
    return () => { cancelled = true; };
  }, [isOpen, previewFrames, startByte, numBytes, endianness]);

  const previewValue = (frameIdx: number): string => {
    const value = previewIds[frameIdx];
    return value == null ? '-' : `0x${value.toString(16).toUpperCase().padStart(numBytes * 2, '0')}`;
  };

  const colorClasses = color === 'cyan'
    ? { text: 'text-cyan', bgLight: 'bg-cyan' }
    : color === 'purple'
    ? { text: 'text-purple', bgLight: 'bg-purple' }
    : { text: 'text-amber', bgLight: 'bg-warning' };

  return (
    <Dialog isOpen={isOpen} size="xl" onClose={onClose} title={title}>
      <DialogBody className="space-y-4">
        <p className={`text-sm ${textSecondary}`}>
          {t("serial.byteExtractClickHint")}
        </p>

        {/* Sample frames with clickable bytes */}
        <div className={`space-y-2 font-mono text-sm ${bgDataView} p-3 rounded max-h-48 overflow-y-auto`}>
          {previewFrames.map((frame, frameIdx) => (
            <div key={frameIdx} className={flexRowGap2}>
              <span className={`${textMuted} w-6 text-right`}>{frameIdx + 1}.</span>
              <div className="flex gap-1 flex-wrap">
                {frame.map((byte, byteIdx) => (
                  <button
                    key={byteIdx}
                    onClick={() => handleByteClick(byteIdx, frame.length)}
                    className={`px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                      isByteSelected(byteIdx, frame.length)
                        ? `${colorClasses.bgLight} ${colorClasses.text} ring-1 ring-current`
                        : `${bgSurface} ${textPrimary} hover:brightness-95`
                    }`}
                    title={useNegativeIndex ? `[${byteIdx - frame.length}]` : `[${byteIdx}]`}
                  >
                    {byteToHex(byte)}
                  </button>
                ))}
                <span className={`ml-2 ${colorClasses.text}`}>{t("serial.extractValuePreview", { value: previewValue(frameIdx) })}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Manual controls */}
        <div className={`flex items-center gap-4 pt-2 border-t ${borderDefault} flex-wrap`}>
          {supportsNegativeIndex && (
            <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
              <Checkbox
                checked={useNegativeIndex}
                onChange={(e) => {
                  setUseNegativeIndex(e.target.checked);
                  // Convert current startByte to/from negative
                  if (e.target.checked && startByte >= 0) {
                    setStartByte(startByte - representativeLength);
                  } else if (!e.target.checked && startByte < 0) {
                    setStartByte(representativeLength + startByte);
                  }
                }}
              />
              {t("serial.fromEnd")}
            </label>
          )}
          <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
            {useNegativeIndex ? t("serial.offsetFromEnd") : t("serial.startByte")}
            <Input
              type="number"
              value={startByte}
              onChange={(e) => setStartByte(Number(e.target.value))}
              className="w-16 text-center"
            />
          </label>
          <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
            {t("serial.length")}
            <Select
              value={numBytes}
              onChange={(e) => setNumBytes(Number(e.target.value))}
              className="w-auto"
            >
              <option value={1}>{t("serial.lengthBytes", { count: 1 })}</option>
              <option value={2}>{t("serial.lengthBytes", { count: 2 })}</option>
            </Select>
          </label>
          <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
            {t("serial.byteOrder")}
            <Select
              value={endianness}
              onChange={(e) => setEndianness(e.target.value as 'big' | 'little')}
              className="w-auto"
            >
              <option value="big">{t("serial.bigEndian")}</option>
              <option value="little">{t("serial.littleEndian")}</option>
            </Select>
          </label>
        </div>
      </DialogBody>
      <DialogFooter>
        {onClear ? (
          <DangerButton
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            {t("serial.clear")}
          </DangerButton>
        ) : (
          <SecondaryButton
            onClick={onClose}
          >
            {t("modbusScan.cancel")}
          </SecondaryButton>
        )}
        <Button
          onClick={() => {
            onApply({ startByte, numBytes, endianness });
            onClose();
          }}
          variant="solid"
          tone={color === 'amber' ? 'warning' : color === 'purple' ? 'purple' : 'cyan'}
          size="lg"
        >
          {t("serial.apply")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
