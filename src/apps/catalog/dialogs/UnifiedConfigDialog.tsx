// ui/src/apps/catalog/dialogs/UnifiedConfigDialog.tsx
// Unified catalog configuration dialog with collapsible protocol sections

import { useState, useEffect } from "react";
import { Settings } from "lucide-react";
import { iconLg } from "../../../styles/spacing";
import { disabledState, bgSurface, secondaryButton } from "../../../styles";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import {
  MetadataSection,
  CanConfigSection,
  SerialConfigSection,
  ModbusConfigSection,
} from "./config-sections";

export type UnifiedConfigDialogProps = {
  open: boolean;
  onCancel: () => void;
  onSave: (enabledConfigs: { can: boolean; serial: boolean; modbus: boolean }) => void;
};

export default function UnifiedConfigDialog({
  open,
  onCancel,
  onSave,
}: UnifiedConfigDialogProps) {
  // Store selectors for form values
  const metaFields = useCatalogEditorStore((s) => s.forms.meta);
  const setMetaFields = useCatalogEditorStore((s) => s.setMetaForm);

  // CAN config
  const canConfig = useCatalogEditorStore((s) => s.tree.canConfig);
  const hasCanFrames = useCatalogEditorStore((s) => s.tree.hasCanFrames);
  const canDefaultEndianness = useCatalogEditorStore((s) => s.forms.canDefaultEndianness);
  const setCanDefaultEndianness = useCatalogEditorStore((s) => s.setCanDefaultEndianness);
  const canDefaultInterval = useCatalogEditorStore((s) => s.forms.canDefaultInterval);
  const setCanDefaultInterval = useCatalogEditorStore((s) => s.setCanDefaultInterval);
  const canDefaultExtended = useCatalogEditorStore((s) => s.forms.canDefaultExtended);
  const setCanDefaultExtended = useCatalogEditorStore((s) => s.setCanDefaultExtended);
  const canDefaultFd = useCatalogEditorStore((s) => s.forms.canDefaultFd);
  const setCanDefaultFd = useCatalogEditorStore((s) => s.setCanDefaultFd);
  const canFrameIdMask = useCatalogEditorStore((s) => s.forms.canFrameIdMask);
  const setCanFrameIdMask = useCatalogEditorStore((s) => s.setCanFrameIdMask);
  const canHeaderFields = useCatalogEditorStore((s) => s.forms.canHeaderFields);
  const setCanHeaderFields = useCatalogEditorStore((s) => s.setCanHeaderFields);

  // Serial config
  const serialConfig = useCatalogEditorStore((s) => s.tree.serialConfig);
  const hasSerialFrames = useCatalogEditorStore((s) => s.tree.hasSerialFrames);
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const setSerialEncoding = useCatalogEditorStore((s) => s.setSerialEncoding);
  const serialByteOrder = useCatalogEditorStore((s) => s.forms.serialByteOrder);
  const setSerialByteOrder = useCatalogEditorStore((s) => s.setSerialByteOrder);
  const serialHeaderFields = useCatalogEditorStore((s) => s.forms.serialHeaderFields);
  const setSerialHeaderFields = useCatalogEditorStore((s) => s.setSerialHeaderFields);
  const serialHeaderLength = useCatalogEditorStore((s) => s.forms.serialHeaderLength);
  const setSerialHeaderLength = useCatalogEditorStore((s) => s.setSerialHeaderLength);
  const serialMaxFrameLength = useCatalogEditorStore((s) => s.forms.serialMaxFrameLength);
  const setSerialMaxFrameLength = useCatalogEditorStore((s) => s.setSerialMaxFrameLength);
  const serialChecksum = useCatalogEditorStore((s) => s.forms.serialChecksum);
  const setSerialChecksum = useCatalogEditorStore((s) => s.setSerialChecksum);

  // Modbus config
  const modbusConfig = useCatalogEditorStore((s) => s.tree.modbusConfig);
  const hasModbusFrames = useCatalogEditorStore((s) => s.tree.hasModbusFrames);
  const modbusDeviceAddress = useCatalogEditorStore((s) => s.forms.modbusDeviceAddress);
  const setModbusDeviceAddress = useCatalogEditorStore((s) => s.setModbusDeviceAddress);
  const modbusRegisterBase = useCatalogEditorStore((s) => s.forms.modbusRegisterBase);
  const setModbusRegisterBase = useCatalogEditorStore((s) => s.setModbusRegisterBase);
  const modbusDefaultInterval = useCatalogEditorStore((s) => s.forms.modbusDefaultInterval);
  const setModbusDefaultInterval = useCatalogEditorStore((s) => s.setModbusDefaultInterval);
  const modbusDefaultByteOrder = useCatalogEditorStore((s) => s.forms.modbusDefaultByteOrder);
  const setModbusDefaultByteOrder = useCatalogEditorStore((s) => s.setModbusDefaultByteOrder);
  const modbusDefaultWordOrder = useCatalogEditorStore((s) => s.forms.modbusDefaultWordOrder);
  const setModbusDefaultWordOrder = useCatalogEditorStore((s) => s.setModbusDefaultWordOrder);

  // Track whether each protocol is "enabled" (we'll add config when enabling)
  const [canEnabled, setCanEnabled] = useState(!!canConfig);
  const [serialEnabled, setSerialEnabled] = useState(!!serialConfig);
  const [modbusEnabled, setModbusEnabled] = useState(!!modbusConfig);

  // Expansion state for each section
  const [canExpanded, setCanExpanded] = useState(false);
  const [serialExpanded, setSerialExpanded] = useState(false);
  const [modbusExpanded, setModbusExpanded] = useState(false);

  // Sync enabled state with actual config when dialog opens
  useEffect(() => {
    if (open) {
      setCanEnabled(!!canConfig);
      setSerialEnabled(!!serialConfig);
      setModbusEnabled(!!modbusConfig);

      // Auto-expand sections that have frames but no config (to guide user)
      setCanExpanded(!!canConfig || (hasCanFrames && !canConfig));
      setSerialExpanded(!!serialConfig || (hasSerialFrames && !serialConfig));
      setModbusExpanded(!!modbusConfig || (hasModbusFrames && !modbusConfig));
    }
  }, [open, canConfig, serialConfig, modbusConfig, hasCanFrames, hasSerialFrames, hasModbusFrames]);

  // Handle adding a protocol config
  const handleAddCanConfig = () => {
    setCanEnabled(true);
    setCanExpanded(true);
    // Set defaults
    setCanDefaultEndianness("little");
    setCanDefaultInterval(undefined);
    setCanDefaultExtended(undefined);
    setCanDefaultFd(undefined);
    setCanFrameIdMask("");
    setCanHeaderFields([]);
  };

  const handleAddSerialConfig = () => {
    setSerialEnabled(true);
    setSerialExpanded(true);
    // Set defaults
    setSerialEncoding("slip");
    setSerialByteOrder("big");
    setSerialHeaderFields([]);
    setSerialHeaderLength(undefined);
    setSerialMaxFrameLength(undefined);  // Default: 64 in backend
    setSerialChecksum(null);
  };

  const handleAddModbusConfig = () => {
    setModbusEnabled(true);
    setModbusExpanded(true);
    // Set defaults
    setModbusDeviceAddress(1);
    setModbusRegisterBase(1);
    setModbusDefaultInterval(undefined);
    setModbusDefaultByteOrder("big");
    setModbusDefaultWordOrder("big");
  };

  // Handle removing a protocol config (just update local state - actual removal on Save)
  const handleRemoveCanConfig = () => {
    if (hasCanFrames) {
      if (!window.confirm("This catalog has CAN frames. Remove CAN configuration anyway?")) {
        return;
      }
    }
    setCanEnabled(false);
    setCanExpanded(false);
  };

  const handleRemoveSerialConfig = () => {
    if (hasSerialFrames) {
      if (!window.confirm("This catalog has Serial frames. Remove Serial configuration anyway?")) {
        return;
      }
    }
    setSerialEnabled(false);
    setSerialExpanded(false);
  };

  const handleRemoveModbusConfig = () => {
    if (hasModbusFrames) {
      if (!window.confirm("This catalog has Modbus frames. Remove Modbus configuration anyway?")) {
        return;
      }
    }
    setModbusEnabled(false);
    setModbusExpanded(false);
  };

  if (!open) return null;

  // Validation
  const isMetaValid = metaFields.name.trim() !== "" && metaFields.version >= 1;
  const isModbusValid = !modbusEnabled || (modbusDeviceAddress >= 1 && modbusDeviceAddress <= 247);
  const isValid = isMetaValid && isModbusValid;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`${bgSurface} rounded-xl shadow-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto`}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-[var(--bg-accent)] rounded-lg">
            <Settings className={`${iconLg} text-[color:var(--text-accent)]`} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-[color:var(--text-primary)]">
              Catalog Configuration
            </h2>
            <p className="text-sm text-[color:var(--text-muted)]">
              Configure catalog metadata and protocol settings
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Metadata Section */}
          <MetadataSection
            name={metaFields.name}
            setName={(name) => setMetaFields({ ...metaFields, name })}
            version={metaFields.version}
            setVersion={(version) => setMetaFields({ ...metaFields, version })}
          />

          {/* Protocol Configurations */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)] uppercase tracking-wide">
              Protocol Configurations
            </h3>

            <CanConfigSection
              isConfigured={canEnabled}
              hasFrames={hasCanFrames}
              isExpanded={canExpanded}
              onToggleExpanded={() => setCanExpanded(!canExpanded)}
              onAdd={handleAddCanConfig}
              onRemove={handleRemoveCanConfig}
              defaultEndianness={canDefaultEndianness}
              setDefaultEndianness={setCanDefaultEndianness}
              defaultInterval={canDefaultInterval}
              setDefaultInterval={setCanDefaultInterval}
              defaultExtended={canDefaultExtended}
              setDefaultExtended={setCanDefaultExtended}
              defaultFd={canDefaultFd}
              setDefaultFd={setCanDefaultFd}
              frameIdMask={canFrameIdMask}
              setFrameIdMask={setCanFrameIdMask}
              headerFields={canHeaderFields}
              setHeaderFields={setCanHeaderFields}
            />

            <SerialConfigSection
              isConfigured={serialEnabled}
              hasFrames={hasSerialFrames}
              isExpanded={serialExpanded}
              onToggleExpanded={() => setSerialExpanded(!serialExpanded)}
              onAdd={handleAddSerialConfig}
              onRemove={handleRemoveSerialConfig}
              encoding={serialEncoding}
              setEncoding={setSerialEncoding}
              byteOrder={serialByteOrder}
              setByteOrder={setSerialByteOrder}
              headerFields={serialHeaderFields}
              setHeaderFields={setSerialHeaderFields}
              headerLength={serialHeaderLength}
              setHeaderLength={setSerialHeaderLength}
              maxFrameLength={serialMaxFrameLength}
              setMaxFrameLength={setSerialMaxFrameLength}
              checksum={serialChecksum}
              setChecksum={setSerialChecksum}
            />

            <ModbusConfigSection
              isConfigured={modbusEnabled}
              hasFrames={hasModbusFrames}
              isExpanded={modbusExpanded}
              onToggleExpanded={() => setModbusExpanded(!modbusExpanded)}
              onAdd={handleAddModbusConfig}
              onRemove={handleRemoveModbusConfig}
              deviceAddress={modbusDeviceAddress}
              setDeviceAddress={setModbusDeviceAddress}
              registerBase={modbusRegisterBase}
              setRegisterBase={setModbusRegisterBase}
              defaultInterval={modbusDefaultInterval}
              setDefaultInterval={setModbusDefaultInterval}
              defaultByteOrder={modbusDefaultByteOrder}
              setDefaultByteOrder={setModbusDefaultByteOrder}
              defaultWordOrder={modbusDefaultWordOrder}
              setDefaultWordOrder={setModbusDefaultWordOrder}
            />
          </div>

          {/* Info box */}
          <div className="p-3 bg-[var(--bg-surface)] rounded-lg border border-[color:var(--border-default)]">
            <p className="text-xs text-[color:var(--text-muted)]">
              <strong>Note:</strong> Protocol configurations define default settings for all frames of that type.
              Add a configuration for each protocol you plan to use in this catalog.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            className={secondaryButton}
          >
            Cancel
          </button>
          <button
            onClick={() => onSave({ can: canEnabled, serial: serialEnabled, modbus: modbusEnabled })}
            disabled={!isValid}
            className={`px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors ${disabledState}`}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
