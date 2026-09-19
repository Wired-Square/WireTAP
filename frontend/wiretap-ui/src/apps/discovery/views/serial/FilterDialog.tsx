// ui/src/apps/discovery/views/serial/FilterDialog.tsx
//
// Dialog for configuring frame filter settings.
// Uses the shared FilterOptionsPanel component.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog, { DialogBody, DialogFooter } from '../../../../components/Dialog';
import { SecondaryButton, PrimaryButton } from '../../../../components/forms';
import FilterOptionsPanel, { type FilterConfig } from '../../../../components/FilterOptionsPanel';

interface FilterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  minLength: number;
  onApply: (minLength: number) => void;
}

export default function FilterDialog({ isOpen, onClose, minLength: initialMinLength, onApply }: FilterDialogProps) {
  const { t } = useTranslation("discovery");
  const [config, setConfig] = useState<FilterConfig>({ minFrameLength: initialMinLength });

  useEffect(() => {
    if (isOpen) {
      setConfig({ minFrameLength: initialMinLength });
    }
  }, [isOpen, initialMinLength]);

  const handleApply = () => {
    onApply(config.minFrameLength);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} size="sm" onClose={onClose} title={t("serial.filterTitle")}>
      <DialogBody className="space-y-4">
        <FilterOptionsPanel
          config={config}
          onChange={setConfig}
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
