// ui/src/apps/catalog/dialogs/config-sections/SerialConfigSection.tsx
// Serial protocol configuration section for unified config dialog

import { useState, useCallback, useMemo } from "react";
import { Cable, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, Check } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { disabledState, caption, textMedium, focusRing, bgSurface, expandableRowContainer } from "../../../../styles";
import type { SerialHeaderFieldEntry } from "../../../../stores/catalogEditorStore";
import type { SerialEncoding, HeaderFieldFormat, SerialChecksumConfig, ChecksumAlgorithm } from "../../types";
import MaskBitPicker from "../../../../components/MaskBitPicker";
import { CHECKSUM_ALGORITHMS } from "../../../../utils/analysis/checksums";

/** Predefined header field types */
type FieldType = "id" | "source_address" | "destination_address" | "custom";

const FIELD_TYPE_OPTIONS: Array<{ value: FieldType; label: string }> = [
  { value: "id", label: "ID" },
  { value: "source_address", label: "Source Address" },
  { value: "destination_address", label: "Destination Address" },
  { value: "custom", label: "Custom" },
];

/** Format a mask number as a hex string */
function formatMaskHex(mask: number, numBytes: number = 2): string {
  const hexDigits = numBytes * 2;
  return `0x${mask.toString(16).toUpperCase().padStart(hexDigits, '0')}`;
}

/** Compute byte position info from mask */
function computeByteInfo(mask: number, headerLength: number): string {
  if (mask === 0 || headerLength === 0) return "no bits selected";

  // Find first and last set bit
  let firstBit = -1;
  let lastBit = -1;
  for (let i = 0; i < headerLength * 8; i++) {
    if ((mask >> i) & 1) {
      if (firstBit === -1) firstBit = i;
      lastBit = i;
    }
  }

  if (firstBit === -1) return "no bits selected";

  const startByte = Math.floor(firstBit / 8);
  const numBits = lastBit - firstBit + 1;
  const numBytes = Math.ceil(numBits / 8);

  return `${numBytes} byte${numBytes !== 1 ? 's' : ''} @ offset ${startByte}`;
}

const encodingOptions: Array<{ value: SerialEncoding; label: string; description: string }> = [
  { value: "slip", label: "SLIP (RFC 1055)", description: "Serial Line Internet Protocol - uses END (0xC0) as delimiter" },
  { value: "cobs", label: "COBS", description: "Consistent Overhead Byte Stuffing - eliminates 0x00 bytes" },
  { value: "raw", label: "Raw (delimiter-based)", description: "Uses custom delimiter bytes to separate frames" },
  { value: "length_prefixed", label: "Length Prefixed", description: "Each frame starts with its length" },
];

export type SerialConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured)
  encoding: SerialEncoding;
  setEncoding: (encoding: SerialEncoding) => void;
  byteOrder: "little" | "big";
  setByteOrder: (byteOrder: "little" | "big") => void;
  headerFields: SerialHeaderFieldEntry[];
  setHeaderFields: (fields: SerialHeaderFieldEntry[]) => void;
  headerLength: number | undefined;
  setHeaderLength: (length: number | undefined) => void;
  checksum: SerialChecksumConfig | null;
  setChecksum: (checksum: SerialChecksumConfig | null) => void;
};

