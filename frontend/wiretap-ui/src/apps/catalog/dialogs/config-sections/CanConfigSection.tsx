// ui/src/apps/catalog/dialogs/config-sections/CanConfigSection.tsx
// CAN protocol configuration section for unified config dialog

import { useState, useCallback, useMemo } from "react";
import { Network, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles";
import type { CanHeaderFieldEntry } from "../../../../stores/catalogEditorStore";
import type { HeaderFieldFormat } from "../../types";
import MaskBitPicker from "../../../../components/MaskBitPicker";
import { Button, IconButton } from "../../../../components/Button";
import { Select, Input } from "../../../../components/forms";
import { Card } from "../../../../components/Card";
import { ConfigSectionHeader } from "./ConfigSectionHeader";
/** Predefined CAN header field types */
type CanFieldType = "source_address" | "custom";

const CAN_FIELD_TYPE_OPTIONS: Array<{ value: CanFieldType; label: string }> = [
  { value: "source_address", label: "Source Address" },
  { value: "custom", label: "Custom" },
];

/** Parse a hex string like "0x000000FF" or "255" to a number */
function parseMaskString(maskStr: string): number {
  if (!maskStr) return 0;
  const trimmed = maskStr.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return parseInt(trimmed, 16) || 0;
  }
  return parseInt(trimmed, 10) || 0;
}

