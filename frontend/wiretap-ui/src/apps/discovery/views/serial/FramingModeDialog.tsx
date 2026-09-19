// ui/src/apps/discovery/views/serial/FramingModeDialog.tsx
//
// Dialog for selecting and configuring the serial framing mode.
// Uses the shared FramingOptionsPanel component.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog, { DialogBody, DialogFooter } from '../../../../components/Dialog';
import { SecondaryButton, PrimaryButton } from '../../../../components/forms';
import FramingOptionsPanel, { type FramingPanelConfig, type FramingMode } from '../../../../components/FramingOptionsPanel';
import type { FramingConfig } from '../../../../stores/discoveryStore';

interface FramingModeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: FramingConfig | null;
  onApply: (config: FramingConfig | null) => void;
}

/** Convert store FramingConfig to panel config */
function toPanelConfig(config: FramingConfig | null): FramingPanelConfig | null {
  if (!config) return null;

  // Map 'raw' mode (delimiter-based) to 'delimiter' in panel
  const mode: FramingMode = config.mode === 'raw' ? 'delimiter' : config.mode;

  return {
    mode,
    delimiterHex: config.delimiter,
    maxFrameLength: config.maxLength,
    validateCrc: config.validateCrc,
    deviceAddress: config.deviceAddress,
    vendorFunctions: config.vendorFunctions,
    allowBroadcast: config.allowBroadcast,
    anyFunction: config.anyFunction,
  };
}

/** Convert panel config back to store FramingConfig */
function toStoreConfig(panelConfig: FramingPanelConfig | null): FramingConfig | null {
  if (!panelConfig) return null;

  switch (panelConfig.mode) {
    case 'raw':
      // 'raw' in panel means no framing
      return null;
    case 'delimiter':
      // 'delimiter' in panel maps to 'raw' mode in store (confusing legacy naming)
      return {
        mode: 'raw',
        delimiter: panelConfig.delimiterHex || '0A',
        maxLength: panelConfig.maxFrameLength || 1024,
      };
    case 'modbus_rtu':
      return {
        mode: 'modbus_rtu',
        validateCrc: panelConfig.validateCrc ?? true,
        deviceAddress: panelConfig.deviceAddress,
        vendorFunctions: panelConfig.vendorFunctions,
        allowBroadcast: panelConfig.allowBroadcast,
        anyFunction: panelConfig.anyFunction,
      };
    case 'slip':
      return { mode: 'slip' };
    default:
      return null;
  }
}

export default function FramingModeDialog({ isOpen, onClose, config, onApply }: FramingModeDialogProps) {
  const { t } = useTranslation("discovery");
  const [panelConfig, setPanelConfig] = useState<FramingPanelConfig | null>(toPanelConfig(config));

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPanelConfig(toPanelConfig(config));
    }
  }, [isOpen, config]);

  const handleApply = () => {
    onApply(toStoreConfig(panelConfig));
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("serial.framingModeTitle")}>
      <DialogBody className="space-y-4">
        <FramingOptionsPanel
          config={panelConfig}
          onChange={setPanelConfig}
          variant="card"
        />
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={handleApply}>{t("serial.apply")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