export default function SerialConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  encoding,
  setEncoding,
  byteOrder,
  setByteOrder,
  headerFields,
  setHeaderFields,
  headerLength,
  setHeaderLength,
  checksum,
  setChecksum,
}: SerialConfigSectionProps) {
  // State for inline add form
  const [isAddingField, setIsAddingField] = useState(false);
  const [newFieldType, setNewFieldType] = useState<FieldType>("id");
  const [newFieldCustomName, setNewFieldCustomName] = useState("");
  const [newFieldEndianness, setNewFieldEndianness] = useState<"big" | "little">("big");
  const [newFieldFormat, setNewFieldFormat] = useState<HeaderFieldFormat>("hex");

  // State for field bit pickers (which fields have expanded picker)
  const [expandedFieldPickers, setExpandedFieldPickers] = useState<Record<number, boolean>>({});

  // Effective header length (default to 2 if not set)
  const effectiveHeaderLength = headerLength ?? 2;

  // Check if 'id' field already exists
  const hasIdField = useMemo(
    () => headerFields.some((f) => f.name.toLowerCase() === "id"),
    [headerFields]
  );

  const resetAddForm = () => {
    setNewFieldType("id");
    setNewFieldCustomName("");
    setNewFieldEndianness("big");
    setNewFieldFormat("hex");
    setIsAddingField(false);
  };

  const handleAddField = () => {
    const name = newFieldType === "custom"
      ? newFieldCustomName.trim()
      : newFieldType;

    if (!name) return;

    // Default mask covers all header bytes
    const defaultMask = ((1 << (effectiveHeaderLength * 8)) - 1) >>> 0;

    const newField: SerialHeaderFieldEntry = {
      name,
      mask: defaultMask,
      endianness: newFieldEndianness,
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

  const handleUpdateField = (index: number, updates: Partial<SerialHeaderFieldEntry>) => {
    setHeaderFields(
      headerFields.map((field, i) =>
        i === index ? { ...field, ...updates } : field
      )
    );
  };

  const toggleFieldPicker = (index: number) => {
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const handleFieldMaskChange = useCallback((index: number, mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    handleUpdateField(index, { mask: fullMask });
  }, [headerFields]);

  // Checksum helpers
  const handleAddChecksum = () => {
    setChecksum({
      algorithm: "sum8" as ChecksumAlgorithm,
      start_byte: -1,
      byte_length: 1,
      calc_start_byte: 0,
      calc_end_byte: -1,
    });
  };

  const handleRemoveChecksum = () => {
    setChecksum(null);
  };

  const handleUpdateChecksum = (updates: Partial<SerialChecksumConfig>) => {
    if (checksum) {
      setChecksum({ ...checksum, ...updates });
    }
  };

  // Status indicator
  const showWarning = hasFrames && !isConfigured;

  // Filter field type options - disable 'id' if already exists
  const availableFieldTypes = FIELD_TYPE_OPTIONS.map((opt) => ({
    ...opt,
    disabled: opt.value === "id" && hasIdField,
  }));

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
          <div className="p-1.5 bg-[var(--bg-purple)] rounded">
            <Cable className={`${iconMd} text-[color:var(--text-purple)]`} />
          </div>
          <span className="font-medium text-[color:var(--text-primary)]">Serial</span>
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
              className="px-2 py-1 text-xs text-[color:var(--text-purple)] hover:bg-[var(--hover-bg-purple)] rounded transition-colors"
            >
              + Add
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-[color:var(--border-default)]">
          {/* Encoding and Byte Order row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Encoding */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                Encoding <span className="text-red-500">*</span>
              </label>
              <select
                value={encoding}
                onChange={(e) => setEncoding(e.target.value as SerialEncoding)}
                className={`w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              >
                {encodingOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className={`mt-1 ${caption}`}>
                {encodingOptions.find((o) => o.value === encoding)?.description}
              </p>
            </div>

            {/* Byte Order */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                Byte Order <span className="text-red-500">*</span>
              </label>
              <select
                value={byteOrder}
                onChange={(e) => setByteOrder(e.target.value as "little" | "big")}
                className={`w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              >
                <option value="big">Big Endian (MSB first)</option>
                <option value="little">Little Endian (LSB first)</option>
              </select>
              <p className={`mt-1 ${caption}`}>
                Default byte order for signal decoding
              </p>
            </div>
          </div>

          {/* Header Section */}
          <div className="border-t border-[color:var(--border-default)] pt-4 mt-4">
            <h3 className={`${textMedium} mb-3`}>
              Header
            </h3>

            {/* Header Length */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                Header Length (bytes)
              </label>
              <input
                type="number"
                min={1}
                max={8}
                value={headerLength ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setHeaderLength(val === "" ? undefined : Math.max(1, Math.min(8, parseInt(val) || 1)));
                }}
                className={`w-24 px-3 py-1.5 bg-[var(--bg-secondary)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
                placeholder="2"
              />
              <p className={`mt-1 ${caption}`}>
                Fixed header size for all frames. Required when defining header fields.
              </p>
            </div>
          </div>

          {/* Header Fields Section */}
          <div className="border-t border-[color:var(--border-default)] pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>
                  Header Fields
                </h3>
                <p className={caption}>
                  Define named masks over the header bytes. The "ID" field is used for frame matching.
                </p>
              </div>
              {!isAddingField && (
                <button
                  type="button"
                  onClick={() => setIsAddingField(true)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[var(--bg-purple)] text-[color:var(--text-purple)] rounded-lg hover:bg-[var(--hover-bg-purple)] transition-colors"
                >
                  <Plus className={iconMd} />
                  Add Field
                </button>
              )}
            </div>

            {/* Existing fields list */}
            {headerFields.length > 0 && (
              <div className="space-y-2 mb-3">
                {headerFields.map((field, index) => (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center gap-2 p-2 bg-[var(--bg-secondary)] rounded-lg border border-[color:var(--border-default)]">
                      {/* Expand/collapse toggle */}
                      <button
                        type="button"
                        onClick={() => toggleFieldPicker(index)}
                        className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
                        title={expandedFieldPickers[index] ? "Hide bit picker" : "Show bit picker"}
                      >
                        {expandedFieldPickers[index] ? (
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
                      <code className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs font-mono text-[color:var(--text-secondary)]">
                        {formatMaskHex(field.mask, effectiveHeaderLength)}
                      </code>

                      {/* Byte info */}
                      <span className={caption}>
                        ({computeByteInfo(field.mask, effectiveHeaderLength)})
                      </span>

                      {/* Spacer */}
                      <div className="flex-1" />

                      {/* Endianness */}
                      <select
                        value={field.endianness}
                        onChange={(e) => handleUpdateField(index, { endianness: e.target.value as "big" | "little" })}
                        className={`w-16 px-1 py-1 ${bgSurface} border border-[color:var(--border-default)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                        title="Byte order"
                      >
                        <option value="big">BE</option>
                        <option value="little">LE</option>
                      </select>

                      {/* Format */}
                      <select
                        value={field.format}
                        onChange={(e) => handleUpdateField(index, { format: e.target.value as HeaderFieldFormat })}
                        className={`w-16 px-1 py-1 ${bgSurface} border border-[color:var(--border-default)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
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
                    {expandedFieldPickers[index] && (
                      <div className="ml-8 p-3 bg-[var(--bg-tertiary)] rounded-lg border border-[color:var(--border-default)]">
                        <MaskBitPicker
                          mask={field.mask}
                          shift={0}
                          onMaskChange={(mask, shift) => handleFieldMaskChange(index, mask, shift)}
                          numBytes={effectiveHeaderLength}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add new field form */}
            {isAddingField && (
              <div className="p-3 bg-[var(--bg-purple-subtle)] rounded-lg border border-[color:var(--border-purple)]">
                <div className="flex items-center gap-2 mb-3">
                  {/* Field type dropdown */}
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as FieldType)}
                    className={`w-40 px-2 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
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
                      className={`flex-1 px-2 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                      placeholder="Field name"
                      autoFocus
                    />
                  )}

                  {/* Endianness */}
                  <select
                    value={newFieldEndianness}
                    onChange={(e) => setNewFieldEndianness(e.target.value as "big" | "little")}
                    className={`w-16 px-1 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                    title="Byte order"
                  >
                    <option value="big">BE</option>
                    <option value="little">LE</option>
                  </select>

                  {/* Format */}
                  <select
                    value={newFieldFormat}
                    onChange={(e) => setNewFieldFormat(e.target.value as HeaderFieldFormat)}
                    className={`w-16 px-1 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-xs text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                  >
                    <option value="hex">Hex</option>
                    <option value="decimal">Dec</option>
                  </select>
                </div>

                <div className="flex items-center justify-between">
                  <p className={caption}>
                    Use the bit picker to select which header bytes this field covers.
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
                      className={`px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 ${disabledState} transition-colors`}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {headerFields.length === 0 && !isAddingField && (
              <p className={`${caption} italic`}>
                No header fields defined. Add an "ID" field to enable frame matching.
              </p>
            )}
          </div>

          {/* Protocol-Level Checksum Section */}
          <div className="border-t border-[color:var(--border-default)] pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>
                  Protocol Checksum
                </h3>
                <p className={caption}>
                  Default checksum settings for all frames
                </p>
              </div>
              {!checksum ? (
                <button
                  type="button"
                  onClick={handleAddChecksum}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[var(--bg-purple)] text-[color:var(--text-purple)] rounded-lg hover:bg-[var(--hover-bg-purple)] transition-colors"
                >
                  <Plus className={iconMd} />
                  Add Checksum
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleRemoveChecksum}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-[color:var(--text-red)] hover:bg-[var(--hover-bg-red)] rounded-lg transition-colors"
                >
                  <Trash2 className={iconMd} />
                  Remove
                </button>
              )}
            </div>

            {checksum && (
              <div className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[color:var(--border-default)] space-y-3">
                {/* Algorithm */}
                <div>
                  <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                    Algorithm
                  </label>
                  <select
                    value={checksum.algorithm}
                    onChange={(e) => handleUpdateChecksum({ algorithm: e.target.value as ChecksumAlgorithm })}
                    className={`w-full px-3 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                  >
                    {CHECKSUM_ALGORITHMS.map((alg) => (
                      <option key={alg.id} value={alg.id}>
                        {alg.name}
                      </option>
                    ))}
                  </select>
                  <p className={`mt-0.5 ${caption}`}>
                    {CHECKSUM_ALGORITHMS.find((a) => a.id === checksum.algorithm)?.description}
                  </p>
                </div>

                {/* Checksum location */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                      Start Byte
                    </label>
                    <input
                      type="number"
                      value={checksum.start_byte}
                      onChange={(e) => handleUpdateChecksum({ start_byte: parseInt(e.target.value) || 0 })}
                      className={`w-full px-3 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                      title="Byte position where checksum is stored (-1 = last byte)"
                    />
                    <p className={`mt-0.5 ${caption}`}>
                      -1 = last byte
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                      Byte Length
                    </label>
                    <select
                      value={checksum.byte_length}
                      onChange={(e) => handleUpdateChecksum({ byte_length: parseInt(e.target.value) })}
                      className={`w-full px-3 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                    >
                      <option value={1}>1 byte</option>
                      <option value={2}>2 bytes</option>
                    </select>
                  </div>
                </div>

                {/* Calculation range */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                      Calc Start Byte
                    </label>
                    <input
                      type="number"
                      value={checksum.calc_start_byte}
                      onChange={(e) => handleUpdateChecksum({ calc_start_byte: parseInt(e.target.value) || 0 })}
                      className={`w-full px-3 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                      title="First byte included in calculation"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                      Calc End Byte
                    </label>
                    <input
                      type="number"
                      value={checksum.calc_end_byte}
                      onChange={(e) => handleUpdateChecksum({ calc_end_byte: parseInt(e.target.value) || 0 })}
                      className={`w-full px-3 py-1.5 ${bgSurface} border border-[color:var(--border-default)] rounded text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500`}
                      title="Last byte (exclusive) included in calculation (-1 = up to checksum)"
                    />
                    <p className={`mt-0.5 ${caption}`}>
                      -1 = up to checksum
                    </p>
                  </div>
                </div>

                {/* Big endian checkbox (only show for 2-byte checksums) */}
                {checksum.byte_length === 2 && (
                  <div className={flexRowGap2}>
                    <input
                      type="checkbox"
                      id="checksum-big-endian"
                      checked={checksum.big_endian ?? false}
                      onChange={(e) => handleUpdateChecksum({ big_endian: e.target.checked })}
                      className="w-4 h-4 rounded border-[color:var(--border-default)] text-purple-600 focus:ring-purple-500"
                    />
                    <label htmlFor="checksum-big-endian" className="text-sm text-[color:var(--text-secondary)]">
                      Big endian (MSB first)
                    </label>
                  </div>
                )}
              </div>
            )}

            {!checksum && (
              <p className={`${caption} italic`}>
                No protocol-level checksum configured. Click "Add Checksum" to define defaults.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Collapsed preview when configured but not expanded */}
      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-[color:var(--border-default)]`}>
          Encoding: {encoding.toUpperCase()} • {byteOrder === 'big' ? 'BE' : 'LE'}
          {headerLength !== undefined && headerLength > 0 && ` • Header: ${headerLength}B`}
          {headerFields.length > 0 && ` • ${headerFields.length} field(s)`}
          {hasIdField && " • ID field"}
          {checksum && ` • Checksum: ${checksum.algorithm.toUpperCase()}`}
        </div>
      )}
    </div>
  );
}
