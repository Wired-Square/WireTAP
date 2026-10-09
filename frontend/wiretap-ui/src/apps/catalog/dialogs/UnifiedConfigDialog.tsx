// ui/src/apps/catalog/dialogs/UnifiedConfigDialog.tsx
// Unified catalog configuration dialog with collapsible protocol sections

import { useState, useEffect } from "react";
import { Settings } from "lucide-react";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { hasFrames } from "../model";
import {
  MetadataSection,
  CanConfigSection,
  SerialConfigSection,
  ModbusConfigSection,
} from "./config-sections";
import { SecondaryButton, PrimaryButton } from "../../../components/forms";
import { Alert } from "../../../components/Alert";
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

  const catalog = useCatalogEditorStore((s) => s.tree.catalog);
  const seedConfigForms = useCatalogEditorStore((s) => s.seedConfigForms);
  const effective = catalog?.effectiveDefaults;

  // CAN config
  const canConfig = catalog?.can;
  const hasCanFrames = hasFrames(catalog, "can");
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
  const serialConfig = catalog?.serial;
  const hasSerialFrames = hasFrames(catalog, "serial");
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const setSerialEncoding = useCatalogEditorStore((s) => s.setSerialEncoding);
  const serialByteOrder = useCatalogEditorStore((s) => s.forms.serialByteOrder);
  const setSerialByteOrder = useCatalogEditorStore((s) => s.setSerialByteOrder);
  const serialHeaderFields = useCatalogEditorStore((s) => s.forms.serialHeaderFields);
  const setSerialHeaderFields = useCatalogEditorStore((s) => s.setSerialHeaderFields);
  const serialHeaderLength = useCatalogEditorStore((s) => s.forms.serialHeaderLength);
  const setSerialHeaderLength = useCatalogEditorStore((s) => s.setSerialHeaderLength);
  const serialChecksum = useCatalogEditorStore((s) => s.forms.serialChecksum);
  const setSerialChecksum = useCatalogEditorStore((s) => s.setSerialChecksum);

  // Modbus config
  const modbusConfig = catalog?.modbus;
  const hasModbusFrames = hasFrames(catalog, "modbus");
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

  // Seed the draft and the enabled state from the catalogue when the dialog opens
  useEffect(() => {
    if (open) {
      seedConfigForms(catalog);
      if (catalog) setMetaFields({ name: catalog.meta.name, version: catalog.meta.version, default_frame: catalog.meta.defaultFrame });
      setCanEnabled(!!canConfig);
      setSerialEnabled(!!serialConfig);
      setModbusEnabled(!!modbusConfig);

      // Auto-expand sections that have frames but no config (to guide user)
      setCanExpanded(!!canConfig || (hasCanFrames && !canConfig));
      setSerialExpanded(!!serialConfig || (hasSerialFrames && !serialConfig));
      setModbusExpanded(!!modbusConfig || (hasModbusFrames && !modbusConfig));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Handle adding a protocol config
  const handleAddCanConfig = () => {
    setCanEnabled(true);
    setCanExpanded(true);
    setCanDefaultEndianness(undefined);
    setCanDefaultInterval(undefined);
    setCanDefaultExtended(undefined);
    setCanDefaultFd(undefined);
    setCanFrameIdMask("");
    setCanHeaderFields([]);
  };

  const handleAddSerialConfig = () => {
    setSerialEnabled(true);
    setSerialExpanded(true);
    setSerialEncoding("slip");
    setSerialByteOrder(undefined);
    setSerialHeaderFields([]);
    setSerialHeaderLength(undefined);
    setSerialChecksum(null);
  };

  const handleAddModbusConfig = () => {
    setModbusEnabled(true);
    setModbusExpanded(true);
    setModbusDeviceAddress(1);
    setModbusRegisterBase(1);
    setModbusDefaultInterval(undefined);
    setModbusDefaultByteOrder(undefined);
    setModbusDefaultWordOrder(undefined);
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

  // Validation
  const isMetaValid = metaFields.name.trim() !== "" && metaFields.version >= 1;
  const isValid = isMetaValid;

  return (
    <Dialog
      isOpen={open}
      onClose={onCancel}
      size="xl"
      title="Catalog Configuration"
      subtitle="Configure catalog metadata and protocol settings"
      icon={<Settings className="text-accent-primary" />}
    >
      <DialogBody className="space-y-6">
        {/* Metadata Section */}
        <MetadataSection
          name={metaFields.name}
          setName={(name) => setMetaFields({ ...metaFields, name })}
          version={metaFields.version}
          setVersion={(version) => setMetaFields({ ...metaFields, version })}
        />

        {/* Protocol Configurations */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-primary uppercase tracking-wide">
            Protocol Configurations
          </h3>

          <CanConfigSection
            isConfigured={canEnabled}
            hasFrames={hasCanFrames}
            isExpanded={canExpanded}
            onToggleExpanded={() => setCanExpanded(!canExpanded)}
            onAdd={handleAddCanConfig}
            onRemove={handleRemoveCanConfig}
            defaultEndianness={canDefaultEndianness ?? effective?.canByteOrder ?? "little"}
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
            byteOrder={serialByteOrder ?? effective?.serialByteOrder ?? "little"}
            setByteOrder={setSerialByteOrder}
            headerFields={serialHeaderFields}
            setHeaderFields={setSerialHeaderFields}
            headerLength={serialHeaderLength}
            setHeaderLength={setSerialHeaderLength}
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
            registerBase={modbusRegisterBase}
            setRegisterBase={setModbusRegisterBase}
            defaultInterval={modbusDefaultInterval}
            setDefaultInterval={setModbusDefaultInterval}
            defaultByteOrder={modbusDefaultByteOrder ?? effective?.modbusByteOrder ?? "big"}
            setDefaultByteOrder={setModbusDefaultByteOrder}
            defaultWordOrder={modbusDefaultWordOrder ?? effective?.modbusWordOrder ?? "big"}
            setDefaultWordOrder={setModbusDefaultWordOrder}
          />
        </div>

        {/* Info box */}
        <Alert tone="info" size="sm">
          <strong>Note:</strong> Protocol configurations define default settings for all frames of that type.
          Add a configuration for each protocol you plan to use in this catalog.
        </Alert>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton
          onClick={() => onSave({ can: canEnabled, serial: serialEnabled, modbus: modbusEnabled })}
          disabled={!isValid}
        >
          Save Changes
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
