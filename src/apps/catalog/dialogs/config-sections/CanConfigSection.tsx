// ui/src/apps/catalog/dialogs/config-sections/CanConfigSection.tsx
// CAN protocol configuration section for unified config dialog

import { useState, useCallback, useMemo } from "react";
import { Network, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, Check } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { disabledState, caption, textMedium, focusRing, bgSurface, expandableRowContainer } from "../../../../styles";
import type { CanHeaderFieldEntry } from "../../../../stores/catalogEditorStore";
import type { HeaderFieldFormat } from "../../types";
import MaskBitPicker from "../../../../components/MaskBitPicker";

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
    <div className="border border-[color:var(--border-default)] rounded-lg overflow-hidden">
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpanded(); }}
        className={expandableRowContainer}
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className={`${iconMd} text-slate-500`} />
          ) : (
            <ChevronRight className={`${iconMd} text-slate-500`} />
          )}
          <div className="p-1.5 bg-[var(--bg-green)] rounded">
            <Network className={`${iconMd} text-[color:var(--text-green)]`} />
          </div>
          <span className="font-medium text-[color:var(--text-primary)]">CAN</span>
          {isConfigured && (
            <span className="flex items-center gap-1 text-xs text-[color:var(--text-green)]">
              <Check className={iconXs} />
              configured
            </span>
          )}
          {showWarning && (
            <span className="flex items-center gap-1 text-xs text-[color:var(--text-amber)]">
              <AlertTriangle className={iconXs} />
              frames exist, no config
            </span>
          )}
        </div>
        <div className={flexRowGap2} onClick={(e) => e.stopPropagation()}>
          {isConfigured ? (
            <button
              type="button"
              onClick={onRemove}
              className="px-2 py-1 text-xs text-[color:var(--text-red)] hover:bg-[var(--hover-bg-red)] rounded transition-colors"
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              className="px-2 py-1 text-xs text-[color:var(--text-green)] hover:bg-[var(--hover-bg-green)] rounded transition-colors"
            >
              + Add
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-[color:var(--border-default)]">
          {/* Default Byte Order */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Default Byte Order <span className="text-red-500">*</span>
            </label>
            <select
              value={defaultEndianness}
              onChange={(e) => setDefaultEndianness(e.target.value as "little" | "big")}
              className={`w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-input)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
            >
              <option value="little">Little Endian</option>
              <option value="big">Big Endian</option>
            </select>
            <p className={`mt-1 ${caption}`}>
              Byte order used for multi-byte signals
            </p>
          </div>

          {/* Default Interval */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Default Interval (ms) <span className="text-slate-400 text-xs font-normal">(optional)</span>
            </label>
            <input
              type="number"
              min={0}
              value={defaultInterval ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultInterval(val === "" ? undefined : parseInt(val));
              }}
              className={`w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-input)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              placeholder="1000"
            />
            <p className={`mt-1 ${caption}`}>
              Default transmit interval for frames
            </p>
          </div>

          {/* Frame ID Mask */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={textMedium}>
                Frame ID Mask <span className="text-slate-400 text-xs font-normal">(optional, hex)</span>
              </label>
              <button
                type="button"
                onClick={() => setShowFrameIdMaskPicker(!showFrameIdMaskPicker)}
                className="flex items-center gap-1 text-xs text-[color:var(--text-green)] hover:text-[color:var(--text-green-hover)]"
              >
                {showFrameIdMaskPicker ? <ChevronDown className={iconXs} /> : <ChevronRight className={iconXs} />}
                {showFrameIdMaskPicker ? "Hide" : "Show"} bit picker
              </button>
            </div>
            <div className={flexRowGap2}>
              <input
                type="text"
                value={frameIdMask}
                onChange={(e) => setFrameIdMask(e.target.value)}
                className={`flex-1 px-4 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-input)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing}`}
                placeholder="0x1FFFFF00"
              />
              <div className="flex items-center gap-1">
                <span className={caption}>ID type:</span>
                <select
                  value={useExtendedId ? "extended" : "standard"}
                  onChange={(e) => setUseExtendedId(e.target.value === "extended")}
                  className={`w-24 px-1 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-input)] rounded-lg text-sm text-[color:var(--text-primary)] ${focusRing}`}
                  title="CAN ID type"
                >
                  <option value="extended">29-bit</option>
                  <option value="standard">11-bit</option>
                </select>
              </div>
            </div>
            {showFrameIdMaskPicker && (
              <div className="mt-3 p-3 bg-[var(--bg-secondary)]/50 rounded-lg border border-[color:var(--border-default)]">
                <MaskBitPicker
                  mask={parseMaskString(frameIdMask)}
                  shift={0}
                  onMaskChange={handleFrameIdMaskPickerChange}
                  numBytes={4}
                  activeBits={useExtendedId ? 29 : 11}
                />
              </div>
            )}
            <p className={`mt-1 ${caption}`}>
              Mask applied to frame ID before catalog matching. For J1939, use 0x1FFFFF00 to mask off the source address.
            </p>
          </div>

          {/* Header Fields Section */}
          <div className="border-t border-[color:var(--border-default)] pt-4 mt-4">
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
                <button
                  type="button"
                  onClick={() => setIsAddingField(true)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[var(--bg-green)] text-[color:var(--text-green)] rounded-lg hover:bg-[var(--hover-bg-green)] transition-colors"
                >
                  <Plus className={iconMd} />
                  Add Field
                </button>
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
                      <div className="flex items-center gap-2 p-2 bg-[var(--bg-secondary)]/50 rounded-lg border border-[color:var(--border-default)]">
                        {/* Expand/collapse toggle */}
                        <button
                          type="button"
                          onClick={() => toggleFieldPicker(index)}
                          className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
                          title={isFieldExpanded ? "Hide bit picker" : "Show bit picker"}
                        >
                          {isFieldExpanded ? (
                            <ChevronDown className={iconMd} />
                          ) : (
                            <ChevronRight className={iconMd} />
                          )}
                        </button>

                        {/* Field name */}
                        <span className="w-28 font-medium text-sm text-[color:var(--text-primary)] truncate">
                          {field.name}
                        </span>

                        {/* Mask value */}
                        <input
                          type="text"
                          value={field.mask}
                          onChange={(e) => handleUpdateField(index, { mask: e.target.value })}
                          className="w-28 px-2 py-0.5 bg-[var(--bg-tertiary)] border border-[color:var(--border-input)] rounded text-xs font-mono text-[color:var(--text-secondary)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                          title="Mask (hex)"
                        />

                        {/* Shift value input */}
                        <div className="flex items-center gap-1">
                          <span className={caption}>&gt;&gt;</span>
                          <input
                            type="number"
                            min={0}
                            max={31}
                            value={fieldShift}
                            onChange={(e) => handleUpdateField(index, { shift: parseInt(e.target.value) || 0 })}
                            className={`w-12 px-1 py-0.5 ${bgSurface} border border-[color:var(--border-input)] rounded text-xs font-mono text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500 text-center`}
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
                        <select
                          value={field.format}
                          onChange={(e) => handleUpdateField(index, { format: e.target.value as HeaderFieldFormat })}
                          className={`w-16 px-1 py-1 ${bgSurface} border border-[color:var(--border-input)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                        >
                          <option value="hex">Hex</option>
                          <option value="decimal">Dec</option>
                        </select>

                        {/* Remove button */}
                        <button
                          type="button"
                          onClick={() => handleRemoveField(index)}
                          className="p-1 text-red-500 hover:bg-[var(--hover-bg-red)] rounded transition-colors"
                          title="Remove field"
                        >
                          <Trash2 className={iconMd} />
                        </button>
                      </div>

                      {/* Expanded bit picker */}
                      {isFieldExpanded && (
                        <div className="ml-8 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[color:var(--border-default)]">
                          <MaskBitPicker
                            mask={unshiftedMask}
                            shift={fieldShift}
                            onMaskChange={(mask, shift) => handleFieldMaskChange(index, mask, shift)}
                            numBytes={4}
                            activeBits={useExtendedId ? 29 : 11}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add new field form */}
            {isAddingField && (
              <div className="p-3 bg-[var(--bg-green-subtle)] rounded-lg border border-[color:var(--border-green)]">
                <div className="flex items-center gap-2 mb-3">
                  {/* Field type dropdown */}
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as CanFieldType)}
                    className={`w-40 px-2 py-1.5 ${bgSurface} border border-[color:var(--border-input)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                  >
                    {availableFieldTypes.map((opt) => (
                      <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                        {opt.label}{opt.disabled ? " (exists)" : ""}
                      </option>
                    ))}
                  </select>

                  {/* Custom name input (only shown for custom type) */}
                  {newFieldType === "custom" && (
                    <input
                      type="text"
                      value={newFieldCustomName}
                      onChange={(e) => setNewFieldCustomName(e.target.value)}
                      className={`flex-1 px-2 py-1.5 ${bgSurface} border border-[color:var(--border-input)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                      placeholder="Field name"
                      autoFocus
                    />
                  )}

                  {/* Format */}
                  <select
                    value={newFieldFormat}
                    onChange={(e) => setNewFieldFormat(e.target.value as HeaderFieldFormat)}
                    className={`w-16 px-1 py-1.5 ${bgSurface} border border-[color:var(--border-input)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                  >
                    <option value="hex">Hex</option>
                    <option value="decimal">Dec</option>
                  </select>
                </div>

                <div className="flex items-center justify-between">
                  <p className={caption}>
                    Use the bit picker after adding to select which CAN ID bits this field covers.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={resetAddForm}
                      className="px-3 py-1 text-sm text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] rounded transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAddField}
                      disabled={newFieldType === "custom" && !newFieldCustomName.trim()}
                      className={`px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 ${disabledState} transition-colors`}
                    >
                      Add
                    </button>
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
        <div className={`px-4 py-2 ${caption} border-t border-[color:var(--border-default)]`}>
          Endianness: {defaultEndianness}
          {defaultInterval !== undefined && ` • Interval: ${defaultInterval}ms`}
          {frameIdMask && ` • Mask: ${frameIdMask}`}
          {headerFields.length > 0 && ` • ${headerFields.length} header field(s)`}
        </div>
      )}
    </div>
  );
}
