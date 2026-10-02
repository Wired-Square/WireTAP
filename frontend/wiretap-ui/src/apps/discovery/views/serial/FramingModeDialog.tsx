// ui/src/apps/discovery/views/serial/FramingModeDialog.tsx
//
// Dialog for selecting and configuring the serial framing mode.
// Uses the shared FramingOptionsPanel component.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog, { DialogBody, DialogFooter } from '../../../../components/Dialog';
import { SecondaryButton, PrimaryButton } from '../../../../components/forms';
import FramingOptionsPanel from '../../../../components/FramingOptionsPanel';
import type { FramingConfig } from '../../../../stores/discoveryStore';

interface FramingModeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: FramingConfig | null;
  onApply: (config: FramingConfig | null) => void;
}

export default function FramingModeDialog({ isOpen, onClose, config, onApply }: FramingModeDialogProps) {
  const { t } = useTranslation("discovery");
  const [panelConfig, setPanelConfig] = useState(config);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPanelConfig(config);
    }
  }, [isOpen, config]);

  const handleApply = () => {
    onApply(panelConfig);
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
