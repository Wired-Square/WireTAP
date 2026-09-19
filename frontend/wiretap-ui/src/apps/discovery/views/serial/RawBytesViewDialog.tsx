// ui/src/apps/discovery/views/serial/RawBytesViewDialog.tsx
//
// Dialog for configuring raw bytes display mode (individual vs chunked).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { iconLg, flexRowGap2 } from '../../../../styles/spacing';
import Dialog from '../../../../components/Dialog';
import { Input, Select, SecondaryButton, PrimaryButton } from '../../../../components/forms';
import { h2, labelSmall, helpText, borderDefault } from '../../../../styles';
import type { RawBytesViewConfig, RawBytesDisplayMode } from '../../../../stores/discoveryStore';
import { Button, IconButton } from '../../../../components/Button';

interface RawBytesViewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: RawBytesViewConfig;
  onApply: (config: RawBytesViewConfig) => void;
}

/** Common baud rates for the dropdown */
const COMMON_BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/**
 * Calculate byte time in microseconds for a given baud rate.
 * Assumes 8N1 format: 1 start bit + 8 data bits + 0 parity + 1 stop bit = 10 bits per byte
 */
function calculateByteTimeUs(baudRate: number): number {
  const bitsPerByte = 10; // 8N1 format
  return Math.round((bitsPerByte / baudRate) * 1_000_000);
}

export default function RawBytesViewDialog({ isOpen, onClose, config, onApply }: RawBytesViewDialogProps) {
  const { t } = useTranslation("discovery");
  const [displayMode, setDisplayMode] = useState<RawBytesDisplayMode>(config.displayMode);
  const [chunkGapUs, setChunkGapUs] = useState(config.chunkGapUs);
  const [baudRate, setBaudRate] = useState(9600);
  const [idleMultiplier, setIdleMultiplier] = useState(2);

  useEffect(() => {
    if (isOpen) {
      setDisplayMode(config.displayMode);
      setChunkGapUs(config.chunkGapUs);
    }
  }, [isOpen, config]);

  // Calculate suggested gap based on baud rate and multiplier
  const suggestedGapUs = calculateByteTimeUs(baudRate) * idleMultiplier;

  const applyBaudRateGap = () => {
    setChunkGapUs(suggestedGapUs);
  };

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className={h2}>{t("serial.rawBytesTitle")}</h2>
          <IconButton onClick={onClose} size="sm">
            <X className={`${iconLg} text-slate-400`} />
          </IconButton>
        </div>

        <div className="space-y-3">
          {/* Display Mode Selection */}
          <div className="space-y-2">
            <span className={labelSmall}>{t("serial.displayMode")}</span>

            <Button
              onClick={() => setDisplayMode('individual')}
              variant="outline"
              tone="primary"
              pressed={displayMode === 'individual'}
            >
              <div className="font-medium">{t("serial.individualBytes")}</div>
              <div className={`text-xs mt-0.5 ${displayMode === 'individual' ? 'text-[color:var(--accent-primary)]/70' : 'text-[color:var(--text-muted)]'}`}>
                {t("serial.individualDescription")}
              </div>
            </Button>

            <Button
              onClick={() => setDisplayMode('chunked')}
              variant="outline"
              tone="primary"
              pressed={displayMode === 'chunked'}
            >
              <div className="font-medium">{t("serial.chunkedBytes")}</div>
              <div className={`text-xs mt-0.5 ${displayMode === 'chunked' ? 'text-[color:var(--accent-primary)]/70' : 'text-[color:var(--text-muted)]'}`}>
                {t("serial.chunkedDescription")}
              </div>
            </Button>
          </div>

          {/* Chunk Gap Threshold - only shown when chunked mode selected */}
          {displayMode === 'chunked' && (
            <div className="ml-4 pl-4 border-l-2 border-blue-600 space-y-3 py-2">
              {/* Baud rate calculator */}
              <div className="bg-[var(--bg-surface)] rounded-lg p-3 space-y-2">
                <span className={labelSmall}>{t("serial.calculateFromBaud")}</span>
                <div className={flexRowGap2}>
                  <Select
                    variant="simple"
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className="flex-1 text-sm"
                  >
                    {COMMON_BAUD_RATES.map((rate) => (
                      <option key={rate} value={rate}>{t("serial.baudUnit", { rate: rate.toLocaleString() })}</option>
                    ))}
                  </Select>
                  <span className="text-slate-400 text-sm">×</span>
                  <Select
                    variant="simple"
                    value={idleMultiplier}
                    onChange={(e) => setIdleMultiplier(Number(e.target.value))}
                    className="w-20 text-sm"
                  >
                    <option value={1.5}>1.5×</option>
                    <option value={2}>2×</option>
                    <option value={3}>3×</option>
                    <option value={3.5}>3.5×</option>
                    <option value={5}>5×</option>
                    <option value={10}>10×</option>
                    <option value={50}>50×</option>
                    <option value={100}>100×</option>
                  </Select>
                  <PrimaryButton onClick={applyBaudRateGap} size="sm">
                    {t("serial.applyBaud")}
                  </PrimaryButton>
                </div>
                <div className={helpText}>
                  {t("serial.byteTimeHint", { us: calculateByteTimeUs(baudRate), threshold: suggestedGapUs.toLocaleString() })}
                </div>
              </div>

              {/* Manual input */}
              <div className="space-y-1">
                <label className={labelSmall}>{t("serial.chunkGapLabel")}</label>
                <Input
                  variant="simple"
                  type="number"
                  value={chunkGapUs}
                  onChange={(e) => setChunkGapUs(Math.max(1, Number(e.target.value)))}
                  min={1}
                  step={100}
                />
                <p className={helpText}>
                  {t("serial.chunkGapHint")}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className={`flex justify-end gap-2 pt-2 border-t ${borderDefault}`}>
          <SecondaryButton onClick={onClose}>{t("modbusScan.cancel")}</SecondaryButton>
          <PrimaryButton
            onClick={() => {
              onApply({ displayMode, chunkGapUs });
              onClose();
            }}
          >
            {t("serial.apply")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
