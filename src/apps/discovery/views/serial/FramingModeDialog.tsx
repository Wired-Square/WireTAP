// ui/src/apps/discovery/views/serial/FramingModeDialog.tsx
//
// Dialog for selecting and configuring the serial framing mode.
// Uses the shared FramingOptionsPanel component.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { iconLg } from '../../../../styles/spacing';
import { hoverLight } from '../../../../styles';
import Dialog from '../../../../components/Dialog';
import FramingOptionsPanel, { type FramingPanelConfig, type FramingMode } from '../../../../components/FramingOptionsPanel';
import { DialogFooter } from '../../../../components/forms/DialogFooter';
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
      };
    case 'slip':
      return { mode: 'slip' };
    default:
      return null;
  }
}

export default function FramingModeDialog({ isOpen, onClose, config, onApply }: FramingModeDialogProps) {
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
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Framing Mode</h2>
          <button onClick={onClose} className={`p-1 ${hoverLight} rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]`}>
            <X className={iconLg} />
          </button>
        </div>

        <FramingOptionsPanel
          config={panelConfig}
          onChange={setPanelConfig}
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