/** Format a mask number as a hex string like "0x000000FF" */
function formatMaskHex(mask: number, shift: number = 0): string {
  const fullMask = (mask << shift) >>> 0;
  return `0x${fullMask.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Compute byte position info from mask for display */
function computeBitInfo(mask: number): string {
  if (mask === 0) return "no bits selected";

  // Find first and last set bit
  let firstBit = -1;
  let lastBit = -1;
  for (let i = 0; i < 32; i++) {
    if ((mask >> i) & 1) {
      if (firstBit === -1) firstBit = i;
      lastBit = i;
    }
  }

  if (firstBit === -1) return "no bits selected";

  const numBits = lastBit - firstBit + 1;
  return `${numBits} bit${numBits !== 1 ? 's' : ''} @ bit ${firstBit}`;
}

export type CanConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured)
  defaultEndianness: "little" | "big";
  setDefaultEndianness: (endianness: "little" | "big") => void;
  defaultInterval: number | undefined;
  setDefaultInterval: (interval: number | undefined) => void;
  defaultExtended: boolean | undefined;
  setDefaultExtended: (extended: boolean | undefined) => void;
  defaultFd: boolean | undefined;
  setDefaultFd: (fd: boolean | undefined) => void;
  frameIdMask: string;
  setFrameIdMask: (mask: string) => void;
  headerFields: CanHeaderFieldEntry[];
  setHeaderFields: (fields: CanHeaderFieldEntry[]) => void;
};

export default function CanConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  defaultEndianness,
  setDefaultEndianness,
  defaultInterval,
  setDefaultInterval,
  defaultExtended,
  setDefaultExtended,
  defaultFd,
  setDefaultFd,
  frameIdMask,
  setFrameIdMask,
  headerFields,
  setHeaderFields,
}: CanConfigSectionProps) {
  // State for inline add form
  const [isAddingField, setIsAddingField] = useState(false);
  const [newFieldType, setNewFieldType] = useState<CanFieldType>("source_address");
  const [newFieldCustomName, setNewFieldCustomName] = useState("");
  const [newFieldFormat, setNewFieldFormat] = useState<HeaderFieldFormat>("hex");

  // Track which existing fields have their bit picker expanded
  const [expandedFieldPickers, setExpandedFieldPickers] = useState<Record<number, boolean>>({});

  // State for frame ID mask bit picker
  const [showFrameIdMaskPicker, setShowFrameIdMaskPicker] = useState(false);
  const [useExtendedId, setUseExtendedId] = useState(true);

  // Check if source_address field already exists
  const hasSourceAddressField = useMemo(
    () => headerFields.some((f) => f.name.toLowerCase() === "source_address"),
    [headerFields]
  );

  const toggleFieldPicker = useCallback((index: number) => {
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  }, []);

  const resetAddForm = () => {
    setNewFieldType("source_address");
    setNewFieldCustomName("");
    setNewFieldFormat("hex");
    setIsAddingField(false);
  };

  const handleFrameIdMaskPickerChange = useCallback((mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    setFrameIdMask(`0x${fullMask.toString(16).toUpperCase().padStart(8, '0')}`);
  }, [setFrameIdMask]);

  const handleFieldMaskChange = useCallback((index: number, mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    handleUpdateField(index, { mask: formatMaskHex(fullMask, 0), shift });
  }, []);

  const handleAddField = () => {
    const name = newFieldType === "custom"
      ? newFieldCustomName.trim()
      : newFieldType;

    if (!name) return;

    // Default mask: 0xFF for source_address (bits 0-7), full mask for custom
    const defaultMask = newFieldType === "source_address" ? 0xFF : 0x1FFFFFFF;

    const newField: CanHeaderFieldEntry = {
      name,
      mask: formatMaskHex(defaultMask, 0),
      format: newFieldFormat,
    };

    setHeaderFields([...headerFields, newField]);

    // Auto-expand the bit picker for the new field
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [headerFields.length]: true,
    }));

    resetAddForm();
  };

  const handleRemoveField = (index: number) => {
    setHeaderFields(headerFields.filter((_, i) => i !== index));
    // Clean up expanded state
    setExpandedFieldPickers((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleUpdateField = (index: number, updates: Partial<CanHeaderFieldEntry>) => {
    setHeaderFields(
      headerFields.map((field, i) =>
        i === index ? { ...field, ...updates } : field
      )
    );
  };

  // Filter field type options - disable source_address if already exists
  const availableFieldTypes = CAN_FIELD_TYPE_OPTIONS.map((opt) => ({
    ...opt,
    disabled: opt.value === "source_address" && hasSourceAddressField,
  }));

  // Status indicator
  const showWarning = hasFrames && !isConfigured;

  return (
    <Card padding="none" className="overflow-hidden">
      <ConfigSectionHeader
        label="CAN"
        icon={<Network className={iconMd} />}
        tone="success"
        isConfigured={isConfigured}
        showWarning={showWarning}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onAdd={onAdd}
        onRemove={onRemove}
      />

      {/* Content */}
      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-default">
          {/* Default Byte Order */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Default Byte Order <span className="text-danger">*</span>
            </label>
            <Select
              value={defaultEndianness}
              onChange={(e) => setDefaultEndianness(e.target.value as "little" | "big")}
              size="lg"
            >
              <option value="little">Little Endian</option>
              <option value="big">Big Endian</option>
            </Select>
            <p className={`mt-1 ${caption}`}>
              Byte order used for multi-byte signals
            </p>
          </div>

          {/* Default Interval */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Default Interval (ms) <span className="text-muted text-xs font-normal">(optional)</span>
            </label>
            <Input
              type="number"
              min={0}
              value={defaultInterval ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultInterval(val === "" ? undefined : parseInt(val));
              }}
              size="lg"
              placeholder="1000"
            />
            <p className={`mt-1 ${caption}`}>
              Default transmit interval for frames
            </p>
          </div>

          {/* Default Extended ID and CAN FD row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Default Extended ID */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                Default Extended ID <span className="text-muted text-xs font-normal">(optional)</span>
              </label>
              <Select
                value={defaultExtended === undefined ? "auto" : defaultExtended ? "true" : "false"}
                onChange={(e) => {
                  const val = e.target.value;
                  setDefaultExtended(val === "auto" ? undefined : val === "true");
                }}
                size="lg"
              >
                <option value="auto">Auto-detect from ID</option>
                <option value="false">No (11-bit standard)</option>
                <option value="true">Yes (29-bit extended)</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                Default ID type for frames without explicit setting
              </p>
            </div>

            {/* Default CAN FD */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                Default CAN FD <span className="text-muted text-xs font-normal">(optional)</span>
              </label>
              <Select
                value={defaultFd === undefined ? "auto" : defaultFd ? "true" : "false"}
                onChange={(e) => {
                  const val = e.target.value;
                  setDefaultFd(val === "auto" ? undefined : val === "true");
                }}
                size="lg"
              >
                <option value="auto">Classic CAN (default)</option>
                <option value="false">No (Classic CAN)</option>
                <option value="true">Yes (CAN FD)</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                Default to CAN FD frames (64-byte payload, BRS)
              </p>
            </div>
          </div>

          {/* Frame ID Mask */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={textMedium}>
                Frame ID Mask <span className="text-muted text-xs font-normal">(optional, hex)</span>
              </label>
              <Button
                onClick={() => setShowFrameIdMaskPicker(!showFrameIdMaskPicker)}
                variant="link"
                tone="success"
                className="text-xs"
              >
                {showFrameIdMaskPicker ? <ChevronDown className={iconXs} /> : <ChevronRight className={iconXs} />}
                {showFrameIdMaskPicker ? "Hide" : "Show"} bit picker
              </Button>
            </div>
            <div className={flexRowGap2}>
              <Input
                type="text"
                value={frameIdMask}
                onChange={(e) => setFrameIdMask(e.target.value)}
                size="lg"
                mono
                className="flex-1"
                placeholder="0x1FFFFF00"
              />
              <div className="flex items-center gap-1">
                <span className={caption}>ID type:</span>
                <Select
                  value={useExtendedId ? "extended" : "standard"}
                  onChange={(e) => setUseExtendedId(e.target.value === "extended")}
                  size="lg"
                  className="w-24"
                  title="CAN ID type"
                >
                  <option value="extended">29-bit</option>
                  <option value="standard">11-bit</option>
                </Select>
              </div>
            </div>
            {showFrameIdMaskPicker && (
              <Card className="mt-3">
                <MaskBitPicker
                  mask={parseMaskString(frameIdMask)}
                  shift={0}
                  onMaskChange={handleFrameIdMaskPickerChange}
                  numBytes={4}
                  activeBits={useExtendedId ? 29 : 11}
                />
              </Card>
            )}
            <p className={`mt-1 ${caption}`}>
              Mask applied to frame ID before catalog matching. For J1939, use 0x1FFFFF00 to mask off the source address.
            </p>
          </div>

          {/* Header Fields Section */}
          <div className="border-t border-default pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>
                  Header Fields
                </h3>
                <p className={caption}>
                  Extract named values from the CAN ID using bitmasks. The "Source Address" field enables per-source view.
                </p>
              </div>
              {!isAddingField && (
                <Button
                  onClick={() => setIsAddingField(true)}
                  variant="tonal"
                  tone="success"
                >
                  <Plus className={iconMd} />
                  Add Field
                </Button>
              )}
            </div>

            {/* Existing fields list */}
            {headerFields.length > 0 && (
              <div className="space-y-2 mb-3">
                {headerFields.map((field, index) => {
                  const isFieldExpanded = expandedFieldPickers[index] ?? false;
                  const fieldMask = parseMaskString(field.mask);
                  const fieldShift = field.shift ?? 0;
                  // For the bit picker, we need the unshifted mask
                  // If shift is stored, the mask was already stored as full mask, so we need to unshift
                  const unshiftedMask = fieldShift > 0 ? (fieldMask >>> fieldShift) : fieldMask;

                  return (
                    <div key={index} className="space-y-2">
                      <Card padding="sm" className="flex items-center gap-2">
                        {/* Expand/collapse toggle */}
                        <IconButton
                          onClick={() => toggleFieldPicker(index)}
                          size="sm"
                          title={isFieldExpanded ? "Hide bit picker" : "Show bit picker"}
                        >
                          {isFieldExpanded ? (
                            <ChevronDown className={iconMd} />
                          ) : (
                            <ChevronRight className={iconMd} />
                          )}
                        </IconButton>

                        {/* Field name */}
                        <span className="w-28 font-medium text-sm text-primary truncate">
                          {field.name}
                        </span>

                        {/* Mask value */}
                        <Input
                          type="text"
                          value={field.mask}
                          onChange={(e) => handleUpdateField(index, { mask: e.target.value })}
                          size="xs"
                          mono
                          className="w-28"
                          title="Mask (hex)"
                        />

                        {/* Shift value input */}
                        <div className="flex items-center gap-1">
                          <span className={caption}>&gt;&gt;</span>
                          <Input
                            type="number"
                            min={0}
                            max={31}
                            value={fieldShift}
                            onChange={(e) => handleUpdateField(index, { shift: parseInt(e.target.value) || 0 })}
                            size="xs"
                            mono
                            className="w-12 text-center"
                            title="Right shift (bits)"
                          />
                        </div>

                        {/* Bit info */}
                        <span className={caption}>
                          ({computeBitInfo(fieldMask)})
                        </span>

                        {/* Spacer */}
                        <div className="flex-1" />

                        {/* Format */}
                        <Select
                          value={field.format}
                          onChange={(e) => handleUpdateField(index, { format: e.target.value as HeaderFieldFormat })}
                          size="sm"
                          className="w-16"
                        >
                          <option value="hex">Hex</option>
                          <option value="decimal">Dec</option>
                        </Select>

                        {/* Remove button */}
                        <IconButton
                          onClick={() => handleRemoveField(index)}
                          tone="danger"
                          size="sm"
                          title="Remove field"
                        >
                          <Trash2 className={iconMd} />
                        </IconButton>
                      </Card>

                      {/* Expanded bit picker */}
                      {isFieldExpanded && (
                        <Card className="ml-8">
                          <MaskBitPicker
                            mask={unshiftedMask}
                            shift={fieldShift}
                            onMaskChange={(mask, shift) => handleFieldMaskChange(index, mask, shift)}
                            numBytes={4}
                            activeBits={useExtendedId ? 29 : 11}
                          />
                        </Card>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add new field form */}
            {isAddingField && (
              <div className="p-3 bg-success rounded-lg border border-success">
                <div className="flex items-center gap-2 mb-3">
                  {/* Field type dropdown */}
                  <Select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as CanFieldType)}
                    className="w-40"
                  >
                    {availableFieldTypes.map((opt) => (
                      <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                        {opt.label}{opt.disabled ? " (exists)" : ""}
                      </option>
                    ))}
                  </Select>

                  {/* Custom name input (only shown for custom type) */}
                  {newFieldType === "custom" && (
                    <Input
                      type="text"
                      value={newFieldCustomName}
                      onChange={(e) => setNewFieldCustomName(e.target.value)}
                      className="flex-1"
                      placeholder="Field name"
                      autoFocus
                    />
                  )}

                  {/* Format */}
                  <Select
                    value={newFieldFormat}
                    onChange={(e) => setNewFieldFormat(e.target.value as HeaderFieldFormat)}
                    className="w-16"
                  >
                    <option value="hex">Hex</option>
                    <option value="decimal">Dec</option>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <p className={caption}>
                    Use the bit picker after adding to select which CAN ID bits this field covers.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={resetAddForm}
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleAddField}
                      disabled={newFieldType === "custom" && !newFieldCustomName.trim()}
                      variant="solid"
                      tone="success"
                    >
                      Add
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {headerFields.length === 0 && !isAddingField && (
              <p className={`${caption} italic`}>
                No header fields defined. Add a "Source Address" field to enable per-source view in the decoder.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Collapsed preview when configured but not expanded */}
      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-default`}>
          Byte order: {defaultEndianness}
          {defaultInterval !== undefined && ` • Interval: ${defaultInterval}ms`}
          {defaultExtended !== undefined && ` • Extended: ${defaultExtended ? "Yes" : "No"}`}
          {defaultFd !== undefined && ` • FD: ${defaultFd ? "Yes" : "No"}`}
          {frameIdMask && ` • Mask: ${frameIdMask}`}
          {headerFields.length > 0 && ` • ${headerFields.length} header field(s)`}
        </div>
      )}
    </Card>
  );
}
