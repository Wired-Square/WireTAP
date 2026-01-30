// ui/src/apps/discovery/views/serial/FilterDialog.tsx
//
// Dialog for configuring frame filter settings.
// Uses the shared FilterOptionsPanel component.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { iconLg } from '../../../../styles/spacing';
import { hoverLight } from '../../../../styles';
import Dialog from '../../../../components/Dialog';
import FilterOptionsPanel, { type FilterConfig } from '../../../../components/FilterOptionsPanel';
import { DialogFooter } from '../../../../components/forms/DialogFooter';

interface FilterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  minLength: number;
  onApply: (minLength: number) => void;
}

export default function FilterDialog({ isOpen, onClose, minLength: initialMinLength, onApply }: FilterDialogProps) {
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
    <Dialog isOpen={isOpen} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Filter Settings</h2>
          <button onClick={onClose} className={`p-1 ${hoverLight} rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]`}>
            <X className={iconLg} />
          </button>
        </div>

        <FilterOptionsPanel
          config={config}
          onChange={setConfig}
          variant="card"
        />

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleApply}
          confirmLabel="Apply"
        />
      </div>
    </Dialog>
  );
}
